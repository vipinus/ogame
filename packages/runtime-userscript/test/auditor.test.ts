import { describe, it, expect, vi } from "vitest";
import type { Planet, WorldState } from "@ogamex/shared";
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

describe("Auditor (M6.5)", () => {
  it("resource_overflow violation triggers emission", () => {
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

    const evidences = auditor.runAll();
    expect(evidences).toHaveLength(1);
    expect(evidences[0]!.rule_id).toBe("resource_overflow");
    expect(evidences[0]!.threshold).toBe(90);
    expect(evidences[0]!.observed).toBeGreaterThan(90);
    expect(evidences[0]!.details).toMatchObject({ planet_id: "p1", resource: "m" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(evidences[0]);

    auditor.stop();
  });

  it("no resource_overflow emission when below threshold", () => {
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

    const evidences = auditor.runAll();
    expect(evidences).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    auditor.stop();
  });

  it("emits one evidence per (planet, resource) violation", () => {
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

    const evidences = auditor.runAll();
    // p1 violates m and c; p2 violates d → 3 evidences
    expect(evidences).toHaveLength(3);
    const ids = evidences.map((e) => `${e.details["planet_id"]}:${e.details["resource"]}`).sort();
    expect(ids).toEqual(["p1:c", "p1:m", "p2:d"]);
    expect(spy).toHaveBeenCalledTimes(3);
    auditor.stop();
  });

  it("fleet_slot_starvation fires when ratio exceeds threshold", () => {
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

    const evidences = auditor.runAll();
    const starv = evidences.filter((e) => e.rule_id === "fleet_slot_starvation");
    expect(starv).toHaveLength(1);
    expect(starv[0]!.observed).toBeCloseTo((5 / 6) * 100, 1);
    expect(starv[0]!.threshold).toBe(80);
    expect(spy).toHaveBeenCalled();
    auditor.stop();
  });

  it("fleet_slot_starvation silently skips when fleet_slots_max missing", () => {
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

    const evidences = auditor.runAll();
    expect(evidences.filter((e) => e.rule_id === "fleet_slot_starvation")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    auditor.stop();
  });

  it("setThresholds live-updates without restart", () => {
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

    expect(auditor.runAll()).toEqual([]);

    auditor.setThresholds({ resource_overflow_pct: 90 });
    const evidences = auditor.runAll();
    expect(evidences).toHaveLength(1);
    expect(evidences[0]!.threshold).toBe(90);
    auditor.stop();
  });

  it("debounces state.updated bursts to one rule run per ~1000ms", () => {
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

    // Only the first should have run the rules; the rest are debounced.
    expect(spy).toHaveBeenCalledTimes(1);

    // Log buffer should also have just 1 entry.
    expect(auditor._log()).toHaveLength(1);
    auditor.stop();
  });
});
