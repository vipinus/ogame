import { describe, it, expect, vi } from "vitest";
import type {
  ExpeditionConfig,
  ExpeditionOutcome,
  FleetMovement,
  Planet,
  WorldState,
} from "@ogamex/shared";
import type { SendFleetParams } from "../../../src/api/fleet_api.js";
import { PriorityGate } from "../../../src/emergency/priority_gate.js";
import {
  fillExpeditionSlots,
  type SlotFillerActions,
} from "../../../src/daily/expedition/slot_filler.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function makeOutcome(
  overrides: Partial<ExpeditionOutcome> = {},
): ExpeditionOutcome {
  return {
    expedition_id: "exp-1",
    source_planet_id: "p1",
    source_coords: [1, 100, 8],
    target_galaxy: 1,
    target_system: 100,
    target_position: 16,
    template_id: "default",
    fleet_sent: {},
    launched_at: NOW - 2 * HOUR,
    returned_at: NOW - HOUR,
    duration_actual_seconds: 3600,
    outcome_type: "resources_small",
    resources_gained: { m: 0, c: 0, d: 0, e: 0 },
    ships_gained: {},
    ships_lost: {},
    raw_report_id: "r1",
    artifacts_gained: {},
    lifeform_xp_gained: null,
    ...overrides,
  };
}

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

function makeState(args: {
  sourcePlanetId: string;
  sourceGalaxy: number;
  astrophysics?: number;
  outboundExpeditions?: number;
}): WorldState {
  const planet = makePlanet({
    id: args.sourcePlanetId,
    coords: [args.sourceGalaxy, 100, 8],
  });
  const fleets_outbound: FleetMovement[] = [];
  const count = args.outboundExpeditions ?? 0;
  for (let i = 0; i < count; i++) {
    fleets_outbound.push({
      id: `f${i}`,
      mission: 15, // EXPEDITION
      origin: planet.coords,
      origin_type: "planet",
      dest: [args.sourceGalaxy, 100, 16],
      dest_type: 1,
      arrival_at: NOW + HOUR,
      return_at: null,
      ships: {},
      cargo: { m: 0, c: 0, d: 0 },
    });
  }
  return {
    server: { universe: "uni1", speed: 1 },
    player: { id: "me", name: "me", alliance: null },
    planets: [planet],
    research: {
      levels: { astrophysics: args.astrophysics ?? 4 },
      queue: null,
    },
    fleets_outbound,
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: NOW,
    page_snapshots: {},
  };
}

