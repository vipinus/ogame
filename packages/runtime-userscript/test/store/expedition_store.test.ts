import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory as FDBFactory } from "fake-indexeddb";
import type { ExpeditionOutcome } from "@ogamex/shared";
import { ExpeditionStore } from "../../src/store/expedition_store.js";

function makeOutcome(overrides: Partial<ExpeditionOutcome> = {}): ExpeditionOutcome {
  return {
    expedition_id: "exp-1",
    source_planet_id: "p1",
    source_coords: [1, 1, 1],
    target_galaxy: 1,
    target_system: 100,
    target_position: 16,
    template_id: "aggressive",
    fleet_sent: {},
    launched_at: 1000,
    returned_at: 2000,
    duration_actual_seconds: 1000,
    outcome_type: "resources_small",
    resources_gained: { m: 0, c: 0, d: 0, e: 0 },
    ships_gained: {},
    ships_lost: {},
    raw_report_id: "r1",
    artifacts_gained: {},
    lifeform_xp_gained: null,
    ...overrides,
  };
}

// Each test gets its own FDBFactory so persistent fake-indexeddb state
// doesn't leak between tests.
let store: ExpeditionStore;
beforeEach(() => {
  store = new ExpeditionStore({ factory: new FDBFactory() });
});

describe("ExpeditionStore", () => {
  it("put then recent(10) returns the outcome", async () => {
    const o = makeOutcome();
    await store.put(o);
    const got = await store.recent(10);
    expect(got).toHaveLength(1);
    expect(got[0]?.expedition_id).toBe("exp-1");
  });

  it("queryByGalaxy returns only matching galaxy", async () => {
    await store.put(makeOutcome({ expedition_id: "a", target_galaxy: 1, returned_at: 100 }));
    await store.put(makeOutcome({ expedition_id: "b", target_galaxy: 1, returned_at: 200 }));
    await store.put(makeOutcome({ expedition_id: "c", target_galaxy: 2, returned_at: 300 }));
    const g1 = await store.queryByGalaxy(1, 0);
    expect(g1.map((o) => o.expedition_id).sort()).toEqual(["a", "b"]);
  });

  it("queryByTemplate filters by template_id", async () => {
    await store.put(makeOutcome({ expedition_id: "a", template_id: "aggressive", returned_at: 100 }));
    await store.put(makeOutcome({ expedition_id: "b", template_id: "defensive", returned_at: 200 }));
    await store.put(makeOutcome({ expedition_id: "c", template_id: "aggressive", returned_at: 300 }));
    const aggr = await store.queryByTemplate("aggressive", 0);
    expect(aggr.map((o) => o.expedition_id).sort()).toEqual(["a", "c"]);
  });

  it("queryByGalaxy excludes outcomes returned before sinceTs", async () => {
    await store.put(makeOutcome({ expedition_id: "a", target_galaxy: 1, returned_at: 100 }));
    await store.put(makeOutcome({ expedition_id: "b", target_galaxy: 1, returned_at: 500 }));
    await store.put(makeOutcome({ expedition_id: "c", target_galaxy: 1, returned_at: 1000 }));
    const recent = await store.queryByGalaxy(1, 500);
    expect(recent.map((o) => o.expedition_id).sort()).toEqual(["b", "c"]);
  });

  it("recent(2) returns 2 newest by returned_at DESC", async () => {
    await store.put(makeOutcome({ expedition_id: "old", returned_at: 100 }));
    await store.put(makeOutcome({ expedition_id: "mid", returned_at: 500 }));
    await store.put(makeOutcome({ expedition_id: "new", returned_at: 1000 }));
    const r = await store.recent(2);
    expect(r.map((o) => o.expedition_id)).toEqual(["new", "mid"]);
  });

  it("clear() empties the store", async () => {
    await store.put(makeOutcome({ expedition_id: "a" }));
    await store.put(makeOutcome({ expedition_id: "b", returned_at: 3000 }));
    await store.clear();
    expect(await store.recent(10)).toEqual([]);
  });
});
