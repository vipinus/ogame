/**
 * safe_fetch — 唯一 cp= fetch 入口.
 *
 * 頂層邏輯: ogame `/game/index.php?...&cp=PID` 在服務端立刻切 session-cp,
 * UI 頂欄跟着跳. 即使 try/finally restoreSessionCp 也是 ~500ms 可見跳躍.
 * Operator 2026-05-27 反復中招 "操作時被自動切到其他月球".
 *
 * 架構 enforcement (operator: "架構層缺乏 enforcement"):
 * - 所有帶 cp= 的 fetch **必須** 透過 fetchWithCp / fetchWithCpBypassBusy
 * - 嚴禁直接 fetch 拼 `&cp=` 字面 (CI grep gate, see scripts/check-no-raw-cp.sh)
 *
 * 行爲:
 * - userBusy (store.server.user_busy_until > now) 時 throw BusyDeferredError
 *   除非 bypassBusy=true (僅限 emergency.* FS save 路徑)
 * - try { fetch } finally { fetchEventBox cp=operatorCp } 把 session-cp 切回
 *   operator 當前 planet (避免 UI 頂欄長期停留在 fetch 目標 planet/moon)
 * - operatorCp 取自 meta[name=ogame-planet-id], 即 ogame 自己暴露的"當前頁"
 */

import type { StateStore } from "../state_store.js";

let _store: StateStore | null = null;
let _winRef: Window | null = null;
let _docRef: Document | null = null;

export interface SafeFetchDeps {
  store: StateStore;
  win: Window;
  doc: Document;
}

export function initSafeFetch(deps: SafeFetchDeps): void {
  _store = deps.store;
  _winRef = deps.win;
  _docRef = deps.doc;
  // v0.0.871 — seed ownerCurrentCp from meta on boot.
  try {
    const v = deps.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    if (v) _ownerCurrentCp = v;
  } catch { /* */ }
}

/* ─────────────────────────────────────────────────────────────────────────
 * v0.0.871 — Owner's intended planet (authoritative source of truth).
 *
 * Owner directive 2026-06-06: "点击星球或者月球的时候保存当前星球或者月球的cp，
 * 其他点击的时候先保存当前cp 先恢复当前星球的cp 然后发送点击，然后再恢复cp".
 *
 * Why: meta[name=ogame-planet-id] reflects whatever cp= was set last, including
 * our background fetches. It's NOT a reliable view of owner's intent. By
 * explicitly tracking owner's planet/moon clicks, we get a stable signal
 * separate from session-cp transient state.
 *
 * Writers:
 *   - initSafeFetch (boot): seed from current meta
 *   - setOwnerCurrentCp (boot.ts click-intercept): on planet/moon link click
 *   - MutationObserver on meta (optional, future)
 *
 * Readers:
 *   - boot.ts clickInterceptSync: align session-cp before non-planet click
 *   - safe_fetch's restore phase could optionally prefer this over meta read
 *     (kept on meta for now to preserve existing restore semantics; the
 *      align-before-click new path is owner's explicit ask).
 * ───────────────────────────────────────────────────────────────────── */
let _ownerCurrentCp: string | null = null;
export function getOwnerCurrentCp(): string | null { return _ownerCurrentCp; }
export function setOwnerCurrentCp(cp: string): void {
  if (!cp) return;
  if (_ownerCurrentCp === cp) return;
  _ownerCurrentCp = cp;
  if (_winRef) {
    (_winRef as Window & { __ogamexOwnerCp?: string }).__ogamexOwnerCp = cp;
  }
}

/** Thrown when fetchWithCp() is called while operator is interacting with ogame.
 *  Caller should choose: re-queue / drop / treat as transient. */
export class BusyDeferredError extends Error {
  readonly deferred = true as const;
  constructor() {
    super("operator busy — cp= fetch deferred to avoid UI bounce");
    this.name = "BusyDeferredError";
  }
}

// Operator 2026-05-28: cp lock state — tracks every in-flight cp= fetch
// + its restore-to-operator-cp phase. click_lock (boot.ts) awaits this so
// operator clicks can be delayed until session-cp is back to operatorCp,
// preventing ogame UI race when background dispatch is mid-flight.
const inFlightCpFetches = new Set<Promise<unknown>>();

