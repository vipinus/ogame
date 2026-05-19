import { describe, it, expect } from "vitest";
import { buildHealthReport, type HealthDeps } from "../../src/sidecar/health.js";
import type { WorldState } from "@ogamex/shared";

/**
 * M8.1 — buildHealthReport composes status from injected deps. These tests
 * pin both the "ok overall" reduction and the per-subsystem reporting.
 */

function emptyState(): WorldState {
  return {
    server: { universe: "uni-test", speed: 1 },
    player: { id: "p1", name: "tester", alliance: null },
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

function baseDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  const deps: HealthDeps = {
    startedAt: Date.now(),
    lastUserscriptSeenAt: null,
    bridgeOpen: () => true,
    llmPing: async () => ({ ok: true, rttMs: 42 }),
    stateRef: { current: emptyState() },
    strategyVersion: () => 0,
    ...overrides,
  };
  return deps;
}

describe("buildHealthReport", () => {
  it("returns ok=true when bridge open, llm ok, snapshot present (and uptime >= 60s)", async () => {
    const deps = baseDeps({ startedAt: Date.now() - 60_000 });
    const r = await buildHealthReport(deps);
    expect(r.ok).toBe(true);
    expect(r.sidecar.uptime_seconds).toBeGreaterThanOrEqual(60);
    expect(r.userscript.connected).toBe(true);
    expect(r.llm.ok).toBe(true);
    expect(r.llm.rtt_ms).toBe(42);
    expect(r.state.has_snapshot).toBe(true);
    expect(r.strategy.version).toBe(0);
    // exactOptionalPropertyTypes: error MUST be omitted, not undefined.
    expect("error" in r.llm).toBe(false);
  });

  it("returns ok=false when bridge is down", async () => {
    const r = await buildHealthReport(baseDeps({ bridgeOpen: () => false }));
    expect(r.ok).toBe(false);
    expect(r.userscript.connected).toBe(false);
  });

  it("returns ok=false and surfaces llm.error when llm ping failed", async () => {
    const deps = baseDeps({
      llmPing: async () => ({ ok: false, rttMs: null, error: "timeout" }),
    });
    const r = await buildHealthReport(deps);
    expect(r.ok).toBe(false);
    expect(r.llm.ok).toBe(false);
    expect(r.llm.rtt_ms).toBeNull();
    expect(r.llm.error).toBe("timeout");
  });

  it("returns has_snapshot=false and ok=false when stateRef is null", async () => {
    const r = await buildHealthReport(baseDeps({ stateRef: { current: null } }));
    expect(r.state.has_snapshot).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.state.server_universe).toBeNull();
    expect(r.state.planets_count).toBe(0);
    expect(r.state.fleets_outbound_count).toBe(0);
    expect(r.state.events_incoming_count).toBe(0);
    expect(r.state.hostile_events_count).toBe(0);
  });

  it("reports last_seen_ago_seconds=null when userscript never seen", async () => {
    const r = await buildHealthReport(baseDeps({ lastUserscriptSeenAt: null }));
    expect(r.userscript.last_seen_at).toBeNull();
    expect(r.userscript.last_seen_ago_seconds).toBeNull();
  });

  it("derives planet/fleet/event counts (incl. hostile) from snapshot", async () => {
    const state = emptyState();
    state.server.universe = "uni-derive";
    state.planets = [
      { id: "1", name: "HQ", coords: { galaxy: 1, system: 1, position: 1 }, has_moon: false, fields: { used: 0, max: 100 }, temperature: { min: 0, max: 0 }, resources: { metal: 0, crystal: 0, deuterium: 0, energy: 0 }, buildings: {}, ships: {}, defense: {}, production: { metal: 0, crystal: 0, deuterium: 0 } } as unknown as WorldState["planets"][number],
      { id: "2" } as unknown as WorldState["planets"][number],
      { id: "3" } as unknown as WorldState["planets"][number],
    ];
    state.fleets_outbound = [
      { id: "f1" } as unknown as WorldState["fleets_outbound"][number],
      { id: "f2" } as unknown as WorldState["fleets_outbound"][number],
    ];
    state.events_incoming = [
      { id: "e1", type: "attack", hostile: true, from: { galaxy: 1, system: 1, position: 1 }, to: { galaxy: 1, system: 1, position: 1 }, arrives_at: 0, ships_count: 0 },
      { id: "e2", type: "transport", hostile: false, from: { galaxy: 1, system: 1, position: 1 }, to: { galaxy: 1, system: 1, position: 1 }, arrives_at: 0, ships_count: 0 },
    ];
    const r = await buildHealthReport(baseDeps({ stateRef: { current: state } }));
    expect(r.state.has_snapshot).toBe(true);
    expect(r.state.server_universe).toBe("uni-derive");
    expect(r.state.planets_count).toBe(3);
    expect(r.state.fleets_outbound_count).toBe(2);
    expect(r.state.events_incoming_count).toBe(2);
    expect(r.state.hostile_events_count).toBe(1);
  });
});
