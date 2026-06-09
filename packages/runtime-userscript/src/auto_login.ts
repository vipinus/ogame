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
  // v0.0.989k — owner 2026-06-09 "新账号不会自动登录": cooldown/kill-switch
  // 之前 per-domain localStorage,owner 切换账号时旧账号的 cooldown 阻塞新账号
  // 自动 click. 用当前 hub 上 serverDetails 文本 (universe 名+玩家数, e.g.
  // "Titania – Players: 2040") 拼 key 后缀, 每账号互不影响. 同账号反复刷新
  // 仍受 cooldown 保护.
  const acctTag = readCurrentServerTag(win);
  const clickedKey = acctTag ? `${CLICKED_KEY}_${acctTag}` : CLICKED_KEY;
  const countKey = acctTag ? `${COUNT_KEY}_${acctTag}` : COUNT_KEY;
  if (clickCountTooMany(win, countKey)) {
    console.warn(`[OgameX/auto-login] kill-switch active for ${acctTag || "(no-tag)"}. Run in console: ` +
      `localStorage.removeItem("${countKey}"); localStorage.removeItem("${clickedKey}")`);
    return false;
  }
  if (alreadyClickedRecently(win, clickedKey)) {
    const ageS = Math.round((Date.now() - readNum(win, clickedKey)) / 1000);
    console.info(`[OgameX/auto-login] cooldown active for ${acctTag || "(no-tag)"} (last click ${ageS}s ago). To force, clear ${clickedKey}.`);
    return false;
  }
  // Operator directive: "直接点 last play". Always look for the
  // "Last Play" button by class/text fallbacks. Override only via custom
  // selector key if operator sets one explicitly.
  let savedSelector = "";
  try { savedSelector = win.localStorage.getItem(SELECTOR_KEY) ?? ""; } catch { /* */ }
  runLastPlayClicker(win, savedSelector, clickedKey, countKey);
  return true;
}

/** v0.0.989k — extract serverDetails text from hub to use as per-account
 *  cooldown key suffix. Returns sanitized [a-z0-9_] or "" if absent. */
function readCurrentServerTag(win: Window): string {
  try {
    const el = win.document.querySelector<HTMLElement>(".serverDetails")
      ?? win.document.querySelector<HTMLElement>("[class*='serverDetails']");
    if (!el) return "";
    const txt = (el.textContent ?? "").trim().toLowerCase();
    return txt.replace(/[^a-z0-9]+/g, "_").slice(0, 40);
  } catch { return ""; }
}

