import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorldStateStore } from "../../src/sidecar/world_state_store.js";
import type { WorldState } from "@ogamex/shared";

function makeState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    server: { universe: "s274-en", speed: 1 },
    player: { id: "P1", name: "tester", alliance: null },
    planets: {},
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: 1_000_000_000_000,
    page_snapshots: {},
    ...overrides,
  };
}

describe("WorldStateStore", () => {
  let store: WorldStateStore;
  let clock: number;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    store = new WorldStateStore({ dbPath: ":memory:", clock: () => clock });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("hydrate on empty db returns null", () => {
    expect(store.hydrate()).toBeNull();
    expect(store.lastUpdatedAt()).toBeNull();
  });

  it("upsert + hydrate roundtrips a WorldState", () => {
    const state = makeState({
      tech_labels: { heatRecovery: "热量回收", psionicNetwork: "精神调谐器" },
    });
    store.upsert(state);
    const hydrated = store.hydrate();
    expect(hydrated).not.toBeNull();
    expect(hydrated!.state).toEqual(state);
    expect(hydrated!.updated_at).toBe(1_700_000_000_000);
  });

  it("upsert is idempotent on id=1 — second write replaces, not duplicates", () => {
    store.upsert(makeState({ server: { universe: "first", speed: 1 } }));
    clock = 1_700_000_001_000;
    store.upsert(makeState({ server: { universe: "second", speed: 2 } }));

    const hydrated = store.hydrate();
    expect(hydrated!.state.server.universe).toBe("second");
    expect(hydrated!.state.server.speed).toBe(2);
    expect(hydrated!.updated_at).toBe(1_700_000_001_000);
  });

  it("lastUpdatedAt tracks most recent upsert", () => {
    expect(store.lastUpdatedAt()).toBeNull();
    store.upsert(makeState());
    expect(store.lastUpdatedAt()).toBe(1_700_000_000_000);
    clock = 1_700_000_005_000;
    store.upsert(makeState());
    expect(store.lastUpdatedAt()).toBe(1_700_000_005_000);
  });

  it("appendEvent + listRecentEvents roundtrips payload as JSON", () => {
    store.appendEvent("event.emergency", { subtype: "attack", from: [1, 486, 7], arrives_at: 1_700_000_010_000 });
    clock = 1_700_000_001_000;
    store.appendEvent("event.daily_failure", { task: "metal_balance", attempts: 3 });

    const rows = store.listRecentEvents(10);
    expect(rows).toHaveLength(2);
    // Most-recent first
    expect(rows[0]?.type).toBe("event.daily_failure");
    expect(rows[0]?.created_at).toBe(1_700_000_001_000);
    expect((rows[0]?.payload as { task: string }).task).toBe("metal_balance");
    expect(rows[1]?.type).toBe("event.emergency");
    expect((rows[1]?.payload as { subtype: string }).subtype).toBe("attack");
  });

  it("listEventsByType filters", () => {
    store.appendEvent("event.emergency", { n: 1 });
    store.appendEvent("event.daily_failure", { n: 2 });
    store.appendEvent("event.emergency", { n: 3 });

    const emergencies = store.listEventsByType("event.emergency", 10);
    expect(emergencies).toHaveLength(2);
    expect((emergencies[0]?.payload as { n: number }).n).toBe(3);
    expect((emergencies[1]?.payload as { n: number }).n).toBe(1);
  });

  it("trimEvents keeps last N rows", () => {
    for (let i = 0; i < 20; i++) store.appendEvent("evt", { i });
    expect(store.listRecentEvents(100)).toHaveLength(20);
    store.trimEvents(5);
    const rows = store.listRecentEvents(100);
    expect(rows).toHaveLength(5);
    // The 5 most-recent (i=15..19) survive.
    expect((rows[0]?.payload as { i: number }).i).toBe(19);
    expect((rows[4]?.payload as { i: number }).i).toBe(15);
  });

  it("survives store close + reopen on disk (cross-process simulation)", () => {
    // The canonical sidecar-restart contract: write → close → fresh
    // instance on the SAME file → hydrate returns the data verbatim.
    // :memory: db would only test in-process consistency; on-disk db
    // catches WAL-checkpoint regressions a :memory: roundtrip can't.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ogamex-wss-"));
    const dbPath = path.join(tmpDir, "world.db");
    try {
      const writer = new WorldStateStore({ dbPath, clock: () => 1_700_111_000_000 });
      writer.upsert(makeState({
        server: { universe: "persist-test", speed: 7 },
        tech_labels: { heatRecovery: "热量回收" },
      }));
      writer.appendEvent("event.emergency", { subtype: "attack", from: [1, 486, 7] });
      writer.appendEvent("event.daily_failure", { task: "metal_balance" });
      writer.close();

      // SIMULATE sidecar restart: fresh WorldStateStore instance, same file.
      const reader = new WorldStateStore({ dbPath, clock: () => 1_700_111_001_000 });
      const hydrated = reader.hydrate();
      expect(hydrated).not.toBeNull();
      expect(hydrated!.state.server.universe).toBe("persist-test");
      expect(hydrated!.state.server.speed).toBe(7);
      expect(hydrated!.state.tech_labels?.heatRecovery).toBe("热量回收");
      expect(hydrated!.updated_at).toBe(1_700_111_000_000);

      // Events table also survives close+reopen
      const events = reader.listRecentEvents(10);
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe("event.daily_failure");
      expect(events[1]?.type).toBe("event.emergency");

      reader.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("hydrate JSON-parses back nested records / arrays preserved", () => {
    const state = makeState({
      research: { levels: { gravitation: 5, energy: 12 }, queue: null },
      events_incoming: [],
      page_snapshots: { lfresearch: 1_700_000_002_000 },
    });
    store.upsert(state);
    const hydrated = store.hydrate();
    expect(hydrated!.state.research.levels.gravitation).toBe(5);
    expect(hydrated!.state.research.levels.energy).toBe(12);
    expect(hydrated!.state.page_snapshots.lfresearch).toBe(1_700_000_002_000);
  });
});
