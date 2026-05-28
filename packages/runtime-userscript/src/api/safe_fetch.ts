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
  const operatorCp = currentOperatorCp();
  const sourceStr = String(sourcePID);
  const sep = baseUrl.includes("?") ? "&" : "?";
  const fullUrl = `${baseUrl}${sep}cp=${encodeURIComponent(sourceStr)}`;
  // Track this fetch + restore as one in-flight unit so click_lock can
  // delay operator clicks until session-cp is back to operatorCp.
  let resolveLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => { resolveLock = resolve; });
  inFlightCpFetches.add(lockPromise);
  mirrorInFlightCount();
  try {
    return await _winRef.fetch(fullUrl, init);
  } finally {
    try {
      if (!opts.skipRestore && operatorCp && operatorCp !== sourceStr) {
        try {
          await _winRef.fetch(
            `/game/index.php?page=componentOnly&component=eventList&action=fetchEventBox&ajax=1&asJson=1&cp=${encodeURIComponent(operatorCp)}`,
            { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
          );
        } catch (_) { /* best-effort restore */ }
      }
    } finally {
      inFlightCpFetches.delete(lockPromise);
      mirrorInFlightCount();
      resolveLock();
    }
  }
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
    await _winRef.fetch(
      `/game/index.php?page=componentOnly&component=eventList&action=fetchEventBox&ajax=1&asJson=1&cp=${encodeURIComponent(targetCp)}`,
      { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
    );
  } catch (_) { /* */ }
}

/** Helper for tests / diagnostics. */
export function _userBusyForTest(): boolean { return userBusyNow(); }
export function _operatorCpForTest(): string | null { return currentOperatorCp(); }
