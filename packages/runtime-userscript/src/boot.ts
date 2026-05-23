import type { WorldState } from "@ogamex/shared";
import { EventBus } from "./event_bus.js";
import { StateStore } from "./state_store.js";
import type { IndexedKv } from "./store/indexed_db.js";
import { startMutationObserver } from "./probes/mutation_observer.js";
import { installXhrHook } from "./probes/xhr_hook.js";
import {
  extractResources,
  extractStorage,
  extractProduction,
  extractLifeformResources,
} from "./probes/extractors/resources.js";
import { extractIncomingEvents } from "./probes/extractors/events.js";
import { extractPlanets } from "./probes/extractors/planets.js";
import { extractTechLevels } from "./probes/extractors/buildings.js";
import { TECH_TREE, TECH_NAME_BY_ID, TECH_ID_BY_NAME, idKind } from "@ogamex/shared";
import { extractFleetMovements } from "./probes/extractors/fleet.js";
import { installEventBoxHook } from "./probes/eventbox_hook.js";
import { extractToken, type OgameWindow } from "./probes/extractors/token.js";

export interface BootEnv {
  doc: Document;
  win: Window;
  fetch?: typeof fetch;
  kv?: IndexedKv | null;
}

export interface BootSummary {
  resources_ok: boolean;
  storage_ok: boolean;
  production_ok: boolean;
  lifeform_resources_ok: boolean;
  events_count: number;
  planets_count: number;
  fleet_movements_count: number;
  token_present: boolean;
  ogame_meta: {
    universe?: string;
    universe_speed?: number;
    player_id?: string;
    player_name?: string;
    planet_coords?: string;
    alliance_tag?: string;
    is_vacation_mode?: boolean;
  };
}

export interface BootHandle {
  bus: EventBus;
  store: StateStore;
  summary: BootSummary;
  stop: () => void;
}

function readMeta(doc: Document, name: string): string | undefined {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;
}

/**
 * Convert PlanetIdentity[] (extractor output) to Record<string, Planet>
 * (state shape, keyed by ogame planet id), preserving existing per-planet
 * data (buildings/ships/queues) where ids match, and synthesizing safe
 * defaults for fresh planets.
 *
 * Refactored 2026-05-21 from Array→Record. Callers spread the result
 * into state.planets so additional planets in existing (e.g. moons not in
 * the current planetList scrape) are NOT lost.
 */
function mergeWithExistingPlanets(
  ids: import("./probes/extractors/planets.js").PlanetIdentity[],
  existing: Record<string, import("@ogamex/shared").Planet>,
): Record<string, import("@ogamex/shared").Planet> {
  const out: Record<string, import("@ogamex/shared").Planet> = {};
  for (const p of ids) {
    const prev = existing[p.id];
    if (prev) {
      out[p.id] = { ...prev, ...p } as import("@ogamex/shared").Planet;
    } else {
      out[p.id] = {
        ...p,
        resources: { m: 0, c: 0, d: 0, e: 0 },
        storage: { m_max: 0, c_max: 0, d_max: 0 },
        production: { m_h: 0, c_h: 0, d_h: 0 },
        buildings: {},
        build_q: null,
        shipyard_q: null,
        defense_q: null,
        ships: {},
        defense: {},
        lifeform: null,
      } as import("@ogamex/shared").Planet;
    }
  }
  return out;
}

function detectVacationMode(doc: Document): boolean {
  // The advice bar contains an icon with a title that includes "假期模式" / "vacation mode"
  const banners = doc.querySelectorAll<HTMLElement>("#advice-bar [title]");
  for (const b of banners) {
    const t = b.getAttribute("title") ?? "";
    if (t.includes("假期模式") || /vacation\s*mode/i.test(t)) return true;
  }
  return false;
}

/**
 * Read current ogame page DOM for building / research levels, partition by
 * TECH_TREE kind, and merge into the right slots of state:
 *   - kind "building" → state.planets[activeIdx].buildings (active planet = the one
 *     whose id matches the <meta name="ogame-planet-id"> content)
 *   - kind "research" → state.research.levels (player-wide)
 *
 * Ship and defense kinds aren't extracted here (different DOM shape). Each
 * invocation is idempotent: missing tech ids just don't show up.
 */
