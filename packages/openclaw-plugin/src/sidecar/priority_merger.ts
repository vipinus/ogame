/**
 * M5.4 PriorityMerger — pulls active Goals from the store, plans each via the
 * injected planner, merges results by priority, and dispatches resulting
 * Directives downstream via the injected send (typically WsServer.send or
 * HttpServer.queueDownstream).
 *
 * Sorting: priority DESC (higher first), then created_at ASC (older first) as
 * stable tiebreak. Already-blocked rows are still re-planned because state may
 * have changed since they last failed.
 *
 * Planner result handling:
 *   - Directive               → mark row "active",   send directive.dispatch.
 *   - { blocked: "..." }      → mark row "blocked",  persist reason, count.
 *   - { blocked: /already at or above/ } → mark row "completed" (terminal).
 *
 * Note: daily-task directives and pending user directives are not yet sourced
 * from the plugin side (M5.x). This merger currently handles goal-derived
 * directives only; the higher-level merge slot is reserved for later wiring.
 */
import type { Directive, DownstreamMsg, Goal, WorldState } from "@ogamex/shared";
import type { GoalsStore, GoalRow } from "./goals_store.js";

export interface PriorityMergerDeps {
  store: GoalsStore;
  planGoal: (goal: Goal, state: WorldState) => Directive | { blocked: string };
  /** Send a DownstreamMsg via the bridge (WsServer.send or HttpServer.queueDownstream). */
  send: (msg: DownstreamMsg) => void;
}

export interface DispatchResult {
  dispatched: Directive[];
  blocked: { goal_id: string; reason: string }[];
  skipped_terminal: number;
}

/**
 * Terminal-blocked patterns. Any blocked reason matching this regex causes the
 * merger to mark the goal as COMPLETED rather than blocked — these reasons all
 * mean "there is nothing left for this goal to do". Includes:
 *   - "already at or above target …"            (research/build at level)
 *   - "already upgrading in ogame queue …"     (build_q already targets it)
 *   - "… in flight"                             (fleet already outbound)
 *   - "… production started"                   (shipyard_q has the ship)
 */
const ALREADY_AT_TARGET_RE =
  /already at or above target|already upgrading in ogame queue|in flight|production started|goal complete/i;

function isBlocked(r: Directive | { blocked: string }): r is { blocked: string } {
  return typeof (r as { blocked?: unknown }).blocked === "string";
}

/**
 * Comparator: main-goal first, then priority DESC, then created_at ASC.
 * The is_main_goal flag is an OPERATOR-set OVERRIDE — must always run before
 * any other goal, even one with a higher numeric priority.
 */
function compareRows(a: GoalRow, b: GoalRow): number {
  const am = a.goal.is_main_goal === true ? 1 : 0;
  const bm = b.goal.is_main_goal === true ? 1 : 0;
  if (am !== bm) return bm - am;
  const dp = b.goal.priority - a.goal.priority;
  if (dp !== 0) return dp;
  return a.created_at - b.created_at;
}

export class PriorityMerger {
  private readonly store: GoalsStore;
  private readonly planGoal: (goal: Goal, state: WorldState) => Directive | { blocked: string };
  private readonly send: (msg: DownstreamMsg) => void;
  // v0.0.459: pure event-driven gate (operator 2026-05-29 "基本原则就是只用
  // 事件触发"). All timer-based cooldowns / stuck-recovery removed:
  //   - removed DISPATCH_COOLDOWN_MS (10s rate limit) — pure event triggers
  //   - removed STUCK_ACTIVE_MS (90s recovery) — operator-resume only
  // Per-goal awaiting-event Set: when directive fails → mark this goal as
  // waiting for one of {empire_poll, operator_retry}. dispatch() skips such
  // goals. Cleared on state.snapshot arrival (empire_poll) or operator
  // pause+resume (operator_retry).
  private readonly awaitingEvents = new Map<string, Set<string>>();
  // v0.0.463: event-driven stuck recovery (operator 2026-05-29 "N=2 落地").
  // When a goal sits "active" for N consecutive snapshots WHERE the ogame
  // slot it would occupy is empty AND the snapshot's last_update is newer
  // than row.updated_at, the dispatched directive is presumed lost (WS drop,
  // network hiccup, page reload during dispatch). Counter increments per
  // qualifying snapshot; demote to pending when it hits STUCK_DEMOTE_AT.
  // Counter zeroes when slot becomes busy (directive succeeded) or goal
  // exits active. NOT timer-based — counts snapshot events.
  private readonly stuckCounter = new Map<string, number>();
  private readonly STUCK_DEMOTE_AT = 2;