function mirrorInFlightCount(): void {
  if (!_winRef) return;
  (_winRef as Window & { __ogamexCpInFlight?: number }).__ogamexCpInFlight = inFlightCpFetches.size;
}

/** How many cp= fetches are currently in flight (including their restore phase). */
export function cpInFlightCount(): number {
  return inFlightCpFetches.size;
}

/** Operator 2026-05-28 "cp 的點選保護機制能不能一起保護 token": general-
 *  purpose background-op tracker. Use for ogame ajax that ROTATES THE
 *  GLOBAL TOKEN but doesn't itself carry cp= (e.g. recallFleet — raw POST
 *  to /movement). click_lock awaits inFlightCpFetches → so caller pushes
 *  a placeholder promise here for the entire duration of their op, and
 *  releases it when done. The placeholder counts toward window.__ogamex
 *  CpInFlight just like a real cp= fetch. */
export function trackBackgroundOp(): () => void {
  let resolve!: () => void;
  const p = new Promise<void>((res) => { resolve = res; });
  inFlightCpFetches.add(p);
  mirrorInFlightCount();
  return () => {
    inFlightCpFetches.delete(p);
    mirrorInFlightCount();
    resolve();
  };
}

/** Resolve once all in-flight cp= fetches finish AND session-cp is restored
 *  to operatorCp. Returns immediately when no fetch is in flight. */
export async function awaitCpIdle(): Promise<void> {
  if (inFlightCpFetches.size === 0) return;
  await Promise.allSettled([...inFlightCpFetches]);
  // A new fetch may have started; loop once more (bounded to avoid spin).
  for (let i = 0; i < 4 && inFlightCpFetches.size > 0; i++) {
    await Promise.allSettled([...inFlightCpFetches]);
  }
}

function userBusyNow(): boolean {
  // Operator 2026-05-28: "取消 userbusy 機制". Click intercept (boot.ts
  // v0.0.386 clickInterceptSync) replaces the userBusy gate as the operator-
  // protection layer. No more fetch deferral based on mousedown activity —
  // background cp= fetches always proceed, and operator clicks are awaited
  // via cp lock when a fetch is in flight.
  return false;
}

function currentOperatorCp(): string | null {
  if (!_docRef) return null;
  return _docRef.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? null;
}

