import type { HttpBridgeClient } from "./bridge/http_client.js";
import type { BridgeClient as WsBridgeClient } from "./bridge/ws_client.js";
import type { PriorityGate } from "./emergency/priority_gate.js";
import type { DirectiveExecutor } from "./directive_executor_iface.js";
import type { Directive } from "@ogamex/shared";

/**
 * M5.5 GoalRunner — userscript-side consumer of `directive.dispatch`.
 *
 * Receives directives from the plugin bridge, validates them, yields to the
 * emergency PriorityGate when active, and routes execution to the first
 * registered DirectiveExecutor whose `canHandle()` returns true. Every
 * dispatched directive produces exactly one `event.directive_completed` ack —
 * unless validation fails, in which case the directive is silently dropped
 * with a console.warn (the upstream scheduler will reissue if needed).
 */
export interface GoalRunnerDeps {
  client: HttpBridgeClient | WsBridgeClient;
  gate: PriorityGate;
  /** One or more executors; first whose `canHandle(directive)===true` wins. */
  executors: DirectiveExecutor[];
  /** Operator activity gate — when true, defer non-emergency directives so the
   *  cp= session-shift doesn't visibly bounce ogame UI under the operator's
   *  cursor. Re-queued for retry every 10s until busy clears or expires_at hit. */
  userBusy?: () => boolean;
}

export interface GoalRunnerHandle {
  stop(): void;
  /** Test/inspection accessor — internal pending queue size. */
  pendingCount(): number;
}

type AckResult =
  | { success: true; result: unknown }
  | { success: false; error: string };

const REQUIRED_FIELDS: readonly (keyof Directive)[] = [
  "id",
  "source",
  "method",
  "priority",
  "action",
  "params",
  "preconds",
  "expires_at",
  "reason",
];

function isValidDirective(d: unknown): d is Directive {
  if (!d || typeof d !== "object") { console.warn("[GoalRunner/validate] not object", d); return false; }
  const rec = d as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in rec)) { console.warn(`[GoalRunner/validate] missing field "${f}"`, rec); return false; }
  }
  if (typeof rec["id"] !== "string") { console.warn(`[GoalRunner/validate] id type=${typeof rec["id"]}`, rec); return false; }
  if (typeof rec["source"] !== "string") { console.warn(`[GoalRunner/validate] source type=${typeof rec["source"]} val=${String(rec["source"])}`, rec); return false; }
  if (typeof rec["method"] !== "string") { console.warn(`[GoalRunner/validate] method type=${typeof rec["method"]} val=${String(rec["method"])}`, rec); return false; }
  if (typeof rec["priority"] !== "number") { console.warn(`[GoalRunner/validate] priority type=${typeof rec["priority"]} val=${String(rec["priority"])}`, rec); return false; }
  if (typeof rec["action"] !== "string") { console.warn(`[GoalRunner/validate] action type=${typeof rec["action"]}`, rec); return false; }
  if (!rec["params"] || typeof rec["params"] !== "object") { console.warn(`[GoalRunner/validate] params type=${typeof rec["params"]}`, rec); return false; }
  if (!Array.isArray(rec["preconds"])) { console.warn(`[GoalRunner/validate] preconds not array, type=${typeof rec["preconds"]} val=${JSON.stringify(rec["preconds"])}`, rec); return false; }
  if (typeof rec["expires_at"] !== "number") { console.warn(`[GoalRunner/validate] expires_at type=${typeof rec["expires_at"]} val=${String(rec["expires_at"])}`, rec); return false; }
  if (typeof rec["reason"] !== "string") { console.warn(`[GoalRunner/validate] reason type=${typeof rec["reason"]} val=${String(rec["reason"])}`, rec); return false; }
  return true;
}

// v0.0.1021 — owner 2026-06-09 "网络克隆或者掉线了 请求回丢失吧": persistent
// ack queue in localStorage. ack 失败 (tab 关 / 网络掉线 / 浏览器崩) → 下次
// boot 自动 replay 至 sidecar 收到 (sidecar directiveToGoal 去重幂等). Cap 200
// 条 FIFO 防 localStorage 撑爆.
const ACK_QUEUE_KEY = "OGAMEX_ACK_PENDING_QUEUE";
const ACK_QUEUE_CAP = 200;