  constructor(deps: PriorityMergerDeps) {
    this.store = deps.store;
    this.planGoal = deps.planGoal;
    this.send = deps.send;
  }

  /** Mark a goal as awaiting one of the given events. Called when a directive
   *  fails — goal stays blocked until one of those events arrives. */
  markAwaiting(goalId: string, events: string[]): void {
    const set = this.awaitingEvents.get(goalId) ?? new Set<string>();
    for (const e of events) set.add(e);
    this.awaitingEvents.set(goalId, set);
  }

  /** Clear awaiting for a goal+event combo. If event is "*" or omitted, clear
   *  all awaitings for that goal. If goalId is "*", clear that event across
   *  ALL goals. */
  clearAwaiting(goalId: string, event?: string): void {
    if (goalId === "*") {
      if (!event || event === "*") { this.awaitingEvents.clear(); return; }
      for (const [g, set] of this.awaitingEvents) {
        set.delete(event);
        if (set.size === 0) this.awaitingEvents.delete(g);
      }
      return;
    }
    if (!event || event === "*") { this.awaitingEvents.delete(goalId); return; }
    const set = this.awaitingEvents.get(goalId);
    if (!set) return;
    set.delete(event);
    if (set.size === 0) this.awaitingEvents.delete(goalId);
  }

  /** Read-only access for /v1/goals to expose awaiting set per goal. Returns
   *  empty set when none set (allocator-free common path). */
  getAwaiting(goalId: string): ReadonlySet<string> {
    return this.awaitingEvents.get(goalId) ?? new Set<string>();
  }

  /** Reset awaiting + all internal state — invoked on client reconnect. */
  resetCooldown(): void {
    this.awaitingEvents.clear();
    this.stuckCounter.clear();
  }

