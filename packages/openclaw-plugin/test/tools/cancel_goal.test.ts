import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Goal } from "@ogamex/shared";
import { GoalsStore } from "../../src/sidecar/goals_store.js";
import { makeCancelGoalTool } from "../../src/tools/cancel_goal.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g-cancel-1",
    type: "research",
    target: { tech: "gravitation", level: 6 },
    priority: 5,
    status: "pending",
    created_at: 1_000_000_000_000,
    progress_pct: 0,
    current_step: "queued",
    eta_at: null,
    ...overrides,
  };
}

describe("makeCancelGoalTool", () => {
  let store: GoalsStore;

  beforeEach(() => {
    store = new GoalsStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("happy path: cancels an existing goal", () => {
    const g = makeGoal({ id: "g-1" });
    store.add(g);
    const tool = makeCancelGoalTool({ store });

    const result = tool.execute({ id: "g-1" });
    expect(result).toEqual({ id: "g-1", status: "cancelled" });

    const row = store.get("g-1");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("cancelled");
  });

  it("returns error envelope for unknown id", () => {
    const tool = makeCancelGoalTool({ store });
    const result = tool.execute({ id: "does-not-exist" });
    expect(result).toEqual({ error: "not found" });
  });

  it("cancelling twice still succeeds (idempotent on a cancelled row)", () => {
    const g = makeGoal({ id: "g-2" });
    store.add(g);
    const tool = makeCancelGoalTool({ store });

    expect(tool.execute({ id: "g-2" })).toEqual({ id: "g-2", status: "cancelled" });
    expect(tool.execute({ id: "g-2" })).toEqual({ id: "g-2", status: "cancelled" });
    expect(store.get("g-2")!.status).toBe("cancelled");
  });
});
