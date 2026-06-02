import { describe, it, expect } from "vitest";
import { SaveCoordinator } from "../../src/sidecar/save_coordinator.js";
import type { WorldState, DownstreamMsg } from "@ogamex/shared";

function makeState(eventIds: string[]): WorldState {
  return {
    server: { universe: "u", speed: 1 } as WorldState["server"],
    player: { id: "1", name: "x", alliance: null },
    planets: {},
    research: { levels: {} },
    fleets_outbound: [],
    events_incoming: eventIds.map((id) => ({
      id, type: "spy", hostile: true,
      from: [0, 0, 0] as const, to: [1, 1, 1] as const,
      arrives_at: 9_999_999_999,
      ships_count: "?",
    })),
    artifacts: {} as WorldState["artifacts"],
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: Date.now(),
    page_snapshots: {},
  } as WorldState;
}

describe("SaveCoordinator", () => {
  it("LAUNCH → IN_FLIGHT", () => {
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["evt-1"]) };
    const sc = new SaveCoordinator({
      safetyMarginSeconds: 300, stateRef, send: (m) => sent.push(m),
    });
    sc.recordLaunch({ planet_id: "p1", fleet_id: 12345, hostile_event_ids: ["evt-1"] });
    const active = sc.list();
    expect(active).toHaveLength(1);
    expect(active[0]!.fleet_id).toBe(12345);
    expect(active[0]!.state).toBe("IN_FLIGHT");
  });

  it("onSnapshot transitions IN_FLIGHT → RECALLING instantly when pending events cleared", () => {
    // Operator 2026-05-26 "威胁解除立即召回" — no margin wait.
    const now = 1_000_000_000;
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["evt-1", "evt-2"]) };
    const sc = new SaveCoordinator({
      stateRef,
      send: (m) => sent.push(m), now: () => now,
    });
    sc.recordLaunch({ planet_id: "p1", fleet_id: 1, hostile_event_ids: ["evt-1", "evt-2"] });
    // Drop both events from state → trigger snapshot
    stateRef.current = makeState([]);
    sc.onSnapshot(stateRef.current);
    expect(sc.list()[0]!.state).toBe("RECALLING");
    expect(sc.list()[0]!.clearedAt).toBe(now);
    expect(sc.list()[0]!.pendingEventIds).toEqual([]);
    // save.recall_now emitted immediately (no tick / no margin needed)
    expect(sent).toHaveLength(1);
    const msg = sent[0] as { type: string; planet_id: string; fleet_id: number };
    expect(msg.type).toBe("save.recall_now");
    expect(msg.planet_id).toBe("p1");
    expect(msg.fleet_id).toBe(1);
  });

  it("tick is a no-op — recall is event-driven, not timer-driven", () => {
    // Operator 2026-05-26 removed safetyMargin tick. Verify tick() does
    // nothing harmful when called (kept for backward-compat callers).
    const now = 1_000_000_000;
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["evt-1"]) };
    const sc = new SaveCoordinator({
      stateRef,
      send: (m) => sent.push(m), now: () => now,
    });
    sc.recordLaunch({ planet_id: "p1", fleet_id: 42, hostile_event_ids: ["evt-1"] });
    sc.tick(); sc.tick(); sc.tick();
    expect(sent).toHaveLength(0);
    expect(sc.list()[0]!.state).toBe("IN_FLIGHT");
  });

  it("recordRecallConfirmed → RETURNED, removes from active list", () => {
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["e1"]) };
    const sc = new SaveCoordinator({
      safetyMarginSeconds: 300, stateRef, send: (m) => sent.push(m),
    });
    sc.recordLaunch({ planet_id: "p1", fleet_id: 7, hostile_event_ids: ["e1"] });
    expect(sc.list()).toHaveLength(1);
    sc.recordRecallConfirmed(7);
    expect(sc.list()).toHaveLength(0);
  });

  it("persistence sink — mirrors every FSM transition to disk in correct order", () => {
    // v0.0.637 — verifies SaveCoordinatorPersistence is called at each
    // mutation point so the on-disk row stays in lock-step with the
    // in-memory map. Without this, a restart during partial-clear or
    // RECALLING reloads a stale state and re-fires save.recall_now.
    type Call =
      | { op: "upsert"; planet_id: string; state: string; pending: string[] }
      | { op: "delete"; planet_id: string };
    const calls: Call[] = [];
    const sink = {
      upsert: (r: { planet_id: string; state: string; pending_event_ids: string[] }) =>
        calls.push({ op: "upsert", planet_id: r.planet_id, state: r.state, pending: r.pending_event_ids }),
      delete: (planet_id: string) => calls.push({ op: "delete", planet_id }),
    };
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["e1", "e2"]) };
    const sc = new SaveCoordinator({
      stateRef, send: (m) => sent.push(m), persistence: sink,
    });

    // 1) recordLaunch → upsert IN_FLIGHT with both pending
    sc.recordLaunch({ planet_id: "p1", fleet_id: 7, hostile_event_ids: ["e1", "e2"] });
    expect(calls).toEqual([
      { op: "upsert", planet_id: "p1", state: "IN_FLIGHT", pending: ["e1", "e2"] },
    ]);

    // 2) Partial clear (e1 drops) → upsert IN_FLIGHT with shrunk pending
    stateRef.current = makeState(["e2"]);
    sc.onSnapshot(stateRef.current);
    expect(calls[1]).toEqual({ op: "upsert", planet_id: "p1", state: "IN_FLIGHT", pending: ["e2"] });

    // 3) Full clear → upsert RECALLING (instant transition)
    stateRef.current = makeState([]);
    sc.onSnapshot(stateRef.current);
    expect(calls[2]).toEqual({ op: "upsert", planet_id: "p1", state: "RECALLING", pending: [] });

    // 4) recordRecallConfirmed → delete
    sc.recordRecallConfirmed(7);
    expect(calls[3]).toEqual({ op: "delete", planet_id: "p1" });

    // sent: only the save.recall_now from step 3
    expect(sent.filter((m) => m.type === "save.recall_now")).toHaveLength(1);
  });

  it("rehydrate restores IN_FLIGHT and RECALLING records, skips RETURNED", () => {
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState([]) };
    const sc = new SaveCoordinator({ stateRef, send: (m) => sent.push(m) });
    sc.rehydrate([
      { planet_id: "p1", fleet_id: 1, state: "IN_FLIGHT", pending_event_ids: ["e1"], cleared_at: null, launched_at: 1000, last_error: null },
      { planet_id: "p2", fleet_id: 2, state: "RECALLING", pending_event_ids: [], cleared_at: 2000, launched_at: 1000, last_error: null },
      { planet_id: "p3", fleet_id: 3, state: "RETURNED", pending_event_ids: [], cleared_at: 3000, launched_at: 1000, last_error: null },
    ]);
    const list = sc.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.planet_id).sort()).toEqual(["p1", "p2"]);
    const p1 = list.find((r) => r.planet_id === "p1")!;
    expect(p1.state).toBe("IN_FLIGHT");
    expect(p1.pendingEventIds).toEqual(["e1"]);
  });

  it("multiple planets — clearing one fires its recall, others stay IN_FLIGHT", () => {
    let now = 0;
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["e1", "e2"]) };
    const sc = new SaveCoordinator({
      stateRef,
      send: (m) => sent.push(m), now: () => now,
    });
    now = 1000;
    sc.recordLaunch({ planet_id: "p1", fleet_id: 1, hostile_event_ids: ["e1"] });
    now = 2000;
    sc.recordLaunch({ planet_id: "p2", fleet_id: 2, hostile_event_ids: ["e2"] });
    // Clear only e1 first
    stateRef.current = makeState(["e2"]);
    sc.onSnapshot(stateRef.current);
    const list = sc.list();
    // p1 transitioned instantly (no margin). p2 still has pending event.
    expect(list.find((r) => r.planet_id === "p1")!.state).toBe("RECALLING");
    expect(list.find((r) => r.planet_id === "p2")!.state).toBe("IN_FLIGHT");
    const recalls = sent.filter((m) => m.type === "save.recall_now") as Array<{ type: string; planet_id: string; fleet_id: number }>;
    expect(recalls).toHaveLength(1);
    expect(recalls[0]!.planet_id).toBe("p1");
    expect(recalls[0]!.fleet_id).toBe(1);
  });
});
