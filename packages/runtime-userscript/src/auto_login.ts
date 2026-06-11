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
// v0.0.1002 — owner 2026-06-09 "新账号没有自动登录": 之前 5min cooldown +
// 3次/5min kill-switch 太激进, owner 反复尝试登录直接进入"5min 永久 kill"状态
// (老 localStorage 残留). v0.0.994 fallback 已经处理 click-loop 风险 (3s URL
// 不变 → 跳 /en_GB/accounts), kill-switch 多余. cooldown 降到 30s 防 ogame
// rate limit. MAX_CLICKS_IN_WINDOW 大幅放宽到 20 实质等于关闭.
const COOLDOWN_MS = 30_000;
const MAX_CLICKS_IN_WINDOW = 20;
const ABORT_WINDOW_MS = 5 * 60_000;

// v1.0.22 — owner 2026-06-10 真态金锭出土 (拉 gameforge main.973742d0.js 真源 verify):
//
// gameforge loginIntoGameAccount (hub Last played + /accounts Play 都调它) 真代码:
//   var y = o || window.open("/loading");   // o = null (quick_join / account_list 两 caller)
//   return v().then(r => api.post("/users/me/loginLink", {blackbox: r}))
//             .then(e => new URL(e.url).href)
//             .then(o => { y !== window ? y.location = o : setTimeout(...y.location=o, 2e3); });
//
// 真根源: programmatic click (isTrusted=false) → window.open 被 popup blocker block → 返
// null → 后续 null.location = url 真 throw → React state 污染.
// 真修法: window.open shim 永远返 Proxy, 拦未来 `popup.location = realGameUrl` 时同 tab nav.
//
// 顶层设计 v5 真闭环:
// - shim 装在**所有 lobby pages** (含 /accounts), 基建非决策, owner manual click 也吃 shim.
// - /hub: auto click Last played, shim 接 popup → 同 tab 进游戏.
// - /accounts: 只 shim 不 auto-click. owner manual click PLAY → React open popup → shim 接 → 同 tab 进游戏.
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

  // 真基建: shim 必装所有 lobby pages (含 /accounts), owner manual click 也吃 shim.
  installWindowOpenShim(win);

  // /hub 或 landing: auto click Last played, shim 已就位.
  // /accounts: shim 装好就完, owner manual click PLAY 时 shim 接 popup → 同 tab nav.
  const path = win.location.pathname;
  const isHubOrLanding = /^\/(?:[a-z]{2}_[A-Z]{2}\/?(?:hub\/?)?)?$/i.test(path);
  if (isHubOrLanding) {
    runLobbyClicker(win);
  } else {
    console.info(`[OgameX/auto-login] non-hub lobby path (${path}) — shim installed, manual click protected.`);
  }
  return true;
}

/**
 * v1.0.22 — 真 shim unsafeWindow.open. 拉 gameforge main.973742d0.js 真源 verify:
 *   var y = o || window.open("/loading");  // o = null (quick_join / account_list)
 *   v().then(r => api.post("/users/me/loginLink", {blackbox: r}))
 *     .then(e => new URL(e.url).href)
 *     .then(o => { y.location = o; });  // 最后赋值真 trigger nav
 *
 * **必须 always return Proxy** — 不能 immediately nav 因为初始 url="/loading" 是 placeholder.
 * Proxy 拦截 future `.location = realGameUrl` 时才同 tab nav. v1.0.21 误把 /loading 当真 url
 * 直接 nav 主 tab → owner 主 tab 真态被拉去 /loading 页 → loop 回 lobby.
 *
 * 不区分 url arg, 永远返 Proxy 等 future assignment.
 */
