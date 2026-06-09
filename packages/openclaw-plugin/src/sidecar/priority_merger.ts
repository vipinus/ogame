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
import type { GoalRow, GoalStatus } from "./goals_types.js";
import type { IGoalsStoreReader } from "./goals_store_iface.js";
import { tenantRegistry } from "./tenant_context.js";
import { getCurrentUserId } from "./user_context.js";

export interface PriorityMergerDeps {
  // Phase 7c.5.f — store: GoalsStore retired. reader (PG) is the sole read
  // surface, writer (PG) the sole write surface. Boot dispatch with no uid
  // → no-op (handled in dispatch()).
  planGoal: (goal: Goal, state: WorldState, activeRows?: readonly GoalRow[]) => Directive | { blocked: string };
  /** Send a DownstreamMsg via the bridge (WsServer.send or HttpServer.queueDownstream). */
  send: (msg: DownstreamMsg) => void;
  /** Phase 5c — fired AFTER every store.updateStatus mutation so the PG
   *  shadow writer can mirror merger-driven status transitions (the 11
   *  call sites previously SQLite-only, surfaced as drift in Phase 5b).
   *  Receives the POST-update row so the mirror can do INSERT-or-UPDATE
   *  (upsertGoal) — converges even when the goal never existed in PG
   *  (e.g. created via a path that pre-dated Phase 0 shadowFire wiring). */
  onStatusChange?: (row: GoalRow, userId: string | undefined) => void;
  /** Phase 6a — optional async reader. When supplied, dispatch() reads
   *  active goals from this surface instead of `store.listActive*` sync
   *  SQLite. Writes (updateStatus) still go through `store` for now
   *  (Phase 6b removes the dual-write). Mode is env-controlled (sqlite/
   *  dual/pg via OGAMEX_DB_MODE); env flip is the rollback button. */
  reader?: IGoalsStoreReader;
  /** Phase 7c.2 (2026-06-05) — async PG writer. When supplied AND the
   *  current dispatch has an ALS uid, updateStatusAndMirror writes
   *  directly to PG via this surface, bypassing SQLite entirely. The
   *  SQLite path is preserved as fallback only when writer is undefined
   *  OR the merger ran outside an ALS frame (e.g. legacy single-tenant
   *  bootstrap). Eliminates the "unknown goal id" throw observed for
   *  PG-only goals created via web POST → PG (no SQLite row). */
  writer?: IGoalsStoreWriter;
}

export interface IGoalsStoreWriter {
  updateGoalStatus(
    userId: string,
    id: string,
    status: GoalStatus,
    reason: string | null,
  ): Promise<void>;
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
// v0.0.934 — owner 2026-06-07 "我知道修过了, 恢复一下就可以了" + 同类病灶扫
// 到 4+ 条 nano/crystal/solar/fusion 假完成. 真因: "already upgrading in
// ogame queue" 表示**正在建**, 不是**建完了** — 自动 complete 是错语义。
// 移除该 pattern; 队列在建时 planner 仍 return blocked, 但不再被 merger
// 错当 terminal. 待 ogame 真完成 + state.snapshot 反映 → 自然走 "already at
// or above target" 路径正常完成。
const ALREADY_AT_TARGET_RE =
  /already at or above target|in flight|production started|goal complete|no-op: source body/i;

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
  // Phase 7c.5.f — store removed (SQLite GoalsStore retired).
  private readonly planGoal: (goal: Goal, state: WorldState, activeRows?: readonly GoalRow[]) => Directive | { blocked: string };
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
  // v0.0.827 — operator 2026-06-06 "4-leg chain leg 1 双发". dispatch() 是
  // fire-and-forget (index.ts:654 triggerDispatch + WS snapshot handler +
  // status change), 同 uid 多 caller 并发. await updateStatusAndMirror yield
  // control 后第二个 caller 还看到 row.status='pending' (PG read lag) → 同
  // goal 同秒 emit 2 directive → 真双 fleet. Per-uid reentrancy guard: 同 uid
  // 进行中的 dispatch tick 时第二个 call 立即 skip; 漏掉的工作 next snapshot
  // / trigger 自然补上.
  private readonly inFlightUids = new Set<string>();
  // v0.0.577 — operator 2026-06-01 "选C": stuck-recovery 60s race-free
  // safety net. Happy path ack ≈ 1s (event-driven), 60s tolerates internal
  // transient retry + slow ogame response without false-positive re-dispatch.
  // True failures (Chrome crash / sidecar restart / long-poll 断) unstuck
  // automatically after 60s — no operator manual intervention needed.
  // v0.0.668 — operator 2026-06-02 "全部30": stuck-recovery 收紧至 30s 跨所有
  // goal 类型。原 60s 是按 sendFleet 最慢 round-trip 估的；实测 ack 通常
  // <10s，30s 给 3x 安全 margin，让 chain pipeline 卡死后更快 self-heal。
  // 安全网仍在：planner 重发前 re-check slot/cooldown/库存，不会 double-fire。
  // v0.0.834 — operator 2026-06-06 retry 审计: stuck-recovery 30s 比 backoff
  // 60s 短被 race, 双向都升 60s 跟齐, 减少噪声.
  private readonly STUCK_TIMEOUT_MS = 60_000;
  private readonly STUCK_TIMEOUT_MS_ATOMIC = 60_000;

