import { boot } from "./boot.js";
import { createIndexedKv } from "./store/indexed_db.js";
import { wireBridge } from "./bridge/wire.js";
import { wireRuntime } from "./wire_runtime.js";
import type { ExpeditionConfig } from "@ogamex/shared";

declare const GM_getValue: ((key: string, def?: string) => string) | undefined;

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:18790";

/**
 * Resolve a config value via the following precedence:
 *   1. Tampermonkey GM_getValue (preferred; survives across reloads)
 *   2. window.localStorage (page-level; useful when GM grants aren't configured)
 *   3. provided default
 * Page-level localStorage is also handy for smoke testing without a userscript
 * manager: just `localStorage.setItem("OGAMEX_BRIDGE_TOKEN", "...")` and reload.
 */
function readConfig(key: string, def: string): string {
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

/** Stub config until M5+ pulls from Strategy.daily.expedition. Dormant by default. */
function defaultExpeditionConfig(): ExpeditionConfig {
  return {
    enabled: false,
    auto_fill_slots: false,
    source_planet: null,
    duration: "medium",
    target_position: 16,
    fleet_templates: {},
    galaxy_strategy: {
      mode: "stats_based",
      home_galaxy_first: true,
      switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
      cross_galaxy_deut_budget: 0,
    },
    cargo_load: { smallCargo_capacity_pct: 100, largeCargo_capacity_pct: 100 },
  };
}

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

    // Wire bridge if a token is configured (GM_getValue OR window.localStorage)
    const bridgeUrl = readConfig("OGAMEX_BRIDGE_URL", DEFAULT_BRIDGE_URL);
    const bridgeToken = readConfig("OGAMEX_BRIDGE_TOKEN", "");
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
      const runtime = wireRuntime(handle, {
        ...(wired?.client ? { bridge: wired.client } : {}),
        expeditionConfig: defaultExpeditionConfig,
        win: window,
        doc: document,
        auditThresholds: {},
        fetch: window.fetch.bind(window),
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
