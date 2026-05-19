// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { extractPlanets } from "../../../src/probes/extractors/planets.js";

const fixture = readFileSync(
  resolve(
    process.cwd(),
    "packages/runtime-userscript/test/fixtures/ogame_html/planetlist.html"
  ),
  "utf8"
);
const dom = new JSDOM(fixture);

describe("extractPlanets", () => {
  it("extracts 2 planets + 1 moon from fixture", () => {
    const result = extractPlanets(dom.window.document);
    expect(result).toHaveLength(3);
  });

  it("first entry is 母星 planet with correct coords", () => {
    const result = extractPlanets(dom.window.document);
    expect(result[0]).toEqual({
      id: "33700001", name: "母星", coords: [1, 42, 8], type: "planet",
    });
  });

  it("identifies moon type via .moonlink class", () => {
    const result = extractPlanets(dom.window.document);
    const moon = result.find(p => p.type === "moon");
    expect(moon).toMatchObject({
      id: "33700001", name: "母月", coords: [1, 42, 8], type: "moon",
    });
  });

  it("falls back to data-planet-id when id attribute lacks planet- prefix", () => {
    const local = new JSDOM(`
      <div id="planetList">
        <li class="moonlink" data-planet-id="42">
          <span class="planet-name">辅月</span>
          <span class="planet-koords">[3:300:8]</span>
        </li>
      </div>`);
    const result = extractPlanets(local.window.document);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("42");
    expect(result[0]!.type).toBe("moon");
  });

  it("returns empty when #planetList missing", () => {
    const local = new JSDOM(`<html></html>`);
    expect(extractPlanets(local.window.document)).toEqual([]);
  });

  it("skips entries with malformed coords", () => {
    const local = new JSDOM(`
      <div id="planetList">
        <li id="planet-1" class="smallplanet">
          <span class="planet-name">bad</span>
          <span class="planet-koords">not coords</span>
        </li>
        <li id="planet-2" class="smallplanet">
          <span class="planet-name">good</span>
          <span class="planet-koords">[5:10:15]</span>
        </li>
      </div>`);
    const result = extractPlanets(local.window.document);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("2");
  });
});
