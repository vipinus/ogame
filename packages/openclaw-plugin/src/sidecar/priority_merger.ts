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
  // Per-goal dispatch rate limit. Without this, a 500ms merger tick combined
  // with a goal that keeps planning the same directive (e.g., resource
  // shortfall returns the same crystalMine each plan call) results in
  // hundreds of `dir-<uuid>` per minute — GoalRunner queue overflow + ApiExec
  // POST spam against ogame. Each goal can dispatch at most 1 directive
  // every COOLDOWN_MS to ogame.
  private readonly lastDispatchTs = new Map<string, number>();
  private readonly DISPATCH_COOLDOWN_MS = 10_000;
  // v0.0.432 stuck-active recovery threshold (90s). Operator 2026-05-29:
  // "能不能一次拉通" — when WS message drops or executor crashes silently,
  // goal sits at active forever. Re-emit on timeout so chain progresses.
  private readonly STUCK_ACTIVE_MS = 90_000;

  constructor(deps: PriorityMergerDeps) {
    this.store = deps.store;
    this.planGoal = deps.planGoal;
    this.send = deps.send;
  }

  /** Reset per-goal cooldown — invoked on client reconnect. */
  resetCooldown(): void {
    this.lastDispatchTs.clear();
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

    for (const row of rows) {
      // Operator-paused row: skip entirely. Status / reason untouched.
      if (row.status === "blocked" && typeof row.reason === "string" && row.reason.startsWith("PAUSED")) {
        continue;
      }
      // v0.0.432: stuck-active recovery — if a row sits at "active" without
      // ack > STUCK_ACTIVE_MS, assume WS-lost or executor crash, downgrade
      // to pending so next merger tick re-dispatches. updated_at is the
      // last status-change timestamp; if it predates the cutoff, recover.
      if (row.status === "active" && now - (row.updated_at ?? row.created_at) > this.STUCK_ACTIVE_MS) {
        this.store.updateStatus(row.goal.id, "pending", "stuck-active recovery");
        this.lastDispatchTs.delete(row.goal.id);
        // Fall through — pick up as pending this same tick.
      }
      // Per-goal cooldown — see lastDispatchTs comment for rationale.
      const lastTs = this.lastDispatchTs.get(row.goal.id) ?? 0;
      if (now - lastTs < this.DISPATCH_COOLDOWN_MS) {
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
      this.lastDispatchTs.set(row.goal.id, now);
      dispatched.push(result);
    }

    return { dispatched, blocked, skipped_terminal };
  }
}
