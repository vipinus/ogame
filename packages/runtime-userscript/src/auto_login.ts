/**
 * Auto-login from gameforge lobby/hub back into the game universe.
 *
 * Operator request: "服务器reset 自动登录回游戏". After ogame's nightly
 * reset the tab lands at lobby.ogame.gameforge.com/en_GB/hub.
 *
 * Earlier versions (v0.0.203/204) failed because the play-button selector
 * was guessed without inspecting real DOM. Per project rule "verify don't
 * guess", THIS version operates in two modes:
 *
 *   1. DIAGNOSTIC MODE (default first run) — DUMPS the hub's clickable
 *      elements (a/button) to console as JSON. Does NOT click. Operator
 *      pastes log back, we add the precise selector.
 *   2. ARMED MODE — once localStorage[OGAMEX_AUTO_LOGIN_ARMED] = "1",
 *      look for the exact selector pattern stored under
 *      OGAMEX_AUTO_LOGIN_SELECTOR and click it.
 *
 *   3. EXPLICIT KILL — localStorage[OGAMEX_AUTO_LOGIN_DISABLED] = "1"
 *      skips everything (operator's manual override).
 *
 * Hard safety: max 1 click per 5min cooldown; max 3 clicks per 5min
 * window → permanent kill until operator clears flags. Prevents the
 * "infinite click loop" reported on v0.0.203/204.
 */

const LAST_GAME_HOST_KEY = "OGAMEX_LAST_GAME_HOST";
const DISABLE_KEY = "OGAMEX_AUTO_LOGIN_DISABLED";
const ARMED_KEY = "OGAMEX_AUTO_LOGIN_ARMED";
const SELECTOR_KEY = "OGAMEX_AUTO_LOGIN_SELECTOR";
const CLICKED_KEY = "OGAMEX_AUTO_LOGIN_CLICKED_AT";
const COUNT_KEY = "OGAMEX_AUTO_LOGIN_CLICK_COUNT";
const POLL_MS = 1000;
const TIMEOUT_MS = 60_000;
const COOLDOWN_MS = 5 * 60_000;
const MAX_CLICKS_IN_WINDOW = 3;
const ABORT_WINDOW_MS = 5 * 60_000;

export function maybeAutoLoginFromHub(win: Window): boolean {
  if (/\.ogame\.gameforge\.com\/game\//.test(win.location.href)) {
    try {
      const host = win.location.hostname.split(".")[0];
      if (host) win.localStorage.setItem(LAST_GAME_HOST_KEY, host);
    } catch { /* */ }
    return false;
  }
  const isLobby = /lobby\.ogame\.gameforge\.com/i.test(win.location.href);
  if (!isLobby) return false;
  try {
    if (win.localStorage.getItem(DISABLE_KEY) === "1") {
      console.info("[OgameX/auto-login] DISABLED via OGAMEX_AUTO_LOGIN_DISABLED");
      return false;
    }
  } catch { /* */ }
  // Cooldown / kill-switch — checked BEFORE diagnostic too, so we don't
  // spam dumps on every reload during a loop.
  if (clickCountTooMany(win)) {
    console.warn("[OgameX/auto-login] kill-switch active. Run in console: " +
      `localStorage.removeItem("${COUNT_KEY}"); localStorage.removeItem("${CLICKED_KEY}")`);
    return false;
  }
  if (alreadyClickedRecently(win)) {
    const ageS = Math.round((Date.now() - readNum(win, CLICKED_KEY)) / 1000);
    console.info(`[OgameX/auto-login] cooldown active (last click ${ageS}s ago). To force, clear ${CLICKED_KEY}.`);
    return false;
  }
  // Mode select: ARMED requires explicit operator opt-in + saved selector.
  let armed = false;
  let savedSelector = "";
  try {
    armed = win.localStorage.getItem(ARMED_KEY) === "1";
    savedSelector = win.localStorage.getItem(SELECTOR_KEY) ?? "";
  } catch { /* */ }
  if (armed && savedSelector) {
    runArmedClicker(win, savedSelector);
  } else {
    runDiagnostic(win);
  }
  return true;
}