  /**
   * Plan & dispatch all non-terminal goals. Status transitions are written
   * back to the store before this method returns; callers may observe them
   * synchronously after dispatch resolves.
   */
  dispatch(state: WorldState): DispatchResult {
    const rows = [...this.store.listActive()].sort(compareRows);

    const dispatched: Directive[] = [];
    const blocked: { goal_id: string; reason: string }[] = [];
    let skipped_terminal = 0;

    // Slot tracking — ogame physics: research is GLOBAL (1 player), build &
    // shipyard are PER PLANET (1 each). Pre-seed from in-flight state queues
    // (build_q with future ends_at, research.queue active) so already-queued
    // ogame work also blocks new directives that would race it.
    const now = Date.now();
    let researchSlot = !!(state.research?.queue && (state.research.queue.ends_at ?? 0) > now);
    const buildSlot = new Set<string>();
    const lfBuildSlot = new Set<string>(); // separate lifeform queue per planet
    const shipsSlot = new Set<string>();
    for (const p of Object.values(state.planets ?? {})) {
      const bq = p.build_q as { ends_at?: number } | null;
      if (bq && (bq.ends_at ?? 0) > now) buildSlot.add(p.id);
      const sq = p.shipyard_q as { ends_at?: number } | null;
      if (sq && (sq.ends_at ?? 0) > now) shipsSlot.add(p.id);
      // ogame's lf queue is tracked separately — we don't currently extract
      // its in-flight state from page DOM, so this set seeds empty and only
      // gets entries from same-tick claims.
    }

    // v0.0.433: per-tick chain-prereq tracking. rows are sorted priority
    // DESC (compareRows). Within a chain_id, the FIRST row we encounter
    // (highest priority) is the active leg; any subsequent row with the
    // same chain_id is a lower-priority leg waiting on the earlier one.
    // Block lower legs until the higher one completes — operator
    // 2026-05-29: "为什么 Leg 4 是 active 不是 block?"
    const chainBlocked = new Set<string>();
    for (const row of rows) {
      // Operator-paused row: skip entirely. Status / reason untouched.
      if (row.status === "blocked" && typeof row.reason === "string" && row.reason.startsWith("PAUSED")) {
        continue;
      }
      // Chain prereq gate.
      const chainId = (row.goal.target as { chain_id?: unknown })?.chain_id;
      if (typeof chainId === "string" && chainId && chainBlocked.has(chainId)) {
        const reason = "chain prereq: waiting for prior leg";
        if (row.status !== "blocked" || row.reason !== reason) {
          this.store.updateStatus(row.goal.id, "blocked", reason);
        }
        blocked.push({ goal_id: row.goal.id, reason });
        continue;
      }
      // v0.0.463: pure-event stuck recovery. Operator's directive may have
      // been dispatched but lost (WS drop / page reload / etc.). For build/
      // research goals, the ogame slot it would occupy is the diagnostic:
      // empty slot + snapshot newer than dispatch = directive presumed lost.
      // After STUCK_DEMOTE_AT consecutive qualifying snapshots → demote.
      if (row.status === "active") {
        const goalType = row.goal.type;
        const planetIdRaw = typeof row.goal.planet === "string" ? row.goal.planet : "";
        // Resolve planet ref (coord or id) to actual planet object for slot probe
        const planet = planetIdRaw
          ? (Object.values(state.planets ?? {}).find((p) => p.id === planetIdRaw)
             ?? Object.values(state.planets ?? {}).find((p) => Array.isArray(p.coords) && p.coords.join(":") === planetIdRaw))
          : undefined;
        let slotEmpty = false;
        if (goalType === "build" || goalType === "build_universal") {
          const bq = planet?.build_q as { ends_at?: number } | null;
          slotEmpty = !bq || (bq.ends_at ?? 0) <= now;
        } else if (goalType === "research") {
          const rq = state.research?.queue as { ends_at?: number } | null;
          slotEmpty = !rq || (rq.ends_at ?? 0) <= now;
        } else if (goalType === "build_ships" || goalType === "build_defense") {
          const sq = planet?.shipyard_q as { ends_at?: number } | null;
          slotEmpty = !sq || (sq.ends_at ?? 0) <= now;
        } else if (goalType === "lifeform_building") {
          const lfq = (planet as { lf_build_q?: { ends_at?: number } | null } | undefined)?.lf_build_q;
          slotEmpty = !lfq || (lfq.ends_at ?? 0) <= now;
        } else if (goalType === "expedition" || goalType === "colonize" || goalType === "deploy" || goalType === "transport") {
          // v0.0.466 + v0.0.467: atomic fleet ops stuck recovery. Operator
          // 2026-05-29 "do" → extend pattern from expedition to colonize/
          // deploy/transport. Signal = "no outbound fleet of matching
          // mission originating from this goal's source planet". If zero
          // matching fleets and snapshot newer than dispatch → directive
          // presumed lost. Same N=2 demote logic shared with build/research.
          const missionByType: Record<string, number> = {
            expedition: 15,
            colonize: 7,
            deploy: 4,
            transport: 3,
          };
          const expectedMission = missionByType[goalType];
          const targetParams = row.goal.target as { source_planet?: string };
          const srcId = targetParams.source_planet ?? (typeof row.goal.planet === "string" ? row.goal.planet : "");
          const srcPlanet = srcId
            ? (Object.values(state.planets ?? {}).find((p) => p.id === srcId)
               ?? Object.values(state.planets ?? {}).find((p) => Array.isArray(p.coords) && p.coords.join(":") === srcId))
            : undefined;
          const srcCoordStr = Array.isArray(srcPlanet?.coords) ? srcPlanet.coords.join(":") : "";
          const myOutbound = (state.fleets_outbound ?? []).filter((f) => {
            if (f.mission !== expectedMission) return false;
            const orig = Array.isArray(f.origin) ? f.origin.join(":") : "";
            return orig === srcCoordStr;
          });
          slotEmpty = myOutbound.length === 0;
        }
        // jumpgate is the remaining atomic op without a fleet signal — JG
        // POSTs to ogame's jumpgate endpoint; success = instant ship swap
        // between moons with no outbound fleet visible. Needs cooldown
        // detection (separate enhancement) — left for operator pause+resume.
        const snapshotFresher = (state.last_update ?? 0) > (row.updated_at ?? 0);
        if (slotEmpty && snapshotFresher) {
          const cnt = (this.stuckCounter.get(row.goal.id) ?? 0) + 1;
          if (cnt >= this.STUCK_DEMOTE_AT) {
            this.stuckCounter.delete(row.goal.id);
            this.store.updateStatus(row.goal.id, "pending", `stuck-recovery: empty slot ${cnt} snapshots, directive presumed lost`);
            // fall through — re-plan as pending below
          } else {
            this.stuckCounter.set(row.goal.id, cnt);
            if (typeof chainId === "string" && chainId) chainBlocked.add(chainId);
            continue;
          }
        } else {
          // slot busy (directive working) OR same snapshot — reset counter
          this.stuckCounter.delete(row.goal.id);
          if (typeof chainId === "string" && chainId) chainBlocked.add(chainId);
          continue;
        }
      }
      // v0.0.459: per-goal awaiting-event gate. After a directive failed for
      // this goal, sidecar marks awaiting={"empire_poll","operator_retry"}.
      // Skip until one of those events arrives and clears the awaiting set.
      const awaiting = this.awaitingEvents.get(row.goal.id);
      if (awaiting && awaiting.size > 0) {
        if (typeof chainId === "string" && chainId) chainBlocked.add(chainId);
        continue;
      }
      const result = this.planGoal(row.goal, state);
      if (isBlocked(result)) {
        if (ALREADY_AT_TARGET_RE.test(result.blocked)) {
          this.store.updateStatus(row.goal.id, "completed");
          skipped_terminal += 1;
        } else {
          this.store.updateStatus(row.goal.id, "blocked", result.blocked);
          blocked.push({ goal_id: row.goal.id, reason: result.blocked });
          // v0.0.433: chain prereq — this leg is blocked, downstream waits.
          if (typeof chainId === "string" && chainId) chainBlocked.add(chainId);
        }
        continue;
      }
      // Slot allocation — check before claiming.
      const params = result.params as { planet_id?: string };
      const planetId = params.planet_id;
      if (result.action === "research") {
        if (researchSlot) {
          const reason = "research slot in use";
          this.store.updateStatus(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        researchSlot = true;
      } else if (result.action === "build" || result.action === "build_universal") {
        // ogame physics: lifeform buildings have a SEPARATE per-planet
        // build queue from regular supplies/facilities. Same "build" action
        // here distinguishes via technology_id range (111xx-141xx = lifeform).
        const techId = (result.params as { technology_id?: number }).technology_id ?? 0;
        const isLifeform = techId >= 11000 && techId <= 15000;
        const slotSet = isLifeform ? lfBuildSlot : buildSlot;
        const slotLabel = isLifeform ? "lf build" : "build";
        if (planetId && slotSet.has(planetId)) {
          const reason = `${slotLabel} slot on ${planetId} in use this tick`;
          this.store.updateStatus(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        if (planetId) slotSet.add(planetId);
      } else if (result.action === "build_ships" || result.action === "build_defense") {
        if (planetId && shipsSlot.has(planetId)) {
          const reason = `shipyard slot on ${planetId} in use this tick`;
          this.store.updateStatus(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        if (planetId) shipsSlot.add(planetId);
      }
      this.store.updateStatus(row.goal.id, "active");
      this.send({ type: "directive.dispatch", directive: result });
      dispatched.push(result);
      // v0.0.433: this leg is now active; downstream chain peers must wait.
      const cid = (row.goal.target as { chain_id?: unknown })?.chain_id;
      if (typeof cid === "string" && cid) chainBlocked.add(cid);
    }

    return { dispatched, blocked, skipped_terminal };
  }
}