function installWindowOpenShim(win: Window): void {
  const us = ((globalThis as unknown as { unsafeWindow?: Window }).unsafeWindow ?? win) as Window & {
    __ogamexOpenShimmed?: boolean;
  };
  if (us.__ogamexOpenShimmed) return;
  us.__ogamexOpenShimmed = true;
  us.open = function shimmedOpen(urlArg?: string | URL, _target?: string, _features?: string): Window | null {
    const url = typeof urlArg === "string" ? urlArg : urlArg ? String(urlArg) : "(empty)";
    console.info(`[OgameX/auto-login] window.open("${url}") intercepted — returning Proxy (defer nav until popup.location = realUrl)`);
    // 永远返 Proxy, 不 immediately nav. 拦未来 `y.location = realGameUrl` 真态 trigger nav.
    return new Proxy({} as unknown as Window, {
      set(_t, prop, value): boolean {
        if (prop === "location") {
          // gameforge 真态: `y.location = o;` 其中 o 是 game URL string
          const href = typeof value === "string" ? value : (value as { href?: string })?.href ?? String(value);
          console.info(`[OgameX/auto-login] ★ shim popup.location = ${href} → 主 tab nav 同 tab 进游戏`);
          try { us.location.href = href; } catch { /* */ }
          return true;
        }
        return true;
      },
      get(_t, prop): unknown {
        if (prop === "location") {
          // popup.location.href = url 路径兼容
          return new Proxy({ href: "" } as Record<string, unknown>, {
            set(_t2, p2, v2): boolean {
              if (p2 === "href" || p2 === "assign" || p2 === "replace") {
                const href = String(v2);
                console.info(`[OgameX/auto-login] ★ shim popup.location.${String(p2)} = ${href} → 主 tab nav`);
                try { us.location.href = href; } catch { /* */ }
              }
              return true;
            },
            get(_t2, p2): unknown {
              if (p2 === "assign" || p2 === "replace") {
                return (href: string) => {
                  console.info(`[OgameX/auto-login] ★ shim popup.location.${String(p2)}("${href}") → 主 tab nav`);
                  try { us.location.href = String(href); } catch { /* */ }
                };
              }
              return "";
            },
          });
        }
        if (prop === "closed") return false;
        if (prop === "focus" || prop === "blur" || prop === "close") return () => undefined;
        if (prop === "document") return us.document;
        return undefined;
      },
    });
  } as typeof window.open;
  console.info("[OgameX/auto-login] window.open shim installed (popup defer → main-tab nav at popup.location set)");
}

/**
 * v1.0.21 — 真 single-click 策略. 找 hub Last played OR accounts page first row Play
 * 按钮; 找到就**单次** click; 60s 找不到给 up. window.open shim 已 install, click 触发
 * React handler 时 popup 流程被代理同 tab nav, 不抛 throw, 不污染 state.
 */
function runLobbyClicker(win: Window): void {
  console.info("[OgameX/auto-login] looking for login button (Last played on /hub OR Play on /accounts)...");
  const startedAt = Date.now();
  const tick = (): void => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.warn("[OgameX/auto-login] 60s gave up — no clickable login button found.");
      return;
    }
    const target = findLoginButton(win.document);
    if (target) {
      console.info(`[OgameX/auto-login] clicking: ${describe(target)} (window.open shim active, single attempt)`);
      try { target.click(); } catch (e) { console.warn("[OgameX/auto-login] click threw:", e); }
      return; // 真单次, 不 retry (避免 [[no-spam-ogame]] / React state 污染)
    }
    win.setTimeout(tick, POLL_MS);
  };
  tick();
}

