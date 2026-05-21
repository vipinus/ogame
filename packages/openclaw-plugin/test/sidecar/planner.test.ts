import { describe, it, expect } from "vitest";
import type { Goal, Planet, WorldState, Directive } from "@ogamex/shared";
import { planGoal, type PlanResult } from "../../src/sidecar/planner.js";

// ────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ────────────────────────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> & Pick<Goal, "type" | "target">): Goal {
  return {
    id: "g-test",
    priority: 50,
    status: "pending",
    created_at: 0,
    progress_pct: 0,
    current_step: "queued",
    eta_at: null,
    ...overrides,
  } as Goal;
}

function makePlanet(
  id: string,
  buildings: Record<string, number> = {},
  resources?: { m?: number; c?: number; d?: number; e?: number },
): Planet {
  return {
    id,
    name: id,
    coords: [1, 1, 1],
    type: "planet",
    resources: { m: resources?.m ?? 0, c: resources?.c ?? 0, d: resources?.d ?? 0, e: resources?.e ?? 100 },
    storage: { m_max: 0, c_max: 0, d_max: 0 },
    production: { m_h: 0, c_h: 0, d_h: 0 },
    buildings,
    build_q: null,
    shipyard_q: null,
    defense_q: null,
    ships: {},
    defense: {},
    lifeform: null,
  };
}

