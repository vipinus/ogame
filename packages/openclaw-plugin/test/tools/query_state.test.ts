import { describe, it, expect } from "vitest";
import type { Planet, WorldState } from "@ogamex/shared";
import { makeQueryStateTool, type WorldStateRef } from "../../src/tools/query_state.js";

function makePlanet(name: string, id = name.toLowerCase(), coords: Planet["coords"] = [1, 1, 1]): Planet {
  return {
    id,
    name,
    coords,
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
  };
}

function makeMinimalWorldState({ planets }: { planets: Planet[] }): WorldState {
  return {
    server: { universe: "uni1", speed: 1 },
    player: { id: "p1", name: "tester", alliance: null },
    planets,
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    // fixture: 2026 fields not under test
    artifacts: { artifacts: {} } as any,
    discovery_slots: { used: 0, max: 0 } as any,
    discovery_active: [] as any,
    last_update: 0,
    page_snapshots: {},
  };
}

describe("makeQueryStateTool", () => {
  it("returns error envelope when no state has been received", () => {
    const ref: WorldStateRef = { current: null };
    const tool = makeQueryStateTool(ref);
    expect(tool.execute({})).toEqual({ error: "state not yet received" });
  });

  it("returns full WorldState when no planet param is given", () => {
    const state = makeMinimalWorldState({ planets: [makePlanet("Homeworld")] });
    const ref: WorldStateRef = { current: state };
    const tool = makeQueryStateTool(ref);
    expect(tool.execute({})).toEqual(state);
  });

  it("returns matching Planet when planet name matches", () => {
    const home = makePlanet("Homeworld", "p-home", [1, 2, 3]);
    const colony = makePlanet("Colony", "p-col", [4, 5, 6]);
    const state = makeMinimalWorldState({ planets: [home, colony] });
    const ref: WorldStateRef = { current: state };
    const tool = makeQueryStateTool(ref);
    expect(tool.execute({ planet: "Homeworld" })).toEqual(home);
  });

  it("returns error envelope when planet name does not match", () => {
    const state = makeMinimalWorldState({ planets: [makePlanet("Homeworld")] });
    const ref: WorldStateRef = { current: state };
    const tool = makeQueryStateTool(ref);
    expect(tool.execute({ planet: "Atlantis" })).toEqual({
      error: "unknown planet Atlantis",
    });
  });

  it("treats empty-string planet param as 'no filter' and returns full state", () => {
    const state = makeMinimalWorldState({ planets: [makePlanet("Homeworld")] });
    const ref: WorldStateRef = { current: state };
    const tool = makeQueryStateTool(ref);
    expect(tool.execute({ planet: "" })).toEqual(state);
  });

  it("reflects ref-cell mutation between calls (closure references ref, not snapshot)", () => {
    const ref: WorldStateRef = { current: null };
    const tool = makeQueryStateTool(ref);

    const stateA = makeMinimalWorldState({ planets: [makePlanet("Alpha", "a")] });
    ref.current = stateA;
    expect(tool.execute({})).toEqual(stateA);

    const stateB = makeMinimalWorldState({ planets: [makePlanet("Beta", "b")] });
    ref.current = stateB;
    expect(tool.execute({})).toEqual(stateB);
    expect(tool.execute({ planet: "Beta" })).toEqual(stateB.planets[0]);
  });
});
