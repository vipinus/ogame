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
import type { GoalsStore, GoalRow, GoalStatus } from "./goals_store.js";

export interface PriorityMergerDeps {
  store: GoalsStore;
  planGoal: (goal: Goal, state: WorldState) => Directive | { blocked: string };
  /** Send a DownstreamMsg via the bridge (WsServer.send or HttpServer.queueDownstream). */
  send: (msg: DownstreamMsg) => void;
  /** Phase 5c — fired AFTER every store.updateStatus mutation so the PG
   *  shadow writer can mirror merger-driven status transitions (the 11
   *  call sites previously SQLite-only, surfaced as drift in Phase 5b).
   *  Receives the POST-update row so the mirror can do INSERT-or-UPDATE
   *  (upsertGoal) — converges even when the goal never existed in PG
   *  (e.g. created via a path that pre-dated Phase 0 shadowFire wiring). */
  onStatusChange?: (row: GoalRow, userId: string | undefined) => void;
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
  /already at or above target|already upgrading in ogame queue|in flight|production started|goal complete|no-op: source body/i;

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
  // v0.0.478: dispatch-time-anchored stuck recovery (operator 2026-05-30).
  // PREVIOUS DESIGN (v0.0.463 N=2 / v0.0.469 N_ATOMIC=4 snapshot count) was
  // wrong: snapshot rate (~5-7.5s) is unstable, demote window flapped, and
  // a fleet POST that took >20s to reflect in state.fleets_outbound got
  // false-positive-demoted → second directive dispatched → DUPLICATE fleet
  // (operator 2026-05-30: "运输又发了两次, 17min 20s/17min 40s 同源同终").
  //
  // NEW DESIGN: track when each goal was last dispatched (dispatchedAt).
  // stuck-recovery requires (Date.now() - dispatchedAt) >= timeout AND
  // qualifying snapshot. Timeout is decoupled from snapshot rate.
  //   - build / research:           30s timeout (slot signal is reliable)
  //   - atomic fleet (deploy etc.): 90s timeout (sendFleet + ack + state
  //                                 catch-up can take 30-60s under load)
  // dispatchedAt cleared on ack (completed/blocked/cancelled status).
  // Also serves as in-flight DEDUP at dispatch path: if dispatchedAt exists
  // within timeout window AND goal status is still "active" without ack,
  // skip re-dispatch this tick (defense-in-depth vs. userscript dedup).
  private readonly dispatchedAt = new Map<string, number>();
  // v0.0.577 — operator 2026-06-01 "选C": stuck-recovery 60s race-free
  // safety net. Happy path ack ≈ 1s (event-driven), 60s tolerates internal
  // transient retry + slow ogame response without false-positive re-dispatch.
  // True failures (Chrome crash / sidecar restart / long-poll 断) unstuck
  // automatically after 60s — no operator manual intervention needed.
  // v0.0.668 — operator 2026-06-02 "全部30": stuck-recovery 收紧至 30s 跨所有
  // goal 类型。原 60s 是按 sendFleet 最慢 round-trip 估的；实测 ack 通常
  // <10s，30s 给 3x 安全 margin，让 chain pipeline 卡死后更快 self-heal。
  // 安全网仍在：planner 重发前 re-check slot/cooldown/库存，不会 double-fire。
  private readonly STUCK_TIMEOUT_MS = 30_000;
  private readonly STUCK_TIMEOUT_MS_ATOMIC = 30_000;

  private readonly onStatusChange: ((row: GoalRow, userId: string | undefined) => void) | undefined;
  /** Set at start of dispatch(), threaded through to onStatusChange so
   *  the PG mirror knows which tenant the status mutation belongs to. */
  private currentDispatchUid: string | undefined = undefined;

  constructor(deps: PriorityMergerDeps) {
    this.store = deps.store;
    this.planGoal = deps.planGoal;
    this.send = deps.send;
    this.onStatusChange = deps.onStatusChange;
  }

