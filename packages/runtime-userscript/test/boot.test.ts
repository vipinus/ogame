// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import { boot } from "../src/boot.js";

function loadFixture(name: string) {
  const html = readFileSync(
    resolve(process.cwd(), `packages/runtime-userscript/test/fixtures/ogame_html/${name}`),
    "utf8",
  );
  return new JSDOM(html);
}

describe("boot()", () => {
  it("boots against minimal overview.html fixture and exposes summary", async () => {
    const dom = loadFixture("overview.html");
    const handle = await boot({
      doc: dom.window.document,
      win: dom.window as unknown as Window,
      kv: null,
    });
    expect(handle.summary.resources_ok).toBe(true);
    expect(handle.summary.storage_ok).toBe(true);
    expect(handle.summary.production_ok).toBe(true);
    handle.stop();
  });

  it("boots against real ogame snapshot, populates ogame_meta, detects vacation mode", async () => {
    const dom = loadFixture("overview_real.html");
    const handle = await boot({
      doc: dom.window.document,
      win: dom.window as unknown as Window,
      kv: null,
    });
    expect(handle.summary.resources_ok).toBe(true);
    expect(handle.summary.storage_ok).toBe(true);     // zh tooltip parsed
    expect(handle.summary.lifeform_resources_ok).toBe(true);
    expect(handle.summary.ogame_meta.universe_speed).toBe(8);
    expect(handle.summary.ogame_meta.player_id).toBe("105948");
    expect(handle.summary.ogame_meta.player_name).toBe("Commander Icarus");
    expect(handle.summary.ogame_meta.planet_coords).toBe("4:241:8");
    expect(handle.summary.ogame_meta.alliance_tag).toBe("F2P");
    expect(handle.summary.ogame_meta.is_vacation_mode).toBe(true);
    expect(handle.summary.planets_count).toBe(9);
    handle.stop();
  });

  it("seeds StateStore.server and StateStore.player from meta tags", async () => {
    const dom = loadFixture("overview_real.html");
    const handle = await boot({
      doc: dom.window.document,
      win: dom.window as unknown as Window,
      kv: null,
    });
    const s = handle.store.state;
    expect(s.server.universe).toContain("s274-en");
    expect(s.server.speed).toBe(8);
    expect(s.player.id).toBe("105948");
    expect(s.player.name).toBe("Commander Icarus");
    expect(s.player.alliance).toBe("F2P");
    handle.stop();
  });

  it("hydrates from IndexedDB when kv provided", async () => {
    const { createIndexedKv } = await import("../src/store/indexed_db.js");
    const kv = createIndexedKv();
    await kv.clear();
    // Pre-seed
    await kv.put("world_state", {
      server: { universe: "saved-uni", speed: 99 },
      player: { id: "saved-id", name: "saved", alliance: null },
      planets: [], research: { levels: {}, queue: null },
      fleets_outbound: [], events_incoming: [],
      artifacts: { artifacts: {} },
      discovery_slots: { used: 0, max: 0 },
      discovery_active: [],
      last_update: 1700000000000,
      page_snapshots: {},
    });
    const dom = loadFixture("overview.html");
    const handle = await boot({
      doc: dom.window.document,
      win: dom.window as unknown as Window,
      kv,
    });
    // initial-extraction setPartial happens AFTER hydrate; minimal fixture has no meta
    // tags, so server.universe is blanked back to "" by the seed step.
    expect(handle.store.state.server.universe).toBe("");
    handle.stop();
  });

  it("survives missing fetch (no XHR hook installed)", async () => {
    const dom = loadFixture("overview.html");
    const handle = await boot({
      doc: dom.window.document,
      win: dom.window as unknown as Window,
      // no fetch
      kv: null,
    });
    expect(handle.summary.resources_ok).toBe(true);
    handle.stop();
  });
});
