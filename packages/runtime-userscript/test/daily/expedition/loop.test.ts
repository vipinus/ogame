// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IDBFactory as FDBFactory } from "fake-indexeddb";
import type {
  ExpeditionConfig,
  FleetMovement,
  Planet,
  WorldState,
} from "@ogamex/shared";
import { EventBus } from "../../../src/event_bus.js";
import { StateStore } from "../../../src/state_store.js";
import { ExpeditionStore } from "../../../src/store/expedition_store.js";
import { PriorityGate } from "../../../src/emergency/priority_gate.js";
import type { SendFleetParams } from "../../../src/api/fleet_api.js";
import {
  startDailyExpeditionLoop,
  type DailyExpeditionLoopDeps,
  type DailyExpeditionLoopHandle,
} from "../../../src/daily/expedition/loop.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function makePlanet(
  overrides: Partial<Planet> & Pick<Planet, "id" | "coords">,
): Planet {
  return {
    name: "Homeworld",
    type: "planet",
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
    ...overrides,
  };
}

function makeState(): WorldState {
  const planet = makePlanet({ id: "p1", coords: [1, 100, 8] });
  return {
    server: { universe: "uni1", speed: 1 },
    player: { id: "me", name: "me", alliance: null },
    planets: [planet],
    research: { levels: { astrophysics: 4 }, queue: null }, // 2 slots
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: NOW,
    page_snapshots: {},
  };
}

function makeConfig(): ExpeditionConfig {
  return {
    enabled: true,
    auto_fill_slots: true,
    source_planet: "p1",
    duration: "medium",
    target_position: 16,
    fleet_templates: {
      default: { fleet: { lt: 10 }, used_when: "default" },
    },
    galaxy_strategy: {
      mode: "fixed",
      home_galaxy_first: true,
      switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
      cross_galaxy_deut_budget: 0,
      preferred_galaxies: [3],
    },
    cargo_load: {
      smallCargo_capacity_pct: 100,
      largeCargo_capacity_pct: 100,
    },
  };
}

function makeExpeditionFleet(overrides: Partial<FleetMovement> = {}): FleetMovement {
  return {
    id: "f-exp-1",
    mission: 15, // EXPEDITION
    origin: [1, 100, 8],
    origin_type: "planet",
    dest: [1, 250, 16],
    dest_type: 1,
    arrival_at: NOW + HOUR,
    return_at: null,
    ships: { lt: 10 },
    cargo: { m: 0, c: 0, d: 0 },
    ...overrides,
  };
}

function makeTransportFleet(): FleetMovement {
  return makeExpeditionFleet({ id: "f-trn-1", mission: 3 }); // TRANSPORT
}

// Minimal HTML the parser recognises as a "nothing" outcome — keeps parsing
// path live without coupling to richer fixtures.
const NOTHING_REPORT_HTML = `<div>毫無所獲</div>`;

interface DepsHarness {
  deps: DailyExpeditionLoopDeps;
  bus: EventBus;
  store: StateStore;
  expeditionStore: ExpeditionStore;
  gate: PriorityGate;
  send: ReturnType<typeof vi.fn>;
  randomSystem: ReturnType<typeof vi.fn>;
  putSpy: ReturnType<typeof vi.spyOn>;
}

function makeDeps(overrides: Partial<DailyExpeditionLoopDeps> = {}): DepsHarness {
  const bus = new EventBus();
  const gate = new PriorityGate();
  const state = makeState();
  const store = new StateStore(bus, null, state);
  const expeditionStore = new ExpeditionStore({ factory: new FDBFactory() });
  const putSpy = vi.spyOn(expeditionStore, "put");
  let nextId = 1000;
  const send = vi.fn(async (_p: SendFleetParams) => ({ fleetId: nextId++ }));
  const randomSystem = vi.fn((_g: number) => 250);
  const cfg = makeConfig();
  const deps: DailyExpeditionLoopDeps = {
    bus,
    store,
    expeditionStore,
    gate,
    config: () => cfg,
    send,
    randomSystem,
    fallbackIntervalMs: 0, // disable the timer by default; per-test opt-in.
    ...overrides,
  };
  return { deps, bus, store, expeditionStore, gate, send, randomSystem, putSpy };
}