  private readonly onStatusChange: ((row: GoalRow, userId: string | undefined) => void) | undefined;
  private readonly reader: IGoalsStoreReader | undefined;
  private readonly writer: IGoalsStoreWriter | undefined;
  /** Set at start of dispatch(), threaded through to onStatusChange so
   *  the PG mirror knows which tenant the status mutation belongs to. */
  private currentDispatchUid: string | undefined = undefined;
  /** Phase 7 transition (2026-06-05) — pinned during each per-row loop iter
   *  so updateStatusAndMirror can synthesize an updated row when the goal
   *  is PG-only (created via web POST to /api/me/goals/transport → PG only,
   *  SQLite has no record). Without this, SQLite's "unknown goal id" throw
   *  rolls back the whole tick. */
  private currentRow: GoalRow | undefined = undefined;
  /** Phase 7c.2 — cached at dispatch() top from reader.list / store.list so
   *  the per-row chain-prereq gate (line ~445) doesn't re-read SQLite
   *  cross-tenant per goal. The old this.store.list() was blind to PG-only
   *  rows; this cache fixes the cross-tick chain prereq for webtx-* legs. */
  private allRowsForChain: GoalRow[] = [];
  /** v0.0.765 — global pause kill-switch hook. Injected by setupSidecar so
   *  the merger can short-circuit when ogamex.global.paused=true. */
  public isGlobalPausedFn?: (userId?: string) => boolean;
  // v0.0.794 — operator 2026-06-05 "可以安装 但是要暂停". Free user 装 + 看
  // 都 OK, 但没 active subscription 时 priorityMerger 不真派 directive. 这是
  // freemium 隔离层 — 不动 install/auth, 只 gate dispatch.
  public isSubscriptionPausedFn?: (userId?: string) => boolean;

  constructor(deps: PriorityMergerDeps) {
    // Phase 7c.5.f — no this.store assignment.
    this.planGoal = deps.planGoal;
    this.send = deps.send;
    this.onStatusChange = deps.onStatusChange;
    this.reader = deps.reader;
    this.writer = deps.writer;
  }

