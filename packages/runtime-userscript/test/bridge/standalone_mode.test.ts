// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { EventBus } from "../../src/event_bus.js";
import {
  startStandaloneMode,
  type StandaloneModeHandle,
} from "../../src/bridge/standalone_mode.js";

interface ChangedEvent {
  active: boolean;
  reason?: string;
}

interface Harness {
  bus: EventBus;
  events: ChangedEvent[];
  connected: { value: boolean };
  mockTime: { value: number };
  handle: StandaloneModeHandle;
}

const POLL_MS = 20;
const GRACE_MS = 100;

function makeHarness(opts?: { startConnected?: boolean }): Harness {
  const bus = new EventBus();
  const events: ChangedEvent[] = [];
  bus.on<ChangedEvent>("standalone_mode.changed", (p) => {
    events.push(p);
  });
  const connected = { value: opts?.startConnected ?? true };
  const mockTime = { value: 1_000_000 };
  const handle = startStandaloneMode(() => connected.value, {
    bus,
    pollIntervalMs: POLL_MS,
    enterAfterDisconnectedMs: GRACE_MS,
    now: () => mockTime.value,
  });
  return { bus, events, connected, mockTime, handle };
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 1000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!cond()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const harnesses: Harness[] = [];

function track(h: Harness): Harness {
  harnesses.push(h);
  return h;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    h?.handle.stop();
  }
});

describe("startStandaloneMode", () => {
  it("stays inactive while bridge is connected", async () => {
    const h = track(makeHarness({ startConnected: true }));
    // Let several poll cycles run.
    await sleep(POLL_MS * 5);
    h.mockTime.value += GRACE_MS * 5;
    await sleep(POLL_MS * 2);
    expect(h.handle.isActive()).toBe(false);
    expect(h.events.length).toBe(0);
  });

  it("enters active state after disconnect-grace period", async () => {
    const h = track(makeHarness({ startConnected: true }));
    // Let one poll establish baseline connected.
    await sleep(POLL_MS * 2);
    h.connected.value = false;
    // First poll while disconnected → records disconnectedSince.
    await sleep(POLL_MS * 2);
    expect(h.handle.isActive()).toBe(false);
    // Advance mock clock beyond grace.
    h.mockTime.value += GRACE_MS + 10;
    await waitFor(() => h.handle.isActive() === true);
    expect(h.handle.isActive()).toBe(true);
    const activeEvents = h.events.filter((e) => e.active === true);
    expect(activeEvents.length).toBe(1);
    expect(activeEvents[0]?.reason).toContain("bridge disconnected");
  });

  it("exits active state on reconnect", async () => {
    const h = track(makeHarness({ startConnected: false }));
    // Push to active.
    await sleep(POLL_MS * 2);
    h.mockTime.value += GRACE_MS + 10;
    await waitFor(() => h.handle.isActive() === true);
    // Reconnect.
    h.connected.value = true;
    await waitFor(() => h.handle.isActive() === false);
    expect(h.handle.isActive()).toBe(false);
    const inactiveEvents = h.events.filter((e) => e.active === false);
    expect(inactiveEvents.length).toBe(1);
    expect(inactiveEvents[0]?.reason).toContain("reconnected");
  });

  it("resets grace timer on transient reconnect", async () => {
    const h = track(makeHarness({ startConnected: true }));
    await sleep(POLL_MS * 2);
    // Disconnect for half the grace.
    h.connected.value = false;
    await sleep(POLL_MS * 2);
    h.mockTime.value += GRACE_MS / 2;
    await sleep(POLL_MS * 2);
    expect(h.handle.isActive()).toBe(false);
    // Reconnect briefly → timer resets.
    h.connected.value = true;
    await sleep(POLL_MS * 2);
    // Disconnect again. Advance by another GRACE/2 + small buffer — still
    // less than full grace from the second disconnect, so must NOT activate.
    h.connected.value = false;
    await sleep(POLL_MS * 2);
    h.mockTime.value += GRACE_MS / 2 + 5;
    await sleep(POLL_MS * 3);
    expect(h.handle.isActive()).toBe(false);
    // No active=true emit yet.
    expect(h.events.filter((e) => e.active === true).length).toBe(0);
  });

  it("setActive(true) forces immediate activation", async () => {
    const h = track(makeHarness({ startConnected: true }));
    await sleep(POLL_MS);
    expect(h.handle.isActive()).toBe(false);
    h.handle.setActive(true, "forced by test");
    expect(h.handle.isActive()).toBe(true);
    const activeEvents = h.events.filter((e) => e.active === true);
    expect(activeEvents.length).toBe(1);
    expect(activeEvents[0]?.reason).toBe("forced by test");
    // Calling again with same value should not double-emit.
    h.handle.setActive(true, "again");
    expect(h.events.filter((e) => e.active === true).length).toBe(1);
  });

  it("stop() halts polling — no further transitions", async () => {
    const h = track(makeHarness({ startConnected: true }));
    await sleep(POLL_MS * 2);
    h.handle.stop();
    const eventsBefore = h.events.length;
    h.connected.value = false;
    h.mockTime.value += GRACE_MS * 10;
    await sleep(POLL_MS * 5);
    expect(h.handle.isActive()).toBe(false);
    expect(h.events.length).toBe(eventsBefore);
  });
});