describe("startDailyExpeditionLoop", () => {
  let realNow: () => number;
  let handle: DailyExpeditionLoopHandle | null = null;

  beforeEach(() => {
    realNow = Date.now;
    Date.now = () => NOW;
  });

  afterEach(() => {
    Date.now = realNow;
    if (handle) {
      handle.stop();
      handle = null;
    }
    vi.useRealTimers();
  });

  it("fleet_returned (mission=15) with reportHtml → parses, stores, emits, and triggers fillSlots", async () => {
    const h = makeDeps();
    handle = startDailyExpeditionLoop(h.deps);

    const updatedSpy = vi.fn();
    h.bus.on("expedition_data_updated", updatedSpy);

    h.bus.emit("fleet_returned", {
      fleet: makeExpeditionFleet(),
      reportHtml: NOTHING_REPORT_HTML,
    });

    // Wait for the async handler chain (parse → put → emit → tick).
    await new Promise((r) => setTimeout(r, 20));

    expect(h.putSpy).toHaveBeenCalledTimes(1);
    expect(updatedSpy).toHaveBeenCalledTimes(1);
    // expedition_data_updated triggers tick → fillSlots → 2 sends (astro=4 → 2 slots).
    expect(h.send.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fleet_returned with mission=3 (transport) → no parsing, no store", async () => {
    const h = makeDeps();
    handle = startDailyExpeditionLoop(h.deps);

    const updatedSpy = vi.fn();
    h.bus.on("expedition_data_updated", updatedSpy);

    h.bus.emit("fleet_returned", {
      fleet: makeTransportFleet(),
      reportHtml: NOTHING_REPORT_HTML,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(h.putSpy).not.toHaveBeenCalled();
    expect(updatedSpy).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("fleet_returned with no reportHtml → skips parse + store silently", async () => {
    const h = makeDeps();
    handle = startDailyExpeditionLoop(h.deps);

    const updatedSpy = vi.fn();
    h.bus.on("expedition_data_updated", updatedSpy);

    h.bus.emit("fleet_returned", { fleet: makeExpeditionFleet() });

    await new Promise((r) => setTimeout(r, 20));

    expect(h.putSpy).not.toHaveBeenCalled();
    expect(updatedSpy).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("expedition_data_updated event → directly triggers fillSlots", async () => {
    const h = makeDeps();
    handle = startDailyExpeditionLoop(h.deps);

    h.bus.emit("expedition_data_updated", {});
    await new Promise((r) => setTimeout(r, 20));

    expect(h.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.putSpy).not.toHaveBeenCalled(); // no parse-path side effects
  });

  it("tick yields when the emergency gate is active (no send calls)", async () => {
    const h = makeDeps();
    h.gate.setActive(true);
    handle = startDailyExpeditionLoop(h.deps);

    await handle.tick();

    expect(h.send).not.toHaveBeenCalled();
  });

  it("fallback timer fires tick after fallbackIntervalMs", async () => {
    // We deliberately do NOT use vi.useFakeTimers here — the tick reads from
    // ExpeditionStore (fake-indexeddb), whose internal queue depends on real
    // microtask scheduling. Instead, use a very short interval (5 ms) and
    // wait via real timers.
    const h = makeDeps({ fallbackIntervalMs: 5 });
    handle = startDailyExpeditionLoop(h.deps);

    // Before the first interval fires: no calls.
    expect(h.send).not.toHaveBeenCalled();

    // Wait long enough for the interval to fire and the async tick chain
    // (recent → fillSlots → send) to settle.
    await new Promise((r) => setTimeout(r, 60));

    expect(h.send.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
