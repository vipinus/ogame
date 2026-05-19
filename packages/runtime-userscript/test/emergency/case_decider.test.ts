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
  it("Case A: source on moon → mission=RECYCLE to debris, speed=1, full ships+cargo", () => {
    const moon = makePlanet({
      id: "m1", name: "母月", coords: [1, 42, 8], type: "moon",
      resources: { m: 100, c: 200, d: 300, e: 0 },
      ships: { smallCargo: 50, recycler: 5 },
    });
    const d = decideCase(emptyState([moon]), "m1");
    expect(d.case).toBe("A");
    expect(d.mission).toBe(8);
    expect(d.destType).toBe(2);
    expect(d.destCoords).toEqual([1, 42, 8]);
    expect(d.speed).toBe(1);
    expect(d.ships).toEqual({ smallCargo: 50, recycler: 5 });
    expect(d.cargo).toEqual({ m: 100, c: 200, d: 300 });
    expect(d.sourcePlanetId).toBe("m1");
  });

  it("Case B: source on planet with same-coord moon → mission=TRANSPORT to moon, speed=10", () => {
    const planet = makePlanet({
      id: "p1", name: "母星", coords: [1, 42, 8], type: "planet",
      resources: { m: 500000, c: 300000, d: 100000, e: 0 },
      ships: { smallCargo: 200, lightFighter: 500, recycler: 3 },
    });
    const moon = makePlanet({
      id: "m1", name: "母月", coords: [1, 42, 8], type: "moon",
      ships: {}, resources: { m: 0, c: 0, d: 0, e: 0 },
    });
    const d = decideCase(emptyState([planet, moon]), "p1");
    expect(d.case).toBe("B");
    expect(d.mission).toBe(3);
    expect(d.destType).toBe(3);
    expect(d.destCoords).toEqual([1, 42, 8]);
    expect(d.speed).toBe(10);
    expect(d.ships).toEqual({ smallCargo: 200, lightFighter: 500, recycler: 3 });
    expect(d.cargo).toEqual({ m: 500000, c: 300000, d: 100000 });
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

  it("includes ALL available resources as cargo", () => {
    const planet = makePlanet({
      resources: { m: 1234567, c: 891011, d: 22222, e: 100 },
      ships: { recycler: 1 },
    });
    const d = decideCase(emptyState([planet]), "p1");
    expect(d.cargo).toEqual({ m: 1234567, c: 891011, d: 22222 });
    // energy is intentionally NOT cargo (cargo is m/c/d only)
  });

  it("throws when no recycler at source (degradation handled by caller)", () => {
    const planet = makePlanet({ ships: { smallCargo: 100 } });
    expect(() => decideCase(emptyState([planet]), "p1")).toThrow(/recycler/i);
  });

  it("throws when source planet not found", () => {
    expect(() => decideCase(emptyState([]), "nope")).toThrow(/not found/i);
  });

  it("includes a human-readable reason string", () => {
    const moon = makePlanet({
      id: "m1", type: "moon", ships: { recycler: 1 },
    });
    const d = decideCase(emptyState([moon]), "m1");
    expect(d.reason).toMatch(/Case A/i);
  });
});