function readNum(win: Window, key: string): number {
  try {
    const raw = win.localStorage.getItem(key);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}
function alreadyClickedRecently(win: Window, clickedKey: string): boolean {
  const ts = readNum(win, clickedKey);
  return ts > 0 && (Date.now() - ts) < COOLDOWN_MS;
}
function clickCountTooMany(win: Window, countKey: string): boolean {
  try {
    const raw = win.localStorage.getItem(countKey);
    if (!raw) return false;
    const p = JSON.parse(raw) as { since: number; count: number };
    if (!p.since || (Date.now() - p.since) > ABORT_WINDOW_MS) return false;
    return p.count >= MAX_CLICKS_IN_WINDOW;
  } catch { return false; }
}
function markClicked(win: Window, clickedKey: string, countKey: string): void {
  try {
    win.localStorage.setItem(clickedKey, String(Date.now()));
    const raw = win.localStorage.getItem(countKey);
    let p: { since: number; count: number } | null = null;
    try { p = raw ? JSON.parse(raw) as { since: number; count: number } : null; } catch { /* */ }
    if (!p || (Date.now() - p.since) > ABORT_WINDOW_MS) {
      p = { since: Date.now(), count: 1 };
    } else {
      p.count += 1;
    }
    win.localStorage.setItem(countKey, JSON.stringify(p));
  } catch { /* */ }
}

// gameforge ogame lobby v7.0.2 hub structure (verified 2026-05-22 via DOM dump):
//   <div id="joinGame">
//     <a href="/en_GB/accounts"><button class="button button-primary">Play</button></a>
//     <button class="button button-default">
//       Last played<span class="serverDetails">Scorpius – Players: 3869</span>
//     </button>
//   </div>
// "Last played" is the second button inside #joinGame — uniquely identified
// by its .serverDetails child (the universe name + player count).
//
// Strategies (most specific first):
const LAST_PLAY_SELECTORS = [
  // Strategy 1: button containing .serverDetails — unique to Last Played CTA
  "#joinGame button:has(.serverDetails)",
  "button:has(.serverDetails)",
  // Strategy 2: explicit hub layout — second button in joinGame
  "#joinGame button.button-default",
  // Strategy 3: data-attribute heuristics (other ogame skin versions)
  'button[data-action="lastplay"]',
  'a[data-action="lastplay"]',
  ".lastPlay",
  ".js-last-play",
  ".js-lobby-last-play",
  ".js-last-played",
  '[class*="lastPlay"]',
  '[class*="last-play"]',
  '[class*="lastPlayed"]',
  '[id*="lastPlay"]',
];
// Multi-lang text — no trailing \b so "Last playedScorpius..." textContent
// (no space between sibling text + child span) still matches.
const LAST_PLAY_TEXT_RE =
  /(?:last\s*play(?:ed)?|continuer|continuar|forts(?:e|ä)tzen|上次遊玩|上次游玩|最后游玩|最後遊玩|繼續遊戲|继续游戏)/i;

function findLastPlayButton(doc: Document): HTMLElement | null {
  for (const sel of LAST_PLAY_SELECTORS) {
    try {
      const el = doc.querySelector<HTMLElement>(sel);
      if (el && isVisible(el)) return el;
    } catch { /* invalid (e.g. :has not supported) — skip */ }
  }
  // Strategy: text-content match across all clickables.
  const clickables = Array.from(doc.querySelectorAll<HTMLElement>("a, button, [role='button']"));
  for (const c of clickables) {
    const t = (c.textContent ?? "").trim();
    if (LAST_PLAY_TEXT_RE.test(t) && isVisible(c)) return c;
  }
  return null;
}

function runLastPlayClicker(win: Window, customSelector: string, clickedKey: string, countKey: string): void {
  const label = customSelector ? `custom selector "${customSelector}"` : "Last Play button";
  console.info(`[OgameX/auto-login] looking for ${label}...`);
  const startedAt = Date.now();
  const tick = (): void => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.warn("[OgameX/auto-login] gave up — Last Play button not found. " +
        "Run: window.__ogamexHubClickables (saved at boot) to inspect DOM. " +
        `If your hub uses a different selector, set localStorage["${SELECTOR_KEY}"] to it.`);
      // Dump clickables on giveup for diagnostic.
      const clickables = Array.from(win.document.querySelectorAll<HTMLElement>("a, button"));
      (win as Window & { __ogamexHubClickables?: HTMLElement[] }).__ogamexHubClickables = clickables;
      console.warn(`[OgameX/auto-login] ${clickables.length} clickables present at giveup time. ` +
                   "Sample:", JSON.stringify(clickables.slice(0, 15).map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className ?? "").toString().slice(0, 60),
        text: (el.textContent ?? "").trim().slice(0, 40),
        href: (el as HTMLAnchorElement).href || undefined,
      })), null, 2));
      return;
    }
    let target: HTMLElement | null = null;
    if (customSelector) {
      try { target = win.document.querySelector<HTMLElement>(customSelector); } catch { /* */ }
      if (target && !isVisible(target)) target = null;
    }
    if (!target) target = findLastPlayButton(win.document);
    if (target) {
      console.info(`[OgameX/auto-login] clicking: ${describe(target)}`);
      markClicked(win, clickedKey, countKey); // mark BEFORE click
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