export interface FetchWithCpOpts {
  /** Skip the v0.0.870 owner-busy defer gate AND the legacy userBusy check.
   *  RESERVED for emergency.* FS save chain, sendFleet retry path, jumpgate
   *  executeJump, and any callsite where deferral would corrupt timing-sensitive
   *  semantics. Background pollers / refreshers MUST NOT set this. */
  bypassBusy?: boolean;
  /** Skip the post-fetch session-cp restore. Use when you know operatorCp===sourcePID
   *  (no shift happened) or caller will do its own restore. */
  skipRestore?: boolean;
  /** v0.0.578 — fetch timeout in ms. Defaults to 30000 (30s). Set 0/Infinity
   *  to disable (rare; only useful for explicitly long-running ops). Hitting
   *  the timeout aborts the fetch and throws — caller's retry loop handles. */
  timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/* ─────────────────────────────────────────────────────────────────────────
 * v0.0.870 — defer-before owner-busy gate.
 *
 * Owner 2026-06-06: "感觉这个逻辑设计的不好 有更好的保护cp的方法吗？".
 *
 * Old architecture (v0.0.386-v0.0.869) was REACTIVE: every background cp=
 * fetch fired immediately, then `clickInterceptSync` in boot.ts captured
 * owner clicks during the in-flight window, awaited cp-idle, and replayed.
 * Symptoms: owner click → "Syncing…" toast → 1-4s latency → click replays.
 *
 * New architecture is PREVENTIVE:
 *   1. Defer-before gate: if owner mousedown/keydown < 5s ago AND the fetch
 *      isn't emergency, queue it until idle. No more clicks-during-fetch.
 *   2. Piggyback fast-path: if cp= target matches current session-cp, the
 *      cp= URL param is a no-op — skip the restore phase entirely. The
 *      in-flight window shrinks from "fetch + restore (~500-2000ms)" to
 *      "fetch (~200ms)".
 *   3. clickInterceptSync stays as fallback for the < 5s residual race
 *      window between gate-pass and fetch-start, and for emergency callsites
 *      (bypassBusy=true) which can't defer.
 *
 * Idle-threshold: 5s matches the boot.ts skipIfActive helper (now deleted,
 * since this gate centralizes the behavior across ALL cp= callsites, not
 * just refreshOnePage).
 * ───────────────────────────────────────────────────────────────────── */
const OWNER_IDLE_THRESHOLD_MS = 5_000;
const DEFER_POLL_MS = 250;
const DEFER_QUEUE_CAP = 50;
const DEFER_DRAIN_GAP_MS = 50;
const STATS_LOG_INTERVAL_MS = 5 * 60 * 1000;

interface DeferredResolver {
  resolve: () => void;
  reject: (e: Error) => void;
  enqueuedAt: number;
}
const deferredQueue: DeferredResolver[] = [];
let deferDrainTimer: ReturnType<typeof setInterval> | null = null;

function ownerLastActivityMs(): number {
  const g = globalThis as { __ogamexLastUserActivity?: number };
  return g.__ogamexLastUserActivity ?? 0;
}

function ownerIdleMs(): number {
  const last = ownerLastActivityMs();
  if (!last) return Number.POSITIVE_INFINITY; // no activity yet → treat as fully idle
  return Date.now() - last;
}

function ownerBusyNow(): boolean {
  return ownerIdleMs() < OWNER_IDLE_THRESHOLD_MS;
}

function startDrainTimerIfNeeded(): void {
  if (deferDrainTimer) return;
  deferDrainTimer = setInterval(() => {
    if (deferredQueue.length === 0) {
      if (deferDrainTimer) { clearInterval(deferDrainTimer); deferDrainTimer = null; }
      return;
    }
    if (ownerBusyNow()) return;
    // Idle — drain one at a time with a small gap to avoid burst.
    const head = deferredQueue.shift();
    if (head) head.resolve();
    if (deferredQueue.length > 0) {
      // Schedule next drain after a brief gap (re-uses the same interval loop;
      // the gap is implicit via DEFER_POLL_MS, but we additionally sleep
      // DEFER_DRAIN_GAP_MS via setTimeout to avoid hammering ogame when
      // multiple deferred fetches are queued).
      setTimeout(() => {
        if (deferredQueue.length > 0 && !ownerBusyNow()) {
          const next = deferredQueue.shift();
          if (next) next.resolve();
        }
      }, DEFER_DRAIN_GAP_MS);
    }
  }, DEFER_POLL_MS);
  // Don't keep Node-like event loop alive (no-op in browser, defensive for tests).
  const t = deferDrainTimer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

async function deferUntilIdle(label: string): Promise<void> {
  // Queue-full eviction: oldest gets rejected; caller's catch falls through.
  if (deferredQueue.length >= DEFER_QUEUE_CAP) {
    const oldest = deferredQueue.shift();
    if (oldest) {
      console.warn(`[safe_fetch/defer] queue full (${DEFER_QUEUE_CAP}) — evicting oldest, proceeding ${label} without defer`);
      oldest.reject(new Error("deferred queue full"));
    }
  }
  return new Promise<void>((resolve, reject) => {
    deferredQueue.push({ resolve, reject, enqueuedAt: Date.now() });
    startDrainTimerIfNeeded();
  });
}

// v0.0.870 visibility counters — owner can read via window.__ogamexCpStats.
interface CpStats {
  fired: number;        // total fetchWithCp invocations that reached the network
  deferred: number;     // invocations that went through the defer queue
  piggybacked: number;  // invocations that skipped restore via piggyback
  restored: number;     // invocations that ran the restore phase
}
const cpStats: CpStats = { fired: 0, deferred: 0, piggybacked: 0, restored: 0 };
function mirrorCpStats(): void {
  if (!_winRef) return;
  (_winRef as Window & { __ogamexCpStats?: CpStats }).__ogamexCpStats = cpStats;
}

// Periodic summary log so owner can grep journalctl / DevTools to verify the
// new architecture is firing (deferred > 0 proves the gate works).
let _statsTimerStarted = false;
function ensureStatsTimer(): void {
  if (_statsTimerStarted) return;
  _statsTimerStarted = true;
  const t = setInterval(() => {
    if (cpStats.fired === 0) return; // nothing to report yet
    console.info(`[safe_fetch/stats] fired=${cpStats.fired} deferred=${cpStats.deferred} piggybacked=${cpStats.piggybacked} restored=${cpStats.restored}`);
  }, STATS_LOG_INTERVAL_MS);
  const u = t as unknown as { unref?: () => void };
  if (typeof u.unref === "function") u.unref();
}

/**
 * Fetch wrapper with AbortController-driven timeout. Happy path: 0 overhead
 * (clearTimeout cancels the abort scheduling on success). Failure path: throws
 * AbortError after timeoutMs, letting caller retry loop kick in.
 *
 * Operator 2026-06-01 "全 api 操作透過返回值執行後續, 爲什麼要等待": fetch
 * without timeout was the silent killer — ogame hang → fetch promise pending
 * forever → cpFetchChain mutex locked forever → all subsequent cp= ops dead.
 * Adding timeout makes "hang" indistinguishable from "fail" — both go through
 * caller's retry → ack-failed → auto-recovery.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!_winRef) throw new Error("[safe_fetch] not initialized");
  if (!timeoutMs || timeoutMs === Infinity) {
    return _winRef.fetch(url, init);
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Merge caller signal if any.
    const callerSignal = (init as { signal?: AbortSignal }).signal;
    if (callerSignal) {
      if (callerSignal.aborted) ac.abort();
      else callerSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    return await _winRef.fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * The ONLY way userscript should issue a cp= fetch.
 *
 * @param baseUrl Path WITHOUT cp= param (we append). Ex: "/game/index.php?page=ajax&component=jumpgate&overlay=1&ajax=1"
 * @param init Standard fetch init.
 * @param sourcePID The planet/moon id the fetch is operating on. Will become &cp=<sourcePID>.
 * @throws BusyDeferredError when userBusy() && !opts.bypassBusy.
 */
export async function fetchWithCp(
  baseUrl: string,
  init: RequestInit,
  sourcePID: string | number,
  opts: FetchWithCpOpts = {},
): Promise<Response> {
  if (!_winRef) {
    throw new Error("[safe_fetch] not initialized — call initSafeFetch() at boot");
  }
  ensureStatsTimer();
  if (!opts.bypassBusy && userBusyNow()) {
    throw new BusyDeferredError();
  }
  // v0.0.870 — defer-before owner-busy gate. If owner mousedown/keydown
  // happened within OWNER_IDLE_THRESHOLD_MS, queue this fetch instead of
  // firing immediately. Eliminates the reactive intercept→toast→replay loop
  // for the bulk of background pollers (build_q refresh, fetchResources,
  // empire polls, etc). Emergency callsites (bypassBusy=true) bypass this
  // gate — they cannot defer (FS save, sendFleet retry, JG executeJump).
  if (!opts.bypassBusy && ownerBusyNow()) {
    cpStats.deferred += 1;
    mirrorCpStats();
    try {
      await deferUntilIdle(baseUrl.slice(0, 60));
    } catch (e) {
      // Queue-full eviction or programmatic reject — log and proceed without
      // deferral so caller doesn't lose work. The fetch still goes through
      // acquireCpSlot below; click-intercept fallback covers race window.
      console.warn(`[safe_fetch/defer] proceeding without defer for ${baseUrl.slice(0, 60)}:`, (e as Error).message ?? e);
    }
  }
  // v0.0.461: register THIS fetch as in-flight BEFORE acquiring the cp slot.
  // Operator 2026-05-29 "我點選的時候正好去建造也能攔住嗎?" — without
  // pre-mutex registration, two queued cp= fetches (A running, B awaiting
  // mutex) create a microsecond gap mirror=0 between A's release and B's
  // start. A click in that gap slipped through. Registering up front means
  // mirror reflects pending+running total — click intercept sees nonzero
  // for the ENTIRE pending+running lifetime of every cp= fetch.
  let resolveLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => { resolveLock = resolve; });
  inFlightCpFetches.add(lockPromise);
  mirrorInFlightCount();
  // v0.0.456: acquire global cp slot BEFORE capturing operatorCp — mirror of
  // sendFleet's acquireSendFleetSlot. Forces strict serialization of all cp=
  // fetches so session-cp can't race between concurrent dispatchers (build A
  // and build B for different planets used to interleave → operator UI bouncing).
  const releaseSlot = await acquireCpSlot();
  const operatorCp = currentOperatorCp();
  const sourceStr = String(sourcePID);
  // v0.0.870 piggyback fast-path — if target sourcePID matches the current
  // session-cp, the cp= URL param is a no-op for session state. Skipping the
  // restore phase shrinks the in-flight window from ~500-2000ms to ~200ms.
  // Edge: owner switching planets MID-fetch flips meta[ogame-planet-id] —
  // we evaluate at fetch START, which is correct: if owner switched during,
  // their new view is whatever they chose, so restoring the OLD value would
  // fight them. Skipping restore is the safe behavior either way.
  const isPiggyback = operatorCp !== null && operatorCp === sourceStr;
  cpStats.fired += 1;
  mirrorCpStats();
  const sep = baseUrl.includes("?") ? "&" : "?";
  const fullUrl = `${baseUrl}${sep}cp=${encodeURIComponent(sourceStr)}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  try {
    return await fetchWithTimeout(fullUrl, init, timeoutMs);
  } finally {
    try {
      if (isPiggyback) {
        cpStats.piggybacked += 1;
        mirrorCpStats();
      }
      if (!isPiggyback && !opts.skipRestore && operatorCp && operatorCp !== sourceStr) {
        cpStats.restored += 1;
        mirrorCpStats();
        // v0.0.457: switched restore endpoint from eventList → overview ajax.
        // Evidence (operator 2026-05-29 morning DevTools probe): fetchEventBox
        // cp=moon does NOT actually switch server session-cp — server fell
        // back to operator's main planet. eventList is a body-agnostic feed;
        // overview is the canonical body-aware ajax (same URL ogame's own
        // sidebar moonlink/planetlink resolves to with ajax=1). Also capture
        // newAjaxToken from response — fire-and-forget was leaking token
        // rotations to global ogame state without our tokenManager learning
        // about them (operator: "沒有恢復cp和token").
        // v0.0.580 — restore retry × 3 with 250/500/1000ms backoff.
        // v0.0.869 — operator 2026-06-06 "ogame 网页发船经常卡住" 实测真因:
        // clickInterceptSync 在 __ogamexCpInFlight > 0 整段都拦 owner click +
        // replay; restore 老阈值 3 attempts × 10s timeout = 最坏 30s+ owner 卡死.
        // restore 是 GET overview ajax 实际 <500ms 就成, 10s 严重过保守.
        // 降到 2 attempts × 2s timeout + 250ms backoff → 最坏 4.25s, 仍保留
        // 1 次 retry 兜底 flaky network. 失败率 (single-fail-rate)² 通常 <1%.
        const restoreUrl = `/game/index.php?page=componentOnly&component=overview&ajax=1&cp=${encodeURIComponent(operatorCp)}`;
        let restoreOk = false;
        const RESTORE_TIMEOUT_MS = 2_000;
        const RESTORE_MAX_ATTEMPTS = 2;
        for (let attempt = 1; attempt <= RESTORE_MAX_ATTEMPTS; attempt++) {
          try {
            const restoreRes = await fetchWithTimeout(restoreUrl, {
              credentials: "same-origin",
              headers: { "X-Requested-With": "XMLHttpRequest" },
            }, RESTORE_TIMEOUT_MS);
            if (restoreRes.ok) {
              // Surface restore-side newAjaxToken on documentElement.dataset so
              // tokenManager.refresh() (which reads dataset.ogamexToken) picks it
              // up on next read. fire-and-forget body parse — must not throw.
              try {
                const text = await restoreRes.text();
                const m = text.match(/["']newAjaxToken["']\s*:\s*["']([a-zA-Z0-9_-]+)["']/);
                if (m && _docRef) {
                  (_docRef.documentElement as HTMLElement).dataset["ogamexToken"] = m[1]!;
                }
              } catch (_) { /* token capture is best-effort */ }
              restoreOk = true;
              break;
            }
            console.warn(`[safe_fetch/restore] attempt=${attempt} HTTP ${restoreRes.status} — backoff before retry`);
          } catch (e) {
            const errName = (e as { name?: string }).name;
            console.warn(`[safe_fetch/restore] attempt=${attempt} ${errName === "AbortError" ? "TIMEOUT" : "ERROR"}: ${(e as Error).message ?? e}`);
          }
          if (attempt < RESTORE_MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          }
        }
        if (!restoreOk) {
          console.warn(`[safe_fetch/restore] gave up after ${RESTORE_MAX_ATTEMPTS} attempts for cp=${operatorCp} — operator may see top-bar stuck on ${sourceStr}; manual click recovers`);
        }
      }
    } finally {
      inFlightCpFetches.delete(lockPromise);
      mirrorInFlightCount();
      resolveLock();
      releaseSlot();
    }
  }
}

// v0.0.456: module-level mutex serializing ALL cp= fetches — mirrors
// fleet_api.ts sendFleetChain pattern (operator 2026-05-29 "照着發船的接口
// 改"). Without this, two concurrent cp= POSTs race ogame's session-cp:
//   T0: build A starts cp=planetX, captures operatorCp=Y
//   T0+ε: build B starts cp=planetZ, captures operatorCp=Y
//   T1: A done, restore cp=Y starts
//   T2: B done, server session now Z, restore cp=Y starts
//   T3: operator sees session bouncing X→Z→Y
// Mutex ensures: A's full lifecycle (fetch + restore) completes before B
// starts. sendFleet already has its own per-feature mutex; this gate adds
// the same guarantee to scheduleEntry / discover / jumpgate / every cp=
// site.
let cpFetchChain: Promise<unknown> = Promise.resolve();
async function acquireCpSlot(): Promise<() => void> {
  const prev = cpFetchChain;
  let release!: () => void;
  cpFetchChain = new Promise<void>((resolve) => { release = resolve; });
  try { await prev; } catch { /* prior failure isn't ours to handle */ }
  return release;
}

/**
 * v0.0.721 — operator 2026-06-03 "保护cp的API 有没有保护token" / "A".
 * Public hook for non-cp= callers (recallFleet — uses recallFleetAjax which
 * doesn't carry cp= but DOES use the same global token as cp= POSTs). Join
 * the cpFetchChain mutex so the recall POST serializes against any cp= POST
 * already holding a token, preventing newAjaxToken rotation races that would
 * otherwise burn one of recallFleet's 4 retry attempts on TOKEN_INVALID.
 * Caller MUST invoke the returned release fn in finally{}.
 */
export async function acquireCpMutexSlot(): Promise<() => void> {
  return acquireCpSlot();
}

/** Convenience: emergency.* path (FS save, recall) — always fire, no busy gate. */
export function fetchWithCpBypassBusy(
  baseUrl: string,
  init: RequestInit,
  sourcePID: string | number,
  opts: Omit<FetchWithCpOpts, "bypassBusy"> = {},
): Promise<Response> {
  return fetchWithCp(baseUrl, init, sourcePID, { ...opts, bypassBusy: true });
}

/**
 * Manually restore ogame session-cp to a target planet (typically operatorCp).
 * Used when a multi-stage flow does its own snapshot+restore and inner fetches
 * use {skipRestore: true} to avoid N restore round-trips. Best-effort silent.
 */
export async function restoreSessionCp(targetCp: string | null): Promise<void> {
  if (!_winRef || !targetCp) return;
  try {
    // v0.0.457: switched eventList → overview ajax (body-aware) for same
    // reason as fetchWithCp inline restore. Also capture newAjaxToken into
    // documentElement.dataset for tokenManager pickup.
    const res = await _winRef.fetch(
      `/game/index.php?page=componentOnly&component=overview&ajax=1&cp=${encodeURIComponent(targetCp)}`,
      { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
    );
    try {
      const text = await res.text();
      const m = text.match(/["']newAjaxToken["']\s*:\s*["']([a-zA-Z0-9_-]+)["']/);
      if (m && _docRef) {
        (_docRef.documentElement as HTMLElement).dataset["ogamexToken"] = m[1]!;
      }
    } catch (_) { /* */ }
  } catch (_) { /* */ }
}

/** Helper for tests / diagnostics. */
export function _userBusyForTest(): boolean { return userBusyNow(); }
export function _operatorCpForTest(): string | null { return currentOperatorCp(); }
