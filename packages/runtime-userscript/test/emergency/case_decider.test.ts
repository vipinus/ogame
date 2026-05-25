import { describe, it, expect } from "vitest";
import { decideCase } from "../../src/emergency/case_decider.js";
import type { WorldState, Planet } from "@ogamex/shared";

const emptyState = (planets: Planet[]): WorldState => ({
  server: { universe: "u", speed: 1 },
  player: { id: "p", name: "n", alliance: null },
  planets,
  research: { levels: {}, queue: null },
  fleets_outbound: [],
  events_incoming: [],
  artifacts: { artifacts: {} },
  discovery_slots: { used: 0, max: 0 },
  discovery_active: [],
  last_update: 0,
  page_snapshots: {},
});

const makePlanet = (overrides: Partial<Planet>): Planet => ({
  id: "p1", name: "母星", coords: [1, 42, 8], type: "planet",
  resources: { m: 0, c: 0, d: 0, e: 0 },
  storage: { m_max: 0, c_max: 0, d_max: 0 },
  production: { m_h: 0, c_h: 0, d_h: 0 },
  buildings: {}, build_q: null, shipyard_q: null, defense_q: null,
  ships: {}, defense: {}, lifeform: null,
  ...overrides,
});

describe("decideCase", () => {
  it("Case A: source on moon → mission=TRANSPORT to same-coord planet, speed=1 (10%)", () => {
    // Operator 2026-05-24 new strategy: 月→同坐标星球 transport @ 10%,
    // moon retains 50K deut reserve for jump gate.
    const moon = makePlanet({
      id: "m1", name: "母月", coords: [1, 42, 8], type: "moon",
      // Plenty of deut so reserve is meaningful (d=200K, 50K stays)
      resources: { m: 100, c: 200, d: 200_000, e: 0 },
      ships: { smallCargo: 50, recycler: 5 },
    });
    const planet = makePlanet({
      id: "p1", name: "母星", coords: [1, 42, 8], type: "planet",
      ships: {}, resources: { m: 0, c: 0, d: 0, e: 0 },
    });
    const d = decideCase(emptyState([moon, planet]), "m1");
    expect(d.case).toBe("A");
    expect(d.mission).toBe(4);  // DEPLOY (operator 2026-05-25)
    expect(d.destType).toBe(1);
    expect(d.destCoords).toEqual([1, 42, 8]);
    expect(d.speed).toBe(1);
    expect(d.ships).toEqual({ smallCargo: 50, recycler: 5 });
    // 50 smallCargo (5000ea) + 5 recyclers (20000ea) = 350K capacity.
    // Requested = 100 + 200 + (200K - 50K reserve) = 150_300 → fits.
    expect(d.cargo).toEqual({ m: 100, c: 200, d: 150_000 });
    expect(d.sourcePlanetId).toBe("m1");
  });

  it("Case B: source on planet with same-coord moon → mission=TRANSPORT to moon, speed=1 (10%)", () => {
    // Operator 2026-05-24 new strategy: 星→同坐标月 transport @ 10% (was 100%).
    const planet = makePlanet({
      id: "p1", name: "母星", coords: [1, 42, 8], type: "planet",
      resources: { m: 100, c: 200, d: 100, e: 0 },
      ships: { smallCargo: 200, lightFighter: 500, recycler: 3 },
    });
    const moon = makePlanet({
      id: "m1", name: "母月", coords: [1, 42, 8], type: "moon",
      ships: {}, resources: { m: 0, c: 0, d: 0, e: 0 },
    });
    const d = decideCase(emptyState([planet, moon]), "p1");
    expect(d.case).toBe("B");
    expect(d.mission).toBe(4);  // DEPLOY (operator 2026-05-25)
    expect(d.destType).toBe(3);
    expect(d.destCoords).toEqual([1, 42, 8]);
    expect(d.speed).toBe(1);
    expect(d.ships).toEqual({ smallCargo: 200, lightFighter: 500, recycler: 3 });
    // Resources < capacity → unchanged
    expect(d.cargo).toEqual({ m: 100, c: 200, d: 100 });
  });

  it("Case C: source on planet, no moon at same coords → mission=RECYCLE to local debris, speed=1", () => {
    const planet = makePlanet({
      id: "p2", name: "辅1", coords: [2, 100, 8], type: "planet",
      resources: { m: 1000, c: 1000, d: 500, e: 0 },
      ships: { smallCargo: 100, recycler: 2 },
    });
    const otherMoon = makePlanet({
      id: "m_other", name: "其他月球", coords: [3, 200, 8], type: "moon",
    });
    const d = decideCase(emptyState([planet, otherMoon]), "p2");
    expect(d.case).toBe("C");
    expect(d.mission).toBe(8);
    expect(d.destType).toBe(2);
    expect(d.destCoords).toEqual([2, 100, 8]);
    expect(d.speed).toBe(1);
  });

  it("includes ALL ships from source planet in fleet", () => {
    const planet = makePlanet({
      ships: {
        smallCargo: 50, largeCargo: 30,
        lightFighter: 200, heavyFighter: 30,
        recycler: 1, espionageProbe: 100,
      },
    });
    const d = decideCase(emptyState([planet]), "p1");
    expect(d.ships).toEqual({
      smallCargo: 50, largeCargo: 30,
      lightFighter: 200, heavyFighter: 30,
      recycler: 1, espionageProbe: 100,
    });
  });

  it("cargo priority deut→crystal→metal (operator 2026-05-24)", () => {
    // recycler×1 = 20000 base capacity. Resources 1234567 m + 891011 c + 22222 d.
    // Priority: full 22222 deut first, then fill crystal w/ remaining, metal last.
    const planet = makePlanet({
      resources: { m: 1234567, c: 891011, d: 22222, e: 100 },
      ships: { recycler: 1 },
    });
    const d = decideCase(emptyState([planet]), "p1");
    const total = d.cargo.m + d.cargo.c + d.cargo.d;
    expect(total).toBeLessThanOrEqual(20000);
    // 22222 deut requested but only 20000 capacity → all 20000 goes to deut,
    // 0 left for crystal/metal.
    expect(d.cargo.d).toBe(20000);
    expect(d.cargo.c).toBe(0);
    expect(d.cargo.m).toBe(0);
  });

  it("cargo priority fills deut first, then crystal, then metal", () => {
    // Larger capacity: smallCargo×100 (5000ea) = 500000. Resources 200 d, 800K c, big m.
    const planet = makePlanet({
      resources: { m: 1_000_000, c: 800_000, d: 200, e: 0 },
      ships: { smallCargo: 100, recycler: 1 },  // 500000 + 20000 = 520000 cap
    });
    const d = decideCase(emptyState([planet]), "p1");
    // 200 deut fully loaded, then 519800 capacity remains
    expect(d.cargo.d).toBe(200);
    // Crystal 800K requested, fills 519800 of cap → crystal=519800, metal=0
    expect(d.cargo.c).toBe(519_800);
    expect(d.cargo.m).toBe(0);
  });

  it("Case A reserves 50K deut on moon (operator 2026-05-24 jump-gate fuel)", () => {
    const moon = makePlanet({
      id: "m1", coords: [1, 42, 8], type: "moon",
      // 200K deut on moon, fleet has plenty capacity to carry it all
      resources: { m: 0, c: 0, d: 200_000, e: 0 },
      ships: { recycler: 10 },  // 10 × 20000 = 200K capacity, far more than 150K
    });
    const planet = makePlanet({
      id: "p1", coords: [1, 42, 8], type: "planet", ships: {},
    });
    const d = decideCase(emptyState([moon, planet]), "m1");
    expect(d.case).toBe("A");
    // 200K - 50K reserve = 150K loadable. Capacity 200K ≥ 150K → no scale.
    expect(d.cargo.d).toBe(150_000);
    expect(d.cargo.m).toBe(0);
    expect(d.cargo.c).toBe(0);
  });

  it("Case B (planet→moon) does NOT reserve deut (only moon source reserves)", () => {
    const planet = makePlanet({
      id: "p1", coords: [1, 42, 8], type: "planet",
      resources: { m: 0, c: 0, d: 100_000, e: 0 },
      ships: { recycler: 10 },  // 200K capacity
    });
    const moon = makePlanet({
      id: "m1", coords: [1, 42, 8], type: "moon", ships: {},
    });
    const d = decideCase(emptyState([planet, moon]), "p1");
    expect(d.case).toBe("B");
    // No reservation on planet source — full 100K loaded
    expect(d.cargo.d).toBe(100_000);
  });

  it("Case C throws when no recycler (only Case C needs recycler)", () => {
    // Planet with no same-coord moon → falls to Case C → recycle mission
    // strictly requires recycler. Without one, throws so fsm silent-skips.
    const planet = makePlanet({ ships: { smallCargo: 100 } });
    expect(() => decideCase(emptyState([planet]), "p1")).toThrow(/recycler/i);
  });

  it("Case A (moon→planet transport) does NOT need recycler — operator 2026-05-24", () => {
    const moon = makePlanet({
      id: "m1", coords: [1, 42, 8], type: "moon",
      ships: { smallCargo: 100, largeCargo: 50 },  // no recycler
      resources: { m: 0, c: 0, d: 0, e: 0 },
    });
    const planet = makePlanet({
      id: "p1", coords: [1, 42, 8], type: "planet", ships: {},
    });
    const d = decideCase(emptyState([moon, planet]), "m1");
    expect(d.case).toBe("A");
    expect(d.mission).toBe(4); // DEPLOY
    expect(d.ships.smallCargo).toBe(100);
  });

  it("Case B (planet→moon transport) does NOT need recycler — operator 2026-05-24", () => {
    const planet = makePlanet({
      id: "p1", coords: [1, 42, 8], type: "planet",
      ships: { smallCargo: 100, lightFighter: 50 },  // no recycler
      resources: { m: 0, c: 0, d: 0, e: 0 },
    });
    const moon = makePlanet({
      id: "m1", coords: [1, 42, 8], type: "moon", ships: {},
    });
    const d = decideCase(emptyState([planet, moon]), "p1");
    expect(d.case).toBe("B");
    expect(d.mission).toBe(4); // DEPLOY
    expect(d.ships.smallCargo).toBe(100);
  });

  it("throws when source planet not found", () => {
    expect(() => decideCase(emptyState([]), "nope")).toThrow(/not found/i);
  });

  it("includes a human-readable reason string", () => {
    // Case A needs a same-coord planet (operator 2026-05-24 new strategy).
    const moon = makePlanet({
      id: "m1", coords: [1, 42, 8], type: "moon", ships: { recycler: 1 },
    });
    const planet = makePlanet({
      id: "p1", coords: [1, 42, 8], type: "planet", ships: {},
    });
    const d = decideCase(emptyState([moon, planet]), "m1");
    expect(d.reason).toMatch(/Case A/i);
  });
});
