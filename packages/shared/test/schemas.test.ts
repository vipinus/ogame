import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { GoalSchema, DirectiveSchema, SendFleetParamsSchema } from "../src/schemas.js";

describe("GoalSchema", () => {
  it("validates a research goal", () => {
    const ok = {
      id: "g1", type: "research",
      target: { tech: "gravitonTech", level: 1 },
      planet: "母星", priority: 85, status: "active",
      created_at: 1, progress_pct: 0,
      current_step: "init", eta_at: null,
    };
    expect(Value.Check(GoalSchema, ok)).toBe(true);
  });

  it("validates a lifeform goal type", () => {
    const ok = {
      id: "g2", type: "lifeform_research",
      target: { species: "humans", tech: "neuroscience", level: 5 },
      planet: "母星", priority: 70, status: "active",
      created_at: 1, progress_pct: 0,
      current_step: "init", eta_at: null,
    };
    expect(Value.Check(GoalSchema, ok)).toBe(true);
  });

  it("rejects invalid priority", () => {
    const bad = {
      id: "g1", type: "research", target: {}, priority: 999,
      status: "active", created_at: 1, progress_pct: 0,
      current_step: "x", eta_at: null,
    };
    expect(Value.Check(GoalSchema, bad)).toBe(false);
  });

  it("rejects unknown goal type", () => {
    const bad = {
      id: "g1", type: "not_a_real_goal_type",
      target: {}, priority: 50, status: "active",
      created_at: 1, progress_pct: 0,
      current_step: "x", eta_at: null,
    };
    expect(Value.Check(GoalSchema, bad)).toBe(false);
  });
});

describe("DirectiveSchema", () => {
  it("validates an emergency send_fleet directive", () => {
    const ok = {
      id: "d1", source: "emergency", method: "api",
      priority: 0, action: "send_fleet",
      params: { mission: 8, speed: 1 },
      preconds: [], expires_at: 9999999999,
      reason: "fleet save",
    };
    expect(Value.Check(DirectiveSchema, ok)).toBe(true);
  });

  it("rejects invalid method", () => {
    const bad = {
      id: "d1", source: "daily", method: "telepathy",
      priority: 50, action: "build", params: {},
      preconds: [], expires_at: 1, reason: "x",
    };
    expect(Value.Check(DirectiveSchema, bad)).toBe(false);
  });
});

describe("SendFleetParamsSchema", () => {
  it("validates a fleet save dispatch", () => {
    const ok = {
      source_planet_id: "母星",
      coords: [1, 42, 8],
      destType: 2,
      mission: 8,
      speed: 1,
      ships: { recycler: 1, smallCargo: 50 },
      cargo: { m: 100000, c: 50000, d: 20000 },
    };
    expect(Value.Check(SendFleetParamsSchema, ok)).toBe(true);
  });

  it("rejects negative ship count", () => {
    const bad = {
      source_planet_id: "p1",
      coords: [1, 1, 1], destType: 1,
      mission: 3, speed: 10,
      ships: { smallCargo: -1 },
      cargo: { m: 0, c: 0, d: 0 },
    };
    expect(Value.Check(SendFleetParamsSchema, bad)).toBe(false);
  });

  it("rejects invalid destType (must be 1|2|3)", () => {
    const bad = {
      source_planet_id: "p1",
      coords: [1, 1, 1], destType: 4,
      mission: 3, speed: 10,
      ships: {}, cargo: { m: 0, c: 0, d: 0 },
    };
    expect(Value.Check(SendFleetParamsSchema, bad)).toBe(false);
  });

  it("rejects out-of-range speed", () => {
    const bad = {
      source_planet_id: "p1",
      coords: [1, 1, 1], destType: 1,
      mission: 3, speed: 11,
      ships: {}, cargo: { m: 0, c: 0, d: 0 },
    };
    expect(Value.Check(SendFleetParamsSchema, bad)).toBe(false);
  });
});
