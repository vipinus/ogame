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

  it("onSnapshot transitions IN_FLIGHT → RECALL_READY when pending events cleared", () => {
    let now = 1_000_000_000;
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["evt-1", "evt-2"]) };
    const sc = new SaveCoordinator({
      safetyMarginSeconds: 300, stateRef,
      send: (m) => sent.push(m), now: () => now,
    });
    sc.recordLaunch({ planet_id: "p1", fleet_id: 1, hostile_event_ids: ["evt-1", "evt-2"] });
    // Drop both events from state → trigger snapshot
    stateRef.current = makeState([]);
    sc.onSnapshot(stateRef.current);
    expect(sc.list()[0]!.state).toBe("RECALL_READY");
    expect(sc.list()[0]!.clearedAt).toBe(now);
    expect(sc.list()[0]!.pendingEventIds).toEqual([]);
  });

  it("tick promotes RECALL_READY → RECALLING after margin, emits save.recall_now", () => {
    let now = 1_000_000_000;
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["evt-1"]) };
    const sc = new SaveCoordinator({
      safetyMarginSeconds: 300, stateRef,
      send: (m) => sent.push(m), now: () => now,
    });
    sc.recordLaunch({ planet_id: "p1", fleet_id: 42, hostile_event_ids: ["evt-1"] });
    stateRef.current = makeState([]);
    sc.onSnapshot(stateRef.current);
    expect(sc.list()[0]!.state).toBe("RECALL_READY");
    // Before margin elapsed
    now += 100_000;  // 100s
    sc.tick();
    expect(sc.list()[0]!.state).toBe("RECALL_READY");
    expect(sent.length).toBe(0);
    // After margin elapsed (5min = 300s)
    now += 250_000;  // total 350s since cleared
    sc.tick();
    expect(sc.list()[0]!.state).toBe("RECALLING");
    expect(sent).toHaveLength(1);
    const msg = sent[0] as { type: string; planet_id: string; fleet_id: number };
    expect(msg.type).toBe("save.recall_now");
    expect(msg.planet_id).toBe("p1");
    expect(msg.fleet_id).toBe(42);
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

  it("multiple planets each get their own record, independent margins", () => {
    let now = 0;
    const sent: DownstreamMsg[] = [];
    const stateRef = { current: makeState(["e1", "e2"]) };
    const sc = new SaveCoordinator({
      safetyMarginSeconds: 100, stateRef,
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
    const p1 = list.find((r) => r.planet_id === "p1")!;
    const p2 = list.find((r) => r.planet_id === "p2")!;
    expect(p1.state).toBe("RECALL_READY");
    expect(p2.state).toBe("IN_FLIGHT");
    // Margin elapses for p1
    now = 200_000;
    sc.tick();
    const list2 = sc.list();
    expect(list2.find((r) => r.planet_id === "p1")!.state).toBe("RECALLING");
    expect(list2.find((r) => r.planet_id === "p2")!.state).toBe("IN_FLIGHT");
    expect(sent.filter((m) => m.type === "save.recall_now")).toHaveLength(1);
  });
});
