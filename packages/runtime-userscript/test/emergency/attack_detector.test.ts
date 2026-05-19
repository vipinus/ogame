import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../src/event_bus.js";
import { startAttackDetector, type StateRef } from "../../src/emergency/attack_detector.js";
import type { WorldState, IncomingEvent } from "@ogamex/shared";

function emptyState(): WorldState {
  return {
    server: { universe: "u", speed: 1 },
    player: { id: "p", name: "n", alliance: null },
    planets: [],
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: 0,
    page_snapshots: {},
  };
}

const NOW_S = 1716200000;

function makeAttack(id: string, arriveInSec: number): IncomingEvent {
  return {
    id, type: "attack", hostile: true,
    from: [3, 42, 7], to: [1, 42, 8],
    arrives_at: NOW_S + arriveInSec,
    ships_count: "?",
  };
}

describe("attack_detector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_S * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits emergency.attack when hostile within SAVE_WINDOW", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });

    stateRef.current.events_incoming = [makeAttack("ev1", 600)]; // 10 min
    bus.emit("state.updated", { ts: NOW_S * 1000 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      event_id: "ev1",
      from: [3, 42, 7],
      to: [1, 42, 8],
      arrives_at: NOW_S + 600,
    }));
    stop();
  });

  it("does NOT re-emit for the same event id", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    stateRef.current.events_incoming = [makeAttack("ev1", 600)];
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    bus.emit("state.updated", null);
    bus.emit("state.updated", null);
    expect(spy).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores friendly events", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    stateRef.current.events_incoming = [{
      id: "f1", type: "transport", hostile: false,
      from: [1, 1, 1], to: [1, 42, 8],
      arrives_at: NOW_S + 600,
      ships_count: 100,
    }];
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    expect(spy).not.toHaveBeenCalled();
    stop();
  });

  it("ignores hostile events outside SAVE_WINDOW", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    stateRef.current.events_incoming = [makeAttack("ev1", 60 * 60)]; // 60 min > 30 min window
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    expect(spy).not.toHaveBeenCalled();
    stop();
  });

  it("ignores hostile events that have already arrived (remaining<=0)", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    stateRef.current.events_incoming = [makeAttack("ev1", -60)]; // already passed
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    expect(spy).not.toHaveBeenCalled();
    stop();
  });

  it("emits separately for multiple distinct hostile events", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    stateRef.current.events_incoming = [
      makeAttack("ev1", 300),
      makeAttack("ev2", 600),
      makeAttack("ev3", 900),
    ];
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    expect(spy).toHaveBeenCalledTimes(3);
    const ids = spy.mock.calls.map((c: any) => c[0].event_id).sort();
    expect(ids).toEqual(["ev1", "ev2", "ev3"]);
    stop();
  });

  it("stop() detaches the listener and no further emits happen", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    stop();
    stateRef.current.events_incoming = [makeAttack("ev1", 300)];
    bus.emit("state.updated", null);
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits detected_at timestamp (seconds)", () => {
    const bus = new EventBus();
    const stateRef: StateRef = { current: emptyState() };
    stateRef.current.events_incoming = [makeAttack("ev1", 300)];
    const spy = vi.fn();
    bus.on("emergency.attack", spy);
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    const call = (spy.mock.calls[0] as any)[0];
    expect(call.detected_at).toBe(NOW_S);
    stop();
  });
});
