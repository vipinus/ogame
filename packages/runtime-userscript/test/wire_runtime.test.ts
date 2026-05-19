// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { IDBFactory as FDBFactory } from "fake-indexeddb";
import type { ExpeditionConfig, DownstreamMsg, UpstreamMsg } from "@ogamex/shared";
import type { BootHandle } from "../src/boot.js";
import type { BridgeClient } from "../src/bridge/ws_client.js";
import { EventBus } from "../src/event_bus.js";
import { StateStore } from "../src/state_store.js";
import { wireRuntime } from "../src/wire_runtime.js";

function makeBootHandle(): BootHandle {
  const bus = new EventBus();
  const store = new StateStore(bus, null);
  return {
    bus,
    store,
    summary: {
      resources_ok: false,
      storage_ok: false,
      production_ok: false,
      lifeform_resources_ok: false,
      events_count: 0,
      planets_count: 0,
      fleet_movements_count: 0,
      token_present: false,
      ogame_meta: {},
    },
    stop: () => {},
  };
}

function makeConfig(): ExpeditionConfig {
  return {
    enabled: false,
    auto_fill_slots: false,
    source_planet: null,
    duration: "medium",
    target_position: 16,
    fleet_templates: {},
    galaxy_strategy: {
      mode: "stats_based",
      home_galaxy_first: true,
      switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
      cross_galaxy_deut_budget: 0,
    },
    cargo_load: { smallCargo_capacity_pct: 100, largeCargo_capacity_pct: 100 },
  };
}

interface MockBridge {
  client: BridgeClient;
  onCalls: Array<{ type: string }>;
  sent: UpstreamMsg[];
  emit: (msg: DownstreamMsg) => void;
}

function makeMockBridge(): MockBridge {
  const handlers = new Map<string, Set<(m: unknown) => void>>();
  const onCalls: Array<{ type: string }> = [];
  const sent: UpstreamMsg[] = [];

  const client = {
    on(type: string, handler: (m: unknown) => void): () => void {
      onCalls.push({ type });
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    send(msg: UpstreamMsg): void {
      sent.push(msg);
    },
  } as unknown as BridgeClient;

  return {
    client,
    onCalls,
    sent,
    emit(msg: DownstreamMsg): void {
      const set = handlers.get(msg.type);
      if (!set) return;
      for (const h of set) h(msg);
    },
  };
}

function stubFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("wireRuntime (M-userscript-main)", () => {
  it("constructs subsystems and returns a handle with stop", () => {
    const boot = makeBootHandle();
    // jsdom window doesn't have indexedDB by default — inject fake one through
    // the win we pass.
    const win = window as unknown as Window & { indexedDB: IDBFactory };
    win.indexedDB = new FDBFactory();

    const runtime = wireRuntime(boot, {
      expeditionConfig: makeConfig,
      win,
      doc: document,
      auditThresholds: {},
      fetch: stubFetch(),
    });

    expect(typeof runtime.stop).toBe("function");
    runtime.stop();
  });

  it("stop() halts subsystems — no further bus reactions after stop", () => {
    const boot = makeBootHandle();
    const win = window as unknown as Window & { indexedDB: IDBFactory };
    win.indexedDB = new FDBFactory();

    const spy = vi.fn();
    boot.bus.on("audit.condition_unmet", spy);

    const runtime = wireRuntime(boot, {
      expeditionConfig: makeConfig,
      win,
      doc: document,
      auditThresholds: { resource_overflow_pct: 90 },
      fetch: stubFetch(),
    });

    runtime.stop();

    // Emit state.updated after stop — auditor should not fire.
    boot.store.setPartial({
      planets: [
        {
          id: "p1",
          name: "x",
          coords: [1, 2, 3],
          type: "planet",
          resources: { m: 99999, c: 0, d: 0, e: 0 },
          storage: { m_max: 100000, c_max: 100000, d_max: 100000 },
          production: { m_h: 0, c_h: 0, d_h: 0 },
          buildings: {},
          build_q: null,
          shipyard_q: null,
          defense_q: null,
          ships: {},
          defense: {},
          lifeform: null,
        },
      ],
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("without bridge, no directive subscription is created", () => {
    const boot = makeBootHandle();
    const win = window as unknown as Window & { indexedDB: IDBFactory };
    win.indexedDB = new FDBFactory();

    // No bridge supplied → GoalRunner not started.
    const runtime = wireRuntime(boot, {
      expeditionConfig: makeConfig,
      win,
      doc: document,
      auditThresholds: {},
      fetch: stubFetch(),
    });

    // Smoke: just ensure it constructs and stops cleanly without a bridge.
    expect(() => runtime.stop()).not.toThrow();
  });

  it("with bridge, GoalRunner subscribes to directive.dispatch", () => {
    const boot = makeBootHandle();
    const win = window as unknown as Window & { indexedDB: IDBFactory };
    win.indexedDB = new FDBFactory();

    const mock = makeMockBridge();

    const runtime = wireRuntime(boot, {
      bridge: mock.client,
      expeditionConfig: makeConfig,
      win,
      doc: document,
      auditThresholds: {},
      fetch: stubFetch(),
    });

    const subscribed = mock.onCalls.some((c) => c.type === "directive.dispatch");
    expect(subscribed).toBe(true);

    runtime.stop();
  });

  it("auditor uses provided thresholds — violation emits audit.condition_unmet", async () => {
    const boot = makeBootHandle();
    const win = window as unknown as Window & { indexedDB: IDBFactory };
    win.indexedDB = new FDBFactory();

    const spy = vi.fn();
    boot.bus.on("audit.condition_unmet", spy);

    const runtime = wireRuntime(boot, {
      expeditionConfig: makeConfig,
      win,
      doc: document,
      auditThresholds: { resource_overflow_pct: 90 },
      fetch: stubFetch(),
    });

    // Push state that violates threshold.
    boot.store.setPartial({
      planets: [
        {
          id: "p1",
          name: "x",
          coords: [1, 2, 3],
          type: "planet",
          resources: { m: 99000, c: 0, d: 0, e: 0 },
          storage: { m_max: 100000, c_max: 100000, d_max: 100000 },
          production: { m_h: 0, c_h: 0, d_h: 0 },
          buildings: {},
          build_q: null,
          shipyard_q: null,
          defense_q: null,
          ships: {},
          defense: {},
          lifeform: null,
        },
      ],
    });

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0]![0] as { rule_id: string };
    expect(payload.rule_id).toBe("resource_overflow");

    runtime.stop();
  });
});