  /** v0.0.670 — Phase 5c: helper that mirrors every status mutation to
   *  the PG shadow writer via the onStatusChange callback. Without this
   *  hook the 11 merger-driven updateStatus call sites would stay
   *  SQLite-only (drift observed in Phase 5b: sqlite=13 pg=9). */
  private updateStatusAndMirror(goalId: string, status: GoalStatus, reason?: string): void {
    this.store.updateStatus(goalId, status, reason);
    if (this.onStatusChange) {
      try {
        // Re-fetch so the mirror receives the row's POST-update state. If
        // the row vanished mid-tick (cancelled in parallel), skip.
        const updated = this.store.get(goalId);
        if (updated) this.onStatusChange(updated, this.currentDispatchUid);
      } catch (e) {
        // Mirror failure must NEVER taint the primary SQLite path.
        console.warn("[merger] onStatusChange threw (swallowed)", e);
      }
    }
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

  /** Reset awaiting on client reconnect.
   *  v0.0.498: re-stamped dispatchedAt to give fresh 90s window after reconnect.
   *  v0.0.507 — operator 2026-05-31: WS flapping (connect/disconnect every few
   *  seconds) caused every hello to re-stamp dispatchedAt → 90s timer never
   *  elapsed → stuck-active goals (6 expeditions stuck 2+ min, daemon refuses
   *  new dispatches because cap reached). Fix: DON'T touch dispatchedAt on
   *  reconnect at all. Keep original dispatch time. If stuck-recovery 90s
   *  elapses naturally, demote and re-dispatch. awaitingEvents still cleared
   *  so failed goals get re-tried. */
  resetCooldown(): void {
    this.awaitingEvents.clear();
    // intentionally DO NOT touch dispatchedAt — let original dispatch time
    // anchor the stuck-recovery window through any flapping reconnects.
  }

  /** Clear dispatch tracking for a goal. Called from ack handler when goal
   *  transitions away from "active" (completed / blocked / cancelled). */
  clearDispatched(goalId: string): void {
    this.dispatchedAt.delete(goalId);
  }

  /**
   * Plan & dispatch all non-terminal goals. Status transitions are written
   * back to the store before this method returns; callers may observe them
   * synchronously after dispatch resolves.
   */
  /**
   * Phase 9c.2 — optional userId arg. When supplied, only goals tagged
   * with that user_id participate in this dispatch tick (multi-tenant
   * routing). When undefined, legacy single-tenant behaviour: every
   * non-terminal goal in the store dispatches off the given state.
   *
   * SaveCoordinator / FailureAggregator are NOT yet user-scoped (9c.3);
   * they still operate on the legacy single-tenant stateRef. Cross-user
   * fleet-save / failure-pattern bleed remains a known limitation until
   * 9c.3 lands.
   */
  async dispatch(state: WorldState, userId?: string): Promise<DispatchResult> {
    // v0.0.669 — Phase 5b: dispatch made async so a future swap of
    // this.store to IGoalsStoreReader (PG/async) requires no further
    // refactor of the merger loop. `await` on the current sync GoalsStore
    // returns immediately (identity for non-Promise values).
    // v0.0.670 — Phase 5c: thread userId through so the mirror callback
    // knows the tenant. updateStatusAndMirror reads this each call.
    this.currentDispatchUid = userId;
    const rows = (
      typeof userId === "string" && userId
        ? [...(await this.store.listActiveByUser(userId))]
        : [...(await this.store.listActive())]
    ).sort(compareRows);

    const dispatched: Directive[] = [];
    const blocked: { goal_id: string; reason: string }[] = [];
    let skipped_terminal = 0;

    // v0.0.544 — state-staleness gate (operator 2026-05-31 incident).
    // WS push from userscript broke at 21:07, sidecar kept dispatching
    // based on 30+ min stale snapshot → "ships short" on bodies that
    // ACTUALLY have ships (per ogame email evidence). Planning on stale
    // state is worse than not planning. Fleet-POST goal types skip
    // entirely when state is older than STATE_STALE_MS. Build/research/
    // build_ships goals still try (their state — slots, prereqs — is
    // ledger-style, less volatile than fleet/ship counts).
    const STATE_STALE_MS = 5 * 60 * 1000;
    const lastUpdate = (state as { last_update?: number }).last_update ?? 0;
    const stateAgeMs = Date.now() - lastUpdate;
    const stateStale = lastUpdate > 0 && stateAgeMs > STATE_STALE_MS;

    // Slot tracking — ogame physics: research is GLOBAL (1 player), build &
    // shipyard are PER PLANET (1 each). Pre-seed from in-flight state queues
    // (build_q with future ends_at, research.queue active) so already-queued
    // ogame work also blocks new directives that would race it.
    const now = Date.now();
    let researchSlot = !!(state.research?.queue && (state.research.queue.ends_at ?? 0) > now);
    const buildSlot = new Set<string>();
    const lfBuildSlot = new Set<string>(); // separate lifeform queue per planet
    const lfResearchSlot = new Set<string>(); // v0.0.633 — separate lf research queue per planet
    const shipsSlot = new Set<string>();
    for (const p of Object.values(state.planets ?? {})) {
      const bq = p.build_q as { ends_at?: number } | null;
      if (bq && (bq.ends_at ?? 0) > now) buildSlot.add(p.id);
      const sq = p.shipyard_q as { ends_at?: number } | null;
      if (sq && (sq.ends_at ?? 0) > now) shipsSlot.add(p.id);
      const lfbq = (p as { lf_build_q?: { ends_at?: number } | null }).lf_build_q;
      if (lfbq && (lfbq.ends_at ?? 0) > now) lfBuildSlot.add(p.id);
      const lfrq = (p as { lf_research_q?: { ends_at?: number } | null }).lf_research_q;
      if (lfrq && (lfrq.ends_at ?? 0) > now) lfResearchSlot.add(p.id);
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
          this.updateStatusAndMirror(row.goal.id, "blocked", reason);
        }
        blocked.push({ goal_id: row.goal.id, reason });
        continue;
      }
      // v0.0.539 — cross-tick chain prereq (tree-style, operator 2026-05-31
      // "改成树状前置任务方式，如同建筑任务"). chainBlocked above is per-tick
      // only — once leg 1 ack'd completed (sendFleet success), chainBlocked
      // is empty next tick and leg 2 fires even though leg 1's FLEET hasn't
      // arrived yet. Fix: any leg with chain_id waits for every same-chain
      // sibling with strictly higher priority to be terminal (completed/
      // cancelled) AND its observable fleet (matched in fleets_outbound by
      // source coords + dest coords) to be gone. Priority ordering is the
      // chain template's existing sequence signal (genFerry: load=N,
      // hop=N-1, unload=N-2; Seg 2=9, Seg 3=6).
      if (typeof chainId === "string" && chainId) {
        const allRows = this.store.list();
        const upstream = allRows.filter((r) => {
          const cid = (r.goal.target as { chain_id?: unknown })?.chain_id;
          return cid === chainId && r.goal.id !== row.goal.id && r.goal.priority > row.goal.priority;
        });
        let upstreamReason: string | null = null;
        for (const u of upstream) {
          if (u.status !== "completed" && u.status !== "cancelled") {
            upstreamReason = `chain prereq: upstream leg ${u.goal.id.slice(0, 12)} (${(u.goal.target as { chain_phase?: string })?.chain_phase ?? "?"}) status=${u.status}`;
            break;
          }
          if (u.status === "cancelled") continue;
          const uTarget = u.goal.target as { source_planet?: string; target_coords?: string };
          const srcPlanet = typeof uTarget.source_planet === "string"
            ? Object.values(state.planets ?? {}).find((p) => p.id === uTarget.source_planet)
            : null;
          if (!srcPlanet) continue;
          const srcCoords = srcPlanet.coords.join(":");
          const dstCoords = typeof uTarget.target_coords === "string" ? uTarget.target_coords : "";
          if (!dstCoords) continue;
          const inTransit = (state.fleets_outbound ?? []).some(
            (f) => f.origin.join(":") === srcCoords && f.dest.join(":") === dstCoords,
          );
          if (inTransit) {
            upstreamReason = `chain prereq: upstream ${u.goal.id.slice(0, 12)} (${(u.goal.target as { chain_phase?: string })?.chain_phase ?? "?"}) fleet still in transit ${srcCoords}→${dstCoords}`;
            break;
          }
        }
        // v0.0.664 — operator 2026-06-02 "JG 跳了但是船只过去 3 个":
        // chain race bug. After upstream fleet leaves outbound, the source's
        // ship inventory may not reflect the just-arrived payload yet
        // (sniffer/snapshot lag). JG with take_all=true grabs whatever's
        // CURRENTLY visible → ferries the residual 3 LC instead of the
        // 2713 LC just delivered by Leg 1. Block this leg until source
        // ship counts cover the goal's expected ships.
        if (!upstreamReason) {
          const myT = row.goal.target as {
            source_moon?: string;
            source_planet?: string;
            ships?: Record<string, number>;
            take_all?: boolean;
          };
          const expected = myT.ships ?? {};
          // take_all=true 只对 JG 有意义, 但即便 take_all 也要 ≥ expected
          // (operator 实战: expected=2713 LC, take_all 抓到 3 LC, 显然没等到)
          const sourceId = myT.source_moon ?? myT.source_planet;
          if (sourceId && Object.keys(expected).length > 0) {
            const srcBody = Object.values(state.planets ?? {}).find((p) => p.id === sourceId);
            const srcShips = (srcBody as { ships?: Record<string, number> } | undefined)?.ships ?? {};
            for (const [shipType, needed] of Object.entries(expected)) {
              const have = srcShips[shipType] ?? 0;
              if (have < needed) {
                upstreamReason = `chain prereq: source ${sourceId.slice(-4)} ship inventory not yet synced (need ${needed} ${shipType}, have ${have} — upstream fleet just landed, wait for next snapshot)`;
                break;
              }
            }
          }
        }
        if (upstreamReason) {
          if (row.status !== "blocked" || row.reason !== upstreamReason) {
            this.updateStatusAndMirror(row.goal.id, "blocked", upstreamReason);
          }
          blocked.push({ goal_id: row.goal.id, reason: upstreamReason });
          chainBlocked.add(chainId);
          continue;
        }
      }
      // v0.0.478: time-anchored stuck recovery. Active goal that hasn't
      // ack'd within timeout AND has empty ogame slot → demote. Decoupled
      // from snapshot rate (was N=4 snapshots × 5s = 20s window → false
      // positives → duplicate fleet, operator 2026-05-30). Now 90s for
      // atomic fleet ops (covers slow sendFleet + state catch-up gap) and
      // 30s for build/research (slot signal is reliable & instant).
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
        } else if (goalType === "lifeform_research") {
          // v0.0.633 — owner 2026-06-01 "从0级往上升级的, 当然是有前置任
          // 务在跑, 为什么不等待前置任务完成?". Use real per-planet
          // lf_research_q (runtime harvests from lfresearch page).
          //   - Queue active (ends_at > now) → slotEmpty=false → goal
          //     waits, no spurious re-dispatch, no ogame 120012 retry.
          //   - Queue absent / ends_at past → slotEmpty=true → allow
          //     stuck-recovery to re-arm after timeout.
          const lfrq = (planet as { lf_research_q?: { ends_at?: number } | null } | undefined)?.lf_research_q;
          slotEmpty = !lfrq || (lfrq.ends_at ?? 0) <= now;
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
        } else if (goalType === "species_discovery") {
          // v0.0.575 — operator 2026-06-01 "发现任务派的很慢": discover ack
          // completes when sendDiscoveryFleet POST returns success — the
          // mission=18 fleet still flies out and back, but the directive is
          // DONE. Checking outbound count (like expedition) caused stuck-
          // recovery wait while mission=18 fleets were in transit (90min/
          // coord = 8h for full sweep). Discover is "fast atomic" — slotEmpty
          // is always true once ack arrives; fleet-slot exhaustion is handled
          // separately by planSpeciesDiscoveryGoal's reserve gate.
          slotEmpty = true;
        } else if (goalType === "jumpgate") {
          // v0.0.667 — operator 2026-06-02 "Leg 1 Jump · jumping 卡" root
          // cause: JG dispatched on a moon whose cooldown was active but
          // sniffer hadn't written cd_sec yet (stale state at dispatch
          // time). ogame rejected, userscript ack never propagated → goal
          // stuck "active" forever, blocking the rest of the chain. Old
          // comment said "left for operator pause+resume" — turning it
          // into automatic recovery now. Signal: source moon's JG NOT on
          // cooldown right now. Both halves of "ack came" (ships moved
          // out) and "ack lost but cd elapsed" satisfy this — either way
          // re-dispatching is safe because planner.ts re-checks cd + ship
          // inventory before firing.
          const tParams = row.goal.target as { source_moon?: string };
          const srcMoonId = tParams.source_moon ?? planetIdRaw;
          const srcMoon = srcMoonId
            ? (Object.values(state.planets ?? {}).find((p) => p.id === srcMoonId))
            : undefined;
          const cdSec = (srcMoon as { jumpgate_cooldown_sec?: number | null } | undefined)?.jumpgate_cooldown_sec;
          const harvestedAt = (srcMoon as { jumpgate_harvested_at?: number | null } | undefined)?.jumpgate_harvested_at;
          if (cdSec != null && harvestedAt != null) {
            const remaining = cdSec - Math.floor((now - harvestedAt) / 1000);
            slotEmpty = remaining <= 0;
          } else {
            // No cd recorded → can't tell; assume ready (planner re-checks).
            slotEmpty = true;
          }
        }
        const snapshotFresher = (state.last_update ?? 0) > (row.updated_at ?? 0);
        const isAtomic = goalType === "expedition" || goalType === "colonize" || goalType === "deploy" || goalType === "transport" || goalType === "species_discovery" || goalType === "jumpgate";
        const timeoutMs = isAtomic ? this.STUCK_TIMEOUT_MS_ATOMIC : this.STUCK_TIMEOUT_MS;
        // Anchor on dispatch time, not snapshot count. Fall back to
        // row.updated_at when dispatchedAt is missing (e.g. after server
        // restart while goal was already active).
        const dispatchTs = this.dispatchedAt.get(row.goal.id) ?? row.updated_at ?? 0;
        const sinceDispatch = now - dispatchTs;
        if (slotEmpty && snapshotFresher && sinceDispatch >= timeoutMs) {
          this.dispatchedAt.delete(row.goal.id);
          this.updateStatusAndMirror(row.goal.id, "pending", `stuck-recovery: empty slot ${Math.round(sinceDispatch / 1000)}s after dispatch, directive presumed lost`);
          // fall through — re-plan as pending below
        } else {
          // Still within timeout window OR slot busy → wait for ack.
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
      // v0.0.544 — state-staleness gate for fleet POST goals.
      const gType = row.goal.type;
      const isFleetPostType = gType === "expedition" || gType === "colonize"
        || gType === "deploy" || gType === "transport" || gType === "jumpgate";
      if (stateStale && isFleetPostType) {
        const reason = `state stale (${Math.round(stateAgeMs / 60000)}min) — fleet POST goals defer to fresh state`;
        if (row.status !== "blocked" || row.reason !== reason) {
          this.updateStatusAndMirror(row.goal.id, "blocked", reason);
        }
        blocked.push({ goal_id: row.goal.id, reason });
        if (typeof chainId === "string" && chainId) chainBlocked.add(chainId);
        continue;
      }
      const result = this.planGoal(row.goal, state);
      if (isBlocked(result)) {
        if (ALREADY_AT_TARGET_RE.test(result.blocked)) {
          this.updateStatusAndMirror(row.goal.id, "completed");
          skipped_terminal += 1;
        } else {
          this.updateStatusAndMirror(row.goal.id, "blocked", result.blocked);
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
          this.updateStatusAndMirror(row.goal.id, "blocked", reason);
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
          this.updateStatusAndMirror(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        if (planetId) slotSet.add(planetId);
      } else if (result.action === "lifeform_research") {
        // v0.0.633 — owner 2026-06-01 "等待前置任务完成". Gate dispatch
        // on per-planet lf research slot. Real prereq (e.g. another lf
        // research in progress) blocks; ogame 120012 retry storm avoided.
        if (planetId && lfResearchSlot.has(planetId)) {
          const reason = `lf research slot on ${planetId} busy (waiting for prereq)`;
          this.updateStatusAndMirror(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        if (planetId) lfResearchSlot.add(planetId);
      } else if (result.action === "build_ships" || result.action === "build_defense") {
        if (planetId && shipsSlot.has(planetId)) {
          const reason = `shipyard slot on ${planetId} in use this tick`;
          this.updateStatusAndMirror(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        if (planetId) shipsSlot.add(planetId);
      }
      this.updateStatusAndMirror(row.goal.id, "active");
      // v0.0.478: stamp dispatch time for time-anchored stuck-recovery and
      // in-flight dedup. Cleared by clearDispatched() in ack handler.
      this.dispatchedAt.set(row.goal.id, Date.now());
      this.send({ type: "directive.dispatch", directive: result });
      dispatched.push(result);
      // v0.0.506 forensic — log every dispatch so duplicate-fleet bugs are
      // traceable from journal. Operator 2026-05-30 实证 multiple 2-fleet
      // events on chain Seg 2 path; need to know if sidecar sent twice OR
      // userscript executed twice OR something else.
      try {
        const dParams = result.params as Record<string, unknown>;
        console.log(`[merger] DISPATCH goal=${row.goal.id} type=${row.goal.type} P=${row.goal.priority} action=${result.action} dirId=${result.id} planet_id=${dParams["planet_id"]} source_planet=${dParams["source_planet"]} target=${dParams["target_coords"]}(${dParams["target_type"]}) mission=${dParams["mission"]} ships=${JSON.stringify(dParams["ships"])} resources=${JSON.stringify(dParams["resources"])}`);
      } catch { /* */ }
      // v0.0.433: this leg is now active; downstream chain peers must wait.
      const cid = (row.goal.target as { chain_id?: unknown })?.chain_id;
      if (typeof cid === "string" && cid) chainBlocked.add(cid);
    }

    return { dispatched, blocked, skipped_terminal };
  }
}