  /** v0.0.670 — Phase 5c: helper that mirrors every status mutation to
   *  the PG shadow writer via the onStatusChange callback. Without this
   *  hook the 11 merger-driven updateStatus call sites would stay
   *  SQLite-only (drift observed in Phase 5b: sqlite=13 pg=9). */
  private async updateStatusAndMirror(goalId: string, status: GoalStatus, reason?: string): Promise<void> {
    // Phase 7c.2 — PG primary write path. When writer + ALS uid present,
    // skip SQLite entirely. Eliminates the "unknown goal id" throw for
    // PG-only goals AND removes the drift surface from dual-write era.
    const uid = this.currentDispatchUid;
    if (this.writer && uid) {
      try {
        await this.writer.updateGoalStatus(uid, goalId, status, reason ?? null);
      } catch (e) {
        // PG write failure is real (network/SQL error). Bubble up so the
        // dispatch loop's outer try/catch logs it — don't silently mask.
        throw e;
      }
      // Synthesize updated for any onStatusChange observers (memory writer,
      // legacy mirror). currentRow is pinned per-iter so this matches the
      // goal we just wrote.
      if (this.onStatusChange && this.currentRow && this.currentRow.goal.id === goalId) {
        // v0.0.907 — owner 2026-06-07 "没做完的任务又被删除了". 实证 6 个 build
        // goal 误标 completed reason="planet not found". 真因: L197 PG UPDATE
        // 写 status+reason=null 后, 这里合成 row 用 ...this.currentRow spread,
        // currentRow.reason 是上 tick 的 stale ("planet not found"), reason=
        // undefined 时旧逻辑保留 stale → onStatusChange→upsertGoal 反 ON CONFLICT
        // DO UPDATE 用合成 row 把 reason 还原成 "planet not found". 与 L197 的
        // null 不一致. 修法 — reason 字段显式落地 (undefined → null), 跟 PG 写
        // 一致, 不再保留 stale.
        const updated: GoalRow = {
          ...this.currentRow,
          status,
          reason: (reason ?? null) as string,
          updated_at: Date.now(),
        };
        try { this.onStatusChange(updated, uid); }
        catch (e) { console.warn("[merger] onStatusChange threw (swallowed)", e); }
      }
      return;
    }
    // Phase 7c.5.f — SQLite legacy fallback retired. When writer + uid
    // absent we have no place to persist (PG is the only store). Synthesize
    // updated from currentRow for any onStatusChange observers, but the
    // status change is in-memory only this iter — operator-driven CRUD
    // endpoints (with their own PG paths) handle persistent state.
    let updated: GoalRow | null | undefined;
    if (this.currentRow && this.currentRow.goal.id === goalId) {
      updated = {
        ...this.currentRow,
        status,
        ...(reason !== undefined ? { reason } : {}),
        updated_at: Date.now(),
      };
    }
    if (updated && this.onStatusChange) {
      try {
        this.onStatusChange(updated, this.currentDispatchUid);
      } catch (e) {
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
    // v0.0.765 — operator 2026-06-04 "前后端都加一个暂停恢复按钮 用于暂停
    // 所有 TM 动作". Master kill-switch: 当 PG section_settings 的
    // 'ogamex.global.paused' 为 "true" 时, dispatch 全部跳过.
    // Hook 在 setupSidecar 里通过 isGlobalPaused() callback 注入.
    if (this.isGlobalPausedFn && this.isGlobalPausedFn(userId)) {
      return { dispatched: [], blocked: [], skipped_terminal: 0 };
    }
    // v0.0.794 — subscription gate. 没 active sub → 整 tick 跳过 dispatch.
    // global pause 是 owner 手动 toggle, 这条是 freemium 自动 throttle.
    if (this.isSubscriptionPausedFn && this.isSubscriptionPausedFn(userId)) {
      return { dispatched: [], blocked: [], skipped_terminal: 0 };
    }
    // v0.0.827 — per-uid reentrancy guard (see inFlightUids comment above).
    const uidKey = userId ?? "__no_uid__";
    if (this.inFlightUids.has(uidKey)) {
      return { dispatched: [], blocked: [], skipped_terminal: 0 };
    }
    this.inFlightUids.add(uidKey);
    try {
      return await this._dispatchImpl(state, userId);
    } finally {
      this.inFlightUids.delete(uidKey);
    }
  }

  private async _dispatchImpl(state: WorldState, userId?: string): Promise<DispatchResult> {
    // v0.0.669 — Phase 5b: dispatch made async so a future swap of
    // this.store to IGoalsStoreReader (PG/async) requires no further
    // refactor of the merger loop. `await` on the current sync GoalsStore
    // returns immediately (identity for non-Promise values).
    // v0.0.670 — Phase 5c: thread userId through so the mirror callback
    // knows the tenant. updateStatusAndMirror reads this each call.
    this.currentDispatchUid = userId;
    // v0.0.671 — Phase 6a: when `reader` is supplied (env OGAMEX_DB_MODE=
    // pg|dual), pull active rows from the async reader (PG or wrapper).
    // Falls back to SQLite-direct read when reader is absent (mode=
    // sqlite — pre-Phase-6 behaviour, safe rollback).
    //
    // listActive() (cross-tenant) is intentionally NOT supplied by
    // IGoalsStoreReader — PG path scans by tenant. When userId is
    // missing AND reader is present, we still use the sync SQLite path
    // (legacy single-tenant fallback). Multi-tenant push always carries
    // an ALS-resolved userId so the async reader is hit normally.
    let rows: GoalRow[];
    // Phase 7c.2 — cached cross-tick full list for chain prereq gate
    // (line ~445). Old code called this.store.list() per-row inside the
    // loop, which read SQLite cross-tenant — PG-only legs were invisible.
    // Fetch once at top from the same source (reader when PG, store else).
    let allRowsForChain: GoalRow[] = [];
    // Phase 7c.5.f — reader (PG) required. SQLite fallback retired.
    // No reader OR no uid → no-op dispatch (boot stage / unauthenticated).
    if (this.reader && typeof userId === "string" && userId) {
      rows = [...(await this.reader.listActiveByUser(userId))];
      allRowsForChain = [...(await this.reader.list(userId))];
    } else {
      return { dispatched: [], blocked: [], skipped_terminal: 0 };
    }
    rows = rows.sort(compareRows);
    this.allRowsForChain = allRowsForChain;

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
      // Pin row for updateStatusAndMirror's PG-only fallback. Cleared at
      // end of this iter so the synthesizer never accidentally uses a
      // stale row id from a previous loop.
      this.currentRow = row;
      // Operator-paused row: skip entirely. Status / reason untouched.
      if (row.status === "blocked" && typeof row.reason === "string" && row.reason.startsWith("PAUSED")) {
        continue;
      }
      // Chain prereq gate.
      // v0.0.819 — operator 2026-06-05 "链式等待?". v0.0.817 已 disable cross
      // tick chain prereq gate (line 422+), per-tick chainBlocked 这条 (line
      // 404) 跟 dispatch 后 chainBlocked.add (line 756) 没改 → 各 leg 同
      // tick 仍互锁. 全 disable.
      const chainId = (row.goal.target as { chain_id?: unknown })?.chain_id;
      const CHAIN_GATE_ENABLED = false; // v0.0.819 disabled
      if (CHAIN_GATE_ENABLED && typeof chainId === "string" && chainId && chainBlocked.has(chainId)) {
        const reason = "chain prereq: waiting for prior leg";
        if (row.status !== "blocked" || row.reason !== reason) {
          await this.updateStatusAndMirror(row.goal.id, "blocked", reason);
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
      // v0.0.817 — operator 2026-06-05 "把链式任务依赖关系解除 变成多个单独
      // 的任务". 整个 chain prereq gate (chain ship-sync gate, SEG3 supersede,
      // chain-Blocked propagation) 全部 disable. 各 transport/jumpgate/deploy
      // goal 独立 plan + dispatch, 让 planner.planDeployGoal 自己 preflight
      // check ships (现有 logic), ogame 真值决定能不能飞. chain_id 字段保留
      // 仅 panel UI grouping, 不再作为 sidecar 调度依赖.
      const CHAIN_DEPS_DISABLED = true;
      if (!CHAIN_DEPS_DISABLED && typeof chainId === "string" && chainId) {
        // Phase 7c.2 — use dispatch-tick cached list (reader.list when PG)
        // so PG-only chain siblings (web POST → PG only) are visible to
        // the chain prereq gate.
        const allRows = this.allRowsForChain;
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
        // v0.0.814 — operator 2026-06-05 "leg0 第一步没飞 没有运输". 两件:
        // 1) ship-sync gate (v0.0.664) 之前不分 upstream 状态, 修 only check
        //    in-flight upstream (status active). completed = ships delivered,
        //    cancelled = 作废, 都不该等.
        // 2) 链顶 supersede: genFerry 模板同时建直送 (phase=to_target_direct)
        //    + 中转 (to_stop_load/hop/unload). 直送 completed 时整 chain 达成,
        //    中转链 应自动 cancel (ships 已 delivered, ferry 失去意义).
        const upstreamActive = upstream.filter((u) => u.status !== "completed" && u.status !== "cancelled");
        // v0.0.816 — operator 2026-06-05 实证 chain template (genFerry, shared/
        // transport_planner.ts) 分 3 segments:
        //   SEG1 (P=12) ferry_to_res_*: empty ferry → resource pickup (optional)
        //   SEG2 (P=9)  to_target_direct OR to_target_load/hop/unload: delivery
        //   SEG3 (P=6)  to_stop_load/hop/unload: empty ferry → stopover (optional cleanup)
        // SEG2 direct completed = delivery 已送达, SEG3 cleanup 不强制 (跟
        // delivery target_coords 设计上就不同, 是 post-delivery 空船 回 stopover).
        // v0.0.815 target_coords 比对反向锁死 SEG3 永远不 supersede → owner
        // panel 看 ferry SEG3 永久 blocked. 修: 任何 SEG2 final leg
        // (direct OR to_target_unload) 完成 → 整 chain delivery 完, 自动 cancel
        // SEG3 (to_stop_*) cleanup, owner 不再看到无意义 blocked.
        const myPhase = (row.goal.target as { chain_phase?: string })?.chain_phase ?? "";
        if (/^to_stop_(load|hop|unload)$/.test(myPhase)) {
          const seg2Done = allRows.find((r) => {
            if ((r.goal.target as { chain_id?: unknown })?.chain_id !== chainId) return false;
            const ph = (r.goal.target as { chain_phase?: string })?.chain_phase ?? "";
            if (!/^to_target_(direct|unload)$/.test(ph)) return false;
            return r.status === "completed";
          });
          if (seg2Done) {
            await this.updateStatusAndMirror(row.goal.id, "cancelled", `chain superseded: SEG2 delivery ${seg2Done.goal.id.slice(0, 12)} completed, SEG3 cleanup obsolete`);
            continue;
          }
        }
        if (!upstreamReason && upstreamActive.length > 0) {
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
            await this.updateStatusAndMirror(row.goal.id, "blocked", upstreamReason);
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
          const targetParams = row.goal.target as { source_planet?: string; target_coords?: string };
          const srcId = targetParams.source_planet ?? (typeof row.goal.planet === "string" ? row.goal.planet : "");
          const srcPlanet = srcId
            ? (Object.values(state.planets ?? {}).find((p) => p.id === srcId)
               ?? Object.values(state.planets ?? {}).find((p) => Array.isArray(p.coords) && p.coords.join(":") === srcId))
            : undefined;
          const srcCoordStr = Array.isArray(srcPlanet?.coords) ? srcPlanet.coords.join(":") : "";
          const srcTypeStr = (srcPlanet as { type?: string } | undefined)?.type ?? "planet";
          const tgtCoordStr = typeof targetParams.target_coords === "string" ? targetParams.target_coords : "";
          const tgtTypeStr = ((row.goal.target as { target_type?: string }).target_type ?? "planet").toLowerCase();
          // v0.0.942 — owner 2026-06-07 实证: 手动 deploy 33650372 planet→33652263 moon
          // 跟 chain leg 2 dispatch 撞 coord+mission, 老 verifier 把 leg 2 false-completed.
          // 加 (a) origin_type/dest_type match (同 v0.0.941 planner.ts 修法)
          //    (b) ship payload subset match — owner 手动 fleet 跟 chain dispatch payload 必差
          // take_all 模式 goal.target.ships 是空(planner.ts 在 dispatch 时才 sweep),
          // expectedShipKeys 空 → 跳过 ship-match, 只靠 type+coord+dispatchedAt 守门.
          const expectedShipKeys: Array<[string, number]> = [];
          const goalShips = (row.goal.target as { ships?: unknown }).ships;
          if (goalShips && typeof goalShips === "object" && !Array.isArray(goalShips)) {
            for (const [k, v] of Object.entries(goalShips as Record<string, unknown>)) {
              if (typeof v === "number" && v > 0) expectedShipKeys.push([k, v]);
            }
          }
          const normFleetType = (t: unknown): string => {
            if (typeof t === "string") return t.toLowerCase();
            if (t === 1) return "planet";
            if (t === 2) return "debris";
            if (t === 3) return "moon";
            return "";
          };
          const myOutbound = (state.fleets_outbound ?? []).filter((f) => {
            if (f.mission !== expectedMission) return false;
            const orig = Array.isArray(f.origin) ? f.origin.join(":") : "";
            if (orig !== srcCoordStr) return false;
            if (tgtCoordStr) {
              const dst = Array.isArray(f.dest) ? f.dest.join(":") : "";
              if (dst !== tgtCoordStr) return false;
            }
            // v0.0.942 — type-aware: 防 same-coord 跨 type 误撞 (planet↔moon 同坐标)
            if (srcTypeStr && normFleetType((f as { origin_type?: unknown }).origin_type) !== srcTypeStr) return false;
            if (tgtTypeStr && normFleetType((f as { dest_type?: unknown }).dest_type) !== tgtTypeStr) return false;
            // v0.0.942 — ship subset: owner 手动 fleet 跟 chain payload 必有 count 差
            // f.ships 空 (recall fleet 等) → 当 0, 不可能 >= expected → 不匹配, 拦掉
            const fShips = (f.ships ?? {}) as Record<string, number>;
            for (const [name, want] of expectedShipKeys) {
              if ((fShips[name] ?? 0) < want) return false;
            }
            return true;
          });
          // v0.0.828 — operator 2026-06-06 "Leg 1 起飞成功以后就标记完成".
          // 用 outbound fleet 兜底 ack 防 503/HTML lost-ack 重派.
          // v0.0.925 — owner 2026-06-07 "回航 LEG 4 又没了": dispatchedAt.has 闸
          // 拦 owner 手工 fleet (无 sidecar dispatch 历史).
          // v0.0.942 — owner 手动 fleet 同源同终同 mission 同 type 同 ship payload
          // 撞型概率极低; type+payload 双重 match 兜住 leg 2 false-complete.
          if (myOutbound.length > 0 && this.dispatchedAt.has(row.goal.id)) {
            await this.updateStatusAndMirror(row.goal.id, "completed", `fleet airborne mission=${expectedMission} ${srcCoordStr}→${tgtCoordStr || "?"} (outbound matched, sidecar-dispatched)`);
            this.dispatchedAt.delete(row.goal.id);
            skipped_terminal += 1;
            continue;
          }
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
          await this.updateStatusAndMirror(row.goal.id, "pending", `stuck-recovery: empty slot ${Math.round(sinceDispatch / 1000)}s after dispatch, directive presumed lost`);
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
          await this.updateStatusAndMirror(row.goal.id, "blocked", reason);
        }
        blocked.push({ goal_id: row.goal.id, reason });
        if (typeof chainId === "string" && chainId) chainBlocked.add(chainId);
        continue;
      }
      // v0.0.938 — owner "不要维护三个决策引擎": 把 active rows 一并传进
      // planner, planner 的 picker 路径就读 optimizer 派的 opt-* 当真理.
      const result = this.planGoal(row.goal, state, this.allRowsForChain);
      if (isBlocked(result)) {
        // v0.0.1017 — owner 2026-06-09 "3 已经部署成功了，为什么还显示没有部署" +
        // "不是手动完成的". 实证 depl-mq6rmib0 dispatched 14:59:43, ogame
        // arrival 15:00:30 (fleet 0 cargo), 但 planner 在 15:00:45 重 eval
        // 看 src 月球 0 LC → blocked. dispatchedAt 已清, outbound match 已扫过
        // 没 fire. 真态是 fleet airborne / arrived 已经 dispatched 完成.
        //
        // 修: planner blocked + 该 goal 是 atomic fleet type → 扫 outbound 找
        // 匹配 fleet (src/dst coord+type + mission). 找到 = 已 dispatched 完成,
        // 直接 mark completed 而不是 blocked.
        const atomicFleetTypes = new Set(["expedition","colonize","deploy","transport","jumpgate","species_discovery"]);
        if (atomicFleetTypes.has(row.goal.type)) {
          const tParams2 = row.goal.target as { source_planet?: string; target_coords?: string; target_type?: string };
          const missionMap2: Record<string, number> = { expedition:15, colonize:7, deploy:4, transport:3 };
          const expectMission2 = missionMap2[row.goal.type] ?? -1;
          if (expectMission2 > 0) {
            const srcId2 = tParams2.source_planet ?? (typeof row.goal.planet === "string" ? row.goal.planet : "");
            const srcPlanet2 = srcId2 ? (Object.values(state.planets ?? {}).find((p) => p.id === srcId2)
              ?? Object.values(state.planets ?? {}).find((p) => Array.isArray(p.coords) && p.coords.join(":") === srcId2)) : undefined;
            const srcCoord2 = Array.isArray(srcPlanet2?.coords) ? srcPlanet2.coords.join(":") : "";
            const srcType2 = (srcPlanet2 as { type?: string } | undefined)?.type ?? "planet";
            const tgtCoord2 = typeof tParams2.target_coords === "string" ? tParams2.target_coords : "";
            const tgtType2 = (tParams2.target_type ?? "planet").toLowerCase();
            const normT = (t: unknown): string => { if (typeof t === "string") return t.toLowerCase(); if (t === 1) return "planet"; if (t === 2) return "debris"; if (t === 3) return "moon"; return ""; };
            const airborne = (state.fleets_outbound ?? []).find((f) => {
              if (f.mission !== expectMission2) return false;
              if (!Array.isArray(f.origin) || f.origin.join(":") !== srcCoord2) return false;
              if (tgtCoord2 && (!Array.isArray(f.dest) || f.dest.join(":") !== tgtCoord2)) return false;
              if (srcType2 && normT((f as { origin_type?: unknown }).origin_type) !== srcType2) return false;
              if (tgtType2 && normT((f as { dest_type?: unknown }).dest_type) !== tgtType2) return false;
              return true;
            });
            if (airborne) {
              console.info(`[merger/auto-complete-airborne] ${row.goal.id} fleet ${(airborne as {id?:string}).id ?? "?"} airborne mission=${expectMission2} ${srcCoord2}→${tgtCoord2} (planner blocked but ogame fleet flying) → completed`);
              await this.updateStatusAndMirror(row.goal.id, "completed", `fleet airborne: planner blocked (${result.blocked}) but ogame fleet matched outbound`);
              this.dispatchedAt.delete(row.goal.id);
              skipped_terminal += 1;
              continue;
            }
          }
        }
        // v0.0.805 — operator 2026-06-05 "跳跃成功了 还卡在这里 是自动跳完
        // 刷新不到结果". planner 返 auto_complete 标记 (e.g. JG self-detect
        // target_moon has expected ships) → priorityMerger mark completed,
        // 不再 blocked. 覆盖 sidecar 自动跳完 但 ack/state 未同步 卡死场景.
        if ((result as { auto_complete?: boolean }).auto_complete === true) {
          await this.updateStatusAndMirror(row.goal.id, "completed");
          skipped_terminal += 1;
          continue;
        }
        if (ALREADY_AT_TARGET_RE.test(result.blocked)) {
          // v0.0.985 → v0.0.995 — owner 2026-06-09 "root 任务完成就标记完成,
          // 任务名称和等级": v0.0.985 一刀切撤 auto-complete 防 snapshot 漂,
          // 现在 owner 直接给出收口规则: 只对 is_main_goal=true 重启 auto-complete,
          // 三道 evidence gate:
          //   (1) goal.target.building/research 命中具体字段
          //   (2) state level >= target level (任务名称和等级双匹配)
          //   (3) build_q / research.queue 不在建该 tech (排除 in-flight 误判)
          // child opt-*/exp-*/expb-* 等仍按 v0.0.985 保持 blocked (snapshot 漂值
          // 误完成的最大风险面). v0.0.985 33674107 case 是 child opt-deut 在漂值,
          // 不是 main goal → 这次新规不复发.
          const goalRef = row.goal;
          const tgt = goalRef.target as { building?: string; research?: string; level?: number } | undefined;
          const tgtLvl = typeof tgt?.level === "number" ? tgt.level : 0;
          const planetId = goalRef.planet;
          const planet = planetId ? (state.planets as Record<string, unknown> | undefined)?.[planetId] : null;
          // v0.0.995b — owner 实证: 33653036 deutSynth 33/33 是 buil-* 用户建的
          // 但 is_main_goal=false. 放宽 gate: buil-* / rsch-* / life-* / lifeb-* 都
          // 算 root user goal (owner 显式创建, 不是 opt-* 后台 emit), 允许 auto-complete.
          // opt-*/exp-*/expb-*/colo-*/disc-* 等仍保持 blocked (v0.0.985 漂值风险面).
          const isRootUserGoal = goalRef.id.startsWith("buil-") ||
            goalRef.id.startsWith("rsch-") || goalRef.id.startsWith("life-") ||
            goalRef.id.startsWith("lifeb-") || goalRef.is_main_goal === true;
          let isMainTerminalComplete = false;
          if (isRootUserGoal && tgt && tgtLvl > 0) {
            if (tgt.building && planet) {
              const cur = (planet as { buildings?: Record<string, number> }).buildings?.[tgt.building] ?? 0;
              const bq = (planet as { build_q?: { item?: { building?: string } } | null }).build_q;
              const inFlight = bq?.item?.building === tgt.building;
              if (cur >= tgtLvl && !inFlight) isMainTerminalComplete = true;
            } else if (tgt.research) {
              const cur = (state.research as unknown as Record<string, number> | undefined)?.[tgt.research] ?? 0;
              const rq = (state.research as unknown as { queue?: { item?: { research?: string } } | null } | undefined)?.queue;
              const inFlight = rq?.item?.research === tgt.research;
              if (cur >= tgtLvl && !inFlight) isMainTerminalComplete = true;
            }
          }
          if (isMainTerminalComplete) {
            const tgtLabel = tgt?.building ?? tgt?.research ?? "?";
            console.info(`[merger/auto-complete] root goal ${row.goal.id} ${tgtLabel} L${tgtLvl} met @planet=${planetId} (build_q clean, snapshot fresh)`);
            await this.updateStatusAndMirror(row.goal.id, "completed", result.blocked);
            skipped_terminal += 1;
            continue;
          }
          await this.updateStatusAndMirror(row.goal.id, "blocked", result.blocked);
          blocked.push({ goal_id: row.goal.id, reason: result.blocked });
          if (typeof chainId === "string" && chainId) chainBlocked.add(chainId);
          continue;
        } else {
          // Different blocked reason → clear any prior "already at" sighting
          const uidClear = getCurrentUserId() ?? "";
          const tenantClear = tenantRegistry.get(uidClear);
          if (tenantClear.alreadyAtTargetSince.has(row.goal.id)) {
            tenantClear.alreadyAtTargetSince.delete(row.goal.id);
          }
          // fall through to existing reason-normalization block
          // v0.0.838 — operator 2026-06-06 "是状态在不停切换? 还有同样的问题".
          // 真因: 老逻辑每 tick 无条件写 status=blocked, reason 含倒计时数字
          // (waiting 463s for resources) 每秒掉 → PG 写 → panel 看到 status 反复
          // pending↔blocked → 颜色 toggle. 修: (1) reason 规范化去掉倒计时数字
          // 比对实质变化才写 (2) "waiting resources" 类 reason 不强制 status=
          // blocked — 保持 pending 让 panel 走稳定 active 颜色, planner 仍 continue
          // skip 本 tick dispatch.
          const reasonRaw = result.blocked;
          // 去掉 "waiting Ns" / "waiting Xs" / "短缺 X" 等动态数字, 抽象出 reason 主干
          const reasonKey = reasonRaw
            .replace(/waiting\s+\d+s?/gi, "waiting Ns")
            .replace(/short\s*\(m=\d+\s*c=\d+\s*d=\d+\s*short\)/gi, "short (m=N c=N d=N short)")
            .replace(/\(~\d+s?\)/g, "(~Ns)")
            .replace(/\d+s\s+remaining/gi, "Ns remaining");
          const prevReason = row.reason ?? "";
          const prevKey = prevReason
            .replace(/waiting\s+\d+s?/gi, "waiting Ns")
            .replace(/short\s*\(m=\d+\s*c=\d+\s*d=\d+\s*short\)/gi, "short (m=N c=N d=N short)")
            .replace(/\(~\d+s?\)/g, "(~Ns)")
            .replace(/\d+s\s+remaining/gi, "Ns remaining");
          const reasonStable = reasonKey === prevKey;
          // shortage countdown 类不该把 pending/active 翻 blocked, planner 仍 wait
          const isShortageWait = /waiting\s+\d+s?\s+for\s+resources|waiting\s+resources/i.test(reasonRaw);
          if (isShortageWait && (row.status === "pending" || row.status === "active") && reasonStable) {
            // 保持原 status, 不写
          } else if (row.status !== "blocked" || !reasonStable) {
            await this.updateStatusAndMirror(row.goal.id, "blocked", reasonRaw);
          }
          blocked.push({ goal_id: row.goal.id, reason: reasonRaw });
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
          await this.updateStatusAndMirror(row.goal.id, "blocked", reason);
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
          await this.updateStatusAndMirror(row.goal.id, "blocked", reason);
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
          await this.updateStatusAndMirror(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        if (planetId) lfResearchSlot.add(planetId);
      } else if (result.action === "build_ships" || result.action === "build_defense") {
        if (planetId && shipsSlot.has(planetId)) {
          const reason = `shipyard slot on ${planetId} in use this tick`;
          await this.updateStatusAndMirror(row.goal.id, "blocked", reason);
          blocked.push({ goal_id: row.goal.id, reason });
          continue;
        }
        if (planetId) shipsSlot.add(planetId);
      }
      await this.updateStatusAndMirror(row.goal.id, "active");
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
        // v0.0.1008 — stamp recent dispatch ts so planner 30s cooldown fires.
        // Only for build actions (mine/facility), not fleet/research.
        if (result.action === "build") {
          const pid = String(dParams["planet_id"] ?? "");
          const bld = String((dParams["target"] as { building?: unknown } | undefined)?.building ?? dParams["building"] ?? "");
          if (pid && bld) {
            const uidDispatch = getCurrentUserId() ?? "";
            tenantRegistry.get(uidDispatch).recentBuildDispatchAt.set(`${pid}:${bld}`, Date.now());
          }
        }
      } catch { /* */ }
      // v0.0.433: this leg is now active; downstream chain peers must wait.
      // v0.0.819 — operator "解除链式依赖" disable chainBlocked.add 也.
      const cid = (row.goal.target as { chain_id?: unknown })?.chain_id;
      void cid; // keep for future re-enable
      // if (typeof cid === "string" && cid) chainBlocked.add(cid);
    }

    return { dispatched, blocked, skipped_terminal };
  }
}
