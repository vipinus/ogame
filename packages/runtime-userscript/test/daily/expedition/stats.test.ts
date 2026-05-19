import { describe, it, expect } from "vitest";
import type { ExpeditionOutcome } from "@ogamex/shared";
import {
  blackHoleRate,
  lossRate,
  avgResourceYield,
} from "../../../src/daily/expedition/stats.js";

function makeOutcome(
  overrides: Partial<ExpeditionOutcome> = {},
): ExpeditionOutcome {
  return {
    expedition_id: "exp-1",
    source_planet_id: "p1",
    source_coords: [1, 1, 1],
    target_galaxy: 1,
    target_system: 100,
    target_position: 16,
    template_id: "aggressive",
    fleet_sent: {},
    launched_at: 1000,
    returned_at: 2000,
    duration_actual_seconds: 1000,
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

describe("blackHoleRate", () => {
  it("returns 0 for empty array", () => {
    expect(blackHoleRate([])).toBe(0);
  });

  it("returns fraction of black_hole outcomes (1/4 → 0.25)", () => {
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({ expedition_id: "a", outcome_type: "black_hole" }),
      makeOutcome({ expedition_id: "b", outcome_type: "resources_small" }),
      makeOutcome({ expedition_id: "c", outcome_type: "nothing" }),
      makeOutcome({ expedition_id: "d", outcome_type: "merchant" }),
    ];
    expect(blackHoleRate(outcomes)).toBe(0.25);
  });

  it("returns 1.0 when all outcomes are black_hole", () => {
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({ expedition_id: "a", outcome_type: "black_hole" }),
      makeOutcome({ expedition_id: "b", outcome_type: "black_hole" }),
      makeOutcome({ expedition_id: "c", outcome_type: "black_hole" }),
    ];
    expect(blackHoleRate(outcomes)).toBe(1.0);
  });
});

describe("lossRate", () => {
  it("returns 0 for empty array", () => {
    expect(lossRate([])).toBe(0);
  });

  it("computes sum(ships_lost) / sum(fleet_sent) (100 sent, 5 lost → 0.05)", () => {
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({
        expedition_id: "a",
        fleet_sent: { lt: 60, sc: 40 },
        ships_lost: { lt: 5 },
      }),
    ];
    expect(lossRate(outcomes)).toBeCloseTo(0.05, 10);
  });

  it("returns 0 when nothing was sent (no division by zero)", () => {
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({
        expedition_id: "a",
        fleet_sent: {},
        ships_lost: {},
      }),
    ];
    expect(lossRate(outcomes)).toBe(0);
  });
});

describe("avgResourceYield", () => {
  it("returns 0 for empty array", () => {
    expect(avgResourceYield([])).toBe(0);
  });

  it("averages (m + c + d) across outcomes", () => {
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({
        expedition_id: "a",
        resources_gained: { m: 100, c: 200, d: 50, e: 0 },
      }),
      makeOutcome({
        expedition_id: "b",
        resources_gained: { m: 0, c: 0, d: 0, e: 0 },
      }),
      makeOutcome({
        expedition_id: "c",
        resources_gained: { m: 50, c: 50, d: 50, e: 0 },
      }),
    ];
    // sums: 350, 0, 150 → total 500 / 3 outcomes ≈ 166.666...
    expect(avgResourceYield(outcomes)).toBeCloseTo(500 / 3, 10);
  });

  it("ignores energy field (e) when computing yield", () => {
    const outcomes: ExpeditionOutcome[] = [
      makeOutcome({
        expedition_id: "a",
        resources_gained: { m: 10, c: 20, d: 30, e: 9999 },
      }),
    ];
    // 10 + 20 + 30 = 60; e=9999 must be ignored
    expect(avgResourceYield(outcomes)).toBe(60);
  });
});
