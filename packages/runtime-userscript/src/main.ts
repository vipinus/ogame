import { boot } from "./boot.js";
import { createIndexedKv } from "./store/indexed_db.js";
import { wireBridge } from "./bridge/wire.js";
import { wireRuntime } from "./wire_runtime.js";
import { maybeAutoLoginFromHub } from "./auto_login.js";

declare const GM_getValue: ((key: string, def?: string) => string) | undefined;

// HTTPS by default — long-poll bridge works through cloud routers that don't
// proxy WebSocket. wire.ts auto-detects scheme; flip to ws[s]:// when you have
// real WS access (e.g. LAN dev, openclaw gateway).
const DEFAULT_BRIDGE_URL = "https://ogame.anyfq.com";

// Build-time placeholder constants. The generic dist/ogame-runtime.user.js
// ships with the bare placeholder literals below. When ogame-next's
// /api/userscript route serves the file PER USER, it string-replaces the
// placeholders with the requester's bridge_token + bridge URL.
// Injection detection at runtime uses the prefix check via wasInjected().
// Note: this comment intentionally does NOT echo the placeholder string,
// otherwise the comment text itself would get rewritten with the user's
// credential at serve-time (harmless but ugly).
const INJECTED_BRIDGE_TOKEN = "__INJECT_BRIDGE_TOKEN__";
const INJECTED_BRIDGE_URL = "__INJECT_BRIDGE_URL__";
const wasInjected = (v: string): boolean => v.length > 0 && v.indexOf("__INJECT_") !== 0;

/**
 * Resolve a config value via the following precedence:
 *   1. Build-time injection (from ogame-next per-user serving) — AUTHORITATIVE
 *      when present. Cannot be overridden by stale localStorage, which is the
 *      bug that bit operator 2026-06-02 (daigang's token in operator's
 *      localStorage caused every push to route as daigang).
 *   2. Tampermonkey GM_getValue (manual dev override)
 *   3. window.localStorage (manual dev override)
 *   4. provided default
 *
 * Per-user installed userscripts hit branch (1) and skip the others entirely.
 * Generic dev builds (smoke-test, /dl/ legacy path) fall through to (2-4).
 */
function readConfig(key: string, def: string, injected?: string): string {
  if (injected && wasInjected(injected)) return injected;
  if (typeof GM_getValue === "function") {
    try {
      const v = GM_getValue(key, "");
      if (v) return v;
    } catch { /* fall through */ }
  }
  try {
    const v = window.localStorage.getItem(key);
    if (v) return v;
  } catch { /* localStorage may be unavailable in some sandboxes */ }
  return def;
}

