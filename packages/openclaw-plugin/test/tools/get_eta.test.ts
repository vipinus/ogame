import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Goal } from "@ogamex/shared";
import { GoalsStore } from "../../src/sidecar/goals_store.js";
import { makeGetEtaTool } from "../../src/tools/get_eta.js";

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

describe("makeGetEtaTool", () => {
  let store: GoalsStore;

  beforeEach(() => {
    store = new GoalsStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("returns eta_at = null when goal has no estimate yet", () => {
    store.add(makeGoal("g-1"));
    const tool = makeGetEtaTool({ store });
    expect(tool.execute({ id: "g-1" })).toEqual({ id: "g-1", eta_at: null });
  });

  it("returns eta_at value when goal has one set", () => {
    const eta = 1_700_000_000_000;
    store.add(makeGoal("g-2", { eta_at: eta }));
    const tool = makeGetEtaTool({ store });
    expect(tool.execute({ id: "g-2" })).toEqual({ id: "g-2", eta_at: eta });
  });

  it("returns error envelope when goal id is unknown", () => {
    const tool = makeGetEtaTool({ store });
    expect(tool.execute({ id: "missing" })).toEqual({ error: "not found" });
  });
});
