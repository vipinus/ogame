import { describe, it, expect } from "vitest";
import type {
  ExpeditionConfig,
  ExpeditionOutcome,
  Planet,
  WorldState,
} from "@ogamex/shared";
import { pickGalaxy } from "../../../src/daily/expedition/galaxy_picker.js";

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

function makePlanet(overrides: Partial<Planet> & Pick<Planet, "id" | "coords">): Planet {
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

function makeState(args: { sourcePlanetId: string; sourceGalaxy: number }): WorldState {
  const planet = makePlanet({
    id: args.sourcePlanetId,
    coords: [args.sourceGalaxy, 100, 8],
  });
  return {
    server: { universe: "uni1", speed: 1 },
    player: { id: "me", name: "me", alliance: null },
    planets: [planet],
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: NOW,
    page_snapshots: {},
  };
}

function makeConfig(
  overrides: Partial<ExpeditionConfig["galaxy_strategy"]> & {
    preferred_galaxies?: number[];
  } = {},
): ExpeditionConfig {
  const { preferred_galaxies, ...rest } = overrides;
  const galaxy_strategy: ExpeditionConfig["galaxy_strategy"] = {
    mode: "stats_based",
    home_galaxy_first: true,
    switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
    cross_galaxy_deut_budget: 0,
    ...rest,
  };
  if (preferred_galaxies !== undefined) {
    galaxy_strategy.preferred_galaxies = preferred_galaxies;
  }
  return {
    enabled: true,
    auto_fill_slots: true,
    source_planet: "p1",
    duration: "medium",
    target_position: 16,
    fleet_templates: {},
    galaxy_strategy,
    cargo_load: {
      smallCargo_capacity_pct: 100,
      largeCargo_capacity_pct: 100,
    },
  };
}

describe("pickGalaxy — mode: fixed", () => {
  it("returns preferred_galaxies[0] regardless of outcomes", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 5 });
    const config = makeConfig({ mode: "fixed", preferred_galaxies: [3] });
    // Even with bad outcomes in galaxy 3, fixed mode wins.
    const outcomes: ExpeditionOutcome[] = Array.from({ length: 30 }, (_, i) =>
      makeOutcome({
        expedition_id: `f${i}`,
        target_galaxy: 3,
        outcome_type: "black_hole",
      }),
    );
    // Mock Date.now so the picker can compute the 24h window.
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(pickGalaxy({ state, recentOutcomes: outcomes, config })).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  it("falls back to source planet galaxy when preferred_galaxies missing", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 5 });
    const config = makeConfig({ mode: "fixed" }); // no preferred_galaxies
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(pickGalaxy({ state, recentOutcomes: [], config })).toBe(5);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("pickGalaxy — mode: rotate", () => {
  it("round-robins through preferred_galaxies keyed off recentOutcomes.length", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 5 });
    const config = makeConfig({ mode: "rotate", preferred_galaxies: [1, 2, 3] });
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({ expedition_id: "a" }),
      makeOutcome({ expedition_id: "b" }),
    ];
    // 2 % 3 = 2 → preferred_galaxies[2] = 3
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(pickGalaxy({ state, recentOutcomes: outcomes, config })).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  it("falls back to source galaxy when preferred_galaxies missing", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 7 });
    const config = makeConfig({ mode: "rotate" });
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(pickGalaxy({ state, recentOutcomes: [], config })).toBe(7);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("pickGalaxy — mode: stats_based", () => {
  it("returns source galaxy when home_galaxy_first=true and bh_rate <= threshold", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 4 });
    const config = makeConfig({
      mode: "stats_based",
      home_galaxy_first: true,
      switch_threshold: { black_hole_rate_24h: 0.1, sample_size_min: 5 },
    });
    // 1 black_hole out of 30 in source galaxy 4 → rate ~0.033, below 0.1
    const outcomes: ExpeditionOutcome[] = Array.from({ length: 30 }, (_, i) =>
      makeOutcome({
        expedition_id: `s${i}`,
        target_galaxy: 4,
        outcome_type: i === 0 ? "black_hole" : "resources_small",
      }),
    );
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(pickGalaxy({ state, recentOutcomes: outcomes, config })).toBe(4);
    } finally {
      Date.now = realNow;
    }
  });

  it("picks a better galaxy when home bh_rate exceeds threshold", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 4 });
    const config = makeConfig({
      mode: "stats_based",
      home_galaxy_first: true,
      switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 5 },
    });
    // Galaxy 4 (source): 5 black_holes / 10 outcomes = 0.5 (above threshold)
    const home: ExpeditionOutcome[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome({
        expedition_id: `h${i}`,
        target_galaxy: 4,
        outcome_type: i < 5 ? "black_hole" : "resources_small",
      }),
    );
    // Galaxy 2: 0 black_holes / 10 → rate 0
    const better: ExpeditionOutcome[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome({
        expedition_id: `g2-${i}`,
        target_galaxy: 2,
        outcome_type: "resources_small",
      }),
    );
    // Galaxy 6: 2 black_holes / 10 → 0.2
    const mid: ExpeditionOutcome[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome({
        expedition_id: `g6-${i}`,
        target_galaxy: 6,
        outcome_type: i < 2 ? "black_hole" : "resources_small",
      }),
    );
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(
        pickGalaxy({
          state,
          recentOutcomes: [...home, ...better, ...mid],
          config,
        }),
      ).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("falls back to source galaxy when no galaxy meets sample_size_min", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 4 });
    const config = makeConfig({
      mode: "stats_based",
      home_galaxy_first: false, // bypass home-first so we hit the picker branch
      switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
    });
    // Plenty of outcomes but none reach 20 in any one galaxy
    const outcomes: ExpeditionOutcome[] = Array.from({ length: 15 }, (_, i) =>
      makeOutcome({
        expedition_id: `t${i}`,
        target_galaxy: 2,
        outcome_type: "resources_small",
      }),
    );
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(pickGalaxy({ state, recentOutcomes: outcomes, config })).toBe(4);
    } finally {
      Date.now = realNow;
    }
  });

  it("breaks ties on black_hole_rate by picking higher avgResourceYield", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 4 });
    const config = makeConfig({
      mode: "stats_based",
      home_galaxy_first: false,
      switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 5 },
    });
    // Galaxy 2: 0 bh, low yield (each outcome 100 total)
    const g2: ExpeditionOutcome[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome({
        expedition_id: `g2-${i}`,
        target_galaxy: 2,
        outcome_type: "resources_small",
        resources_gained: { m: 40, c: 40, d: 20, e: 0 },
      }),
    );
    // Galaxy 6: 0 bh, high yield (each outcome 1000 total)
    const g6: ExpeditionOutcome[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome({
        expedition_id: `g6-${i}`,
        target_galaxy: 6,
        outcome_type: "resources_small",
        resources_gained: { m: 400, c: 400, d: 200, e: 0 },
      }),
    );
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(
        pickGalaxy({ state, recentOutcomes: [...g2, ...g6], config }),
      ).toBe(6);
    } finally {
      Date.now = realNow;
    }
  });

  it("ignores outcomes older than 24h when computing rates", () => {
    const state = makeState({ sourcePlanetId: "p1", sourceGalaxy: 4 });
    const config = makeConfig({
      mode: "stats_based",
      home_galaxy_first: true,
      switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 5 },
    });
    // Source galaxy: 10 ancient black_hole outcomes (>24h old) → must be ignored.
    // Plus 10 recent resources_small → recent rate = 0, so home stays.
    const ancient: ExpeditionOutcome[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome({
        expedition_id: `old-${i}`,
        target_galaxy: 4,
        outcome_type: "black_hole",
        returned_at: NOW - 2 * DAY,
      }),
    );
    const recent: ExpeditionOutcome[] = Array.from({ length: 10 }, (_, i) =>
      makeOutcome({
        expedition_id: `new-${i}`,
        target_galaxy: 4,
        outcome_type: "resources_small",
        returned_at: NOW - HOUR,
      }),
    );
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(
        pickGalaxy({ state, recentOutcomes: [...ancient, ...recent], config }),
      ).toBe(4);
    } finally {
      Date.now = realNow;
    }
  });
});
