import { describe, it, expect } from "vitest";
import { planTransportChain, makeTransportChainId, type PlannerPlanet } from "../src/transport_planner.js";

/**
 * Parity test — pins the chain-planner behaviour ported from
 * runtime-userscript goals_panel.ts:3140-3247 so the userscript and
 * ogame-next web dashboard cannot diverge.
 */

const PLANET_A: PlannerPlanet = { id: "p_a", type: "planet", coords: [1, 100, 5] };
const MOON_A:   PlannerPlanet = { id: "m_a", type: "moon",   coords: [1, 100, 5] };
const PLANET_B: PlannerPlanet = { id: "p_b", type: "planet", coords: [2, 200, 7] };
const MOON_B:   PlannerPlanet = { id: "m_b", type: "moon",   coords: [2, 200, 7] };
const PLANET_C: PlannerPlanet = { id: "p_c", type: "planet", coords: [3, 300, 3] };
const ALL = [PLANET_A, MOON_A, PLANET_B, MOON_B, PLANET_C];

describe("planTransportChain", () => {
  it("source == target ⇒ empty chain", () => {
    const out = planTransportChain({
      source: PLANET_A, target: PLANET_A,
      ships: { largeCargo: 10 }, cargo: { m: 0, c: 0, d: 0 },
      jgEnabled: false, jgTakeAll: true, allPlanets: ALL, chainId: "txc-x",
    });
    expect(out.goals).toHaveLength(0);
  });

  it("direct sublight: 1 deploy with cargo", () => {
    const out = planTransportChain({
      source: PLANET_A, target: PLANET_B,
      ships: { largeCargo: 100 }, cargo: { m: 1_000_000, c: 500_000, d: 100_000 },
      jgEnabled: false, jgTakeAll: true, allPlanets: ALL, chainId: "txc-1",
    });
    expect(out.goals).toHaveLength(1);
    expect(out.goals[0]).toMatchObject({
      type: "deploy",
      planet: "p_a",
      priority: 9,
      target: {
        target_coords: "2:200:7",
        target_type: "planet",
        ships: { largeCargo: 100 },
        cargo: { m: 1_000_000, c: 500_000, d: 100_000 },
        source_planet: "p_a",
        chain_id: "txc-1",
        chain_phase: "to_target_direct",
      },
    });
  });

  it("same-coord planet↔moon ⇒ single local deploy", () => {
    const out = planTransportChain({
      source: PLANET_A, target: MOON_A,
      ships: { largeCargo: 1 }, cargo: { m: 0, c: 0, d: 0 },
      jgEnabled: true, jgTakeAll: true, allPlanets: ALL, chainId: "txc-x",
    });
    expect(out.goals).toHaveLength(1);
    expect(out.goals[0]!.target.chain_phase).toBe("to_target_local");
    // Moon-target adds +50K d buffer even when input cargo.d=0.
    expect((out.goals[0]!.target as { cargo?: { d: number } }).cargo?.d).toBe(50_000);
  });

  it("JG ferry: planet→moon→moon→planet (empty, jgEnabled)", () => {
    const out = planTransportChain({
      source: PLANET_A, target: PLANET_B,
      ships: { largeCargo: 100 }, cargo: { m: 0, c: 0, d: 0 },
      // NOTE: carryCargo=true forces sublight (JG-only-empty rule). Test it
      // by setting all cargo to 0 → segment 2 still hauls cargo. So use the
      // empty-ferry segment which is segment 1: set resource ≠ source so
      // segment 1 fires with carryCargo=false.
      jgEnabled: true, jgTakeAll: true, allPlanets: ALL, chainId: "txc-jg",
      resource: PLANET_B,  // segment 1: A → B empty
    });
    // Segment 1 (A → B, empty) should JG: A → m_a (load), m_a → m_b (hop), m_b → B (unload)
    // Segment 2 (B → B, cargo) should be empty (resource == target).
    const seg1 = out.goals.filter(g => String(g.target.chain_phase).startsWith("ferry_to_res"));
    expect(seg1).toHaveLength(3);
    expect(seg1[0]).toMatchObject({ type: "deploy", planet: "p_a", target: { chain_phase: "ferry_to_res_load",   target_type: "moon" } });
    expect(seg1[1]).toMatchObject({ type: "jumpgate", planet: "m_a", target: { chain_phase: "ferry_to_res_hop",   source_moon: "m_a", target_moon: "m_b", take_all: true } });
    expect(seg1[2]).toMatchObject({ type: "deploy", planet: "m_b", target: { chain_phase: "ferry_to_res_unload", target_type: "planet" } });
    // Priority ladder: load=12, hop=11, unload=10.
    expect(seg1.map(g => g.priority)).toEqual([12, 11, 10]);
  });

  it("JG-only-empty rule: cargo-bearing segment forces sublight even with JG enabled", () => {
    const out = planTransportChain({
      source: PLANET_A, target: PLANET_B,
      ships: { largeCargo: 100 }, cargo: { m: 1_000_000, c: 0, d: 0 },
      jgEnabled: true, jgTakeAll: true, allPlanets: ALL, chainId: "txc-cargo",
    });
    // Cargo segment must be single direct hop, not 3-leg JG ferry.
    expect(out.goals).toHaveLength(1);
    expect(out.goals[0]!.target.chain_phase).toBe("to_target_direct");
  });

  it("moon-source d-reserve: caps d cargo to (sourceD - 500K)", () => {
    const moonWithD: PlannerPlanet = { ...MOON_A, resources: { d: 800_000 } };
    const allWithRes = [PLANET_A, moonWithD, PLANET_B, MOON_B, PLANET_C];
    const out = planTransportChain({
      source: PLANET_A, resource: moonWithD, target: PLANET_B,
      ships: { largeCargo: 100 }, cargo: { m: 0, c: 0, d: 500_000 },
      jgEnabled: false, jgTakeAll: true, allPlanets: allWithRes, chainId: "txc-mr",
    });
    // sourceD=800K, reserve=500K ⇒ maxD = 300K.
    // input d=500K → capped to 300K (no +50K buffer because target is planet).
    const seg2 = out.goals.find(g => String(g.target.chain_phase).startsWith("to_target"));
    expect((seg2!.target as { cargo?: { d: number } }).cargo?.d).toBe(300_000);
  });

  it("stopover: adds empty ferry segment 3", () => {
    const out = planTransportChain({
      source: PLANET_A, target: PLANET_B, stopover: PLANET_C,
      ships: { largeCargo: 10 }, cargo: { m: 100_000, c: 0, d: 0 },
      jgEnabled: false, jgTakeAll: true, allPlanets: ALL, chainId: "txc-stp",
    });
    const seg3 = out.goals.filter(g => String(g.target.chain_phase).startsWith("to_stop"));
    expect(seg3).toHaveLength(1);
    expect(seg3[0]).toMatchObject({ type: "deploy", planet: "p_b", priority: 6 });
    expect((seg3[0]!.target as { cargo?: unknown }).cargo).toBeUndefined();  // empty ferry
  });
});

describe("makeTransportChainId", () => {
  it("formats as txc-<base36>-<rand>", () => {
    const id = makeTransportChainId(1_780_000_000_000, "abcd");
    expect(id).toMatch(/^txc-[0-9a-z]+-abcd$/);
  });
});