function readNum(win: Window, key: string): number {
  try {
    const raw = win.localStorage.getItem(key);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}
function alreadyClickedRecently(win: Window): boolean {
  const ts = readNum(win, CLICKED_KEY);
  return ts > 0 && (Date.now() - ts) < COOLDOWN_MS;
}
function clickCountTooMany(win: Window): boolean {
  try {
    const raw = win.localStorage.getItem(COUNT_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw) as { since: number; count: number };
    if (!p.since || (Date.now() - p.since) > ABORT_WINDOW_MS) return false;
    return p.count >= MAX_CLICKS_IN_WINDOW;
  } catch { return false; }
}
function markClicked(win: Window): void {
  try {
    win.localStorage.setItem(CLICKED_KEY, String(Date.now()));
    const raw = win.localStorage.getItem(COUNT_KEY);
    let p: { since: number; count: number } | null = null;
    try { p = raw ? JSON.parse(raw) as { since: number; count: number } : null; } catch { /* */ }
    if (!p || (Date.now() - p.since) > ABORT_WINDOW_MS) {
      p = { since: Date.now(), count: 1 };
    } else {
      p.count += 1;
    }
    win.localStorage.setItem(COUNT_KEY, JSON.stringify(p));
  } catch { /* */ }
}

function runDiagnostic(win: Window): void {
  console.info("[OgameX/auto-login] DIAGNOSTIC mode — will dump hub clickables (NO click). " +
    "Paste output to maintainer + arm: " +
    `localStorage.setItem("${SELECTOR_KEY}", "<correct css selector>"); ` +
    `localStorage.setItem("${ARMED_KEY}", "1");`);
  const startedAt = Date.now();
  let dumped = false;
  const tick = (): void => {
    if (dumped || Date.now() - startedAt > TIMEOUT_MS) return;
    const doc = win.document;
    const clickables = Array.from(doc.querySelectorAll<HTMLElement>("a, button"));
    // Wait for non-trivial DOM (React renders async).
    if (clickables.length < 3) {
      win.setTimeout(tick, POLL_MS);
      return;
    }
    dumped = true;
    const summary = clickables.slice(0, 50).map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className ?? "").toString().slice(0, 80),
      id: el.id || undefined,
      text: (el.textContent ?? "").trim().slice(0, 60),
      href: (el as HTMLAnchorElement).href || undefined,
      visible: isVisible(el),
    }));
    console.warn(`[OgameX/auto-login] DOM dump (${clickables.length} clickables, showing first 50):`);
    console.warn(JSON.stringify(summary, null, 2));
    // Also expose for operator console queries.
    (win as Window & { __ogamexHubClickables?: HTMLElement[] }).__ogamexHubClickables = clickables;
    console.info("[OgameX/auto-login] saved as window.__ogamexHubClickables for hand inspection.");
  };
  tick();
}

function runArmedClicker(win: Window, selector: string): void {
  console.info(`[OgameX/auto-login] ARMED mode — looking for "${selector}"`);
  const startedAt = Date.now();
  const tick = (): void => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.warn("[OgameX/auto-login] gave up — selector not found in time");
      return;
    }
    let target: HTMLElement | null = null;
    try { target = win.document.querySelector<HTMLElement>(selector); } catch { /* invalid selector */ }
    if (target && isVisible(target)) {
      console.info(`[OgameX/auto-login] clicking: ${describe(target)}`);
      markClicked(win); // mark BEFORE click
      try { target.click(); } catch (e) { console.warn("[OgameX/auto-login] click failed", e); }
      return;
    }
    win.setTimeout(tick, POLL_MS);
  };
  tick();
}

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function describe(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const cls = (el.className ?? "").toString().slice(0, 50);
  const text = (el.textContent ?? "").trim().slice(0, 30);
  const href = (el as HTMLAnchorElement).href ?? "";
  return `${tag}${cls ? "." + cls.split(/\s+/)[0] : ""} text="${text}"${href ? ` href="${href}"` : ""}`;
}
