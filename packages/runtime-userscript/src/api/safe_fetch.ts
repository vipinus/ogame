/**
 * safe_fetch — 唯一 cp= fetch 入口.
 *
 * 顶层逻辑: ogame `/game/index.php?...&cp=PID` 在服务端立刻切 session-cp,
 * UI 顶栏跟着跳. 即使 try/finally restoreSessionCp 也是 ~500ms 可见跳跃.
 * Operator 2026-05-27 反复中招 "操作时被自动切到其他月球".
 *
 * 架构 enforcement (operator: "架构层缺乏 enforcement"):
 * - 所有带 cp= 的 fetch **必须** 通过 fetchWithCp / fetchWithCpBypassBusy
 * - 严禁直接 fetch 拼 `&cp=` 字面 (CI grep gate, see scripts/check-no-raw-cp.sh)
 *
 * 行为:
 * - userBusy (store.server.user_busy_until > now) 时 throw BusyDeferredError
 *   除非 bypassBusy=true (仅限 emergency.* FS save 路径)
 * - try { fetch } finally { fetchEventBox cp=operatorCp } 把 session-cp 切回
 *   operator 当前 planet (避免 UI 顶栏长期停留在 fetch 目标 planet/moon)
 * - operatorCp 取自 meta[name=ogame-planet-id], 即 ogame 自己暴露的"当前页"
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

/** Operator 2026-05-28 "cp 的点击保护机制能不能一起保护 token": general-
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
  // Operator 2026-05-28: "取消 userbusy 机制". Click intercept (boot.ts
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
  /** Skip the userBusy check. RESERVED for emergency.* FS save chain only.
   *  Anything that visibly bounces the operator UI must NOT use this. */
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

/**
 * Fetch wrapper with AbortController-driven timeout. Happy path: 0 overhead
 * (clearTimeout cancels the abort scheduling on success). Failure path: throws
 * AbortError after timeoutMs, letting caller retry loop kick in.
 *
 * Operator 2026-06-01 "全 api 操作通过返回值执行后续, 为什么要等待": fetch
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
  if (!opts.bypassBusy && userBusyNow()) {
    throw new BusyDeferredError();
  }
  // v0.0.461: register THIS fetch as in-flight BEFORE acquiring the cp slot.
  // Operator 2026-05-29 "我点击的时候正好去建造也能拦住吗?" — without
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
  const sep = baseUrl.includes("?") ? "&" : "?";
  const fullUrl = `${baseUrl}${sep}cp=${encodeURIComponent(sourceStr)}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  try {
    return await fetchWithTimeout(fullUrl, init, timeoutMs);
  } finally {
    try {
      if (!opts.skipRestore && operatorCp && operatorCp !== sourceStr) {
        // v0.0.457: switched restore endpoint from eventList → overview ajax.
        // Evidence (operator 2026-05-29 morning DevTools probe): fetchEventBox
        // cp=moon does NOT actually switch server session-cp — server fell
        // back to operator's main planet. eventList is a body-agnostic feed;
        // overview is the canonical body-aware ajax (same URL ogame's own
        // sidebar moonlink/planetlink resolves to with ajax=1). Also capture
        // newAjaxToken from response — fire-and-forget was leaking token
        // rotations to global ogame state without our tokenManager learning
        // about them (operator: "没有恢复cp和token").
        try {
          const restoreUrl = `/game/index.php?page=componentOnly&component=overview&ajax=1&cp=${encodeURIComponent(operatorCp)}`;
          // v0.0.578 — restore也加 10s timeout, 防止 hang lock mutex
          const restoreRes = await fetchWithTimeout(restoreUrl, {
            credentials: "same-origin",
            headers: { "X-Requested-With": "XMLHttpRequest" },
          }, 10_000);
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
        } catch (_) { /* best-effort restore */ }
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
// fleet_api.ts sendFleetChain pattern (operator 2026-05-29 "照着发船的接口
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
