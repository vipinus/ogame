import { boot } from "./boot.js";
import { createIndexedKv } from "./store/indexed_db.js";
import { wireBridge } from "./bridge/wire.js";

declare const GM_getValue: ((key: string, def?: string) => string) | undefined;

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:18790";

(async () => {
  try {
    const handle = await boot({
      doc: document,
      win: window,
      fetch: window.fetch.bind(window),
      kv: createIndexedKv(),
    });
    console.info("[OgameX] runtime booted", handle.summary);
    // Expose for in-browser inspection
    (window as unknown as { __OGAMEX__: unknown }).__OGAMEX__ = handle;

    // Wire bridge if a token is configured via Tampermonkey GM_getValue
    const bridgeUrl = typeof GM_getValue === "function"
      ? GM_getValue("OGAMEX_BRIDGE_URL", DEFAULT_BRIDGE_URL)
      : DEFAULT_BRIDGE_URL;
    const bridgeToken = typeof GM_getValue === "function"
      ? GM_getValue("OGAMEX_BRIDGE_TOKEN", "")
      : "";
    if (bridgeToken) {
      try {
        const wired = await wireBridge(handle, { bridgeUrl, bridgeToken });
        (window as unknown as { __OGAMEX_BRIDGE__: unknown }).__OGAMEX_BRIDGE__ = wired;
        console.info("[OgameX] bridge wired");
      } catch (e) {
        console.warn("[OgameX] bridge wire failed (continuing without bridge)", e);
      }
    } else {
      console.info("[OgameX] bridge token not configured — running offline");
    }
  } catch (e) {
    console.error("[OgameX] boot failed", e);
  }
})();