// Bail early on non-game pages — the userscript's @match is permissive
// (*.ogame.gameforge.com/*) which also matches lobby/account subdomains
// where the in-game DOM (meta tags, planetList, resource bar) doesn't
// exist. If we boot anyway, the stripped state.snapshot push wipes the
// real game tab's state via the WS bridge. Detect the in-game shell via
// the canonical <meta name="ogame-universe-speed"> tag — present on
// every ogame ingame page, absent everywhere else.
// Skip boot inside iframes — the executor's "background iframe" approach
// loads ogame pages in hidden iframes for off-screen clicks; if userscript
// runs inside those frames too, each frame becomes a NEW bridge client
// pushing its own state.snapshot every 60s, dispatching its own directives,
// and spawning more iframes. That's the recursive loop the user was seeing.
// EARLY hello — fires on EVERY page where @match injects. Confirms TM is
// actually running the script (no log = @match miss / TM disabled / wrong
// version). Diagnostic invariant — always-on by design.
console.info(`[OgameX] script-entry url=${window.location.href}`);
const _inIframe = window.self !== window.top;
const _isGamePage = !!document.querySelector('meta[name="ogame-universe-speed"]');
const _isLobby = /lobby\.ogame\.gameforge\.com/i.test(window.location.href);
if (_inIframe) {
  console.info("[OgameX] running inside iframe — skipping boot (parent frame handles state)");
} else if (_isLobby) {
  // Post-server-reset: ogame redirects to lobby/hub. Auto-click play to
  // re-enter the universe. Script re-loads on the new in-game URL.
  maybeAutoLoginFromHub(window);
} else if (!_isGamePage) {
  console.info("[OgameX] not an in-game page (no ogame-universe-speed meta) — skipping boot");
} else
(async () => {
  try {
    const handle = await boot({
      doc: document,
      win: window,
      fetch: window.fetch.bind(window),
      kv: createIndexedKv(),
    });
    console.info("[OgameX] runtime booted", handle.summary);
    // i18n diagnostic — show what locale we picked + what source signal won.
    // operator 2026-06-02 hit "audit modal still English" — would have caught
    // by checking this log first.
    try {
      const lang = (typeof document !== "undefined" ? document.documentElement.lang : "") || "(unset)";
      const host = (typeof window !== "undefined" ? window.location.hostname : "") || "(unknown)";
      const { getOgameLocaleWithOverride } = await import("./i18n/locale.js");
      const resolved = getOgameLocaleWithOverride();
      console.info(`[OgameX/i18n] locale=${resolved} (html.lang=${lang} hostname=${host})`);
    } catch (e) { console.warn("[OgameX/i18n] locale resolve failed", e); }
    // Expose for in-browser inspection
    (window as unknown as { __OGAMEX__: unknown }).__OGAMEX__ = handle;

    // Wire bridge if a token is configured (GM_getValue OR window.localStorage)
    const bridgeUrl = readConfig("OGAMEX_BRIDGE_URL", DEFAULT_BRIDGE_URL, INJECTED_BRIDGE_URL);
    const bridgeToken = readConfig("OGAMEX_BRIDGE_TOKEN", "smoke-test-token", INJECTED_BRIDGE_TOKEN);
    // Visible-in-console diagnostic: confirm which token wins. Show first 12
    // chars only — full token in console would be a credential leak if user
    // shares a screenshot. "(injected)" tag means per-user install is active.
    const tokenSource = wasInjected(INJECTED_BRIDGE_TOKEN) ? "(injected)" : "(localStorage/dev)";
    console.info(`[OgameX] bridge token ${bridgeToken.slice(0, 12)}… ${tokenSource}`);
    let wired: Awaited<ReturnType<typeof wireBridge>> | null = null;
    if (bridgeToken) {
      try {
        wired = await wireBridge(handle, { bridgeUrl, bridgeToken });
        (window as unknown as { __OGAMEX_BRIDGE__: unknown }).__OGAMEX_BRIDGE__ = wired;
        console.info("[OgameX] bridge wired");
      } catch (e) {
        console.warn("[OgameX] bridge wire failed (continuing without bridge)", e);
      }
    } else {
      console.info("[OgameX] bridge token not configured — running offline");
    }

    // Wire all userscript runtime subsystems (emergency / daily / goal / auditor)
    try {
      // The sidecar exposes an unauthenticated operator HTTP on the same host
      // (no-auth by design — same threat model as /v1/debug). The panel base
      // URL is configurable so dev / staging operators can re-target it.
      const goalsPanelBaseUrl = readConfig("OGAMEX_GOALS_PANEL_URL", "https://ogame.anyfq.com");
      const runtime = wireRuntime(handle, {
        ...(wired?.client ? { bridge: wired.client } : {}),
        win: window,
        doc: document,
        auditThresholds: {},
        fetch: window.fetch.bind(window),
        ...(goalsPanelBaseUrl ? { goalsPanelBaseUrl } : {}),
        // Forward bridge token to panel for auth-required sidecar endpoints
        // (operator 2026-05-26: pause/resume daemon 按钮被 sidecar 401 拒).
        ...(bridgeToken ? { goalsPanelBridgeToken: bridgeToken } : {}),
      });
      (window as unknown as { __OGAMEX_RUNTIME__: unknown }).__OGAMEX_RUNTIME__ = runtime;
      console.info("[OgameX] runtime subsystems wired");
    } catch (e) {
      console.error("[OgameX] wireRuntime failed", e);
    }
  } catch (e) {
    console.error("[OgameX] boot failed", e);
  }
})();
