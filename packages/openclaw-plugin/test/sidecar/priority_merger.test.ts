import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Directive, DownstreamMsg, Goal, Planet, WorldState } from "@ogamex/shared";
import { GoalsStore } from "../../src/sidecar/goals_store.js";
import { PriorityMerger } from "../../src/sidecar/priority_merger.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> & Pick<Goal, "id">): Goal {
  return {
    type: "research",
    target: { tech: "energyTech", level: 1 },
    priority: 50,
    status: "pending",
    created_at: 0,
    progress_pct: 0,
    current_step: "queued",
    eta_at: null,
    ...overrides,
  } as Goal;
}

function makePlanet(id: string): Planet {
  return {
    id,
    name: id,
    coords: [1, 1, 1],
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

function makeState(): WorldState {
  return {
    server: { universe: "uni1", speed: 1 },
    player: { id: "p1", name: "tester", alliance: null },
    planets: [makePlanet("p1")],
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} } as any,
    discovery_slots: { used: 0, max: 0 } as any,
    discovery_active: [] as any,
    last_update: 0,
    page_snapshots: {},
  };
}

function makeDirective(goal_id: string, priority = 50, planet_id = goal_id): Directive {
  // Default action=build with a distinct planet_id per goal so the merger's
  // per-planet build slot doesn't serialize unrelated goals in tests that
  // are about ordering rather than slot contention.
  return {
    id: `dir-${goal_id}`,
    source: "goal",
    method: "ui",
    priority,
    action: "build",
    params: { building: "metalMine", target_level: 1, planet_id },
    preconds: [],
    expires_at: Date.now() + 60_000,
    reason: `test directive for ${goal_id}`,
    goal_id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("PriorityMerger", () => {
  let store: GoalsStore;

  beforeEach(() => {
    store = new GoalsStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("dispatches a single active goal via send and marks it active", () => {
    const goal = makeGoal({ id: "g1", priority: 50 });
    store.add(goal);
    const directive = makeDirective("g1", 50);
    const planGoal = vi.fn().mockReturnValue(directive);
    const send = vi.fn<(msg: DownstreamMsg) => void>();

    const merger = new PriorityMerger({ store, planGoal, send });
    const state = makeState();
    const result = merger.dispatch(state);

    expect(planGoal).toHaveBeenCalledTimes(1);
    expect(planGoal).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }), state);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "directive.dispatch", directive });

    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]).toBe(directive);
    expect(result.blocked).toEqual([]);
    expect(result.skipped_terminal).toBe(0);

    const row = store.get("g1");
    expect(row!.status).toBe("active");
    expect(row!.reason).toBeUndefined();
  });

  it("orders dispatch by priority DESC (highest first)", () => {
    let now = 1_000;
    const clock = (): number => now;
    const s = new GoalsStore({ dbPath: ":memory:", clock });
    try {
      now = 1_000; s.add(makeGoal({ id: "low", priority: 1 }));
      now = 2_000; s.add(makeGoal({ id: "mid", priority: 5 }));
      now = 3_000; s.add(makeGoal({ id: "high", priority: 10 }));

      const planGoal = vi.fn((g: Goal) => makeDirective(g.id, g.priority));
      const send = vi.fn<(msg: DownstreamMsg) => void>();
      const merger = new PriorityMerger({ store: s, planGoal, send });

      merger.dispatch(makeState());

      const sendOrder = send.mock.calls.map(
        (c) => (c[0] as { type: "directive.dispatch"; directive: Directive }).directive.goal_id,
      );
      expect(sendOrder).toEqual(["high", "mid", "low"]);
    } finally {
      s.close();
    }
  });

  it("tiebreaks equal priority by created_at ASC (older first)", () => {
    let now = 1_000;
    const clock = (): number => now;
    const s = new GoalsStore({ dbPath: ":memory:", clock });
    try {
      now = 1_000; s.add(makeGoal({ id: "older", priority: 5 }));
      now = 5_000; s.add(makeGoal({ id: "newer", priority: 5 }));

      const planGoal = vi.fn((g: Goal) => makeDirective(g.id, g.priority));
      const send = vi.fn<(msg: DownstreamMsg) => void>();
      const merger = new PriorityMerger({ store: s, planGoal, send });

      merger.dispatch(makeState());

      const sendOrder = send.mock.calls.map(
        (c) => (c[0] as { type: "directive.dispatch"; directive: Directive }).directive.goal_id,
      );
      expect(sendOrder).toEqual(["older", "newer"]);
    } finally {
      s.close();
    }
  });

  it("blocked planner result → status=blocked, reason persisted, no send", () => {
    store.add(makeGoal({ id: "g-block", priority: 50 }));
    const planGoal = vi.fn().mockReturnValue({ blocked: "need gravitation 6" });
    const send = vi.fn<(msg: DownstreamMsg) => void>();

    const merger = new PriorityMerger({ store, planGoal, send });
    const result = merger.dispatch(makeState());

    expect(send).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
    expect(result.blocked).toEqual([{ goal_id: "g-block", reason: "need gravitation 6" }]);
    expect(result.skipped_terminal).toBe(0);

    const row = store.get("g-block");
    expect(row!.status).toBe("blocked");
    expect(row!.reason).toBe("need gravitation 6");
  });

  it("already-at-target blocked text → status=completed and counted as skipped_terminal", () => {
    store.add(makeGoal({ id: "g-done", priority: 50 }));
    const planGoal = vi
      .fn()
      .mockReturnValue({ blocked: "already at or above target level (6 >= 6) for gravitation" });
    const send = vi.fn<(msg: DownstreamMsg) => void>();

    const merger = new PriorityMerger({ store, planGoal, send });
    const result = merger.dispatch(makeState());

    expect(send).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(result.skipped_terminal).toBe(1);

    const row = store.get("g-done");
    expect(row!.status).toBe("completed");
  });

  it("species_discovery 'goal complete' blocked text → status=completed (not blocked)", () => {
    // Operator 2026-05-23: discovery goal finished all 315 coords but UI
    // showed "block" because planner returned blocked-reason "all 315 coords
    // attempted — goal complete" which did not match ALREADY_AT_TARGET_RE.
    // Adding "goal complete" to the regex makes any planner emitting that
    // hint resolve to status=completed correctly.
    store.add(makeGoal({ id: "g-disc-done", priority: 50 }));
    const planGoal = vi
      .fn()
      .mockReturnValue({ blocked: "species_discovery: all 315 coords attempted — goal complete" });
    const send = vi.fn<(msg: DownstreamMsg) => void>();

    const merger = new PriorityMerger({ store, planGoal, send });
    const result = merger.dispatch(makeState());

    expect(result.skipped_terminal).toBe(1);
    expect(result.blocked).toEqual([]);
    const row = store.get("g-disc-done");
    expect(row!.status).toBe("completed");
  });

  it("mixed batch handles dispatch + blocked + already-at-target correctly", () => {
    let now = 1_000;
    const clock = (): number => now;
    const s = new GoalsStore({ dbPath: ":memory:", clock });
    try {
      now = 1_000; s.add(makeGoal({ id: "g-go", priority: 30 }));
      now = 2_000; s.add(makeGoal({ id: "g-blk", priority: 20 }));
      now = 3_000; s.add(makeGoal({ id: "g-fin", priority: 10 }));

      const directive = makeDirective("g-go", 30);
      const planGoal = vi.fn((g: Goal) => {
        if (g.id === "g-go") return directive;
        if (g.id === "g-blk") return { blocked: "need crystal mine 10" };
        return { blocked: "already at or above target level (5 >= 5) for x" };
      });
      const send = vi.fn<(msg: DownstreamMsg) => void>();

      const merger = new PriorityMerger({ store: s, planGoal, send });
      const result = merger.dispatch(makeState());

      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0]).toBe(directive);
      expect(result.blocked).toEqual([{ goal_id: "g-blk", reason: "need crystal mine 10" }]);
      expect(result.skipped_terminal).toBe(1);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ type: "directive.dispatch", directive });

      expect(s.get("g-go")!.status).toBe("active");
      expect(s.get("g-blk")!.status).toBe("blocked");
      expect(s.get("g-blk")!.reason).toBe("need crystal mine 10");
      expect(s.get("g-fin")!.status).toBe("completed");
    } finally {
      s.close();
    }
  });

  it("skips PAUSED rows (status=blocked, reason starts with 'PAUSED')", () => {
    // Two pending goals; one then gets paused by the operator (status=blocked
    // + magic "PAUSED:..." reason). PriorityMerger.dispatch must skip the
    // paused row entirely — planner not invoked, status untouched, no send.
    store.add(makeGoal({ id: "g-live", priority: 50 }));
    store.add(makeGoal({ id: "g-paused", priority: 80 }));
    store.updateStatus("g-paused", "blocked", "PAUSED: by operator");

    const directive = makeDirective("g-live");
    const planGoal = vi.fn<(g: Goal, s: WorldState) => Directive | { blocked: string }>()
      .mockReturnValue(directive);
    const send = vi.fn<(msg: DownstreamMsg) => void>();

    const merger = new PriorityMerger({ store, planGoal, send });
    const result = merger.dispatch(makeState());

    // Planner should have been called ONCE — only for g-live, not g-paused.
    expect(planGoal).toHaveBeenCalledTimes(1);
    expect(planGoal.mock.calls[0]![0].id).toBe("g-live");

    // Paused row's status must remain "blocked" with the PAUSED marker intact.
    const paused = store.get("g-paused");
    expect(paused?.status).toBe("blocked");
    expect(paused?.reason).toBe("PAUSED: by operator");

    expect(result.dispatched).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("non-PAUSED blocked rows are still re-planned (state may have unblocked them)", () => {
    // Regression guard: only rows with the PAUSED prefix are skipped.
    // A naturally-blocked row (e.g. "need crystal mine 10") must still go
    // through the planner so a resource update can unblock it next tick.
    store.add(makeGoal({ id: "g-blk" }));
    store.updateStatus("g-blk", "blocked", "need crystal mine 10");

    const planGoal = vi.fn<(g: Goal, s: WorldState) => Directive | { blocked: string }>()
      .mockReturnValue(makeDirective("g-blk"));
    const send = vi.fn<(msg: DownstreamMsg) => void>();

    const merger = new PriorityMerger({ store, planGoal, send });
    merger.dispatch(makeState());

    expect(planGoal).toHaveBeenCalledTimes(1);
    expect(store.get("g-blk")?.status).toBe("active");
  });

  it("main goal dispatches FIRST regardless of nominal priority", () => {
    // Lower-priority goal flagged as main should beat a higher-priority
    // regular goal because the merger sorts main first.
    let now = 1_000;
    const clock = (): number => now;
    const s = new GoalsStore({ dbPath: ":memory:", clock });
    try {
      now = 1_000; s.add(makeGoal({ id: "regular-hi", priority: 9 }));
      now = 2_000; s.add(makeGoal({ id: "main-low",   priority: 3 }));
      s.setMainGoal("main-low");
      const planGoal = vi.fn((g: Goal) => makeDirective(g.id, g.priority));
      const send = vi.fn<(msg: DownstreamMsg) => void>();
      const merger = new PriorityMerger({ store: s, planGoal, send });
      merger.dispatch(makeState());
      const order = send.mock.calls.map(
        (c) => (c[0] as { type: "directive.dispatch"; directive: Directive }).directive.goal_id,
      );
      expect(order[0]).toBe("main-low"); // main runs first
      expect(order).toEqual(["main-low", "regular-hi"]);
    } finally {
      s.close();
    }
  });

  it("research slot is GLOBAL — second research goal in same tick is deferred", () => {
    store.add(makeGoal({ id: "r1", priority: 10 }));
    store.add(makeGoal({ id: "r2", priority: 9  }));
    const planGoal = vi.fn((g: Goal) => ({
      id: `dir-${g.id}`, source: "goal" as const, method: "ui" as const,
      priority: g.priority, action: "research" as const,
      params: { tech: "energyTech", target_level: 1, planet_id: "p1" },
      preconds: [], expires_at: Date.now() + 60_000, reason: "x", goal_id: g.id,
    }));
    const send = vi.fn<(msg: DownstreamMsg) => void>();
    const merger = new PriorityMerger({ store, planGoal, send });
    const result = merger.dispatch(makeState());
    // Only one research dispatched; the second blocked on slot.
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]!.goal_id).toBe("r1");
    expect(result.blocked).toContainEqual({ goal_id: "r2", reason: "research slot in use" });
  });

  it("build slot is PER PLANET — two builds on same planet → one dispatched, other deferred", () => {
    store.add(makeGoal({ id: "b1", priority: 10 }));
    store.add(makeGoal({ id: "b2", priority: 9  }));
    // Both directives target the same planet "earth".
    const planGoal = vi.fn((g: Goal) => makeDirective(g.id, g.priority, "earth"));
    const send = vi.fn<(msg: DownstreamMsg) => void>();
    const merger = new PriorityMerger({ store, planGoal, send });
    const result = merger.dispatch(makeState());
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.dispatched[0]!.goal_id).toBe("b1");
    expect(result.blocked[0]!.goal_id).toBe("b2");
    expect(result.blocked[0]!.reason).toMatch(/build slot on earth in use/);
  });

  it("planet build_q non-empty → all build goals on that planet deferred this tick", () => {
    store.add(makeGoal({ id: "b1", priority: 10 }));
    const planGoal = vi.fn((g: Goal) => makeDirective(g.id, g.priority, "p1"));
    const send = vi.fn<(msg: DownstreamMsg) => void>();
    const merger = new PriorityMerger({ store, planGoal, send });
    const state = makeState();
    // Simulate planet p1 already having a build in flight.
    (Object.values(state.planets) as any)[0]!.build_q = { item: "metalMine", level: 2, ends_at: Date.now() + 60_000 };
    const result = merger.dispatch(state);
    expect(send).not.toHaveBeenCalled();
    expect(result.blocked[0]!.reason).toMatch(/build slot on p1 in use/);
  });

  it("empty active list → no calls, empty result arrays", () => {
    // Add a goal then mark it cancelled and another completed → both terminal,
    // so listActive() should return nothing.
    store.add(makeGoal({ id: "g-cancel" }));
    store.updateStatus("g-cancel", "cancelled");
    store.add(makeGoal({ id: "g-done" }));
    store.updateStatus("g-done", "completed");

    const planGoal = vi.fn();
    const send = vi.fn<(msg: DownstreamMsg) => void>();

    const merger = new PriorityMerger({ store, planGoal, send });
    const result = merger.dispatch(makeState());

    expect(planGoal).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(result.skipped_terminal).toBe(0);
  });
});
