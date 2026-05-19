import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import { EventBus } from "../src/event_bus.js";
import { StateStore, emptyWorldState } from "../src/state_store.js";
import { createIndexedKv } from "../src/store/indexed_db.js";

describe("StateStore", () => {
  it("constructs with a default empty state", () => {
    const store = new StateStore(new EventBus());
    expect(store.state).toEqual(emptyWorldState());
    expect(store.state.planets).toEqual([]);
    expect(store.state.events_incoming).toEqual([]);
  });

  it("setPartial merges shallow patches and bumps last_update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1716000000000));
    const bus = new EventBus();
    const store = new StateStore(bus);
    const spy = vi.fn();
    bus.on("state.updated", spy);

    store.setPartial({
      server: { universe: "test", speed: 8 },
    });
    expect(store.state.server).toEqual({ universe: "test", speed: 8 });
    expect(store.state.last_update).toBe(1716000000000);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("getSnapshot returns a defensive clone (external mutation does not affect store)", () => {
    const store = new StateStore(new EventBus());
    store.setPartial({ server: { universe: "snap", speed: 1 } });
    const snap = store.getSnapshot();
    snap.server.universe = "MUTATED";
    expect(store.state.server.universe).toBe("snap");
  });

  it("persist + hydrate round-trips state through IndexedDB", async () => {
    const kv = createIndexedKv();
    const bus = new EventBus();
    const a = new StateStore(bus, kv);
    a.setPartial({ player: { id: "p1", name: "Commander Icarus", alliance: "F2P" } });
    await a.persist();

    const b = new StateStore(new EventBus(), kv);
    expect(b.state.player.id).toBe("");
    await b.hydrate();
    expect(b.state.player).toEqual({ id: "p1", name: "Commander Icarus", alliance: "F2P" });
  });

  it("hydrate from empty IndexedDB keeps default empty state", async () => {
    const kv = createIndexedKv();
    await kv.clear();
    const store = new StateStore(new EventBus(), kv);
    await store.hydrate();
    expect(store.state).toEqual(emptyWorldState());
  });

  it("replace overwrites the entire state and emits state.updated", () => {
    const bus = new EventBus();
    const store = new StateStore(bus);
    const spy = vi.fn();
    bus.on("state.updated", spy);
    const next = emptyWorldState();
    next.server = { universe: "newuni", speed: 8 };
    next.last_update = 999;
    store.replace(next);
    expect(store.state.server.universe).toBe("newuni");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ts: 999 }));
  });

  it("emits state.updated when hydrate finds saved state", async () => {
    const kv = createIndexedKv();
    await kv.clear();
    const a = new StateStore(new EventBus(), kv);
    a.setPartial({ server: { universe: "saved", speed: 2 } });
    await a.persist();

    const bus2 = new EventBus();
    const spy = vi.fn();
    bus2.on("state.updated", spy);
    const b = new StateStore(bus2, kv);
    await b.hydrate();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hydrated: true }));
  });
});