type PendingAckEntry = {
  directive_id: string;
  msg: { type: "event.directive_completed"; directive_id: string; result: unknown };
  queued_at: number;
};

function readAckQueue(): PendingAckEntry[] {
  try {
    const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
    const raw = ctxWin.localStorage?.getItem(ACK_QUEUE_KEY) ?? "";
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as PendingAckEntry[];
  } catch { return []; }
}

function writeAckQueue(q: PendingAckEntry[]): void {
  try {
    const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
    ctxWin.localStorage?.setItem(ACK_QUEUE_KEY, JSON.stringify(q));
  } catch { /* localStorage 满 / SecurityError 等吞掉 */ }
}

function persistPendingAck(directiveId: string, msg: { type: "event.directive_completed"; directive_id: string; result: unknown }): void {
  const q = readAckQueue();
  // 同 directive_id 替换 (重 dispatch 同 id 时刷新 payload)
  const filtered = q.filter((e) => e.directive_id !== directiveId);
  filtered.push({ directive_id: directiveId, msg, queued_at: Date.now() });
  // FIFO cap
  while (filtered.length > ACK_QUEUE_CAP) filtered.shift();
  writeAckQueue(filtered);
}

function clearPendingAck(directiveId: string): void {
  const q = readAckQueue();
  const filtered = q.filter((e) => e.directive_id !== directiveId);
  if (filtered.length === q.length) return;
  writeAckQueue(filtered);
}

