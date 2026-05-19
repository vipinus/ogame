import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Goal } from "@ogamex/shared";
import { GoalsStore } from "../../src/sidecar/goals_store.js";
import { makeQueryGoalsTool } from "../../src/tools/query_goals.js";

function makeGoal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
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

describe("makeQueryGoalsTool", () => {
  let store: GoalsStore;

  beforeEach(() => {
    store = new GoalsStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("returns all goals when no status filter is given", () => {
    store.add(makeGoal("a"));
    store.add(makeGoal("b"));
    store.updateStatus("b", "active");

    const tool = makeQueryGoalsTool({ store });
    const result = tool.execute({});
    if ("error" in result) throw new Error("unexpected error");

    expect(result.goals).toHaveLength(2);
    const ids = result.goals.map((r) => r.goal.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("filters by status when one is provided", () => {
    store.add(makeGoal("a"));
    store.add(makeGoal("b"));
    store.updateStatus("b", "active");

    const tool = makeQueryGoalsTool({ store });
    const result = tool.execute({ status: "active" });
    if ("error" in result) throw new Error("unexpected error");

    expect(result.goals).toHaveLength(1);
    expect(result.goals[0]!.goal.id).toBe("b");
    expect(result.goals[0]!.status).toBe("active");
  });

  it("returns empty list when no goals match the status filter", () => {
    store.add(makeGoal("a"));
    const tool = makeQueryGoalsTool({ store });
    const result = tool.execute({ status: "completed" });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.goals).toEqual([]);
  });

  it("returns error envelope on invalid status string", () => {
    const tool = makeQueryGoalsTool({ store });
    const result = tool.execute({ status: "frobnicated" });
    expect(result).toEqual({ error: "invalid status: frobnicated" });
  });
});
