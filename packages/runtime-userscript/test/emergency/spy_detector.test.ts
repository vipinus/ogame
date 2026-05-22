import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../src/event_bus.js";
import { startSpyDetector } from "../../src/emergency/spy_detector.js";
import type { StateRef } from "../../src/emergency/attack_detector.js";
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

function makeSpy(id: string, arriveInSec: number): IncomingEvent {
  return {
    id, type: "spy", hostile: false,
    from: [3, 42, 7], to: [1, 42, 8],
    arrives_at: NOW_S + arriveInSec,
    ships_count: "?",
  };
}

function makeAttack(id: string, arriveInSec: number): IncomingEvent {
  return {
    id, type: "attack", hostile: true,
    from: [3, 42, 7], to: [1, 42, 8],
    arrives_at: NOW_S + arriveInSec,
    ships_count: 50,
  };
}

describe("spy_detector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_S * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits emergency.spy for incoming probe", () => {
    const bus = new EventBus();
    const state = emptyState();
    state.events_incoming = [makeSpy("spy1", 120)];
    const ref: StateRef = { current: state };
    const events: Array<{ event_id: string }> = [];
    bus.on("emergency.spy", (p: unknown) => { events.push(p as { event_id: string }); });
    startSpyDetector(bus, ref);
    bus.emit("state.updated", {});
    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toBe("spy1");
  });

  it("dedupes — same event id never fires twice", () => {
    const bus = new EventBus();
    const state = emptyState();
    state.events_incoming = [makeSpy("spy1", 120)];
    const ref: StateRef = { current: state };
    const events: unknown[] = [];
    bus.on("emergency.spy", (p) => events.push(p));
    startSpyDetector(bus, ref);
    bus.emit("state.updated", {});
    bus.emit("state.updated", {});
    bus.emit("state.updated", {});
    expect(events).toHaveLength(1);
  });

  it("ignores already-arrived probes (remaining <= 0)", () => {
    const bus = new EventBus();
    const state = emptyState();
    state.events_incoming = [makeSpy("spy_past", -10)];
    const ref: StateRef = { current: state };
    const events: unknown[] = [];
    bus.on("emergency.spy", (p) => events.push(p));
    startSpyDetector(bus, ref);
    bus.emit("state.updated", {});
    expect(events).toHaveLength(0);
  });

  it("does not fire on attack events (only spy)", () => {
    const bus = new EventBus();
    const state = emptyState();
    state.events_incoming = [makeAttack("att1", 120)];
    const ref: StateRef = { current: state };
    const events: unknown[] = [];
    bus.on("emergency.spy", (p) => events.push(p));
    startSpyDetector(bus, ref);
    bus.emit("state.updated", {});
    expect(events).toHaveLength(0);
  });

  it("disposer removes subscription", () => {
    const bus = new EventBus();
    const state = emptyState();
    const ref: StateRef = { current: state };
    const events: unknown[] = [];
    bus.on("emergency.spy", (p) => events.push(p));
    const stop = startSpyDetector(bus, ref);
    stop();
    state.events_incoming = [makeSpy("spy1", 120)];
    bus.emit("state.updated", {});
    expect(events).toHaveLength(0);
  });
});
