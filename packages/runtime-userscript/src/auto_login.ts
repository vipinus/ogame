/**
 * Auto-login from gameforge lobby/hub back into the game universe.
 *
 * After ogame's nightly server reset (~21:00 daily) the session expires
 * and any open game tab gets redirected to:
 *   https://lobby.ogame.gameforge.com/en_GB/hub
 * Operator request: "服务器reset 自动登录回游戏" — automate the click.
 *
 * Approach:
 *   1. Detect lobby/hub URL on script entry.
 *   2. Poll DOM up to 60s for the "play" CTA (React app renders async).
 *   3. Match the universe by host substring (e.g. "s274") if available
 *      from saved last-game URL; else click the first play button found.
 *   4. Single .click() — ogame's own SPA navigates back into the game.
 *      Our userscript will boot again on the new URL via @match.
 *
 * Configurable via localStorage:
 *   OGAMEX_AUTO_LOGIN_DISABLED = "1"  → skip auto-login (manual mode)
 *   OGAMEX_LAST_GAME_HOST     = "s274-en"  → universe filter (set
 *                                            automatically on game boot)
 */

const LAST_GAME_HOST_KEY = "OGAMEX_LAST_GAME_HOST";
const DISABLE_KEY = "OGAMEX_AUTO_LOGIN_DISABLED";
const POLL_MS = 1000;
const TIMEOUT_MS = 60_000;

/** Called from main.ts on EVERY script load. No-op unless we're on lobby. */
export function maybeAutoLoginFromHub(win: Window): boolean {
  // Stash current host so next time we land on hub we can match the right
  // universe card.
  if (/\.ogame\.gameforge\.com\/game\//.test(win.location.href)) {
    try {
      const host = win.location.hostname.split(".")[0]; // e.g. "s274-en"
      if (host) win.localStorage.setItem(LAST_GAME_HOST_KEY, host);
    } catch { /* */ }
    return false; // in-game; nothing to do
  }
  // Recognize lobby/hub URLs.
  const isLobby = /lobby\.ogame\.gameforge\.com\/[a-z_]+\/hub/i.test(win.location.href)
               || /lobby\.ogame\.gameforge\.com\/?$/i.test(win.location.href);
  if (!isLobby) return false;
  try {
    if (win.localStorage.getItem(DISABLE_KEY) === "1") {
      console.info("[OgameX/auto-login] disabled via OGAMEX_AUTO_LOGIN_DISABLED");
      return false;
    }
  } catch { /* */ }
  startHubLoginLoop(win);
  return true;
}

function startHubLoginLoop(win: Window): void {
  console.info("[OgameX/auto-login] on lobby/hub — looking for universe play button...");
  let lastHost = "";
  try { lastHost = win.localStorage.getItem(LAST_GAME_HOST_KEY) ?? ""; } catch { /* */ }
  const startedAt = Date.now();
  const tick = (): void => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.warn(`[OgameX/auto-login] gave up after ${TIMEOUT_MS / 1000}s — no play button found`);
      return;
    }
    const target = findPlayTarget(win.document, lastHost);
    if (target) {
      console.info(`[OgameX/auto-login] clicking play target: ${describe(target)}`);
      try {
        target.click();
        // Some hub buttons trigger a form submit / location change async;
        // if URL didn't change after 5s, retry once.
        setTimeout(() => {
          if (Date.now() - startedAt < TIMEOUT_MS &&
              /lobby\.ogame\.gameforge\.com/.test(win.location.href)) {
            console.info("[OgameX/auto-login] URL didn't change — retrying click chain");
            startHubLoginLoop(win); // recurse: rebind for next render frame
          }
        }, 5000);
      } catch (e) { console.warn("[OgameX/auto-login] click failed", e); }
      return;
    }
    win.setTimeout(tick, POLL_MS);
  };
  tick();
}

function findPlayTarget(doc: Document, lastHost: string): HTMLElement | null {
  // Strategy 1 — anchor whose href targets the last-known game universe.
  if (lastHost) {
    const hostMatch = doc.querySelector<HTMLAnchorElement>(`a[href*="${lastHost}.ogame.gameforge.com"]`);
    if (hostMatch) return hostMatch;
  }
  // Strategy 2 — any anchor whose href targets *.ogame.gameforge.com/game/
  //   (i.e. an actual in-game entry link).
  const anyGameLink = doc.querySelector<HTMLAnchorElement>('a[href*=".ogame.gameforge.com/game/"]');
  if (anyGameLink) return anyGameLink;
  // Strategy 3 — known gameforge hub CTA selectors.
  const sel3 = [
    "a.button.btn-primary",
    "button.button.btn-primary",
    ".js-play-button",
    ".play-button",
    '[data-action="play"]',
  ];
  for (const s of sel3) {
    const el = doc.querySelector<HTMLElement>(s);
    if (el && isVisible(el)) return el;
  }
  // Strategy 4 — text match (multi-lang). Last-resort; matches any clickable.
  const textRe = /^\s*(play|jouer|spielen|jugar|进入|進入|играть|spela|giocare|遊ぶ)\s*$/i;
  const clickables = Array.from(doc.querySelectorAll<HTMLElement>("a, button"));
  for (const c of clickables) {
    const t = (c.textContent ?? "").trim();
    if (textRe.test(t) && isVisible(c)) return c;
  }
  return null;
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
