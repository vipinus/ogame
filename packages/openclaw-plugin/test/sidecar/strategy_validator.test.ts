import { describe, it, expect } from "vitest";
import {
  validateStrategy,
  validatePatch,
} from "../../src/sidecar/strategy_validator.js";
import type { Strategy } from "@ogamex/shared";

/**
 * Build a fully-valid Strategy object that satisfies every range guard.
 * Tests then clone & override a single field to test rejection.
 */
function makeValidStrategy(): Strategy {
  return {
    version: 1,
    updated_at: 1_700_000_000_000,
    updated_by: "openclaw-llm",
    reason: "initial",
    daily: {
      expedition: {
        enabled: true,
        auto_fill_slots: true,
        source_planet: null,
        duration: "short",
        target_position: 16,
        fleet_templates: {},
        galaxy_strategy: {
          mode: "stats_based",
          home_galaxy_first: true,
          switch_threshold: {
            black_hole_rate_24h: 0.15,
            sample_size_min: 50,
          },
          cross_galaxy_deut_budget: 100_000,
        },
        cargo_load: {
          smallCargo_capacity_pct: 80,
          largeCargo_capacity_pct: 90,
        },
      },
      resource_balance: { enabled: true, trigger_overflow_pct: 85 },
      defense_replenish: { enabled: true, keep_minimum: {} },
      default_build: { enabled: true, strategy: "balanced", ratio: {} },
      heartbeat: { enabled: true, schedule: [] },
    },
    emergency: {
      attack: {
        save_window_minutes: 30,
        prefer_moon: true,
        alliance_safe_planets: [],
        safety_margin_minutes: 5,
      },
      spy: { push_immediate: true, counter_spy: false, log_attacker: true },
      anomaly: { push_immediate: true, pause_planet_automation: false },
      resource_critical: { threshold_pct: 95, try_redistribute_first: true },
    },
    audit_rules_thresholds: { rule_a: 0, rule_b: 1.5 },
  };
}

describe("strategy_validator", () => {
  it("accepts a fully-valid strategy", () => {
    const result = validateStrategy(makeValidStrategy());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects negative version", () => {
    const s = makeValidStrategy();
    (s as { version: number }).version = -1;
    const result = validateStrategy(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects wrong updated_by enum value", () => {
    const s = makeValidStrategy();
    (s as { updated_by: string }).updated_by = "nobody";
    const result = validateStrategy(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("updated_by"))).toBe(true);
  });

  it("rejects reason longer than 500 chars", () => {
    const s = makeValidStrategy();
    s.reason = "x".repeat(501);
    const result = validateStrategy(s);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("reason"))).toBe(true);
  });

  it("rejects black_hole_rate_24h out of [0,1]", () => {
    const s = makeValidStrategy();
    s.daily.expedition.galaxy_strategy.switch_threshold.black_hole_rate_24h = 1.5;
    const result = validateStrategy(s);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("black_hole_rate_24h")),
    ).toBe(true);
  });

  it("rejects save_window_minutes out of [5,120]", () => {
    const s = makeValidStrategy();
    s.emergency.attack.save_window_minutes = 200;
    const result = validateStrategy(s);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("save_window_minutes")),
    ).toBe(true);
  });

  it("rejects negative safety_margin_minutes", () => {
    const s = makeValidStrategy();
    s.emergency.attack.safety_margin_minutes = -1;
    const result = validateStrategy(s);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("safety_margin_minutes")),
    ).toBe(true);
  });

  it("rejects audit_rules_thresholds with negative value", () => {
    const s = makeValidStrategy();
    s.audit_rules_thresholds = { rule_a: -5 };
    const result = validateStrategy(s);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("audit_rules_thresholds")),
    ).toBe(true);
  });

  it("validatePatch accepts a small partial patch", () => {
    const result = validatePatch({ reason: "manual nudge" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validatePatch rejects out-of-range partial", () => {
    const result = validatePatch({
      emergency: { attack: { save_window_minutes: 200 } },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("save_window_minutes")),
    ).toBe(true);
  });
});
