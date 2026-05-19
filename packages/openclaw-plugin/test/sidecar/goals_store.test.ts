import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GoalsStore } from "../../src/sidecar/goals_store.js";
import type { Goal } from "@ogamex/shared";

/**
 * Build a minimum-valid Goal. The shared Goal interface (packages/shared/src/types.ts)
 * requires: id, type, target, priority, status, created_at, progress_pct, current_step,
 * eta_at. Optional: planet, deadline, blocked_reason.
 */
function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    type: "research",
    target: { tech: "gravitation", level: 6 },
    priority: 50,
    status: "pending",
    created_at: 1_000_000_000_000,
    progress_pct: 0,
    current_step: "queued",
    eta_at: null,
    ...overrides,
  };
}

describe("GoalsStore", () => {
  let store: GoalsStore;

  beforeEach(() => {
    store = new GoalsStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("add + get returns the row with status=pending", () => {
    const g = makeGoal({ id: "g-add-1" });
    const row = store.add(g);
    expect(row.goal).toEqual(g);
    expect(row.status).toBe("pending");
    expect(row.reason).toBeUndefined();
    expect(typeof row.created_at).toBe("number");
    expect(row.updated_at).toBe(row.created_at);

    const got = store.get("g-add-1");
    expect(got).not.toBeNull();
    expect(got!.goal).toEqual(g);
    expect(got!.status).toBe("pending");
  });

  it("add with duplicate id throws", () => {
    const g = makeGoal({ id: "dup" });
    store.add(g);
    expect(() => store.add(makeGoal({ id: "dup", type: "build" }))).toThrow();
  });

  it("get with unknown id returns null", () => {
    expect(store.get("nope")).toBeNull();
  });

  it("updateStatus changes status and bumps updated_at", () => {
    let now = 1_000;
    const clock = (): number => now;
    const s = new GoalsStore({ dbPath: ":memory:", clock });
    try {
      const g = makeGoal({ id: "u1" });
      const added = s.add(g);
      expect(added.created_at).toBe(1_000);
      expect(added.updated_at).toBe(1_000);

      now = 2_000;
      const updated = s.updateStatus("u1", "active");
      expect(updated.status).toBe("active");
      expect(updated.created_at).toBe(1_000);
      expect(updated.updated_at).toBe(2_000);
      expect(updated.updated_at).toBeGreaterThan(updated.created_at);

      const got = s.get("u1");
      expect(got!.status).toBe("active");
    } finally {
      s.close();
    }
  });

  it("updateStatus stores the optional reason", () => {
    store.add(makeGoal({ id: "r1" }));
    const updated = store.updateStatus("r1", "blocked", "blocked: need gravitation 6");
    expect(updated.status).toBe("blocked");
    expect(updated.reason).toBe("blocked: need gravitation 6");

    const got = store.get("r1");
    expect(got!.reason).toBe("blocked: need gravitation 6");
  });

  it("updateStatus on unknown id throws", () => {
    expect(() => store.updateStatus("missing", "active")).toThrow();
  });

  it("remove deletes the row; remove of unknown id is no-op", () => {
    store.add(makeGoal({ id: "rm1" }));
    store.remove("rm1");
    expect(store.get("rm1")).toBeNull();
    // No throw on unknown id.
    expect(() => store.remove("never-existed")).not.toThrow();
  });

  it("list / listByStatus / listActive return the expected slices, newest first", () => {
    let now = 100;
    const clock = (): number => now++;
    const s = new GoalsStore({ dbPath: ":memory:", clock });
    try {
      s.add(makeGoal({ id: "p1" }));                          // pending  @100
      s.add(makeGoal({ id: "p2" }));                          // pending  @101
      const compId = "c1";
      s.add(makeGoal({ id: compId }));                        // pending  @102
      s.updateStatus(compId, "completed");                    // → completed
      const canId = "x1";
      s.add(makeGoal({ id: canId }));                         // pending  @104 (one advance for add)
      s.updateStatus(canId, "cancelled");                     // → cancelled

      const all = s.list();
      expect(all).toHaveLength(4);
      // Newest first by created_at desc.
      expect(all.map(r => r.goal.id)).toEqual([canId, compId, "p2", "p1"]);

      const pending = s.listByStatus("pending");
      expect(pending.map(r => r.goal.id)).toEqual(["p2", "p1"]);

      const completed = s.listByStatus("completed");
      expect(completed.map(r => r.goal.id)).toEqual([compId]);

      const cancelled = s.listByStatus("cancelled");
      expect(cancelled.map(r => r.goal.id)).toEqual([canId]);

      // listActive = pending + active + blocked (non-terminal).
      const active = s.listActive();
      expect(active.map(r => r.goal.id)).toEqual(["p2", "p1"]);

      // Promote p1 → active and p2 → blocked, then re-check listActive still returns both.
      s.updateStatus("p1", "active");
      s.updateStatus("p2", "blocked");
      const active2 = s.listActive();
      expect(active2.map(r => r.goal.id).sort()).toEqual(["p1", "p2"]);
    } finally {
      s.close();
    }
  });

  it("close() releases the handle; subsequent get throws", () => {
    store.add(makeGoal({ id: "close-1" }));
    store.close();
    expect(() => store.get("close-1")).toThrow();
  });
});
