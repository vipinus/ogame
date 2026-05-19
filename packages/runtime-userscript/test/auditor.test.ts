import { describe, it, expect, vi } from "vitest";
import type { ExpeditionOutcome, Planet, WorldState } from "@ogamex/shared";
import { EventBus } from "../src/event_bus.js";
import { StateStore, emptyWorldState } from "../src/state_store.js";
import { startAuditor } from "../src/auditor.js";

function makePlanet(overrides: Partial<Planet> = {}): Planet {
  return {
    id: "p1",
    name: "母星",
    coords: [1, 2, 3],
    type: "planet",
    resources: { m: 0, c: 0, d: 0, e: 0 },
    storage: { m_max: 100000, c_max: 100000, d_max: 100000 },
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

function freshHarness(initial?: WorldState) {
  const bus = new EventBus();
  const store = new StateStore(bus, null, initial);
  return { bus, store };
}

function makeOutcome(overrides: Partial<ExpeditionOutcome> = {}): ExpeditionOutcome {
  return {
    expedition_id: "exp-" + Math.random().toString(36).slice(2, 8),
    source_planet_id: "p1",
    source_coords: [1, 2, 3],
    target_galaxy: 1,
    target_system: 100,
    target_position: 16,
    template_id: "tpl-a",
    fleet_sent: { largeCargo: 100 },
    launched_at: 1_700_000_000_000,
    returned_at: 1_700_000_001_000,
    duration_actual_seconds: 1000,
    outcome_type: "nothing",
    resources_gained: { m: 0, c: 0, d: 0, e: 0 },
    ships_gained: {},
    ships_lost: {},
    raw_report_id: "r-1",
    artifacts_gained: {},
    lifeform_xp_gained: null,
    ...overrides,
  };
}

describe("Auditor (M6.5)", () => {
  it("resource_overflow violation triggers emission", async () => {
    const { bus, store } = freshHarness();
    store.setPartial({
      planets: [
        makePlanet({ resources: { m: 95000, c: 0, d: 0, e: 0 } }),
      ],
    });
    const spy = vi.fn();
    bus.on("audit.condition_unmet", spy);

    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { resource_overflow_pct: 90 },
    });

    const evidences = await auditor.runAll();
    expect(evidences).toHaveLength(1);
    expect(evidences[0]!.rule_id).toBe("resource_overflow");
    expect(evidences[0]!.threshold).toBe(90);
    expect(evidences[0]!.observed).toBeGreaterThan(90);
    expect(evidences[0]!.details).toMatchObject({ planet_id: "p1", resource: "m" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(evidences[0]);

    auditor.stop();
  });

  it("no resource_overflow emission when below threshold", async () => {
    const { bus, store } = freshHarness();
    store.setPartial({
      planets: [
        makePlanet({ resources: { m: 50000, c: 0, d: 0, e: 0 } }),
      ],
    });
    const spy = vi.fn();
    bus.on("audit.condition_unmet", spy);

    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { resource_overflow_pct: 90 },
    });

    const evidences = await auditor.runAll();
    expect(evidences).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    auditor.stop();
  });

  it("emits one evidence per (planet, resource) violation", async () => {
    const { bus, store } = freshHarness();
    store.setPartial({
      planets: [
        makePlanet({
          id: "p1",
          resources: { m: 95000, c: 96000, d: 0, e: 0 },
        }),
        makePlanet({
          id: "p2",
          resources: { m: 0, c: 0, d: 97000, e: 0 },
        }),
      ],
    });
    const spy = vi.fn();
    bus.on("audit.condition_unmet", spy);

    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { resource_overflow_pct: 90 },
    });

    const evidences = await auditor.runAll();
    // p1 violates m and c; p2 violates d → 3 evidences
    expect(evidences).toHaveLength(3);
    const ids = evidences.map((e) => `${e.details["planet_id"]}:${e.details["resource"]}`).sort();
    expect(ids).toEqual(["p1:c", "p1:m", "p2:d"]);
    expect(spy).toHaveBeenCalledTimes(3);
    auditor.stop();
  });

  it("fleet_slot_starvation fires when ratio exceeds threshold", async () => {
    const { bus, store } = freshHarness();
    const initial = emptyWorldState();
    // Cast: fleet_slots_max is not in shared Player type; M6.5 smoke will add it.
    (initial.player as unknown as { fleet_slots_max: number }).fleet_slots_max = 6;
    initial.fleets_outbound = [
      { id: "f1" } as never,
      { id: "f2" } as never,
      { id: "f3" } as never,
      { id: "f4" } as never,
      { id: "f5" } as never,
    ];
    store.replace(initial);

    const spy = vi.fn();
    bus.on("audit.condition_unmet", spy);

    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { fleet_slot_starvation_pct: 80 },
    });

    const evidences = await auditor.runAll();
    const starv = evidences.filter((e) => e.rule_id === "fleet_slot_starvation");
    expect(starv).toHaveLength(1);
    expect(starv[0]!.observed).toBeCloseTo((5 / 6) * 100, 1);
    expect(starv[0]!.threshold).toBe(80);
    expect(spy).toHaveBeenCalled();
    auditor.stop();
  });

  it("fleet_slot_starvation silently skips when fleet_slots_max missing", async () => {
    const { bus, store } = freshHarness();
    store.setPartial({
      fleets_outbound: [
        { id: "f1" } as never,
        { id: "f2" } as never,
      ],
    });
    const spy = vi.fn();
    bus.on("audit.condition_unmet", spy);

    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { fleet_slot_starvation_pct: 50 },
    });

    const evidences = await auditor.runAll();
    expect(evidences.filter((e) => e.rule_id === "fleet_slot_starvation")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    auditor.stop();
  });

  it("setThresholds live-updates without restart", async () => {
    const { bus, store } = freshHarness();
    store.setPartial({
      planets: [
        makePlanet({ resources: { m: 95000, c: 0, d: 0, e: 0 } }),
      ],
    });
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { resource_overflow_pct: 99 },
    });

    expect(await auditor.runAll()).toEqual([]);

    auditor.setThresholds({ resource_overflow_pct: 90 });
    const evidences = await auditor.runAll();
    expect(evidences).toHaveLength(1);
    expect(evidences[0]!.threshold).toBe(90);
    auditor.stop();
  });

  it("debounces state.updated bursts to one rule run per ~1000ms", async () => {
    const { bus, store } = freshHarness();
    store.setPartial({
      planets: [
        makePlanet({ resources: { m: 95000, c: 0, d: 0, e: 0 } }),
      ],
    });
    const spy = vi.fn();
    bus.on("audit.condition_unmet", spy);

    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { resource_overflow_pct: 90 },
    });

    // The initial setPartial above happened BEFORE the auditor subscribed,
    // so it didn't fire. Now flood 5 updates in rapid succession.
    for (let i = 0; i < 5; i++) {
      bus.emit("state.updated", { ts: Date.now() });
    }

    // Allow microtasks from fire-and-forget async runRules to settle.
    await new Promise((r) => setTimeout(r, 0));

    // Only the first should have run the rules; the rest are debounced.
    expect(spy).toHaveBeenCalledTimes(1);

    // Log buffer should also have just 1 entry.
    expect(auditor._log()).toHaveLength(1);
    auditor.stop();
  });
});

