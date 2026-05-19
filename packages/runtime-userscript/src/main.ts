import { boot } from "./boot.js";
import { createIndexedKv } from "./store/indexed_db.js";

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
  } catch (e) {
    console.error("[OgameX] boot failed", e);
  }
})();