function makeState(opts: {
  researchLevels?: Record<string, number>;
  planets?: Array<{ id: string; buildings?: Record<string, number>; resources?: { m?: number; c?: number; d?: number; e?: number } }>;
} = {}): WorldState {
  const planetArr = (opts.planets ?? [{ id: "p1", buildings: {} }]).map((p) =>
    makePlanet(p.id, p.buildings ?? {}, p.resources),
  );
  // Post Map refactor: state.planets is Record<string, Planet>.
  const planets = Object.fromEntries(planetArr.map((p) => [p.id, p]));
  return {
    server: { universe: "uni1", speed: 1 },
    player: { id: "p1", name: "tester", alliance: null },
    planets,
    research: { levels: opts.researchLevels ?? {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    // 2026 fields not under test
    artifacts: { artifacts: {} } as any,
    discovery_slots: { used: 0, max: 0 } as any,
    discovery_active: [] as any,
    last_update: 0,
    page_snapshots: {},
  };
}

function isDirective(r: PlanResult): r is Directive {
  return typeof (r as Directive).id === "string" && typeof (r as Directive).action === "string";
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("planGoal — research", () => {
  it("emits research directive when all prereqs already met", () => {
    // gravitonTech requires researchLab 12 + energyTech 12 + shielding 5
    const state = makeState({
      researchLevels: { energyTech: 12, shielding: 5 },
      planets: [{ id: "p1", buildings: { researchLab: 12 } }],
    });
    const goal = makeGoal({
      id: "g-grav",
      type: "research",
      target: { tech: "gravitonTech", level: 1 },
      priority: 70,
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
    if (!isDirective(result)) return;
    expect(result.action).toBe("research");
    expect(result.params.tech).toBe("gravitonTech");
    expect(result.params.target_level).toBe(1);
    expect(result.params.planet_id).toBe("p1");
    expect(result.source).toBe("goal");
    expect(result.method).toBe("ui");
    expect(result.priority).toBe(70);
    expect(result.goal_id).toBe("g-grav");
    expect(result.preconds).toEqual([]);
    expect(typeof result.id).toBe("string");
    expect(result.id.startsWith("dir-")).toBe(true);
  });

  it("recurses into a missing building prereq (researchLab)", () => {
    // gravitonTech needs researchLab 12 — but researchLab is 0 on the source planet
    const state = makeState({
      researchLevels: { energyTech: 12, shielding: 5 },
      planets: [{ id: "p1", buildings: { researchLab: 0 } }],
    });
    const goal = makeGoal({
      id: "g-grav",
      type: "research",
      target: { tech: "gravitonTech", level: 1 },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
    if (!isDirective(result)) return;
    // The recursion should walk down to a researchLab build directive (researchLab itself has no prereqs)
    expect(result.action).toBe("build");
    expect(result.params.building).toBe("researchLab");
    expect(result.params.target_level).toBe(1);
    expect(result.params.planet_id).toBe("p1");
    // goal_id should still be the top-level goal id
    expect(result.goal_id).toBe("g-grav");
  });

  it("recurses into one of the missing prereqs when multiple are missing", () => {
    // gravitonTech needs researchLab 12, energyTech 12, shielding 5 — all missing.
    // The planner should pick one (implementation order) and recurse into it.
    const state = makeState({
      researchLevels: {},
      planets: [{ id: "p1", buildings: {} }],
    });
    const goal = makeGoal({
      id: "g-grav",
      type: "research",
      target: { tech: "gravitonTech", level: 1 },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
    if (!isDirective(result)) return;
    // Should resolve to ONE of the prereqs (eventually leaf): researchLab (build, no prereqs),
    // or energyTech (research → needs researchLab → build researchLab),
    // or shielding (research → needs researchLab + energyTech → eventually build researchLab).
    // All chains terminate at building researchLab L1 since it's the only no-prereq leaf for these branches.
    // We accept any of: build researchLab, or — if iteration picks energyTech/shielding first — still resolves down.
    const params = result.params;
    const okBuilding =
      result.action === "build" && params.building === "researchLab";
    const okResearch =
      result.action === "research" &&
      (params.tech === "energyTech" || params.tech === "shielding" || params.tech === "gravitonTech");
    expect(okBuilding || okResearch).toBe(true);
  });

  it("blocks when current research level already at or above target", () => {
    const state = makeState({
      researchLevels: { gravitonTech: 6 },
      planets: [{ id: "p1", buildings: { researchLab: 12 } }],
    });
    const goal = makeGoal({
      id: "g-grav",
      type: "research",
      target: { tech: "gravitonTech", level: 6 },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(false);
    expect((result as { blocked: string }).blocked).toMatch(/already at or above/i);
  });

  it("blocks on unknown tech id", () => {
    const state = makeState();
    const goal = makeGoal({
      id: "g-unk",
      type: "research",
      target: { tech: "wakandium", level: 1 },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(false);
    expect((result as { blocked: string }).blocked).toMatch(/unknown tech/i);
    expect((result as { blocked: string }).blocked).toContain("wakandium");
  });
});

describe("planGoal — build", () => {
  it("emits build directive when all prereqs already met", () => {
    // naniteFactory requires roboticsFactory 10 (building) + computerTech 10 (research)
    const state = makeState({
      researchLevels: { computerTech: 10 },
      planets: [{ id: "p1", buildings: { roboticsFactory: 10, naniteFactory: 1 } }],
    });
    const goal = makeGoal({
      id: "g-nano",
      type: "build",
      target: { building: "naniteFactory", level: 2, planet: "p1" },
      priority: 60,
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
    if (!isDirective(result)) return;
    expect(result.action).toBe("build");
    expect(result.params.building).toBe("naniteFactory");
    expect(result.params.target_level).toBe(2);
    expect(result.params.planet_id).toBe("p1");
    expect(result.priority).toBe(60);
    expect(result.goal_id).toBe("g-nano");
  });

  it("recurses when a building prereq is missing on the target planet", () => {
    // naniteFactory needs roboticsFactory 10; we provide 0 → recurse to build roboticsFactory
    const state = makeState({
      researchLevels: { computerTech: 10 },
      planets: [{ id: "p1", buildings: { roboticsFactory: 0 } }],
    });
    const goal = makeGoal({
      id: "g-nano",
      type: "build",
      target: { building: "naniteFactory", level: 1, planet: "p1" },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
    if (!isDirective(result)) return;
    expect(result.action).toBe("build");
    // roboticsFactory has no prereqs → leaf, should be the directive returned
    expect(result.params.building).toBe("roboticsFactory");
    expect(result.params.target_level).toBe(1);
    expect(result.params.planet_id).toBe("p1");
    expect(result.goal_id).toBe("g-nano");
  });

  it("blocks when the goal's target planet is not in state.planets", () => {
    const state = makeState({
      planets: [{ id: "p1", buildings: {} }],
    });
    const goal = makeGoal({
      id: "g-ghost",
      type: "build",
      target: { building: "roboticsFactory", level: 1, planet: "ghost-planet" },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(false);
    expect((result as { blocked: string }).blocked).toMatch(/planet not found/i);
  });
});

describe("planGoal — unimplemented goal types", () => {
  it("returns blocked for goal type 'colonize'", () => {
    const state = makeState();
    const goal = makeGoal({
      id: "g-col",
      type: "colonize",
      target: { coords: [1, 2, 3] },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(false);
    expect((result as { blocked: string }).blocked).toMatch(/not implemented|colonize/i);
  });
});

describe("planGoal — deep recursion", () => {
  it("walks several layers of prereqs and returns a leaf directive", () => {
    // gravitonTech needs researchLab(b) 12 + energyTech(r) 12 + shielding(r) 5.
    //   shielding needs researchLab 6 + energyTech 3.
    //   energyTech needs researchLab 1.
    // Starting from empty state, planner must walk down and eventually return a leaf
    // (researchLab build, since it has no prereqs).
    const state = makeState({
      researchLevels: {},
      planets: [{ id: "p1", buildings: {} }],
    });
    const goal = makeGoal({
      id: "g-deep",
      type: "research",
      target: { tech: "gravitonTech", level: 1 },
    });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
    if (!isDirective(result)) return;
    // Eventually-leaf must be a researchLab build (since all chains converge there).
    expect(result.action).toBe("build");
    expect(result.params.building).toBe("researchLab");
    expect(result.params.target_level).toBe(1);
    expect(result.goal_id).toBe("g-deep");
  });
});

describe("planGoal — energy gating", () => {
  it("auto-recurses into solar upgrade when energy is negative", () => {
    // Energy-gated mine + energy<0 → planner should emit a solar build
    // directive (auto-prereq) instead of just blocking. Owner sets the mine
    // goal once; planner handles the prereq chain.
    const state = makeState({
      planets: [{ id: "p1", buildings: { metalMine: 13, solarPlant: 12 }, resources: { e: -50 } }],
    });
    const goal = makeGoal({ id: "g-mm", type: "build", target: { building: "metalMine", level: 18, planet: "p1" }, priority: 6 });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
    if (!isDirective(result)) return;
    expect(result.action).toBe("build");
    expect(result.params.building).toBe("solarPlant");
    expect(result.params.target_level).toBe(13); // solarPlant +1 from current 12
  });

  it("solar prereq emits for all energy-gated mines (metal/crystal/deut) when greenfield", () => {
    // Greenfield colony (solar=0, mines=0) — planner should propose solar L1
    // regardless of which mine the operator asked for.
    const state = makeState({ planets: [{ id: "p1", buildings: {}, resources: { e: 0 } }] });
    for (const b of ["metalMine", "crystalMine", "deuteriumSynth"]) {
      const goal = makeGoal({ id: `g-${b}`, type: "build", target: { building: b, level: 5, planet: "p1" } });
      const result = planGoal(goal, state);
      expect(isDirective(result)).toBe(true);
      if (isDirective(result)) {
        expect(result.params.building).toBe("solarPlant");
        expect(result.params.target_level).toBe(1);
      }
    }
  });

  it("does NOT block solarPlant/fusionReactor when energy is negative — those PRODUCE energy", () => {
    const state = makeState({ planets: [{ id: "p1", buildings: { solarPlant: 11 }, resources: { e: -50 } }] });
    const goal = makeGoal({ id: "g-solar", type: "build", target: { building: "solarPlant", level: 12, planet: "p1" } });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
  });

  it("does NOT block mines when energy is non-negative", () => {
    const state = makeState({ planets: [{ id: "p1", buildings: { metalMine: 5 }, resources: { e: 100 } }] });
    const goal = makeGoal({ id: "g-mm", type: "build", target: { building: "metalMine", level: 6, planet: "p1" } });
    const result = planGoal(goal, state);
    expect(isDirective(result)).toBe(true);
  });
});
