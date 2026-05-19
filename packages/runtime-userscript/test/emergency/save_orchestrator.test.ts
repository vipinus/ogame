import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/event_bus.js";
import { startEmergencySave } from "../../src/emergency/save_orchestrator.js";
import { TokenManager } from "../../src/api/token_manager.js";

describe("save_orchestrator integration", () => {
  it("end-to-end: hostile event → API call → state machine in IN_FLIGHT", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, fleetIdToReturn: 77 }),
      { status: 200, headers: { "content-type": "application/json" } }));
    const tm = new TokenManager(() => "tk");
    const bus = new EventBus();

    const stateRef = { current: {
      server: { universe: "u", speed: 1 }, player: { id: "p", name: "n", alliance: null },
      planets: [{ id: "m1", name: "母月", coords: [1,42,8], type: "moon",
        resources: { m: 0, c: 0, d: 0 }, storage: { m_max: 0, c_max: 0, d_max: 0 },
        production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, build_q: null,
        shipyard_q: null, defense_q: null, ships: { recycler: 1 }, defense: {} }],
      research: { levels: {}, queue: null },
      fleets_outbound: [], events_incoming: [], last_update: 0, page_snapshots: {},
    } as any };

    const handle = startEmergencySave(bus, stateRef, {
      tokenManager: tm,
      fetch: fetchMock as any,
      saveWindowMinutes: 30,
      safetyMarginMinutes: 5,
    });

    const now = Math.floor(Date.now() / 1000);
    stateRef.current.events_incoming = [{
      id: "ev1", type: "attack", hostile: true,
      from: [3,42,7], to: [1,42,8], arrives_at: now + 600, ships_count: "?",
    }];
    bus.emit("state.updated", null);

    // allow async promise chain to flush
    await new Promise(r => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handle.snapshot().state).toBe("IN_FLIGHT");
    expect(handle.snapshot().fleetId).toBe(77);

    handle.stop();
  });
});
