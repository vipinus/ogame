/**
 * visible_interval — owner 2026-06-09 "idle tab JS 心跳 可以取消": 顶层设计
 * 一刀切 — 隐藏 tab 时所有非关键 timer 完全 stop, 不仅是降频. 可见时 catch-up
 * 一次立刻执行, 之后正常 setInterval. 顶替 `setInterval` 用法.
 *
 * 不适用于 hostile/emergency 探测 (eventbox_hook watchdog 必须背景跑) — 那些
 * 保留原生 setInterval.
 *
 * Owner 心智: "tab 不可见 → 用户看不到 → CPU 一点不要烧".
 */

interface VisibleIntervalHandle {
  /** Stop the interval permanently. */
  stop: () => void;
}

interface VisibleIntervalOpts {
  /**
   * If true (default), fire `fn` immediately when visibility flips back to
   * visible (catch-up tick) before resuming setInterval. Disable for timers
   * where catch-up is wasteful (e.g. pure UI cosmetic ticker).
   */
  catchUpOnVisible?: boolean;
  /**
   * If provided, override the document used for visibility queries. Defaults
   * to global document. Helpful for testing.
   */
  doc?: Document;
}

export function setVisibleInterval(
  fn: () => void,
  ms: number,
  opts: VisibleIntervalOpts = {},
): VisibleIntervalHandle {
  const doc = opts.doc ?? document;
  const catchUp = opts.catchUpOnVisible !== false;
  let id: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const safeCall = (): void => {
    try { fn(); } catch (e) { console.warn("[setVisibleInterval] fn threw", e); }
  };

  const start = (): void => {
    if (stopped || id !== null) return;
    id = setInterval(safeCall, ms);
  };

  const pause = (): void => {
    if (id !== null) { clearInterval(id); id = null; }
  };

  const onVisChange = (): void => {
    if (stopped) return;
    if (doc.hidden) {
      pause();
    } else {
      if (catchUp) safeCall();
      start();
    }
  };

  doc.addEventListener("visibilitychange", onVisChange);
  if (!doc.hidden) start();

  return {
    stop: () => {
      stopped = true;
      pause();
      doc.removeEventListener("visibilitychange", onVisChange);
    },
  };
}