/** v1.0.21 — find Last played button on /hub (Play button on /accounts removed per v1.0.21 conservatism). */
function findLoginButton(doc: Document): HTMLElement | null {
  for (const sel of LAST_PLAY_SELECTORS) {
    try {
      const el = doc.querySelector<HTMLElement>(sel);
      if (el && isVisible(el) && isLobbyReady(el)) return el;
    } catch { /* */ }
  }
  return null;
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

// v1.0.19 — owner 2026-06-10 "新服无法自动登录"
//
// 真态 log: text="Last playedTitania – Players: " — `Players:` 后面**空**, 没数字.
// 底层逻辑: ogame lobby 异步拉 accounts API, .serverDetails span 占位先渲染出来,
// player count 后填. 此时 click 触发的 React handler 引用 `accounts[lastIndex]`
// 还是 null → ogame 自家 main.js 抛 `Cannot set properties of null (setting 'location')`.
// → 命中 button 后强制 verify "Players: \d+" 真完成才返回, 否则继续 poll.
// 不引入新 timeout, 复用 runLastPlayClicker 60s 大窗口.
const LOBBY_READY_RE = /players?\s*:\s*\d/i;

function isLobbyReady(btn: HTMLElement): boolean {
  const txt = (btn.textContent ?? "").trim();
  if (!LOBBY_READY_RE.test(txt)) return false;
  // 副 check: .serverDetails 必须存在且文本含数字 (双源 verify 防 Last played 被
  // 其他 button text 假阳).
  const sd = btn.querySelector<HTMLElement>(".serverDetails");
  if (!sd) return true; // 兼容老 skin (无 .serverDetails 也可能合法)
  return LOBBY_READY_RE.test((sd.textContent ?? "").trim());
}

function findLastPlayButton(doc: Document): HTMLElement | null {
  for (const sel of LAST_PLAY_SELECTORS) {
    try {
      const el = doc.querySelector<HTMLElement>(sel);
      if (el && isVisible(el) && isLobbyReady(el)) return el;
    } catch { /* invalid (e.g. :has not supported) — skip */ }
  }
  // Strategy: text-content match across all clickables.
  const clickables = Array.from(doc.querySelectorAll<HTMLElement>("a, button, [role='button']"));
  for (const c of clickables) {
    const t = (c.textContent ?? "").trim();
    if (LAST_PLAY_TEXT_RE.test(t) && isVisible(c) && isLobbyReady(c)) return c;
  }
  return null;
}

// v1.0.19 — owner 2026-06-10 "新服无法自动登录, 老服 s274 没问题":
// gf-connect 后端 token mint 在新服 (Season-of-Anarchy 刚开服, GF 账号 cache 冷)
// 异步还在 fly 时 button 已渲染 "Players: N". programmatic .click() 抢跑撞
// `Cannot set properties of null (setting 'location')`.
//   防御 1: 命中后强等 1500ms 让 gf-connect 后端落地再 click;
//   防御 2: click 后 4s watch URL — 没变就 retry 1 次 (最多 2 次), 第 1 次 click
//          warms gf-connect token cache, 第 2 次大概率成功. 老服 cache 热第 1 次就过.
const POST_DETECT_DELAY_MS = 1500;
const POST_CLICK_WATCH_MS = 4000;
const MAX_CLICK_RETRIES = 2;

function runLastPlayClicker(win: Window, customSelector: string): void {
  const label = customSelector ? `custom selector "${customSelector}"` : "Last Play button";
  console.info(`[OgameX/auto-login] looking for ${label}...`);
  const startedAt = Date.now();
  let firstDetectedAt = 0;
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
      // v1.0.19 hot-detect → cold-click: 命中后强等 POST_DETECT_DELAY_MS 让
      // gf-connect 后端 token mint 真落地. 新服 cache 冷此差就是 throw 的根因.
      if (firstDetectedAt === 0) {
        firstDetectedAt = Date.now();
        console.info(`[OgameX/auto-login] found ${describe(target)} — waiting ${POST_DETECT_DELAY_MS}ms for gf-connect token mint`);
        win.setTimeout(tick, POST_DETECT_DELAY_MS);
        return;
      }
      // v0.0.1004 — 不偷偷跳 /accounts 兜底防死循环.
      const urlBefore = win.location.href;
      console.info(`[OgameX/auto-login] clicking: ${describe(target)}`);
      try { target.click(); } catch (e) { console.warn("[OgameX/auto-login] click failed", e); }
      // v1.0.19 retry: 4s 后 watch URL — 没变就 retry click 1 次 (max 2 次)
      let retries = 0;
      const watchUrl = (): void => {
        if (!/lobby\.ogame\.gameforge\.com/i.test(win.location.href)) {
          console.info("[OgameX/auto-login] URL changed — click succeeded");
          return;
        }
        if (retries >= MAX_CLICK_RETRIES) {
          console.warn(`[OgameX/auto-login] gave up after ${MAX_CLICK_RETRIES + 1} clicks — URL still ${win.location.href}`);
          return;
        }
        retries++;
        const t = findLastPlayButton(win.document);
        if (!t) {
          console.warn("[OgameX/auto-login] retry: button vanished, stopping");
          return;
        }
        console.info(`[OgameX/auto-login] retry ${retries}/${MAX_CLICK_RETRIES} — URL still ${urlBefore}`);
        try { t.click(); } catch (e) { console.warn("[OgameX/auto-login] retry click failed", e); }
        win.setTimeout(watchUrl, POST_CLICK_WATCH_MS);
      };
      win.setTimeout(watchUrl, POST_CLICK_WATCH_MS);
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