function makeConfig(
  overrides: Partial<ExpeditionConfig> = {},
): ExpeditionConfig {
  return {
    enabled: true,
    auto_fill_slots: true,
    source_planet: "p1",
    duration: "medium",
    target_position: 16,
    fleet_templates: {
      default: {
        fleet: { lt: 10 },
        used_when: "default",
      },
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
    ...overrides,
  };
}

function makeActions(
  sendImpl?: (p: SendFleetParams) => Promise<{ fleetId: number }>,
): SlotFillerActions & {
  send: ReturnType<typeof vi.fn>;
  randomSystem: ReturnType<typeof vi.fn>;
} {
  let nextId = 1000;
  const send = vi.fn(
    sendImpl ??
      (async (_p: SendFleetParams) => ({ fleetId: nextId++ })),
  );
  const randomSystem = vi.fn((_g: number) => 250);
  return { send, randomSystem };
}

describe("fillExpeditionSlots", () => {
  it("yields when emergency gate is active (no API calls)", async () => {
    const gate = new PriorityGate();
    gate.setActive(true);
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 4, // 2 slots
    });
    const actions = makeActions();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = await fillExpeditionSlots(
        state,
        makeConfig(),
        [],
        actions,
        { gate },
      );
      expect(r.launched).toBe(0);
      expect(r.reasons.some((s) => s.includes("emergency"))).toBe(true);
      expect(actions.send).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it("returns 0 launched when config is disabled", async () => {
    const gate = new PriorityGate();
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 4,
    });
    const actions = makeActions();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = await fillExpeditionSlots(
        state,
        makeConfig({ enabled: false }),
        [],
        actions,
        { gate },
      );
      expect(r.launched).toBe(0);
      expect(r.reasons.some((s) => s.includes("disabled"))).toBe(true);
      expect(actions.send).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it("returns 0 launched when no free slots remain", async () => {
    const gate = new PriorityGate();
    // astro=4 → 2 slots, with 2 EXPEDITION fleets already outbound → 0 free
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 4,
      outboundExpeditions: 2,
    });
    const actions = makeActions();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = await fillExpeditionSlots(
        state,
        makeConfig(),
        [],
        actions,
        { gate },
      );
      expect(r.launched).toBe(0);
      expect(r.reasons.some((s) => s.includes("no free slots"))).toBe(true);
      expect(actions.send).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it("launches into all free slots with correct fleet params", async () => {
    const gate = new PriorityGate();
    // astro=4 → 2 slots, 0 outbound → 2 free
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 4,
    });
    const actions = makeActions();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = await fillExpeditionSlots(
        state,
        makeConfig(),
        [],
        actions,
        { gate },
      );
      expect(r.launched).toBe(2);
      expect(actions.send).toHaveBeenCalledTimes(2);
      for (const call of actions.send.mock.calls) {
        const params = call[0] as SendFleetParams;
        expect(params.mission).toBe(15);
        expect(params.speed).toBe(10);
        expect(params.destType).toBe(1);
        expect(params.coords[2]).toBe(16);
        expect(params.coords[1]).toBe(250); // from randomSystem mock
        expect(params.cargo).toEqual({ m: 0, c: 0, d: 0 });
        expect(params.ships).toEqual({ lt: 10 });
        // duration "medium" → holdingTime 4
        expect(params.holdingTime).toBe(4);
      }
    } finally {
      Date.now = realNow;
    }
  });

  it("returns 0 launched when source planet is missing", async () => {
    const gate = new PriorityGate();
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 4,
    });
    const actions = makeActions();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      // config points to a planet id that doesn't exist
      const r = await fillExpeditionSlots(
        state,
        makeConfig({ source_planet: "nonexistent" }),
        [],
        actions,
        { gate },
      );
      expect(r.launched).toBe(0);
      expect(r.reasons.some((s) => s.includes("source planet not found"))).toBe(
        true,
      );
      expect(actions.send).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it("stops the loop after first send failure (returns 0 launched)", async () => {
    const gate = new PriorityGate();
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 9, // 3 slots
    });
    const actions = makeActions(async () => {
      throw new Error("boom");
    });
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = await fillExpeditionSlots(
        state,
        makeConfig(),
        [],
        actions,
        { gate },
      );
      expect(r.launched).toBe(0);
      expect(actions.send).toHaveBeenCalledTimes(1);
      expect(r.reasons.some((s) => s.includes("failed") && s.includes("boom")))
        .toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("wires stats to template_picker (black hole rate selects the safe template)", async () => {
    const gate = new PriorityGate();
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 1, // 1 slot
    });
    // 1 black hole out of 4 → rate 0.25
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({
        expedition_id: "a",
        outcome_type: "black_hole",
        returned_at: NOW - HOUR,
      }),
      makeOutcome({
        expedition_id: "b",
        outcome_type: "resources_small",
        returned_at: NOW - HOUR,
      }),
      makeOutcome({
        expedition_id: "c",
        outcome_type: "resources_small",
        returned_at: NOW - HOUR,
      }),
      makeOutcome({
        expedition_id: "d",
        outcome_type: "resources_small",
        returned_at: NOW - HOUR,
      }),
    ];
    // Two templates: "risky" used when bh rate < 0.2, "safe" otherwise.
    // With rate ~0.25, "safe" must win.
    const config = makeConfig({
      fleet_templates: {
        risky: {
          fleet: { lt: 1 },
          used_when: "black_hole_rate_24h < 0.2",
        },
        safe: {
          fleet: { lt: 999 },
          used_when: "default",
        },
      },
    });
    const actions = makeActions();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = await fillExpeditionSlots(
        state,
        config,
        outcomes,
        actions,
        { gate },
      );
      expect(r.launched).toBe(1);
      expect(actions.send).toHaveBeenCalledTimes(1);
      const params = actions.send.mock.calls[0]?.[0] as SendFleetParams;
      expect(params.ships).toEqual({ lt: 999 }); // safe template wins
    } finally {
      Date.now = realNow;
    }
  });

  it("ignores outcomes older than 24h when computing stats", async () => {
    const gate = new PriorityGate();
    const state = makeState({
      sourcePlanetId: "p1",
      sourceGalaxy: 1,
      astrophysics: 1, // 1 slot
    });
    // 4 ancient black holes (>24h) MUST be ignored. 4 recent normals → rate = 0.
    const outcomes: ExpeditionOutcome[] = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeOutcome({
          expedition_id: `old-${i}`,
          outcome_type: "black_hole",
          returned_at: NOW - 2 * DAY,
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        makeOutcome({
          expedition_id: `new-${i}`,
          outcome_type: "resources_small",
          returned_at: NOW - HOUR,
        }),
      ),
    ];
    // "risky" only triggers when rate < 0.2 (current rate = 0 → matches)
    const config = makeConfig({
      fleet_templates: {
        risky: {
          fleet: { lt: 1 },
          used_when: "black_hole_rate_24h < 0.2",
        },
        safe: {
          fleet: { lt: 999 },
          used_when: "default",
        },
      },
    });
    const actions = makeActions();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const r = await fillExpeditionSlots(
        state,
        config,
        outcomes,
        actions,
        { gate },
      );
      expect(r.launched).toBe(1);
      const params = actions.send.mock.calls[0]?.[0] as SendFleetParams;
      // If 24h filter worked → rate=0 → risky template (lt:1) wins
      expect(params.ships).toEqual({ lt: 1 });
    } finally {
      Date.now = realNow;
    }
  });
});
