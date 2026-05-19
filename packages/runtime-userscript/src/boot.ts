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
import { extractFleetMovements } from "./probes/extractors/fleet.js";
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

  // 2. Wire probes
  const stopMO = startMutationObserver(env.doc, bus, env.win);
  if (env.fetch) {
    installXhrHook({ fetch: env.fetch }, bus);
  }

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
  store.setPartial({
    server: {
      universe: ogame_meta.universe ?? "",
      speed: ogame_meta.universe_speed ?? 1,
    },
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
      if (r) {
        // Update first planet's resources only — full multi-planet state lives in M3
        const cur = store.state;
        if (cur.planets.length > 0) {
          const updated = [...cur.planets];
          updated[0] = { ...updated[0]!, resources: { m: r.m, c: r.c, d: r.d, e: r.e ?? 0 } };
          store.setPartial({ planets: updated });
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
  });

  // 7. Persist on every state.updated, debounced loosely
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const offState = bus.on("state.updated", () => {
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

  return {
    bus,
    store,
    summary,
    stop() {
      stopMO();
      offDomChanged();
      offState();
      if (persistTimer) clearTimeout(persistTimer);
    },
  };
}