function mergeTechLevels(doc: Document, store: StateStore): void {
  const levels = extractTechLevels(doc);
  if (Object.keys(levels).length === 0) return;
  const buildings: Record<string, number> = {};
  const research: Record<string, number> = {};
  const lifeformBuildings: Record<string, number> = {};
  // Detect species from lifeform tech ID prefix:
  //   111xx = humans  121xx = rocktal  131xx = mechas  141xx = kaelesh
  let detectedSpecies: string | null = null;
  for (const [id, lvl] of Object.entries(levels)) {
    const techId = TECH_ID_BY_NAME[id];
    if (techId !== undefined && idKind(techId) === "lifeform_building") {
      lifeformBuildings[id] = lvl;
      if (lvl > 0 && detectedSpecies === null) {
        const prefix = Math.floor(techId / 1000);
        detectedSpecies = prefix === 11 ? "humans"
          : prefix === 12 ? "rocktal"
          : prefix === 13 ? "mechas"
          : prefix === 14 ? "kaelesh"
          : null;
      }
      continue;
    }
    const entry = (TECH_TREE as Record<string, { kind: string }>)[id];
    if (!entry) continue;
    if (entry.kind === "building") buildings[id] = lvl;
    else if (entry.kind === "research") research[id] = lvl;
  }
  const cur = store.state;
  const patch: Partial<typeof cur> = {};
  // Merge buildings into the currently-active planet, identified by
  // <meta name="ogame-planet-id">. Without that meta we can't safely target.
  const activeIdRaw = doc.querySelector<HTMLMetaElement>("meta[name=\"ogame-planet-id\"]")?.content;
  if (Object.keys(buildings).length > 0 && activeIdRaw && Object.keys(cur.planets).length > 0) {
    const existing = cur.planets[activeIdRaw];
    if (existing) {
      const mergedB: Record<string, number> = { ...(existing.buildings ?? {}) };
      for (const [k, v] of Object.entries(buildings)) {
        if (v >= (mergedB[k] ?? 0)) mergedB[k] = v;
      }
      // Lifeform buildings — separate field. Anti-regression too.
      const existingLf = (existing as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {};
      const mergedLf: Record<string, number> = { ...existingLf };
      for (const [k, v] of Object.entries(lifeformBuildings)) {
        if (v >= (mergedLf[k] ?? 0)) mergedLf[k] = v;
      }
      const existingLfMeta = (existing as { lifeform?: { species?: string } | null }).lifeform ?? null;
      const lifeformPatch = detectedSpecies !== null && (existingLfMeta === null || existingLfMeta.species !== detectedSpecies)
        ? { lifeform: { ...(existingLfMeta ?? {}), species: detectedSpecies } }
        : {};
      patch.planets = {
        ...cur.planets,
        [activeIdRaw]: { ...existing, buildings: mergedB, lifeform_buildings: mergedLf, ...lifeformPatch } as typeof existing,
      };
      if (detectedSpecies !== null) {
        console.info(`[OgameX/species] planet ${activeIdRaw}: detected species=${detectedSpecies}`);
      }
    }
  }
  if (Object.keys(research).length > 0) {
    const mergedR: Record<string, number> = { ...(cur.research?.levels ?? {}) };
    for (const [k, v] of Object.entries(research)) {
      if (v >= (mergedR[k] ?? 0)) mergedR[k] = v;
    }
    patch.research = { ...cur.research, levels: mergedR };
  }
  if (Object.keys(patch).length > 0) store.setPartial(patch);
}

/**
 * Boots the OgameX runtime against a given environment.
 * Pure (no global side effects) — takes injected document/window/fetch/kv so it's testable in jsdom.
 */
export async function boot(env: BootEnv): Promise<BootHandle> {
  const bus = new EventBus();
  const store = new StateStore(bus, env.kv ?? null);

  // 1. Hydrate prior state from IndexedDB if available
  try {
    await store.hydrate();
  } catch (e) {
    // Hydration failure should not break boot — log and continue with empty state
    console.warn("[OgameX] hydrate failed; continuing with empty state", e);
  }
  // 1a. Detect player class from DOM — Discoverer / 探险家 = +2 expedition.
  //     Class appears in topbar / player-info widget on every page.
  function detectPlayerClass(): "discoverer" | "collector" | "general" | "unknown" {
    try {
      // Most reliable: ogame's character class icon uses dedicated CSS:
      //   <div class="characterClassDiscoverer ..."> or <i class="characterclass discoverer">
      // Also has meta tags / global JS vars in some skins.
      const html = env.doc.documentElement?.outerHTML ?? "";
      // CSS-class based detection (covers most skins)
      if (/character[Cc]lass[A-Za-z]*[Dd]iscoverer|characterclass.*discoverer|class=.discoverer/.test(html)) return "discoverer";
      if (/character[Cc]lass[A-Za-z]*[Cc]ollector|characterclass.*collector|class=.collector/.test(html)) return "collector";
      if (/character[Cc]lass[A-Za-z]*[Gg]eneral|characterclass.*general|class=.general/.test(html)) return "general";
      // Text-based fallback
      const body = env.doc.body?.textContent ?? "";
      if (/探險家|探险家|[Dd]iscoverer/i.test(body)) return "discoverer";
      if (/收藏家|收集家|[Cc]ollector/i.test(body)) return "collector";
      if (/將軍|将军|[Gg]eneral/i.test(body)) return "general";
      return "unknown";
    } catch { return "unknown"; }
  }
  let playerClass = detectPlayerClass();
  // Hydrate from localStorage if DOM detection on this page didn't find
  // class text (class info isn't on every ogame page).
  if (playerClass === "unknown") {
    try {
      const stored = env.win.localStorage.getItem("OGAMEX_CLASS");
      if (stored === "discoverer" || stored === "collector" || stored === "general") {
        playerClass = stored;
      }
    } catch { /* */ }
  }
  if (playerClass !== "unknown") {
    try { env.win.localStorage.setItem("OGAMEX_CLASS", playerClass); } catch { /* */ }
    const cur = store.state;
    store.setPartial({
      server: { ...(cur.server ?? {}), player_class: playerClass } as typeof cur.server,
    });
    console.log(`[OgameX] player class = ${playerClass}`);
  } else {
    console.log(`[OgameX] player class unknown — set via: localStorage.OGAMEX_CLASS = "discoverer"`);
  }

  // 1b. Hydrate last-known slot caps from localStorage so first server.snapshot
  //     carries real max even before any scraper has run this session.
  try {
    const maxExpStr = env.win.localStorage.getItem("OGAMEX_MAX_EXP");
    const maxFleetStr = env.win.localStorage.getItem("OGAMEX_MAX_FLEET");
    const maxExp = maxExpStr ? parseInt(maxExpStr, 10) : 0;
    const maxFleet = maxFleetStr ? parseInt(maxFleetStr, 10) : 0;
    if (maxExp > 0 || maxFleet > 0) {
      const cur = store.state;
      store.setPartial({
        server: {
          ...(cur.server ?? {}),
          ...(maxExp > 0 ? { max_expedition_slots: maxExp } : {}),
          ...(maxFleet > 0 ? { max_fleet_slots: maxFleet } : {}),
        } as typeof cur.server,
      });
      console.log(`[OgameX] hydrated slot caps from localStorage: exp=${maxExp} fleet=${maxFleet}`);
    }
  } catch (_) { void _; }

  // 1c. Global user-activity tracker — when operator is clicking/typing
  // in ogame UI, PAUSE all autonomous pollers + POSTs for IDLE_GUARD_MS
  // to avoid triggering ogame's anti-bot rate limit ("server not responding").
  // Pollers check `(env.win as any).__ogamexUserBusyUntil > Date.now()`.
  // Operator: "我操作的时候 userscript 就不要操作前台的网页". 10s gate was
  // too short — manual workflows often pause > 10s between clicks. 60s gives
  // operator a real protected window. Background API POSTs (ApiExec) keep
  // running; foreground DOM/click ops are blocked by additional gates.
  const IDLE_GUARD_MS = 60_000;
  const updateBusy = (): void => {
    (env.win as Window & { __ogamexUserBusyUntil?: number }).__ogamexUserBusyUntil = Date.now() + IDLE_GUARD_MS;
  };
  const onUserAct = (e: Event): void => {
    if (!e.isTrusted) return;
    updateBusy();
    // Write user_busy_until into store IMMEDIATELY + force-push to sidecar.
    // Closes the 5s mirror-interval gap where merger had stale ubu and kept
    // dispatching during operator's active session.
    const until = (env.win as Window & { __ogamexUserBusyUntil?: number }).__ogamexUserBusyUntil ?? 0;
    const cur = store.state.server ?? {};
    if ((cur as { user_busy_until?: number }).user_busy_until !== until) {
      store.setPartial({ server: { ...cur, user_busy_until: until } as typeof cur });
    }
    const pushNow = (env.win as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow;
    if (typeof pushNow === "function") pushNow();
  };
  env.doc.addEventListener("mousedown", onUserAct, true);
  env.doc.addEventListener("keydown", onUserAct, true);
  function userBusy(): boolean {
    return ((env.win as Window & { __ogamexUserBusyUntil?: number }).__ogamexUserBusyUntil ?? 0) > Date.now();
  }
  void userBusy; // used below in pollers
  // Mirror busy-until into state.server every 5s so sidecar merger can also
  // skip dispatch while operator is active. Without this, sidecar keeps
  // emitting directives → GoalRunner DEFER 60s but pile up.
  setInterval(() => {
    const until = (env.win as Window & { __ogamexUserBusyUntil?: number }).__ogamexUserBusyUntil ?? 0;
    const cur = store.state.server ?? {};
    if ((cur as { user_busy_until?: number }).user_busy_until !== until) {
      store.setPartial({ server: { ...cur, user_busy_until: until } as typeof cur });
    }
  }, 5000);

  // 2. Wire probes
  const stopMO = startMutationObserver(env.doc, bus, env.win);
  if (env.fetch) {
    installXhrHook({ fetch: env.fetch }, bus);
  }

  // 2b. Page-world fetch/XHR sniffer. The isolated-context xhr_hook above
  // only sees fetches WE make. To learn ogame's real POST endpoints (so
  // ApiDirectiveExecutor can reproduce them), inject a wrapper in page
  // world that captures every fetch/XHR ogame itself fires + logs to
  // console with [OgameXSniff] prefix. The user clicks "upgrade" once
  // and we read the exact URL/body from console.
  const sniffer = env.doc.createElement("script");
  sniffer.textContent = `
    (function(){
      try {
        // Cross-context bridge: store recent ogame API calls on document
        // dataset (string only — userscript-isolated context reads it via
        // env.doc.documentElement.dataset.ogamexCaptures). Last 30 calls.
        const PERSIST_KEY = "ogamexCaptures";
        const LS_KEY = "OGAMEX_API_CAPTURES";
        const TOKEN_LS_KEY = "OGAMEX_TOKEN";
        // ogame v12 stores its CSRF token as 'var token = "..."' in inline
        // JS — only accessible from page world. Sniffer (running in page
        // world) captures it via window.token and persists for isolated
        // context (ApiExec) to read.
        const captureToken = () => {
          try {
            const t = window.token;
            if (typeof t === "string" && t.length > 10) {
              // Only SEED dataset if empty (first boot). After that,
              // ApiExec's scheduleEntry response is authoritative —
              // window.token is for OGAME's UI clicks, not ours.
              if (!document.documentElement.dataset.ogamexToken) {
                document.documentElement.dataset.ogamexToken = t;
                localStorage.setItem(TOKEN_LS_KEY, t);
              }
            }
          } catch (_) {}
        };
        // Capture only once at boot — no longer interval-overwrite.
        captureToken();
        // Auto-dump scheduleEntry captures at boot — operator doesn't have
        // to paste anything; just read the line in console.
        setTimeout(() => {
          try {
            const all = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
            const realClicks = all.filter((c) =>
              c.url && c.url.includes("scheduleEntry") &&
              c.body && !c.body.includes("modus=1&cp=") // exclude our own POSTs
            );
            if (realClicks.length > 0) {
              console.log("[OgameX/captures] REAL ogame scheduleEntry POSTs captured:");
              for (const c of realClicks.slice(-5)) {
                console.log("  url=", c.url);
                console.log("  body=", c.body);
              }
            }
            // (no-captures message silenced — was once-per-boot but still noise)
          } catch (_) {}
        }, 3000);
        // Hydrate from localStorage on every boot so captures survive reload.
        try {
          const stored = localStorage.getItem(LS_KEY);
          if (stored) document.documentElement.dataset[PERSIST_KEY] = stored;
        } catch (_) {}
        const persist = (rec) => {
          try {
            const cur = document.documentElement.dataset[PERSIST_KEY];
            const arr = cur ? JSON.parse(cur) : [];
            arr.push(rec);
            while (arr.length > 50) arr.shift();
            const json = JSON.stringify(arr);
            document.documentElement.dataset[PERSIST_KEY] = json;
            try { localStorage.setItem(LS_KEY, json); } catch (_) {}
          } catch (_) {}
        };
        const log = (kind, url, body, status, respLen) => {
          const u = String(url).replace(/^.*\\/game\\//, "/game/");
          console.log("[OgameXSniff]", kind, status||"", u, body ? "body="+String(body).slice(0,300) : "", respLen?("resp="+respLen+"B"):"");
          // Persist only non-trivial (with body OR with action/modus URL).
          if (body || /[?&](?:modus|action|menge)=/.test(u)) {
            persist({ ts: Date.now(), kind, url: u, body: String(body || "").slice(0, 500), status });
          }
        };
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          const method = (init && init.method) || (typeof input !== "string" && input.method) || "GET";
          if (url.includes("/game/index.php")) {
            const body = init && init.body ? (init.body instanceof URLSearchParams ? init.body.toString() : (typeof init.body === "string" ? init.body : "<form>")) : "";
            const p = origFetch.apply(this, arguments);
            p.then(r => {
              try { r.clone().text().then(t => {
                log("FETCH "+method, url, body, r.status, t.length);
                // Sniff newAjaxToken from ANY ogame JSON response and
                // refresh dataset/localStorage so ApiExec gets fresh token.
                try {
                  // ONLY rotate from scheduleEntry responses — other ogame
                  // responses (fetchResources, eventBox, etc.) have their
                  // own token chains that would pollute scheduleEntry's.
                  if (url.includes("scheduleEntry") || url.includes("buildlistactions")) {
                    const m = t.match(/"newAjaxToken"\\s*:\\s*"([a-f0-9]{20,})"/);
                    if (m) {
                      document.documentElement.dataset.ogamexToken = m[1];
                      localStorage.setItem(TOKEN_LS_KEY, m[1]);
                    }
                  }
                } catch (_) {}
              }); } catch(_){}
            }).catch(()=>{});
            return p;
          }
          return origFetch.apply(this, arguments);
        };
        const OrigXHR = window.XMLHttpRequest;
        function PatchedXHR() {
          const xhr = new OrigXHR();
          let method = ""; let url = ""; let reqBody = "";
          const origOpen = xhr.open.bind(xhr);
          xhr.open = function(m, u) { method = m; url = u; return origOpen.apply(this, arguments); };
          const origSend = xhr.send.bind(xhr);
          xhr.send = function(body) {
            reqBody = body ? (body instanceof URLSearchParams ? body.toString() : (typeof body === "string" ? body : "<form>")) : "";
            xhr.addEventListener("load", () => {
              if (url.includes("/game/index.php")) {
                try { log("XHR "+method, url, reqBody, xhr.status, (xhr.responseText||"").length); } catch(_){}
              }
            });
            return origSend.apply(this, arguments);
          };
          return xhr;
        }
        PatchedXHR.prototype = OrigXHR.prototype;
        window.XMLHttpRequest = PatchedXHR;
        console.log("[OgameXSniff] installed — fetch + XHR wrapped, logging /game/index.php calls");
      } catch (e) { console.warn("[OgameXSniff] install failed", e); }
    })();
  `;
  env.doc.documentElement.appendChild(sniffer);
  setTimeout(() => { try { sniffer.remove(); } catch { /* gone */ } }, 500);

  // 3. Initial extraction from current page
  const resources = extractResources(env.doc);
  const storage = extractStorage(env.doc);
  const production = extractProduction(env.doc);
  const lifeform_resources = extractLifeformResources(env.doc);
  const events = extractIncomingEvents(env.doc);
  const planets = extractPlanets(env.doc);
  const fleets = extractFleetMovements(env.doc);
  const token = extractToken(env.doc, env.win as OgameWindow);

  // 4. Compose ogame_meta from <meta> tags (omit undefined keys for exactOptionalPropertyTypes)
  const universe = readMeta(env.doc, "ogame-universe");
  const universeSpeedRaw = readMeta(env.doc, "ogame-universe-speed");
  const playerIdMeta = readMeta(env.doc, "ogame-player-id");
  const playerNameMeta = readMeta(env.doc, "ogame-player-name");
  const planetCoordsMeta = readMeta(env.doc, "ogame-planet-coordinates");
  const allianceTagMeta = readMeta(env.doc, "ogame-alliance-tag");
  const ogame_meta: BootSummary["ogame_meta"] = {
    is_vacation_mode: detectVacationMode(env.doc),
  };
  if (universe !== undefined) ogame_meta.universe = universe;
  if (universeSpeedRaw !== undefined) ogame_meta.universe_speed = Number(universeSpeedRaw);
  if (playerIdMeta !== undefined) ogame_meta.player_id = playerIdMeta;
  if (playerNameMeta !== undefined) ogame_meta.player_name = playerNameMeta;
  if (planetCoordsMeta !== undefined) ogame_meta.planet_coords = planetCoordsMeta;
  if (allianceTagMeta !== undefined) ogame_meta.alliance_tag = allianceTagMeta;

  // 5. Seed StateStore with what we know
  const playerId = ogame_meta.player_id ?? "";
  const playerName = ogame_meta.player_name ?? "";
  const allianceTag = ogame_meta.alliance_tag ?? null;
  // Fetch /api/serverData.xml for the fleet + research speed multipliers
  // that aren't exposed via meta tags. ogame servers differ — Scorpius has
  // research=16, build=8; classic has both=1. We fire-and-forget here so
  // boot doesn't stall on the network; the result is patched into the
  // store via setPartial once it lands.
  void (async () => {
    try {
      const resp = await fetch("/api/serverData.xml", { credentials: "same-origin" });
      if (!resp.ok) return;
      const xml = await resp.text();
      const pick = (tag: string): number | undefined => {
        const m = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
        return m ? Number(m[1]) : undefined;
      };
      const econ = pick("speed");
      const resDiv = pick("researchDurationDivisor") ?? 1;
      const fleetP = pick("speedFleetPeaceful");
      const fleetW = pick("speedFleetWar");
      const fleetH = pick("speedFleetHolding");
      const patch: Partial<WorldState["server"]> = {};
      if (typeof econ === "number") patch.speed = econ;
      if (typeof econ === "number") patch.research_speed = econ * resDiv;
      if (typeof fleetP === "number") patch.fleet_peaceful_speed = fleetP;
      if (typeof fleetW === "number") patch.fleet_war_speed = fleetW;
      if (typeof fleetH === "number") patch.fleet_holding_speed = fleetH;
      if (Object.keys(patch).length > 0) {
        const prev = store.state.server;
        store.setPartial({ server: { ...prev, ...patch } });
      }
    } catch { /* boot must never throw on network errors */ }
  })();

  // ogame v12+ exposes fleet speeds in <meta> tags directly — read these
  // synchronously so the optimizer's first tick has accurate values
  // without waiting on the /api/serverData.xml async fetch above.
  const metaSpeedFleetP = readMeta(env.doc, "ogame-universe-speed-fleet-peaceful");
  const metaSpeedFleetW = readMeta(env.doc, "ogame-universe-speed-fleet-war");
  const metaSpeedFleetH = readMeta(env.doc, "ogame-universe-speed-fleet-holding");
  // Stamp our userscript version into the snapshot so /v1/state lets the
  // operator see which version is actually running (vs the served bundle).
  // Manually kept in sync with rollup.config.js @version banner.
  const USERSCRIPT_VERSION = "0.0.234";
  console.log(`[OgameX] runtime version ${USERSCRIPT_VERSION} booting on ${location.href}`);
  // (meta-probes / extractProduction / box-title / window.production /
  //  reloadResources extractor traces silenced — extractor stable, schema
  //  stable. Errors still surface from parse-error path below.)
  void extractProduction(env.doc);
  const winAny = env.win;
  void (winAny.production || winAny.productionRates || winAny.resourcesData);
  for (const s of Array.from(env.doc.querySelectorAll("script"))) {
    const txt = s.textContent ?? "";
    const m = txt.match(/reloadResources\(\s*(\{[\s\S]*?"resources"[\s\S]*?\})\s*\)/);
    if (m) {
      try { JSON.parse(m[1]); } catch (e) {
        console.warn(`[OgameX] reloadResources parse error:`, (e as Error).message);
      }
      break;
    }
  }
  store.setPartial({
    server: {
      universe: ogame_meta.universe ?? "",
      speed: ogame_meta.universe_speed ?? 1,
      // userscript_version is non-typed here (extra field) — sidecar
      // listState passes through any extra server fields, so /v1/state
      // surfaces it for "which version is connected" debugging.
      userscript_version: USERSCRIPT_VERSION,
      ...(metaSpeedFleetP ? { fleet_peaceful_speed: Number(metaSpeedFleetP) } : {}),
      ...(metaSpeedFleetW ? { fleet_war_speed: Number(metaSpeedFleetW) } : {}),
      ...(metaSpeedFleetH ? { fleet_holding_speed: Number(metaSpeedFleetH) } : {}),
    } as any,
    player: {
      id: playerId,
      name: playerName,
      alliance: allianceTag,
    },
    events_incoming: events,
    fleets_outbound: fleets,
  });

  // 6. Wire dom.changed → re-extract on the affected target
  const offDomChanged = bus.on("dom.changed", (payload: unknown) => {
    const p = payload as { targetId?: string } | undefined;
    const targetId = p?.targetId;
    if (!targetId) return;
    if (targetId.startsWith("resources_")) {
      const r = extractResources(env.doc);
      const prod = extractProduction(env.doc);
      if (r || prod) {
        // Route updates to the ACTIVE planet (per `<meta name="ogame-planet-id">`).
        // Production is needed by the bridge optimizer for "矿升到几级最快" —
        // without it, prodPerSec=0 and every mine candidate gets discarded.
        const cur = store.state;
        const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        const existing = activeIdRaw ? cur.planets[activeIdRaw] : undefined;
        if (existing) {
          const updatedPlanet = {
            ...existing,
            ...(r ? { resources: { m: r.m, c: r.c, d: r.d, e: r.e ?? 0 } } : {}),
            ...(prod ? { production: { m_h: prod.m_h, c_h: prod.c_h, d_h: prod.d_h } } : {}),
          };
          store.setPartial({ planets: { ...cur.planets, [activeIdRaw]: updatedPlanet } });
        }
      }
    }
    if (targetId === "eventContent") {
      const evs = extractIncomingEvents(env.doc);
      store.setPartial({ events_incoming: evs });
    }
    if (targetId === "movement") {
      const fls = extractFleetMovements(env.doc);
      store.setPartial({ fleets_outbound: fls });
    }
    if (targetId === "planetList") {
      const pls = mergeWithExistingPlanets(extractPlanets(env.doc), store.state.planets);
      if (Object.keys(pls).length > 0) store.setPartial({ planets: pls });
    }
  });

  // 6b. Boot-time race: planetList sometimes renders AFTER document-end. Schedule
  //     a one-shot re-extract at +500ms + +2000ms to catch late renders. The
  //     dom.changed MO handler above covers all later updates.
  const schedulePlanetReExtract = (delayMs: number): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      const pls = mergeWithExistingPlanets(extractPlanets(env.doc), store.state.planets);
      const newCount = Object.keys(pls).length;
      const oldCount = Object.keys(store.state.planets).length;
      if (newCount > 0 && newCount !== oldCount) {
        store.setPartial({ planets: pls });
      }
      // Same window: harvest building / research levels from current page.
      mergeTechLevels(env.doc, store);
    }, delayMs);
  const lateExtract1 = schedulePlanetReExtract(500);
  const lateExtract2 = schedulePlanetReExtract(2000);
  // Also harvest immediately so the very first state.snapshot push carries
  // real building/research levels when the page is fully rendered at boot.
  mergeTechLevels(env.doc, store);

  // Boot-time production harvest — the dom.changed handler above writes
  // production on `resources_*` mutations, but on the very first page
  // load there's no mutation yet. Retry a few times until planets is
  // populated by the late re-extracts (mergeWithExistingPlanets runs at
  // +500ms/+2000ms), then snapshot resources+production into the ACTIVE
  // planet (resolved via `<meta name="ogame-planet-id">`).
  const harvestProduction = (): boolean => {
    const prod = extractProduction(env.doc);
    const res = extractResources(env.doc);
    if (!prod && !res) return false;
    const cur = store.state;
    if (Object.keys(cur.planets).length === 0) return false;
    const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    const existing = activeIdRaw ? cur.planets[activeIdRaw] : undefined;
    if (!existing) return false;
    const updatedPlanet = {
      ...existing,
      ...(res ? { resources: { m: res.m, c: res.c, d: res.d, e: res.e ?? 0 } } : {}),
      ...(prod ? { production: { m_h: prod.m_h, c_h: prod.c_h, d_h: prod.d_h } } : {}),
    };
    store.setPartial({ planets: { ...cur.planets, [activeIdRaw]: updatedPlanet } });
    return true;
  };
  // Try immediately + at the same checkpoints the planet extractor uses.
  if (!harvestProduction()) {
    const harvestRetries = [200, 700, 2100, 4500].map((ms) =>
      setTimeout(() => { harvestProduction(); }, ms),
    );
    void harvestRetries; // keep handles alive — cleared at stop()
  }

  // ─── research / build / shipyard queue harvest ─────────────────────────
  // Scans the page for active queues (li.technology[data-status="active"])
  // and writes them into state. Without this, the planner doesn't know a
  // research is already in flight and keeps computing full ETA. Runs at
  // boot + every dom.changed event so queue stays fresh.
  // Map li[data-technology="<id>"] → canonical name. Reuse the reverse of
  // the executor's table — but boot.ts can't see it; hard-code the small
  // set we actually research/build.
  // Sourced from shared/tech_ids.ts — single source of truth for tech IDs.
  const TECH_ID_TO_NAME = TECH_NAME_BY_ID as Record<string, string>;
  const RESEARCH_NUMERIC_RE = /^(10[6-9]|11[0-9]|12[0-4]|199)$/; // 106-124 + 199
  // Ships inventory extractor — runs on shipyard page. Each ship li has
  // a count rendered either as `<span class="amount">N</span>` inside the
  // li OR baked into `data-tooltip-title="<name> (N)<br/>...". Read both;
  // first hit wins. Without this, Object.values(state.planets ?? {})[0].ships stays empty and
  // the bridge's expedition daemon never realizes ships are built.
  const SHIP_NUMERIC_RE = /^(20[2-9]|21[0-9]|217|218|219)$/;
  const SHIP_ID_TO_NAME = TECH_NAME_BY_ID as Record<string, string>;
  function harvestShips(): void {
    // GATED: only run on shipyard / fleetdispatch pages. On overview/research/
    // other pages, li.technology with data-technology="203" can be present
    // (e.g. ship-build preview, expedition slot indicator) but its tooltip's
    // "(N)" refers to something OTHER than ship-owned count (e.g. "expedition
    // slots used: 1") — writing N=1 there clobbers empire's correct 1500.
    //
    // Empire endpoint IS the multi-planet ship source. DOM-harvest only as
    // belt-and-braces for the CURRENT planet on fleet pages.
    const pageUrl = (env.win.location?.href ?? "");
    if (!/component=(shipyard|fleetdispatch)/.test(pageUrl)) return;
    const lis = env.doc.querySelectorAll<HTMLElement>('li.technology[data-technology]');
    if (lis.length === 0) return;
    const out: Record<string, number> = {};
    for (const li of lis) {
      const numeric = li.getAttribute("data-technology") ?? "";
      if (!SHIP_NUMERIC_RE.test(numeric)) continue;
      const name = SHIP_ID_TO_NAME[numeric];
      if (!name) continue;
      // Only trust explicit data-max-amount (ogame's launchable count).
      const inputEl = li.querySelector<HTMLInputElement>('input[name^="am"][data-max-amount]');
      const dataMax = inputEl?.getAttribute("data-max-amount");
      if (dataMax && /^\d+$/.test(dataMax)) {
        out[name] = parseInt(dataMax, 10);
      }
    }
    if (Object.keys(out).length === 0) return;
    const cur = store.state;
    if (Object.keys(cur.planets).length === 0) return;
    const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    const target = activeIdRaw ? cur.planets[activeIdRaw] : undefined;
    if (!target) return;
    const updatedPlanet = { ...target, ships: { ...(target.ships ?? {}), ...out } };
    store.setPartial({ planets: { ...cur.planets, [activeIdRaw]: updatedPlanet } });
  }
  // Run on boot + retries (shipyard page DOM mounts late).
  [600, 2200, 4600].forEach((ms) => setTimeout(harvestShips, ms));

  // PRIMARY: fetch ogame's movement page → count real fleet entries by
  // mission_type. Server-side truth, no DOM scraping ambiguity.
  async function harvestSlotsFromMovement(): Promise<void> {
    try {
      const url = "/game/index.php?page=componentOnly&component=movement&ajax=1";
      const resp = await env.win.fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!resp.ok) return;
      const html = await resp.text();
      // Parse each fleet block — capture mission type + surrounding HTML so
      // we can extract origin/destination coords. ogame v12 renders each
      // fleet as <div class="fleetDetails" data-mission-type="N">...</div>
      // with coords in <span class="originCoords">[G:S:P]</span> etc.
      const allFleetEls = Array.from(html.matchAll(/data-mission-type="(\d+)"/g));
      const usedFleet = allFleetEls.length;
      const usedExp = allFleetEls.filter((m) => m[1] === "15").length;
      // Parse each <li class="fleetDetails"> block with its inner coords.
      const fleetBlockRe = /<(?:li|div)[^>]+(?:class="fleetDetails[^"]*"|data-mission-type="\d+")[^>]*?>([\s\S]*?)(?=<(?:li|div)[^>]+(?:class="fleetDetails|data-mission-type=)|<\/(?:tbody|ul|table)>)/g;
      // Diagnostic: dump first fleet inner block once per session so we
      // can see actual ogame v12 HTML format for arrival_at / coords.
      if (!(env.win as Window & { __ogamexMovDump?: boolean }).__ogamexMovDump) {
        (env.win as Window & { __ogamexMovDump?: boolean }).__ogamexMovDump = true;
        // (movement-dump silenced — was useful only for first-extractor verify)
      }
      const parsedFleets = Array.from(html.matchAll(fleetBlockRe)).map((m) => {
        const block = m[0] ?? "";
        const inner = m[1] ?? "";
        const missionM = block.match(/data-mission-type="(\d+)"/);
        const mission = missionM ? parseInt(missionM[1]!, 10) : 0;
        // Find ALL coords [G:S:P] in the inner block. First = origin, last = dest.
        const coordsList = Array.from(inner.matchAll(/\[(\d+):(\d+):(\d+)\]/g)).map((cm) =>
          [parseInt(cm[1]!, 10), parseInt(cm[2]!, 10), parseInt(cm[3]!, 10)] as readonly number[]
        );
        // ogame v12 movement renders <span class="timer tooltip" title="DD.MM.YYYY HH:MM:SS" ...>
        // Parse from title attribute (no data-end-time attr in this skin).
        let arrival_at = 0;
        const titleMatch = inner.match(/<span\s+class="timer[^"]*"\s+title="(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})"/i);
        if (titleMatch) {
          const [, dd, mm, yyyy, hh, mi, ss] = titleMatch;
          // Scorpius server runs UTC+1. Title shows server's wall-clock time.
          // Convert: UTC epoch = parse-as-UTC(server-wall-clock) - 1h offset.
          const SERVER_TZ_OFFSET_MS = 1 * 3600 * 1000;
          const tsServerWall = Date.UTC(parseInt(yyyy!, 10), parseInt(mm!, 10) - 1, parseInt(dd!, 10),
                                        parseInt(hh!, 10), parseInt(mi!, 10), parseInt(ss!, 10));
          arrival_at = tsServerWall - SERVER_TZ_OFFSET_MS;
        }
        // Legacy fallback for other ogame skins with data-end-time attr.
        if (!arrival_at) {
          const dataMatch = inner.match(/data-(?:end-time|arrival-time|end)="(\d+)"/i);
          if (dataMatch) {
            const n = parseInt(dataMatch[1]!, 10);
            arrival_at = n < 1e12 ? n * 1000 : n;
          }
        }
        const returnMatch = inner.match(/data-return-time="(\d+)"/i) ?? inner.match(/data-return="(\d+)"/i);
        let return_at: number | null = null;
        if (returnMatch) {
          const n = parseInt(returnMatch[1]!, 10);
          return_at = n < 1e12 ? n * 1000 : n;
        }
        // expedition (mission=15) always targets G:S:16 — derive dest from
        // origin instead of unreliable HTML coord extraction.
        const origin = coordsList[0];
        let dest = coordsList[coordsList.length - 1];
        if (mission === 15 && origin && origin.length === 3) {
          dest = [origin[0]!, origin[1]!, 16] as readonly number[];
        }
        return { mission, origin, dest, arrival_at, return_at };
      });
      // Max slots typically displayed as "fleet slots used: 1/4" in HTML.
      const maxFleetMatch =
        html.match(/(?:[Ff]leets?|艦隊|舰队)[^<]{0,30}?(\d+)\s*\/\s*(\d+)/)
        ?? html.match(/(\d+)\s*\/\s*(\d+)[^<]{0,30}?(?:[Ff]leets?|艦隊|舰队)/);
      const maxExpMatch =
        html.match(/(?:[Ee]xpedit\w*|遠征|远征)[^<]{0,30}?(\d+)\s*\/\s*(\d+)/)
        ?? html.match(/(\d+)\s*\/\s*(\d+)[^<]{0,30}?(?:[Ee]xpedit\w*|遠征|远征)/);
      const maxFleet = maxFleetMatch ? parseInt(maxFleetMatch[2]!, 10) : 0;
      const maxExp = maxExpMatch ? parseInt(maxExpMatch[2]!, 10) : 0;
      // Sanity guard: if scrape shows usedExp=0 but previous tick had ≥2,
      // and the HTML looks suspiciously short (could be a render race or
      // ogame transient empty page), SKIP the write. Avoids panel flashing
      // "0/3" between expedition return and next launch.
      const prevUsed = store.state.server?.used_expedition_slots ?? 0;
      const suspicious = prevUsed >= 2 && usedExp === 0 && allFleetEls.length === 0;
      if (suspicious) {
        console.warn(`[OgameX/movement] suspicious drop ${prevUsed}→0 (html=${html.length}B). Skipping write — preserving last-known value.`);
        return;
      }
      // /movement hostile detection REMOVED (v0.0.219).
      // Was added v0.0.217 as bandaid before the right signal was found.
      // Operator clarified: red enemy spy lives in #eventContent DOM (page-
      // wide events widget), not /movement. eventbox_hook installs a
      // MutationObserver on #eventContent that injects events_incoming
      // entries with prefix "evrow-" directly. /movement endpoint stays for
      // slot counts + own fleet list only.
      // (movement summary silenced — slots are tracked, no repeated log needed)
      // Synthesize fleets_outbound entries from parsedFleets (has origin+dest).
      // Fall back to allFleetEls count if parser missed entries.
      const sourceList = parsedFleets.length === allFleetEls.length ? parsedFleets : allFleetEls.map((m) => ({
        mission: parseInt(m[1]!, 10),
        origin: undefined as readonly number[] | undefined,
        dest: undefined as readonly number[] | undefined,
      }));
      const syntheticFleets = sourceList.map((f, idx) => ({
        id: `mvt-${idx}`,
        mission: f.mission,
        origin: f.origin,
        dest: f.dest,
        arrival_at: (f as { arrival_at?: number }).arrival_at ?? 0,
        return_at: (f as { return_at?: number | null }).return_at ?? null,
        ships: {} as Record<string, number>,
      })) as unknown as typeof cur.fleets_outbound;
      const cur = store.state;
      store.setPartial({
        server: {
          ...(cur.server ?? {}),
          ...(maxExp > 0 ? { max_expedition_slots: maxExp, used_expedition_slots: usedExp } : { used_expedition_slots: usedExp }),
          ...(maxFleet > 0 ? { max_fleet_slots: maxFleet, used_fleet_slots: usedFleet } : { used_fleet_slots: usedFleet }),
        } as typeof cur.server,
        fleets_outbound: syntheticFleets,
      });
    } catch (e) {
      void e;
    }
  }
  setTimeout(() => { void harvestSlotsFromMovement(); }, 2000);
  // 30s → 10s. Operator observed state.fleets_outbound stale by 1 fleet
  // after return (ogame /movement showed 5, state showed 6). 30s window
  // missed the return; 10s catches faster. Cost: ~6 req/min extra to
  // /movement endpoint (acceptable, was pollFetchResources's old rate).
  setInterval(() => { if (!userBusy()) void harvestSlotsFromMovement(); }, 10_000);
  // Expose so eventbox hook can fire it on fleet-count delta detection.
  (env.win as Window & { __ogamexHarvestMovement?: () => Promise<void> }).__ogamexHarvestMovement = harvestSlotsFromMovement;

  // PARASITIC EVENTBOX HOOK — replaces failed /movement-based pollInboundFleets.
  // Rationale (corrected from earlier design): /movement endpoint returns ONLY
  // MY OWN outgoing fleets, NEVER foreign incoming. Incoming attack/spy events
  // live in ogame's eventList endpoint, which the native client polls every 5s.
  // We hook XHR + fetch to PARASITIZE that poll — zero extra requests, perfect
  // sync with what ogame's UI itself sees. Watchdog self-fetches if ogame's
  // own poll stalls (tab backgrounded). See probes/eventbox_hook.ts.
  const eventboxHook = installEventBoxHook({ store, win: env.win });
  void eventboxHook; // handle kept alive via closure; .stop() if we add teardown

  // BACKUP: fetch fleetdispatch page directly for slot caps. That page
  // ALWAYS renders "艦隊:X/Y 遠征艦隊:N/M" regardless of which page operator
  // is currently on. Used when movement endpoint regex can't find caps.
  async function harvestSlotsFromFleetdispatch(): Promise<void> {
    try {
      const url = "/game/index.php?page=ingame&component=fleetdispatch";
      const resp = await env.win.fetch(url, { credentials: "same-origin" });
      if (!resp.ok) return;
      const html = await resp.text();
      // Look for the slots container with fleet + expedition pairs in order.
      // ogame v12 uses <div id="slots">...艦隊:1/2 遠征艦隊:1/2...</div>
      // Match #slots container then scan its inner HTML for the
      // 艦隊:X/Y 遠征艦隊:N/M pattern directly (more robust than
      // generic "first 2 digit pairs"). ogame v12 always has both
      // labels even on fetched HTML.
      const fleetLabel = html.match(/(?:艦隊|舰队|[Ff]leet)\s*:?\s*(\d+)\s*\/\s*(\d+)/);
      const expLabel = html.match(/(?:遠征艦隊|远征舰队|遠征|[Ee]xpedit\w*)\s*:?\s*(\d+)\s*\/\s*(\d+)/);
      // Diagnostic: dump first occurrence of each label's surrounding text
      // so we can see actual ogame HTML format. Run once per session.
      if (!(env.win as Window & { __ogamexDumpedFd?: boolean }).__ogamexDumpedFd) {
        (env.win as Window & { __ogamexDumpedFd?: boolean }).__ogamexDumpedFd = true;
        // (fd-dump silenced — slot extraction works)
        void html;
      }
      const pairs: Array<readonly [number, number]> = [];
      if (fleetLabel) pairs.push([parseInt(fleetLabel[1]!, 10), parseInt(fleetLabel[2]!, 10)]);
      else pairs.push([0, 0]);
      if (expLabel) pairs.push([parseInt(expLabel[1]!, 10), parseInt(expLabel[2]!, 10)]);
      else pairs.push([0, 0]);
      if (pairs.length === 0) return;
      const [usedFleet, maxFleet] = pairs[0] ?? [0, 0];
      const [usedExp, maxExp] = pairs[1] ?? [0, 0];
      if (maxExp > 0 || maxFleet > 0) {
        console.info(`[OgameX/fd-bg] fleetdispatch fetched: fleet=${usedFleet}/${maxFleet} expedition=${usedExp}/${maxExp}`);
        // Persist max_expedition_slots to localStorage so subsequent ticks
        // remember it even if scraper momentarily can't find label text.
        if (maxExp > 0) try { env.win.localStorage.setItem("OGAMEX_MAX_EXP", String(maxExp)); } catch { /* */ }
        if (maxFleet > 0) try { env.win.localStorage.setItem("OGAMEX_MAX_FLEET", String(maxFleet)); } catch { /* */ }
        const cur = store.state;
        store.setPartial({
          server: {
            ...(cur.server ?? {}),
            ...(maxExp > 0 ? { max_expedition_slots: maxExp, used_expedition_slots: usedExp } : {}),
            ...(maxFleet > 0 ? { max_fleet_slots: maxFleet, used_fleet_slots: usedFleet } : {}),
          } as typeof cur.server,
        });
      }
    } catch (e) { void e; }
  }
  setTimeout(() => { void harvestSlotsFromFleetdispatch(); }, 3500);
  setInterval(() => { if (!userBusy()) void harvestSlotsFromFleetdispatch(); }, 30_000);

  // (pollEventList REMOVED — parasitic eventbox_hook now handles eventList
  //  intercept via ogame's own native 5s poll. Self-fetch watchdog inside
  //  the hook covers the gap when ogame's poll stalls.)

  // FALLBACK: scrape from current page DOM (less reliable):
  // Extract BOTH used & max because ogame's `floor(sqrt)` formula misses
  // class/lifeform bonuses AND we can't count expedition fleets in
  // fleets_outbound when the page didn't render them.
  function harvestSlots(): void {
    // Scan the WHOLE document body for the labelled pairs. ogame uses
    // <span> with classes like `tooltipHTML`, but the text is everywhere.
    // ogame v12 fleetdispatch renders slot counters in a specific element.
    // Most-targeted path: `#slots` div with two children "1/2" + "1/2".
    // Fall back to scanning the page for labelled "<label> N/M" patterns.
    let max_fleet = 0, used_fleet = 0;
    let max_expedition = 0, used_expedition = 0;
    // Target 1: ogame's #slots / .slots container — render-stable across skins.
    const slotsEl = env.doc.querySelector<HTMLElement>("#slots, .slots, #fleetstatusbar, .fleetstatusbar");
    if (slotsEl) {
      // Children typically: fleet slot first, expedition slot second.
      // Parse with order-aware regex on the textContent.
      const txt = slotsEl.textContent ?? "";
      // Look for two "N/M" pairs in order.
      const pairs = Array.from(txt.matchAll(/(\d+)\s*\/\s*(\d+)/g)).map((m) => [parseInt(m[1]!, 10), parseInt(m[2]!, 10)] as const);
      // (slots-container diagnostic silenced — extractor stable)
      if (pairs.length >= 1) { used_fleet = pairs[0]![0]; max_fleet = pairs[0]![1]; }
      if (pairs.length >= 2) { used_expedition = pairs[1]![0]; max_expedition = pairs[1]![1]; }
    }
    // No fallback body-scan — it picks up `🛸 Expeditions 1/1 (astro 2)`
    // tooltip text on supplies/overview which is NOT the real slot count.
    // The real slot count lives in #slots container only. If that's not
    // present on this page, fleetdispatch bg fetcher fills it.
    if (max_expedition === 0 && max_fleet === 0) return;
    // Persist max to localStorage so other pages / next boot keep the value.
    if (max_expedition > 0) try { env.win.localStorage.setItem("OGAMEX_MAX_EXP", String(max_expedition)); } catch { /* */ }
    if (max_fleet > 0) try { env.win.localStorage.setItem("OGAMEX_MAX_FLEET", String(max_fleet)); } catch { /* */ }
    const cur = store.state;
    store.setPartial({
      server: {
        ...(cur.server ?? {}),
        ...(max_expedition > 0 ? { max_expedition_slots: max_expedition, used_expedition_slots: used_expedition } : {}),
        ...(max_fleet > 0 ? { max_fleet_slots: max_fleet, used_fleet_slots: used_fleet } : {}),
      } as typeof cur.server,
    });
    // (slots-extracted log silenced — running every 5-8s, no diagnostic value
    //  in steady state. Resurfaces via server.{max,used}_*_slots in /v1/state.)
  }
  // Boot retries + continuous 30s interval so max never gets stuck stale
  // if the user navigated to a page without expedition text on boot.
  [800, 2400, 4800, 10_000, 20_000].forEach((ms) => setTimeout(harvestSlots, ms));
  setInterval(() => { if (!userBusy()) harvestSlots(); }, 30_000);

  function harvestQueues(): void {
    const actives = env.doc.querySelectorAll<HTMLElement>('li.technology[data-status="active"]');
    if (actives.length === 0) return;
    for (const li of actives) {
      const numeric = li.getAttribute("data-technology") ?? "";
      const name = TECH_ID_TO_NAME[numeric];
      if (!name) continue;
      // ogame renders countdown via either <time data-end> or a child
      // <span class="time"> with epoch in attribute. Probe multiple shapes.
      const timeEl = li.querySelector<HTMLElement>("[data-end], time, .time");
      let ends_at: number | null = null;
      const endAttr = timeEl?.getAttribute("data-end") ?? timeEl?.getAttribute("data-target-time");
      if (endAttr) {
        const n = Number(endAttr);
        if (Number.isFinite(n)) ends_at = n * (n < 1e12 ? 1000 : 1);
      }
      // Fallback: parse hh:mm:ss in textContent → relative offset.
      if (ends_at === null) {
        const txt = timeEl?.textContent ?? li.textContent ?? "";
        const m = txt.match(/(\d+)h\s*(\d+)m\s*(\d+)s/i)
              ?? txt.match(/(\d+):(\d+):(\d+)/);
        if (m) {
          const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          ends_at = Date.now() + sec * 1000;
        }
      }
      const technology_id = parseInt(numeric, 10);
      const kind = idKind(technology_id);
      if (kind === "research") {
        // research queue is player-global
        const cur = store.state.research ?? { levels: {}, queue: null };
        const target_level = (cur.levels[name] ?? 0) + 1;
        store.setPartial({
          research: {
            ...cur,
            queue: { tech: name, technology_id, level: target_level, ends_at: ends_at ?? Date.now() + 60000 } as typeof cur.queue,
          },
        });
        console.log(`[OgameX] research queue: ${name} L${target_level} ends_at=${ends_at}`);
      } else if (kind === "ship" || kind === "defense") {
        // shipyard queue on active planet (resolved via meta tag)
        const cur = store.state;
        if (Object.keys(cur.planets).length === 0) continue;
        const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        const target = activeIdRaw ? cur.planets[activeIdRaw] : undefined;
        if (!target) continue;
        const cnt = (target.ships?.[name] ?? 0);
        const updatedPlanet = {
          ...target,
          shipyard_q: { ship: name, technology_id, count: cnt + 1, ends_at: ends_at ?? Date.now() + 60000 } as typeof target.shipyard_q,
        };
        store.setPartial({ planets: { ...cur.planets, [activeIdRaw]: updatedPlanet } });
        console.log(`[OgameX] shipyard queue (planet ${activeIdRaw}): ${name}`);
      } else {
        // building queue on active planet (resolved via meta tag)
        const cur = store.state;
        if (Object.keys(cur.planets).length === 0) continue;
        const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        const target = activeIdRaw ? cur.planets[activeIdRaw] : undefined;
        if (!target) continue;
        const target_level = (target.buildings?.[name] ?? 0) + 1;
        const updatedPlanet = {
          ...target,
          build_q: { building: name, technology_id, level: target_level, ends_at: ends_at ?? Date.now() + 60000 } as typeof target.build_q,
        };
        store.setPartial({ planets: { ...cur.planets, [activeIdRaw]: updatedPlanet } });
        console.log(`[OgameX] build queue (planet ${activeIdRaw}): ${name} L${target_level}`);
      }
    }
  }
  // Run at +500ms (after planets settle) + retry windows.
  [600, 2200, 4600].forEach((ms) => setTimeout(harvestQueues, ms));
  // Also re-run on any DOM mutation in research/supplies areas.
  bus.on("dom.changed", (payload: unknown) => {
    const p = payload as { targetId?: string } | undefined;
    const t = p?.targetId ?? "";
    if (t.includes("technologies") || t.includes("buildlist") || t.includes("queue")) {
      harvestQueues();
    }
  });

  // ─── Background page refresher ─────────────────────────────────────────
  // Periodically fetch ogame pages in the background (same-origin, no UI
  // disruption) and re-run extractors on the fetched HTML. Without this,
  // state.research.queue / planet.build_q / ships go stale when the
  // operator isn't actively navigating between supplies/facilities/
  // research/shipyard. ApiExecutor already token-fetches each page on
  // dispatch; this complements that by keeping STATE fresh, not just
  // tokens.
  // PRIMARY state poller — ogame's own fetchResources JSON endpoint
  // returns resources + queue + production + planet data atomically.
  // Way faster than HTML page scraping. Updates state every 5s.
  async function pollFetchResources(): Promise<void> {
    try {
      // Only poll CURRENT planet. Earlier we rotated through all planets
      // to refresh stale lifeform_resources, but every cp= GET sets the
      // ogame session current-planet cookie. That poisoned ApiExec
      // sendFleet (sees wrong planet → 140054 可用艦船不足). Cross-planet
      // resource freshness now comes from refreshOnePage which is rate-
      // limited and runs less frequently. Worst case stale colony data
      // for a few minutes is acceptable; broken expeditions are not.
      const planetId = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
      if (!planetId) return;
      const url = `/game/index.php?page=fetchResources&ajax=1&cp=${planetId}`;
      const resp = await env.win.fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!resp.ok) return;
      const j = await resp.json() as Record<string, unknown> & {
        resources?: { metal?: { amount?: number; production?: number }; crystal?: { amount?: number; production?: number }; deuterium?: { amount?: number; production?: number }; energy?: { amount?: number } };
        techs?: Record<string, { count?: number }>;
        buildqueue?: Array<{ technologyId?: number; level?: number; endTime?: number; ends_at?: number; name?: string }>;
        researchqueue?: Array<{ technologyId?: number; level?: number; endTime?: number; name?: string }>;
        shipyardqueue?: Array<{ technologyId?: number; count?: number; endTime?: number; name?: string }>;
      };
      // (fetchResources top-level key dump silenced — schema stable.)
      const cur = store.state;
      const patch: Partial<typeof cur> = {};
      // Resources — route to ACTIVE planet (per-planet, like buildings/ships).
      // fetchResources returns whatever planet ogame is currently displaying;
      // writing it to home's slot would clobber colony data and vice-versa.
      const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
      const existing = activeIdRaw ? cur.planets[activeIdRaw] : undefined;
      if (j.resources && existing) {
        type PlanetT = typeof existing;
        const m = j.resources.metal?.amount ?? existing.resources?.m ?? 0;
        const c = j.resources.crystal?.amount ?? existing.resources?.c ?? 0;
        const d = j.resources.deuterium?.amount ?? existing.resources?.d ?? 0;
        const e = j.resources.energy?.amount ?? existing.resources?.e ?? 0;
        // Lifeform: population.storage = 生活空間 (living_space), food.capableToFeed = 酒足飯飽 (well_fed).
        // Operator rule: build residentialSector unless living_space > well_fed.
        const popJson = (j.resources as { population?: { amount?: number; storage?: number } }).population;
        const foodJson = (j.resources as { food?: { amount?: number; capableToFeed?: number } }).food;
        const lf_population = popJson?.amount ?? null;
        const lf_living_space = popJson?.storage ?? null;
        const lf_well_fed = foodJson?.capableToFeed ?? null;
        const lf_food_amount = foodJson?.amount ?? null;
        const lfExtra = (lf_living_space !== null || lf_well_fed !== null) ? {
          lifeform_resources: {
            population: lf_population, living_space: lf_living_space,
            well_fed: lf_well_fed, food: lf_food_amount,
          },
        } : {};
        let updatedPlanet: PlanetT = { ...existing, resources: { m, c, d, e }, ...lfExtra };
        // Production
        if (j.resources.metal?.production != null) {
          updatedPlanet = {
            ...updatedPlanet,
            production: {
              m_h: Math.round((j.resources.metal.production ?? 0) * 3600),
              c_h: Math.round((j.resources.crystal?.production ?? 0) * 3600),
              d_h: Math.round((j.resources.deuterium?.production ?? 0) * 3600),
            },
          };
        }
        // Build/Shipyard/Research queue: ONLY update if fetchResources
        // actually carries the field. This server doesn't include them;
        // clearing on absence would clobber the HTML-scraped truth.
        if (Array.isArray(j.buildqueue)) {
          const bq = j.buildqueue[0];
          if (bq && bq.technologyId) {
            const name = TECH_NAME_BY_ID[bq.technologyId];
            if (name) {
              updatedPlanet = {
                ...updatedPlanet,
                build_q: { building: name, technology_id: bq.technologyId, level: bq.level ?? 1, ends_at: (bq.endTime ?? bq.ends_at ?? 0) * 1000 } as PlanetT["build_q"],
              };
            }
          } else {
            updatedPlanet = { ...updatedPlanet, build_q: null };
          }
        }
        if (Array.isArray(j.shipyardqueue)) {
          const sq = j.shipyardqueue[0];
          if (sq && sq.technologyId) {
            const sname = TECH_NAME_BY_ID[sq.technologyId];
            if (sname) {
              updatedPlanet = {
                ...updatedPlanet,
                shipyard_q: { ship: sname, technology_id: sq.technologyId, count: sq.count ?? 1, ends_at: ((sq.endTime ?? 0) * 1000) } as PlanetT["shipyard_q"],
              };
            }
          } else {
            updatedPlanet = { ...updatedPlanet, shipyard_q: null };
          }
        }
        patch.planets = { ...cur.planets, [activeIdRaw]: updatedPlanet };
      }
      // Research queue — same field-presence guard.
      if (Array.isArray(j.researchqueue)) {
        const rq = j.researchqueue[0];
        if (rq && rq.technologyId) {
          const tname = TECH_NAME_BY_ID[rq.technologyId];
          // Carry BOTH canonical name (for display) AND numeric id (for
          // robust comparison) — see Pass 2 refactor 2026-05-21.
          if (tname) patch.research = { ...cur.research, queue: { tech: tname, technology_id: rq.technologyId, level: rq.level ?? 1, ends_at: ((rq.endTime ?? 0) * 1000) } as typeof cur.research.queue };
        } else if (cur.research?.queue) {
          patch.research = { ...cur.research, queue: null };
        }
      }
      if (Object.keys(patch).length > 0) {
        store.setPartial(patch);
        // (silenced — happens every 5s, expected steady-state)
      }
    } catch (e) {
      void e;
    }
  }
  // Boot seed + 30s safety net (was 5s — 12 req/min). 30s = 2/min, light.
  // ogame's own client polls /fetchResources every 5s for its resource bar;
  // we COULD parasite via eventbox_hook (isFetchResourcesURL filter wired)
  // — but the parser is tightly coupled to the fetch here. Lighter to just
  // slow our own poll than refactor parser into a callable. Operator
  // directive "改成事件触发": event-driven via DOM mutation observers
  // already updates resources when user navigates; this 30s is just for
  // background-tab cases where mutations don't fire.
  setTimeout(() => { void pollFetchResources(); }, 1500);
  setInterval(() => { if (!userBusy()) void pollFetchResources(); }, 30_000);

  // Expedition mail poller — DISABLED per operator. Function kept for
  // re-enable if needed; the schedule calls below are commented out.
  // Rationale: stats were classified but never consumed by anything
  // critical (just localStorage write), so the every-5min fetch + log
  // wasn't load-bearing. If a danger-rate throttle is wanted later,
  // re-enable by uncommenting the setTimeout+setInterval.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  async function _pollExpeditionMails_DISABLED(): Promise<void> {
    try {
      const url = `/game/index.php?page=componentOnly&component=messages&asJson=1&action=getMessagesList`;
      const resp = await env.win.fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body: "activeSubTab=22&showTrash=false",
      });
      if (!resp.ok) return;
      const txt = await resp.text();
      try {
        const j = JSON.parse(txt) as { status?: string; messages?: unknown; messagesContent?: unknown; components?: unknown };
        const msgs = (j as { messages?: unknown[] }).messages;
        const SAFE_RE = /未被探索|第一批|未探索|virgin|unexplored/i;
        const DANGER_RE = /遇到其他人|已經先來過|已经先来过|有人.*先到|pirate|hostile|encountered/i;
        let safe = 0, danger = 0, total = 0;
        const scan = (text: string): void => {
          total++;
          if (SAFE_RE.test(text)) safe++;
          else if (DANGER_RE.test(text)) danger++;
        };
        if (Array.isArray(msgs)) for (const m of msgs) scan(JSON.stringify(m));
        const rate = total > 0 ? danger / total : 0;
        console.log(`[OgameX/mail-poll] outcomes: safe=${safe} danger=${danger} total=${total} danger_rate=${(rate*100).toFixed(0)}%`);
        try { localStorage.setItem("OGAMEX_EXP_STATS", JSON.stringify({ safe, danger, total, rate, ts: Date.now() })); } catch (_) { void _; }
      } catch (_) {
        console.log(`[OgameX/mail-poll] non-JSON resp[0:200]=${txt.slice(0,200)}`);
      }
    } catch (e) { void e; }
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
  void _pollExpeditionMails_DISABLED;
  // setTimeout(() => { void _pollExpeditionMails_DISABLED(); }, 5000);
  // setInterval(() => { if (!userBusy()) void _pollExpeditionMails_DISABLED(); }, 5 * 60 * 1000);

  const REFRESH_PAGES = ["research", "supplies", "facilities", "shipyard", "fleetdispatch", "lfbuildings"];
  let refreshIdx = 0;
  async function refreshOnePage(): Promise<void> {
    const page = REFRESH_PAGES[refreshIdx % REFRESH_PAGES.length]!;
    refreshIdx += 1;
    try {
      const planetId = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
      const url = `/game/index.php?page=ingame&component=${page}${planetId ? `&cp=${planetId}` : ""}`;
      const resp = await env.win.fetch(url, { credentials: "same-origin" });
      if (!resp.ok) return;
      const html = await resp.text();
      // Parse via DOMParser into a detached document; reuse the same
      // extractors that run on env.doc by SWAPPING `env.doc` temporarily?
      // No — extractors close over env.doc. Run them inline against the
      // parsed doc using the same logic.
      const parser = new (env.win as unknown as { DOMParser: typeof DOMParser }).DOMParser();
      const parsedDoc = parser.parseFromString(html, "text/html");

      // Diagnostic dump for lfbuildings — ogame may use different DOM than
      // regular buildings. Without seeing actual markup we can't write the
      // right selector. Logs once per refresh tick so console doesn't flood.
      if (page === "lfbuildings") {
        const lis = parsedDoc.querySelectorAll<HTMLElement>('[data-technology]');
        const sample = Array.from(lis).slice(0, 8).map((li) => ({
          tag: li.tagName, id: li.getAttribute("data-technology"),
          cls: (li.className ?? "").slice(0, 60),
          lvl_dv: li.querySelector(".level")?.getAttribute("data-value"),
          lvl_txt: (li.querySelector(".level")?.textContent ?? "").trim().slice(0, 20),
        }));
        // (lf-dump silenced — extractor working, sample only useful for new lf tech debug)
        void sample;
      }
      // 1) Tech levels (research/supplies/facilities → regular; lfbuildings → lifeform)
      const techMap = (await import("./probes/extractors/buildings.js")).extractTechLevels(parsedDoc);
      if (Object.keys(techMap).length > 0) {
        const buildings: Record<string, number> = {};
        const research: Record<string, number> = {};
        const lifeform_buildings: Record<string, number> = {};
        // Detect species from lifeform tech ID prefix:
        //   111xx = humans  121xx = rocktal  131xx = mechas  141xx = kaelesh
        let detectedSpecies: string | null = null;
        for (const [id, lvl] of Object.entries(techMap)) {
          const techId = TECH_ID_BY_NAME[id];
          if (techId !== undefined && idKind(techId) === "lifeform_building") {
            lifeform_buildings[id] = lvl;
            if (lvl > 0 && detectedSpecies === null) {
              const prefix = Math.floor(techId / 1000);
              detectedSpecies = prefix === 11 ? "humans"
                : prefix === 12 ? "rocktal"
                : prefix === 13 ? "mechas"
                : prefix === 14 ? "kaelesh"
                : null;
            }
            continue;
          }
          const entry = (TECH_TREE as Record<string, { kind: string }>)[id];
          if (!entry) continue;
          if (entry.kind === "building") buildings[id] = lvl;
          else if (entry.kind === "research") research[id] = lvl;
        }
        const cur = store.state;
        const patch: Partial<typeof cur> = {};
        const targetPlanet = planetId ? cur.planets[planetId] : undefined;
        if (targetPlanet && planetId && (Object.keys(buildings).length > 0 || Object.keys(lifeform_buildings).length > 0)) {
          const existingLf = (targetPlanet as { lifeform?: { species?: string } | null }).lifeform ?? null;
          const lifeformPatch = detectedSpecies !== null && (existingLf === null || existingLf.species !== detectedSpecies)
            ? { lifeform: { ...(existingLf ?? {}), species: detectedSpecies } }
            : {};
          patch.planets = {
            ...cur.planets,
            [planetId]: {
              ...targetPlanet,
              buildings: { ...(targetPlanet.buildings ?? {}), ...buildings },
              ...(Object.keys(lifeform_buildings).length > 0 ? {
                lifeform_buildings: { ...((targetPlanet as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {}), ...lifeform_buildings }
              } : {}),
              ...lifeformPatch,
            } as typeof targetPlanet,
          };
          if (detectedSpecies !== null) {
            console.info(`[OgameX/species] planet ${planetId}: detected species=${detectedSpecies}`);
          }
        }
        if (Object.keys(research).length > 0) {
          patch.research = { ...cur.research, levels: { ...(cur.research?.levels ?? {}), ...research } };
        }
        if (Object.keys(patch).length > 0) store.setPartial(patch);
      }

      // 1.5) DISABLED — was parsing li.technology[data-technology=20X] from
      // shipyard/fleetdispatch HTML using `.amount, .level` selectors. But
      // those selectors hit WRONG elements (build-queue input, or level=1
      // tooltip), overwriting the CORRECT ship counts written by pollEmpire.
      //
      // Symptom: empire dumped lc=1500 for [2:279:8], but sidecar /state
      // showed lc=1. The refresh path overwrote 1500 with garbage 1.
      //
      // Empire endpoint is the single source of truth for ship inventory.
      // If shipyard/fleetdispatch DOM extraction is ever needed again, use
      // [data-amount="N"] attribute, NOT .amount/.level innerText.

      // 2) Active queue from this page (research_q / build_q / shipyard_q).
      //    Looking for li.technology[data-status="active"].
      const actives = parsedDoc.querySelectorAll<HTMLElement>('li.technology[data-status="active"]');
      let foundActive = false;
      for (const li of actives) {
        const numeric = li.getAttribute("data-technology") ?? "";
        const name = TECH_ID_TO_NAME[numeric];
        if (!name) continue;
        foundActive = true;
        const timeEl = li.querySelector<HTMLElement>("[data-end], time, .time");
        let ends_at = Date.now() + 60_000;
        const endAttr = timeEl?.getAttribute("data-end") ?? timeEl?.getAttribute("data-target-time");
        if (endAttr) {
          const n = Number(endAttr);
          if (Number.isFinite(n)) ends_at = n * (n < 1e12 ? 1000 : 1);
        } else {
          const txt = timeEl?.textContent ?? "";
          const m = txt.match(/(\d+)h\s*(\d+)m\s*(\d+)s/i) ?? txt.match(/(\d+):(\d+):(\d+)/);
          if (m) ends_at = Date.now() + (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
        }
        const technology_id = parseInt(numeric, 10);
        const kind2 = idKind(technology_id);
        if (kind2 === "research") {
          const cur2 = store.state.research ?? { levels: {}, queue: null };
          const target_level = (cur2.levels[name] ?? 0) + 1;
          store.setPartial({ research: { ...cur2, queue: { tech: name, technology_id, level: target_level, ends_at } as typeof cur2.queue } });
          console.log(`[OgameX/bg] research queue refreshed: ${name} L${target_level}`);
        } else if (kind2 === "ship" || kind2 === "defense") {
          // shipyard queue on the page's planet (cp=planetId)
          const cur2 = store.state;
          const target = planetId ? cur2.planets[planetId] : undefined;
          if (target && planetId) {
            const cnt = (target.ships?.[name] ?? 0);
            const updatedPlanet = { ...target, shipyard_q: { ship: name, technology_id, count: cnt + 1, ends_at } as typeof target.shipyard_q };
            store.setPartial({ planets: { ...cur2.planets, [planetId]: updatedPlanet } });
            console.log(`[OgameX/bg] shipyard queue refreshed (planet ${planetId}): ${name}`);
          }
        } else if (kind2 === "lifeform_building") {
          // Lifeform queue on the page's planet — ogame's lf queue is
          // independent of the supplies/facilities queue, so we track it
          // in a separate field. Without this, lifeform_building goals
          // never have an ETA.
          const cur2 = store.state;
          const target = planetId ? cur2.planets[planetId] : undefined;
          if (target && planetId) {
            const lfBldg = (target as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {};
            const target_level = (lfBldg[name] ?? 0) + 1;
            const updatedPlanet = { ...target, lf_build_q: { building: name, technology_id, level: target_level, ends_at } } as typeof target & { lf_build_q: unknown };
            store.setPartial({ planets: { ...cur2.planets, [planetId]: updatedPlanet } });
            console.log(`[OgameX/bg] lf queue refreshed (planet ${planetId}): ${name} L${target_level}`);
          }
        } else {
          // building queue on the page's planet (cp=planetId)
          const cur2 = store.state;
          const target = planetId ? cur2.planets[planetId] : undefined;
          if (target && planetId) {
            const target_level = (target.buildings?.[name] ?? 0) + 1;
            const updatedPlanet = { ...target, build_q: { building: name, technology_id, level: target_level, ends_at } as typeof target.build_q };
            store.setPartial({ planets: { ...cur2.planets, [planetId]: updatedPlanet } });
            console.log(`[OgameX/bg] build queue refreshed (planet ${planetId}): ${name} L${target_level}`);
          }
        }
      }
      // 3) If this page is research/supplies/facilities/lfbuildings and NO
      //    active li, clear stale queue. Stale q blocks dispatch
      //    indefinitely after operator cancels in ogame UI.
      if (!foundActive && (page === "research" || page === "supplies" || page === "facilities" || page === "lfbuildings")) {
        if (page === "research" && store.state.research?.queue) {
          const cur2 = store.state.research;
          store.setPartial({ research: { ...cur2, queue: null } });
          console.log(`[OgameX/bg] research queue CLEARED (page=${page}, no active)`);
        }
        if ((page === "supplies" || page === "facilities") && planetId) {
          const cur2 = store.state;
          const target = cur2.planets[planetId];
          if (target && target.build_q) {
            store.setPartial({ planets: { ...cur2.planets, [planetId]: { ...target, build_q: null } } });
            console.log(`[OgameX/bg] build queue CLEARED (planet ${planetId}, page=${page}, no active)`);
          }
        }
        if (page === "lfbuildings" && planetId) {
          const cur2 = store.state;
          const target = cur2.planets[planetId] as (typeof cur2.planets[string] & { lf_build_q?: unknown }) | undefined;
          if (target && target.lf_build_q) {
            store.setPartial({ planets: { ...cur2.planets, [planetId]: { ...target, lf_build_q: null } as typeof target } });
            console.log(`[OgameX/bg] lf queue CLEARED (planet ${planetId}, page=${page}, no active)`);
          }
        }
      }
    } catch (e) {
      // Network or parse error — quiet.
      void e;
    }
  }
  // Track user activity — skip background refresh while the operator is
  // actively interacting with ogame (avoid stealing CPU / interfering
  // with their clicks). Only real (isTrusted) mouse/keyboard counts.
  let lastUserActivity = 0;
  const _markUserActive = (e: Event): void => { if (e.isTrusted) lastUserActivity = Date.now(); };
  env.doc.addEventListener("mousedown", _markUserActive, true);
  env.doc.addEventListener("keydown", _markUserActive, true);
  // First refresh after 8s, then every 10s. Respects the global userBusy
  // guard (60s window after any user click/key) so background refresh
  // doesn't compete with operator's own ogame POSTs.
  setTimeout(refreshOnePage, 8000);

  // Empire view poller — direct ogame standalone empire endpoint.
  // Returns ALL planets ships + buildings in a single fetch. No per-planet
  // navigation needed. Most importantly, doesn't set session cp= cookie
  // (separate "standalone" viewport), so ApiExec session stays intact.
  // Used to populate state.planets[].ships across the entire empire.
  async function pollEmpire(opts: { force?: boolean } = {}): Promise<void> {
    // ApiExec preflight needs fresh data even when user is busy (otherwise
    // launching fleets relies on stale data the whole time user browses).
    // Periodic state-push poller passes no force=true so it still defers
    // to user activity for politeness; ApiExec helper passes force=true.
    if (!opts.force && userBusy()) return;
    try {
      // Note: planet=0, mode=0 selects ALL planets in v12 empire endpoint.
      const url = `/game/index.php?page=standalone&component=empire&planetType=0`;
      const r = await env.win.fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!r.ok) return;
      const html = await r.text();
      // ogame v12 empire format candidates — try until one parses.
      let data: Array<Record<string, unknown>> | null = null;
      let usedPattern = "";
      const tryPatterns: Array<[string, RegExp]> = [
        ["A:var planets",     /var\s+planets\s*=\s*(\[[\s\S]*?\]);/],
        ["B:var planetsData", /var\s+planetsData\s*=\s*(\[[\s\S]*?\]);/],
        ["C:Empire planets",  /Empire\.[\w]*planet[\w]*\s*=\s*(\[[\s\S]*?\]);/],
        ["D:data-planets",    /data-planets\s*=\s*"([^"]+)"/],
        ["E:planets json",    /"planets"\s*:\s*(\[[\s\S]*?\}\s*\])/],
      ];
      for (const [name, re] of tryPatterns) {
        const m = html.match(re);
        if (!m) continue;
        try {
          let raw = m[1]!;
          if (name.startsWith("D")) raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            data = parsed;
            usedPattern = name;
            break;
          }
        } catch { /* try next */ }
      }
      if (!data) {
        // Dump 'planet' context for operator to teach the real format.
        console.warn(`[OgameX/empire] all 5 parse patterns failed (${html.length}B). Dumping 'planet' contexts:`);
        let pos = 0;
        for (let i = 0; i < 3; i++) {
          const idx = html.indexOf("planet", pos);
          if (idx < 0) break;
          console.warn(`  @${idx}:`, html.slice(Math.max(0, idx - 40), idx + 250));
          pos = idx + 1;
        }
        return;
      }
      void usedPattern; // (silenced — happens every 5s, expected steady-state)
      const cur = store.state;
      const patchPlanets: Record<string, typeof cur.planets[string]> = { ...cur.planets };
      let updated = 0;
      for (const planet of data) {
        const pid = String(planet["id"] ?? "");
        if (!pid || !patchPlanets[pid]) continue;
        const ships: Record<string, number> = {};
        // STRICT key match + thousand-separator-aware value parse.
        // Parse 3 tid ranges from empire response:
        //   < 200   → regular buildings (metalMine=1, crystalMine=2, ...)
        //   200-300 → ships (smallCargo=202, ...)
        //   11000-15000 → lifeform buildings (residentialSector=11101, sanctuary=14101, ...)
        // Operator: "已经 42 级了, 为啥你的数据是 37 级" — empire was only
        // refreshing ships, so building/lifeform_building levels stayed stale
        // forever. Planner kept thinking sanctuary L37, kept queuing builds.
        const buildings: Record<string, number> = {};
        const lifeform_buildings: Record<string, number> = {};
        for (const [key, val] of Object.entries(planet)) {
          if (!/^\d+$/.test(key)) continue;
          const tid = parseInt(key, 10);
          const name = TECH_ID_TO_NAME[String(tid)];
          if (!name) continue;
          let n: number;
          if (typeof val === "number") {
            n = val;
          } else {
            const stripped = String(val).replace(/[.,\s]/g, "");
            n = parseInt(stripped, 10);
          }
          if (!Number.isFinite(n) || n < 0) continue;
          if (tid >= 200 && tid < 300) ships[name] = n;
          else if (tid >= 11000 && tid < 15000) lifeform_buildings[name] = n;
          else if (tid > 0 && tid < 200) buildings[name] = n;
        }
        const hasAny = Object.keys(ships).length > 0 || Object.keys(buildings).length > 0 || Object.keys(lifeform_buildings).length > 0;
        if (hasAny) {
          const cur = patchPlanets[pid];
          const merged = {
            ...cur,
            ships: { ...((cur as { ships?: Record<string, number> }).ships ?? {}), ...ships },
            ...(Object.keys(buildings).length > 0 ? {
              buildings: { ...((cur as { buildings?: Record<string, number> }).buildings ?? {}), ...buildings },
            } : {}),
            ...(Object.keys(lifeform_buildings).length > 0 ? {
              lifeform_buildings: { ...((cur as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {}), ...lifeform_buildings },
            } : {}),
          };
          patchPlanets[pid] = merged as typeof patchPlanets[string];
          updated += 1;
        }
      }
      if (updated > 0) {
        store.setPartial({ planets: patchPlanets });
        // Expose to BOTH sandboxed window AND page's real window (unsafeWindow)
        // so devtools console eval can read/write the store directly.
        // Tampermonkey @grant GM_* enables sandbox; without unsafeWindow
        // bridge the page-side `__ogamexStore` reference would be undefined.
        (env.win as Window & { __ogamexStore?: typeof store }).__ogamexStore = store;
        const pw = (typeof unsafeWindow !== "undefined" ? unsafeWindow : env.win) as Window & { __ogamexStore?: typeof store };
        pw.__ogamexStore = store;
      }
    } catch (e) {
      console.warn(`[OgameX/empire] fetch failed:`, e);
    }
  }
  // Empire fetch: seed once at +12s, then SLOW periodic safety net every
  // 5 min. Pure event-driven left building levels (lifeform_buildings,
  // research, regular buildings) STALE forever because nothing periodically
  // refreshed them. Operator observed: "sanctuary 已经到达目标了 但还在
  // 继续建造" — state stuck at L37 while ogame at L42 → planner kept
  // queuing builds. 5 min cadence catches build completions without
  // hammering ogame (1 req/5min = 0.2/min). pollEmpire endpoint has no
  // cp= so doesn't pollute session.
  setTimeout(pollEmpire, 12_000);
  setInterval(() => { void pollEmpire(); }, 5 * 60_000);
  // Expose globally so ApiExec can request a refresh on demand.
  (env.win as Window & { __ogamexPollEmpire?: () => Promise<void> }).__ogamexPollEmpire = pollEmpire;
  // Also expose a focused helper: refresh empire then return THIS planet's
  // ship counts. ApiExec calls this RIGHT BEFORE each expedition so the
  // launch decision is based on data fetched microseconds ago. Owner's
  // explicit requirement: "每次远征之前从 api 拿最新的舰船数量".
  (env.win as Window & { __ogamexFetchPlanetShips?: (pid: string) => Promise<Record<string, number>> })
    .__ogamexFetchPlanetShips = async (pid: string): Promise<Record<string, number>> => {
    // GROUND TRUTH = fleetdispatch page. /empire endpoint includes in-transit
    // ships (reports total owned-per-planet including departed fleets).
    // fleetdispatch page's <input data-max-amount=N> reflects what's
    // LAUNCHABLE right now = hangar only.
    //
    // Owner observation: state showed 1500 largeCargo on a planet that
    // "实际没有船" — fleet was already in transit, empire returned the
    // committed count not the available count.
    try {
      const url = `/game/index.php?page=ingame&component=fleetdispatch&cp=${pid}`;
      const r = await env.win.fetch(url, { credentials: "same-origin" });
      if (!r.ok) {
        // CONSERVATIVE ABORT (was: stale store fallback). Operator:
        // "发了缺船的远征" — don't risk launching on stale data.
        console.warn(`[OgameX/fetchShips] fd HTTP ${r.status} for ${pid} → ABORT preflight`);
        return {};
      }
      const html = await r.text();
      const ships: Record<string, number> = {};
      // Multi-pattern parse — ogame v12 ship HTML varies. Try each:
      // A: name="am2XX" ... data-max-amount="N"
      // B: data-max-amount="N" ... name="am2XX" (attribute order reversed)
      // C: data-amount="N" data-technology="2XX" (span/div variant)
      const patternA = /name="am(\d+)"[^>]*data-max-amount="(\d+)"/g;
      for (const m of html.matchAll(patternA)) {
        const tid = String(m[1] ?? ""); const max = parseInt(m[2] ?? "0", 10);
        const name = TECH_ID_TO_NAME[tid];
        if (name && tid.startsWith("2")) ships[name] = max;
      }
      if (Object.keys(ships).length === 0) {
        const patternB = /data-max-amount="(\d+)"[^>]*name="am(\d+)"/g;
        for (const m of html.matchAll(patternB)) {
          const max = parseInt(m[1] ?? "0", 10); const tid = String(m[2] ?? "");
          const name = TECH_ID_TO_NAME[tid];
          if (name && tid.startsWith("2")) ships[name] = max;
        }
      }
      if (Object.keys(ships).length === 0) {
        const patternC = /data-amount="(\d+)"[^>]*data-technology="(2\d+)"/g;
        for (const m of html.matchAll(patternC)) {
          const max = parseInt(m[1] ?? "0", 10); const tid = String(m[2] ?? "");
          const name = TECH_ID_TO_NAME[tid];
          if (name) ships[name] = max;
        }
      }
      // Last resort: parse the lifeform-style amount spans, e.g.
      //   <span class="amount" data-value="N" ...> within technology2XX
      if (Object.keys(ships).length === 0) {
        const patternD = /technology[^"]*?(2\d{2})[^>]*>[\s\S]{0,500}?data-value="(\d+)"/g;
        for (const m of html.matchAll(patternD)) {
          const tid = String(m[1] ?? ""); const max = parseInt(m[2] ?? "0", 10);
          const name = TECH_ID_TO_NAME[tid];
          if (name) ships[name] = max;
        }
      }
      // If empty parse — disambiguate:
      //   - Full ogame page (>10KB) with NO am2XX strings anywhere = planet
      //     truly has 0 ships. Write zeros to store (override stale empire
      //     data) so daemon stops queuing. Return zeros so preflight aborts.
      //   - Small response or fetch failed = unknown, fall back to store.
      if (Object.keys(ships).length === 0) {
        // CRITICAL: verify fdHtml is actually for the requested planet.
        // ogame's session-cp cookie controls which planet's data renders.
        // GET /...?cp=PID may or may not switch session — depends on whether
        // ogame treats cp= as session-switch (varies by build).
        // If returned page is for a DIFFERENT planet, we can't trust 0
        // ships found = "hangar truly empty". Fall back to store.
        const planetMetaMatch = html.match(/<meta\s+name="ogame-planet-id"\s+content="(\d+)"/);
        const returnedPlanetId = planetMetaMatch?.[1];
        const planetMatches = returnedPlanetId === pid;
        const isFullPage = html.length > 10000;
        const hasAmAny = /\bam20\d\b|\bam21\d\b|\bam22\d\b/.test(html);
        if (!planetMatches) {
          // Session-cp didn't switch → can't trust this response. ABORT
          // conservatively rather than risk stale-store launch.
          console.warn(`[OgameX/fetchShips] ${pid}: fdHtml returned for DIFFERENT planet (got ${returnedPlanetId}) → ABORT preflight`);
          return {};
        }
        if (isFullPage && !hasAmAny) {
          // 0 am2XX inputs in full fd page (ogame v12 may render via JS).
          // Fallback: use empire data (just refreshed by ApiExec's pre-
          // preflight pollEmpire) MINUS in-transit ships from fleets_outbound
          // = true launchable count.
          const empireShips = store.state.planets[pid]?.ships ?? {};
          const p = store.state.planets[pid];
          const coordStr = p?.coords ? p.coords.join(":") : "";
          const inTransit: Record<string, number> = {};
          for (const f of store.state.fleets_outbound ?? []) {
            const fOrig = Array.isArray(f.origin) ? f.origin.join(":") : "";
            if (fOrig !== coordStr || !coordStr) continue;
            const fs = (f as { ships?: Record<string, number> }).ships ?? {};
            for (const [s, n] of Object.entries(fs)) {
              if (typeof n !== "number") continue;
              inTransit[s] = (inTransit[s] ?? 0) + n;
            }
          }
          const launchable: Record<string, number> = {};
          for (const [s, n] of Object.entries(empireShips)) {
            if (typeof n !== "number") continue;
            launchable[s] = Math.max(0, n - (inTransit[s] ?? 0));
          }
          console.warn(`[OgameX/fetchShips] ${pid}: fd no am2XX, fallback empire-minus-transit: launchable=${JSON.stringify(launchable)} inTransit=${JSON.stringify(inTransit)}`);
          return launchable;
        }
        // Parse failure on a smaller/partial response — also fall back to
        // fresh-store-minus-transit (same approach).
        console.warn(`[OgameX/fetchShips] PARSE failed for ${pid} (${html.length}B); using fresh store ships`);
        return store.state.planets[pid]?.ships ?? {};
      }
      console.info(`[OgameX/fetchShips] ${pid}: ${JSON.stringify(ships)}`);
      // Mirror hangar truth into store.
      const cur = store.state;
      if (cur.planets[pid]) {
        const p = cur.planets[pid];
        store.setPartial({ planets: { ...cur.planets, [pid]: { ...p, ships: { ...p.ships, ...ships } } } });
      }
      return ships;
    } catch (e) {
      // Network error → CONSERVATIVE ABORT (was: return store stale data which
      // led to "发了缺船的远征"). Daemon retries next tick.
      console.warn(`[OgameX/fetchShips] fd fetch failed for ${pid} → ABORT preflight:`, e);
      return {};
    }
  };

  // One-shot prereq discovery — fetch technologyDetails for every lifeform
  // building on boot and dump real requirements to console. Operator
  // copies this into shared/lifeform/humans_tech.ts. Removes the guessing.
  setTimeout(async () => {
    const LF_IDS = [11101, 11102, 11103, 11104, 11105, 11106, 11107, 11108, 11109, 11110, 11111, 11112];
    const planetId = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
    if (!planetId) {
      console.warn("[OgameX/lf-prereq] no planet id, skipping prereq dump");
      return;
    }
    // ogame's own technologydetails endpoint pattern (from page HTML):
    //   POST /game/index.php?page=ingame&component=technologydetails&ajax=1&action=getDetails
    //   body: technology=<id>&cp=<planet>&token=<jsToken>
    // We use whatever 'token' is exposed globally (set by ogame's JS bootstrap).
    const win = env.win as Window & { token?: string };
    const jsToken = win.token ?? "";
    for (const tid of LF_IDS) {
      try {
        const url = `/game/index.php?page=ingame&component=technologydetails&ajax=1&action=getDetails`;
        const body = new URLSearchParams();
        body.set("technology", String(tid));
        body.set("cp", planetId);
        if (jsToken) body.set("token", jsToken);
        const r = await env.win.fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body,
        });
        if (!r.ok) { console.warn(`[OgameX/lf-prereq] tid=${tid} HTTP ${r.status}`); continue; }
        const txt = await r.text();
        // (silent — body content already used for prereq table; no spam)
        void txt;
      } catch (e) {
        console.warn(`[OgameX/lf-prereq] tid=${tid} fetch failed`, e);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // (lf-prereq discovery-complete silenced — one-shot boot diagnostic, done)
  }, 15_000);
  // refreshOnePage periodic timer REMOVED (operator: "ogame 的改成事件触发").
  // The function is still called from DOM mutation handler when ogame's
  // ajaxNavigation actually loads a research/supplies/etc page — which
  // means data refreshes when it CAN change (operator visits page) rather
  // than 6 req/min unconditionally. Was 6/min, now event-driven (≈0 idle).

  // 7. Persist on every state.updated, debounced loosely
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Event-driven expedition trigger — when fleets_outbound drops (a fleet
  // returned), force sidecar to fire its expedition tick immediately
  // instead of waiting for the daemon's safety-net periodic tick. Sidecar
  // ALSO does this on its end (state.snapshot handler), but firing from
  // userscript shortcuts the round-trip — sidecar might receive a state
  // push with delta only every 5s. Combined: detection ≤ 1s end-to-end.
  let lastFleetCount = Array.isArray(store.state.fleets_outbound) ? store.state.fleets_outbound.length : 0;
  function maybeFireExpeditionTrigger(): void {
    const cur = store.state.fleets_outbound;
    const n = Array.isArray(cur) ? cur.length : 0;
    if (n < lastFleetCount) {
      try {
        const bridgeBase = (env.win.localStorage.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com");
        void env.win.fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/expedition/trigger`, {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => { /* sidecar may be down; safety net catches */ });
      } catch { /* */ }
    }
    lastFleetCount = n;
  }
  const offState = bus.on("state.updated", () => {
    maybeFireExpeditionTrigger();
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void store.persist().catch((e) => console.warn("[OgameX] persist failed", e));
    }, 1000);
  });

  const summary: BootSummary = {
    resources_ok: resources !== null,
    storage_ok: storage !== null,
    production_ok: production !== null,
    lifeform_resources_ok: lifeform_resources !== null,
    events_count: events.length,
    planets_count: planets.length,
    fleet_movements_count: fleets.length,
    token_present: token !== null,
    ogame_meta,
  };

  // Expose store EARLY (at boot return) so devtools console eval works
  // immediately — operator's emergency drills inject events_incoming via
  // __ogamexStore.setPartial({...}), no need to wait for first empire poll.
  (env.win as Window & { __ogamexStore?: typeof store }).__ogamexStore = store;
  try {
    const pw = (typeof unsafeWindow !== "undefined" ? unsafeWindow : env.win) as Window & { __ogamexStore?: typeof store };
    pw.__ogamexStore = store;
  } catch { /* unsafeWindow may be undefined in non-Tampermonkey contexts (tests) */ }

  return {
    bus,
    store,
    summary,
    stop() {
      stopMO();
      offDomChanged();
      offState();
      if (persistTimer) clearTimeout(persistTimer);
      clearTimeout(lateExtract1);
      clearTimeout(lateExtract2);
    },
  };
}
