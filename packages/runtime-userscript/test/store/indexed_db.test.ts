import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { createIndexedKv } from "../../src/store/indexed_db.js";

describe("IndexedKv (with fake-indexeddb)", () => {
  it("put + get round-trips a JSON value", async () => {
    const kv = createIndexedKv();
    await kv.put("hello", { greeting: "world", n: 42 });
    expect(await kv.get("hello")).toEqual({ greeting: "world", n: 42 });
  });

  it("get returns undefined for missing key", async () => {
    const kv = createIndexedKv();
    expect(await kv.get("nope-" + Math.random())).toBeUndefined();
  });

  it("remove deletes a key", async () => {
    const kv = createIndexedKv();
    await kv.put("x", 1);
    await kv.remove("x");
    expect(await kv.get("x")).toBeUndefined();
  });

  it("clear empties the store", async () => {
    const kv = createIndexedKv();
    await kv.put("a", 1);
    await kv.put("b", 2);
    await kv.clear();
    expect(await kv.get("a")).toBeUndefined();
    expect(await kv.get("b")).toBeUndefined();
  });

  it("handles complex nested objects (WorldState shape)", async () => {
    const kv = createIndexedKv();
    const ws = {
      server: { universe: "uni1", speed: 8 },
      player: { id: "1", name: "x", alliance: null },
      planets: [{ id: "p1", name: "母星", coords: [1, 1, 1], type: "planet" }],
      events_incoming: [],
    };
    await kv.put("ws", ws);
    expect(await kv.get("ws")).toEqual(ws);
  });
});
