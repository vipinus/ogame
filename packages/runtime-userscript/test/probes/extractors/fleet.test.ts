// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { extractFleetMovements } from "../../../src/probes/extractors/fleet.js";

const fixture = readFileSync(
  resolve(
    process.cwd(),
    "packages/runtime-userscript/test/fixtures/ogame_html/fleetmovement.html"
  ),
  "utf8"
);
const dom = new JSDOM(fixture);

describe("extractFleetMovements", () => {
  it("extracts 2 fleet entries from fixture", () => {
    const fleets = extractFleetMovements(dom.window.document);
    expect(fleets).toHaveLength(2);
  });

  it("expedition (mission=15) parsed with origin/dest coords and arrival times", () => {
    const fleets = extractFleetMovements(dom.window.document);
    const exp = fleets.find(f => f.id === "100")!;
    expect(exp).toMatchObject({
      id: "100",
      mission: 15,
      origin: [1, 42, 8],
      origin_type: "planet",
      dest: [1, 42, 16],
      dest_type: 1,
      arrival_at: 1716210000,
      return_at: 1716220000,
      ships: { smallCargo: 50, largeCargo: 30, espionageProbe: 1 },
      cargo: { m: 0, c: 0, d: 5000 },
    });
  });

  it("planet→moon transport (fleet save) with no return time set", () => {
    const fleets = extractFleetMovements(dom.window.document);
    const save = fleets.find(f => f.id === "101")!;
    expect(save).toMatchObject({
      mission: 3,
      dest_type: 3,
      return_at: null,
      ships: { recycler: 1, smallCargo: 100 },
      cargo: { m: 1000000, c: 800000, d: 240000 },
    });
  });

  it("returns empty when #movement missing", () => {
    const local = new JSDOM(`<html></html>`);
    expect(extractFleetMovements(local.window.document)).toEqual([]);
  });

  it("skips entries with missing fleet-id or arrival time", () => {
    const local = new JSDOM(`
      <div id="movement">
        <div class="fleetDetails" data-mission-type="3"></div>
      </div>`);
    expect(extractFleetMovements(local.window.document)).toEqual([]);
  });
});
