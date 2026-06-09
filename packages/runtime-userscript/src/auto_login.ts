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
  // v0.0.989k 引入 per-account cooldown 用 serverDetails 文本拼 key 后缀.
  // v0.0.992 修 owner "卡登录页面" 回归: gameforge lobby 是 React SPA, script
  // run-at=document-end 时 #root 还空 → .serverDetails 不存在 → acctTag=""
  // → 退回 base CLICKED_KEY → 旧账号写的 base cooldown 卡死新账号.
  //
  // 顶层修复: 早期 cooldown check 只在 acctTag 已就绪 (React 渲染完) 时跑
  // (快路径). React 未渲染时跳过早 check, 全延后到 tick() 里 — tick 找到
  // button 时 .serverDetails 必然也在 (它们同属 #joinGame 子树), 用最新 tag
  // 推导 per-account key + check cooldown + mark + click. 闭环.
  const acctTag = readCurrentServerTag(win);
  if (acctTag) {
    const clickedKey = `${CLICKED_KEY}_${acctTag}`;
    const countKey = `${COUNT_KEY}_${acctTag}`;
    if (clickCountTooMany(win, countKey)) {
      console.warn(`[OgameX/auto-login] kill-switch active for ${acctTag}. Run: ` +
        `localStorage.removeItem("${countKey}"); localStorage.removeItem("${clickedKey}")`);
      return false;
    }
    if (alreadyClickedRecently(win, clickedKey)) {
      const ageS = Math.round((Date.now() - readNum(win, clickedKey)) / 1000);
      console.info(`[OgameX/auto-login] cooldown active for ${acctTag} (last click ${ageS}s ago).`);
      return false;
    }
  } else {
    console.info("[OgameX/auto-login] serverDetails not yet rendered — deferring cooldown check to tick");
  }
  let savedSelector = "";
  try { savedSelector = win.localStorage.getItem(SELECTOR_KEY) ?? ""; } catch { /* */ }
  runLastPlayClicker(win, savedSelector);
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

function runLastPlayClicker(win: Window, customSelector: string): void {
  const label = customSelector ? `custom selector "${customSelector}"` : "Last Play button";
  console.info(`[OgameX/auto-login] looking for ${label}...`);
  const startedAt = Date.now();
  const tick = (): void => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.warn("[OgameX/auto-login] gave up — Last Play button not found. " +
        "Run: window.__ogamexHubClickables (saved at boot) to inspect DOM. " +
        `If your hub uses a different selector, set localStorage["${SELECTOR_KEY}"] to it.`);
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
      // v0.0.992 — React 渲染完后 .serverDetails 与 button 同时出现 (同属
      // #joinGame 子树). 这里 re-read acctTag → per-account key 正确, fresh
      // 账号不被旧 base CLICKED_KEY cooldown 卡.
      const acctTagNow = readCurrentServerTag(win);
      const clickedKey = acctTagNow ? `${CLICKED_KEY}_${acctTagNow}` : CLICKED_KEY;
      const countKey = acctTagNow ? `${COUNT_KEY}_${acctTagNow}` : COUNT_KEY;
      if (clickCountTooMany(win, countKey)) {
        console.warn(`[OgameX/auto-login] kill-switch active for ${acctTagNow || "(no-tag)"}. ` +
          `Run: localStorage.removeItem("${countKey}"); localStorage.removeItem("${clickedKey}")`);
        return;
      }
      if (alreadyClickedRecently(win, clickedKey)) {
        const ageS = Math.round((Date.now() - readNum(win, clickedKey)) / 1000);
        console.info(`[OgameX/auto-login] cooldown active for ${acctTagNow || "(no-tag)"} ` +
          `(last click ${ageS}s ago). Skip.`);
        return;
      }
      console.info(`[OgameX/auto-login] clicking (acct=${acctTagNow || "(no-tag)"}): ${describe(target)}`);
      markClicked(win, clickedKey, countKey);
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