describe("Auditor (M8.3 / M8.4 — expanded rules)", () => {
  it("fleet_save_coverage_24h fires when coverage < threshold with 3+ attacks", async () => {
    const { bus, store } = freshHarness();
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { fleet_save_coverage_24h: 0.8 },
    });

    // 5 attacks, 2 saved → coverage = 0.4 < 0.8.
    for (let i = 0; i < 5; i++) {
      bus.emit("emergency.attack", { event_id: `atk-${i}` });
    }
    bus.emit("emergency.save_completed", { event_id: "atk-0" });
    bus.emit("emergency.save_completed", { event_id: "atk-1" });

    const evidences = await auditor.runAll();
    const fired = evidences.filter((e) => e.rule_id === "fleet_save_coverage_24h");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.observed).toBeCloseTo(0.4, 5);
    expect(fired[0]!.threshold).toBe(0.8);
    expect(fired[0]!.details).toMatchObject({ saved: 2, total: 5 });
    auditor.stop();
  });

  it("fleet_save_coverage_24h does NOT fire below sample size (2 attacks)", async () => {
    const { bus, store } = freshHarness();
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { fleet_save_coverage_24h: 0.8 },
    });
    bus.emit("emergency.attack", { event_id: "atk-0" });
    bus.emit("emergency.attack", { event_id: "atk-1" });
    const evidences = await auditor.runAll();
    expect(evidences.filter((e) => e.rule_id === "fleet_save_coverage_24h")).toEqual([]);
    auditor.stop();
  });

  it("directive_failure_rate fires when failure ratio exceeds threshold", async () => {
    const { bus, store } = freshHarness();
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { directive_failure_rate: 0.5 },
    });

    for (let i = 0; i < 6; i++) {
      bus.emit("directive_completed", { success: false });
    }
    for (let i = 0; i < 4; i++) {
      bus.emit("directive_completed", { success: true });
    }

    const evidences = await auditor.runAll();
    const fired = evidences.filter((e) => e.rule_id === "directive_failure_rate");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.observed).toBeCloseTo(0.6, 5);
    expect(fired[0]!.details).toMatchObject({ failed: 6, total: 10 });
    auditor.stop();
  });

  it("research_progress_rate fires when below threshold (zero completions vs threshold 1)", async () => {
    const { bus, store } = freshHarness();
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { research_progress_rate: 1 },
    });

    // No research_completed events emitted → completions_24h = 0 < 1.
    const evidences = await auditor.runAll();
    const fired = evidences.filter((e) => e.rule_id === "research_progress_rate");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.observed).toBe(0);
    expect(fired[0]!.threshold).toBe(1);
    expect(fired[0]!.details).toMatchObject({ completions_24h: 0 });

    // After 2 research completions and threshold lowered → no fire.
    bus.emit("research_completed", { tech: "energy", level: 5 });
    bus.emit("research_completed", { tech: "laser", level: 3 });
    auditor.setThresholds({ research_progress_rate: 2 });
    const ev2 = await auditor.runAll();
    expect(ev2.filter((e) => e.rule_id === "research_progress_rate")).toEqual([]);
    auditor.stop();
  });

  it("expedition_loss_rate_50 fires when injected stats exceed threshold", async () => {
    const { bus, store } = freshHarness();
    // 50 outcomes, each sent 100 ships and lost 50 → lossRate = 0.5.
    const outcomes: ExpeditionOutcome[] = [];
    for (let i = 0; i < 50; i++) {
      outcomes.push(makeOutcome({
        expedition_id: `e-${i}`,
        fleet_sent: { largeCargo: 100 },
        ships_lost: { largeCargo: 50 },
      }));
    }
    const getRecentExpeditions = vi.fn(async () => outcomes);
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { expedition_loss_rate_50: 0.1 },
      getRecentExpeditions,
    });

    const evidences = await auditor.runAll();
    const fired = evidences.filter((e) => e.rule_id === "expedition_loss_rate_50");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.observed).toBeCloseTo(0.5, 5);
    expect(fired[0]!.threshold).toBe(0.1);
    expect(getRecentExpeditions).toHaveBeenCalled();
    auditor.stop();
  });

  it("expedition_loss_rate_50 silently skipped when getRecentExpeditions absent", async () => {
    const { bus, store } = freshHarness();
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { expedition_loss_rate_50: 0.1 },
    });
    const evidences = await auditor.runAll();
    expect(evidences.filter((e) => e.rule_id === "expedition_loss_rate_50")).toEqual([]);
    auditor.stop();
  });

  it("expedition_black_hole_rate_high fires when blackHoleRate > 0.05 over 50", async () => {
    const { bus, store } = freshHarness();
    const outcomes: ExpeditionOutcome[] = [];
    // 5 black_hole + 45 nothing → rate = 0.10 > 0.05.
    for (let i = 0; i < 5; i++) {
      outcomes.push(makeOutcome({ expedition_id: `bh-${i}`, outcome_type: "black_hole" }));
    }
    for (let i = 0; i < 45; i++) {
      outcomes.push(makeOutcome({ expedition_id: `n-${i}`, outcome_type: "nothing" }));
    }
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { expedition_black_hole_rate_high: 0.05 },
      getRecentExpeditions: async () => outcomes,
    });

    const evidences = await auditor.runAll();
    const fired = evidences.filter((e) => e.rule_id === "expedition_black_hole_rate_high");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.observed).toBeCloseTo(0.1, 5);
    auditor.stop();
  });

  it("defense_minimum_breach fires per (planet, ship) below the configured minimum", async () => {
    const { bus, store } = freshHarness();
    store.setPartial({
      planets: [
        makePlanet({ id: "p1", defense: { lightFighter: 5 } }),
        makePlanet({ id: "p2", defense: { lightFighter: 20 } }),
      ],
    });
    const auditor = startAuditor({
      bus,
      store,
      initialThresholds: { defense_minimum_breach: 1 },
      defenseKeepMinimum: { lightFighter: 10 },
    });

    const evidences = await auditor.runAll();
    const fired = evidences.filter((e) => e.rule_id === "defense_minimum_breach");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.details).toMatchObject({ planet_id: "p1", ship: "lightFighter", have: 5, min_required: 10 });
    expect(fired[0]!.observed).toBe(5);
    expect(fired[0]!.threshold).toBe(10);

    // setKeepMinimum can be updated live.
    auditor.setKeepMinimum({ lightFighter: 30 });
    const evidences2 = await auditor.runAll();
    const fired2 = evidences2.filter((e) => e.rule_id === "defense_minimum_breach");
    // Both planets now breach.
    expect(fired2).toHaveLength(2);
    auditor.stop();
  });
});