async function sendAckHttp(directiveId: string, msg: { type: "event.directive_completed"; directive_id: string; result: unknown }): Promise<void> {
  try {
    const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
    const bridgeBase = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com";
    const tok = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
    const url = `${bridgeBase.replace(/\/$/, "")}/ogamex/v1/push`;
    const body = JSON.stringify(msg);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5_000);
      try {
        const res = await fetch(url, {
          method: "POST", credentials: "omit",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tok}` },
          body, signal: ac.signal,
        });
        if (res.ok) { clearPendingAck(directiveId); return; }
        if (res.status >= 400 && res.status < 500) {
          // 4xx — payload 永远 reject, 留 queue 也无意义
          console.warn(`[goal_runner/ack] POST HTTP ${res.status} — 4xx 不留 queue`);
          clearPendingAck(directiveId);
          return;
        }
        console.warn(`[goal_runner/ack] attempt=${attempt} HTTP ${res.status} — backoff before retry`);
      } catch (e) {
        const errName = (e as { name?: string }).name;
        console.warn(`[goal_runner/ack] attempt=${attempt} ${errName === "AbortError" ? "TIMEOUT" : "ERROR"}: ${(e as Error).message ?? e}`);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    // 3 次失败 — 留在 localStorage queue, 下次 boot/drain 接力 replay
    console.warn(`[goal_runner/ack] 3 attempts failed for ${directiveId} — staying in localStorage queue for replay`);
  } catch { /* */ }
}

/** v0.0.1021 — boot 时和 WS reconnect 时 drain pending acks (持久化的 replay 路径). */
export async function drainPendingAcks(): Promise<void> {
  const q = readAckQueue();
  if (q.length === 0) return;
  console.info(`[goal_runner/ack/drain] replaying ${q.length} pending acks from localStorage`);
  for (const e of q) {
    await sendAckHttp(e.directive_id, e.msg);
  }
}

export function startGoalRunner(deps: GoalRunnerDeps): GoalRunnerHandle {
  const { client, gate, executors, userBusy } = deps;

  const pending: Directive[] = [];
  let stopped = false;

  // v0.0.1021 — boot 时立即 drain 上次没送达的 ack
  void drainPendingAcks();

  // v0.0.673 — operator 2026-06-03 "等我恢复操作的时候才发出去": fleetdispatch
  // page defer used to wait INDEFINITELY for navigation away. Operator
  // could leave the tab on fleetdispatch page (foreground or background),
  // walk away, and directives queued for hours. Detect operator inactivity
  // — no click/keydown/focus events + tab hidden → drain anyway, the
  // token-race risk only exists when operator is actively interacting
  // with ogame's UI.
  const IDLE_THRESHOLD_MS = 30_000;
  let lastUserInteractionAt = Date.now();
  if (typeof window !== "undefined") {
    const markInteraction = (): void => { lastUserInteractionAt = Date.now(); };
    for (const evt of ["click", "keydown", "mousedown", "focus"] as const) {
      try { window.addEventListener(evt, markInteraction, { passive: true, capture: true }); }
      catch { /* */ }
    }
  }
  const isOperatorIdle = (): boolean => {
    if (typeof window === "undefined") return true;
    // Tab hidden = ogame UI definitely not under operator's cursor.
    const doc = window.document as Document | undefined;
    if (doc?.visibilityState === "hidden") return true;
    return Date.now() - lastUserInteractionAt > IDLE_THRESHOLD_MS;
  };

  function ack(directiveId: string, result: AckResult): void {
    if (stopped) return;
    const msg = {
      type: "event.directive_completed" as const,
      directive_id: directiveId,
      result,
    };
    // v0.0.1021 — owner 2026-06-09 "网络克隆或者掉线了 请求回丢失吧，前端和
    // 后端做池连接做好持久化，保证100%通讯无误":
    // 1. 写 localStorage queue (persistent, 抗 tab 关 / 浏览器崩 / 网络掉线)
    // 2. fire WS + HTTP 双路 (现状)
    // 3. 任一路返回 ok → 删 localStorage entry
    // 4. boot 时 drainPendingAcks() 把上次没送达的 replay
    // sidecar 端 directiveToGoal idempotency check 已经能去重 (index.ts:2370).
    try { persistPendingAck(directiveId, msg); } catch { /* */ }
    client.send(msg);
    void sendAckHttp(directiveId, msg);
  }

  async function run(directive: Directive): Promise<void> {
    if (stopped) return;
    // Expiry check: directive's deadline may have passed while it sat in the
    // queue (or arrived already-stale from sidecar). Ack expired without
    // running the executor — saves wasted ogame POSTs.
    if (typeof directive.expires_at === "number" && Date.now() > directive.expires_at) {
      ack(directive.id, { success: false, error: "expired" });
      return;
    }
    let chosen: DirectiveExecutor | null = null;
    for (const ex of executors) {
      let handles = false;
      try {
        handles = ex.canHandle(directive);
      } catch (e) {
        // Defensive: a misbehaving executor shouldn't crash the runner.
        // eslint-disable-next-line no-console
        console.warn("[GoalRunner] executor.canHandle threw", e);
        handles = false;
      }
      if (handles) {
        chosen = ex;
        break;
      }
    }
    if (!chosen) {
      // eslint-disable-next-line no-console
      console.warn(`[GoalRunner] no executor for action=${directive.action}`);
      ack(directive.id, {
        success: false,
        error: `no executor for action ${directive.action}`,
      });
      return;
    }
    // v0.0.822 — operator 2026-06-06 "不要做任何兜底, 直接针对解决核心问题".
    // 删除整段 `on fleetdispatch page` defer 路径 (历史 v0.0.640/673 累加的
    // 复杂 same-cp/operator-idle 判定). 真因: defer 不 ack 是 ACK 链路 0
    // event 死循环根源. 现在 directive 永远 execute → 必 ack (success / error
    // / transient slot full). token race 风险由 click_intercept (boot.ts)
    // + cp-protected fetch (safe_fetch.ts) 自己 cover, defer 兜底无意义.
    // eslint-disable-next-line no-console
    console.log(`[GoalRunner] executing ${directive.action} via ${chosen.constructor.name}`);
    // Operator 2026-05-28 "cp 的點選保護機制能不能一起保護 token":
    // Mark this directive as a background op so click_lock (boot.ts) delays
    // operator clicks until the entire executor finishes — not just its
    // cp= sub-fetches. ApiExec's multi-stage chain (token fetch +
    // fleetSelectionAjax + checkTarget + sendFleet) rotates the global
    // token; click_lock only seeing cp= fetches would briefly think we're
    // idle between stages and let operator clicks slip through.
    let releaseOp: (() => void) | null = null;
    try {
      const { trackBackgroundOp } = await import("./api/safe_fetch.js");
      releaseOp = trackBackgroundOp();
    } catch { /* */ }
    try {
      const result = await chosen.execute(directive);
      // eslint-disable-next-line no-console
      console.log(`[GoalRunner] execute OK`, result);
      ack(directive.id, { success: true, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.warn(`[GoalRunner] execute FAILED for ${directive.action}:`, msg);
      ack(directive.id, { success: false, error: msg });
    } finally {
      if (releaseOp) releaseOp();
    }
  }

  function handleDispatch(directive: Directive): void {
    if (Date.now() > directive.expires_at) {
      ack(directive.id, { success: false, error: "expired" });
      return;
    }
    if (gate.isActive()) {
      pending.push(directive);
      return;
    }
    // Fire and forget — errors are caught inside run().
    void run(directive);
  }

  // Serialize directive execution + dedupe recent ids. Without this,
  // sidecar's per-tick dispatch (3 directives at once for research +
  // build + build_ships) triggers 3 parallel navigates → reload storm.
  // Dedupe window matches the push interval so the SAME directive id
  // arriving on consecutive ticks doesn't re-execute.
  // Dedupe by EXACT id only — the merger generates a fresh id per tick,
  // so signature dedupe (action+params) blocked legitimate retries after
  // resources arrived. Id dedupe is essentially a no-op for fresh ids
  // but protects against accidental same-id replay within the WS layer.
  const RECENT_IDS_TTL_MS = 5_000;
  const recentIds = new Map<string, number>(); // id → expiresAt
  // 2026-05-27 v0.0.361 anti-flood: backend re-pushes same (action, planet)
  // every ~1s while waiting for ack. With per-id dedup only, every dispatch
  // grew execQueue. Add action+planet de-dup with 60s window — if a directive
  // with same (action, source_planet) was seen recently, drop and ack so
  // backend stops re-issuing.
  const RECENT_ACTION_PLANET_TTL_MS = 60_000;
  const recentActionPlanet = new Map<string, number>();  // "action:planet" → expiresAt
  let executing = false;
  const execQueue: Directive[] = [];
  // userBusy defer: single shared poll timer + queue, NOT per-directive setTimeout
  const deferredQueue: Directive[] = [];
  let pollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDeferLogAt = 0;
  const schedulePollIdle = (): void => {
    if (pollIdleTimer || stopped) return;
    pollIdleTimer = setTimeout(() => {
      pollIdleTimer = null;
      if (stopped) return;
      // v0.0.673 — drain when EITHER operator left fleetdispatch OR
      // operator went inactive (no input 30s+ / tab hidden). The page-
      // only check used to block indefinitely whenever the tab idled
      // on fleetdispatch.
      const onFleetDispatchPage = typeof window !== "undefined" && window.location?.search?.includes("component=fleetdispatch");
      if (onFleetDispatchPage && !isOperatorIdle()) {
        schedulePollIdle();
        return;
      }
      // Idle (or off the page) — drain deferredQueue into execQueue
      // (preserving FIFO), pumpQueue serializes execution.
      while (deferredQueue.length > 0) execQueue.push(deferredQueue.shift()!);
      void pumpQueue();
    }, 5_000);
  };
  // Action+planet dedup helper.
  // 2026-05-27 v0.0.366 finer-grained for discover: include target coord so
  // backend's "掃整個 system 15 個 position" 不被 60s 一刀切. expedition /
  // colonize / deploy / transport 仍按 action+planet (per-planet 節流合理).
  const actionPlanetKey = (d: Directive): string => {
    const params = d.params as { planet_id?: string; source_planet?: string; galaxy?: number; system?: number; position?: number } | undefined;
    const planet = params?.planet_id ?? params?.source_planet ?? "";
    if (d.action === "discover") {
      const g = params?.galaxy ?? 0;
      const s = params?.system ?? 0;
      const p = params?.position ?? 0;
      return `discover:${g}:${s}:${p}`;  // per-coord, not per-planet
    }
    return `${d.action}:${planet}`;
  };
  const gcActionPlanet = (): void => {
    const now = Date.now();
    for (const [k, exp] of recentActionPlanet) if (exp < now) recentActionPlanet.delete(k);
  };
  const gcRecent = (): void => {
    const now = Date.now();
    for (const [id, exp] of recentIds) if (exp < now) recentIds.delete(id);
  };
  async function pumpQueue(): Promise<void> {
    if (executing) return;
    while (execQueue.length > 0) {
      const d = execQueue.shift()!;
      executing = true;
      try {
        await run(d);
      } finally {
        executing = false;
      }
    }
  }

  const unsubDispatch = client.on("directive.dispatch", (msg) => {
    if (stopped) return;
    const d: unknown = msg.directive;
    // v0.0.629 — operator 2026-06-01 "lifeform_research ... 不動".
    // Entry log BEFORE validation so we can verify WS delivery regardless
    // of directive shape. Diagnose: console-empty = sidecar didn't dispatch
    // or WS dropped; entry log present but no "received" = validator
    // rejected; both present but no [ApiExec] = canHandle / executor gap.
    const dRec = d as { id?: unknown; action?: unknown; goal_id?: unknown } | null;
    console.log(`[GoalRunner/dispatch-in] action=${String(dRec?.action ?? "?")} id=${String(dRec?.id ?? "?").slice(0,8)} goal=${String(dRec?.goal_id ?? "?").slice(0,8)}`);
    if (!isValidDirective(d)) {
      console.warn("[GoalRunner] dropped invalid directive", d);
      return;
    }
    const dr = d as Directive;
    gcRecent();
    gcActionPlanet();
    if (recentIds.has(dr.id)) {
      return;
    }
    const apKey = actionPlanetKey(dr);
    if (recentActionPlanet.has(apKey)) {
      // 2026-05-27 ack as SUCCESS (was fail) — backend was marking the goal
      // cancelled on every dup, killing recurring goals. Treat as "no-op
      // completed" so backend keeps the goal alive for next legitimate tick.
      ack(dr.id, { success: true, result: { action: dr.action, clicked: false, skipped: "duplicate" } });
      return;
    }
    // 2026-05-27 v0.0.363 early-skip discover for cooldown/unavailable coord —
    // operator: "cooldown 的星球不要處理不要進隊列，直接跳過". Saves GoalRunner
    // serial slot (~2-3s) + Apiexec preflight time per skipped coord.
    if (dr.action === "discover") {
      const p = dr.params as { galaxy?: number; system?: number; position?: number } | undefined;
      const g = p?.galaxy ?? 0, s = p?.system ?? 0, pos = p?.position ?? 0;
      if (g > 0 && s > 0 && pos > 0) {
        const lookup = (window as Window & { __ogamexCheckDiscoverCooldown?: (g: number, s: number, p: number) => string }).__ogamexCheckDiscoverCooldown;
        const state = lookup ? lookup(g, s, pos) : "unknown";
        if (state === "cooldown" || state === "unavailable") {
          // Operator 2026-05-27: ack as SUCCESS so backend marks this coord
          // done (not retry-able). 7-day cooldown — coord won't change soon.
          ack(dr.id, { success: true, result: { action: "discover", clicked: false, skipped: state } });
          return;
        }
      }
    }
    // 2026-05-27 v0.0.364 early-skip slot-exhausted fleet POSTs:
    //   expedition → uses expedition slot
    //   colonize / deploy / transport / discover → uses fleet slot (keep-1-empty)
    // operator 同族 review: 任何 fleet POST action 都該 slot-gate.
    {
      const srv = (window as Window & { __ogamexStore?: { state: { server?: {
        used_expedition_slots?: number; max_expedition_slots?: number;
        used_fleet_slots?: number; max_fleet_slots?: number;
      } } } }).__ogamexStore?.state.server;
      if (dr.action === "expedition") {
        const usedExp = srv?.used_expedition_slots ?? -1;
        const maxExp = srv?.max_expedition_slots ?? -1;
        if (usedExp >= 0 && maxExp > 0 && usedExp >= maxExp) {
          ack(dr.id, { success: false, error: `expedition slots full ${usedExp}/${maxExp} (early skip, not queued)` });
          return;
        }
        // Operator 2026-05-28: expedition takes the last fleet slot too —
        // emergency FS still works via FSM bypass. Gate trips only at
        // usedFleet >= max (truly no slots), not max-1.
        const usedF1 = srv?.used_fleet_slots ?? -1;
        const maxF1 = srv?.max_fleet_slots ?? -1;
        if (usedF1 >= 0 && maxF1 > 0 && usedF1 >= maxF1) {
          ack(dr.id, { success: false, error: `expedition: fleet slots full ${usedF1}/${maxF1} (early skip, not queued)` });
          return;
        }
      } else if (dr.action === "colonize" || dr.action === "deploy" || dr.action === "transport") {
        const usedF = srv?.used_fleet_slots ?? -1;
        const maxF = srv?.max_fleet_slots ?? -1;
        // Operator 2026-05-29: transport chains (action=transport OR chain-bound
        // deploy leg) bypass keep-1-empty — operator intentionally initiated
        // the chain, accepts last-slot use; emergency FS recall stays safe via
        // FSM bypass that doesn't traverse this gate. Standalone colonize and
        // standalone deploy (no chain_id) still reserve 1 slot for FS recall.
        const params = dr.params as { chain_id?: string } | undefined;
        const isChainBound = typeof params?.chain_id === "string" && params.chain_id !== "";
        // v0.0.841 — operator 2026-06-06 "新号殖民任务卡最后了, 殖民飞船没有飞":
        // 新号 max_fleet_slots=1, 老逻辑 colonize 走 keep-1-empty → slotCeiling=0,
        // 0/1 永远 block. colonize 是 atomic 单次飞, 落地新 planet 没 fleet 不需要
        // FS recall slot 兜底, 加入 bypassKeepEmpty 跟 transport / chain-deploy 同
        // 等级. 同样保护 emergency FS — FSM 走自己路径不经此 gate.
        const bypassKeepEmpty = dr.action === "transport" || (dr.action === "deploy" && isChainBound) || dr.action === "colonize";
        const slotCeiling = bypassKeepEmpty ? maxF : maxF - 1;
        if (usedF >= 0 && maxF > 0 && usedF >= slotCeiling) {
          const label = bypassKeepEmpty ? "all slots used" : "keep-1-empty";
          ack(dr.id, { success: false, error: `fleet slots full ${usedF}/${maxF} ${label} (early skip, not queued)` });
          return;
        }
      }
    }
    recentIds.set(dr.id, Date.now() + RECENT_IDS_TTL_MS);
    // discover ttl 5s only (just WS retry guard) — coord goes into 7-day
    // ogame cooldown on success, can't legitimately re-fire within 60s.
    // Other actions keep 60s throttle.
    const ttl = dr.action === "discover" ? 5_000 : RECENT_ACTION_PLANET_TTL_MS;
    recentActionPlanet.set(apKey, Date.now() + ttl);
    console.log(`[GoalRunner] received ${dr.action} ${JSON.stringify(dr.params).slice(0,80)} id=${dr.id.slice(0,8)}`);
    if (gate.isActive()) {
      pending.push(dr);
      return;
    }
    execQueue.push(dr);
    void pumpQueue();
  });

  const unsubGate = gate.onChange((active) => {
    if (stopped) return;
    if (active) return;
    // Gate transitioned to inactive — drain pending queue (oldest first).
    // We splice into a local list so re-entrant pushes during the drain
    // (e.g. gate flipping again mid-drain) end up in the new `pending`.
    const drained = pending.splice(0, pending.length);
    for (const d of drained) {
      // Re-check expiry at drain time; emergency may have lasted long enough
      // for the directive to expire while it sat in the queue.
      if (Date.now() > d.expires_at) {
        ack(d.id, { success: false, error: "expired" });
        continue;
      }
      // If the gate flipped back on mid-drain, push remaining items back.
      if (gate.isActive()) {
        pending.push(d);
        continue;
      }
      void run(d);
    }
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubDispatch();
      unsubGate();
      pending.length = 0;
    },
    pendingCount(): number {
      return pending.length;
    },
  };
}
