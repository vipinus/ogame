// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { extractResources, extractStorage, extractProduction } from "../../../src/probes/extractors/resources.js";

const fixture = readFileSync(
  resolve(
    process.cwd(),
    "packages/runtime-userscript/test/fixtures/ogame_html/overview.html"
  ),
  "utf8"
);
const dom = new JSDOM(fixture);
const doc = dom.window.document;

describe("extractResources", () => {
  it("reads raw data-raw attribute for all four resources", () => {
    expect(extractResources(doc)).toEqual({
      m: 1234567,
      c: 891011,
      d: 22222,
      e: 500,
    });
  });

  it("falls back to textContent stripped of non-digits when data-raw missing", () => {
    const local = new JSDOM(`<div id="resources_metal">1.234.567</div>
      <div id="resources_crystal">891.011</div>
      <div id="resources_deuterium">22.222</div>`);
    expect(extractResources(local.window.document)).toEqual({
      m: 1234567, c: 891011, d: 22222, e: 0,
    });
  });

  it("returns null when required metal/crystal/deuterium missing", () => {
    const local = new JSDOM(`<html></html>`);
    expect(extractResources(local.window.document)).toBeNull();
  });

  it("defaults energy to 0 when not present", () => {
    const local = new JSDOM(`
      <div id="resources_metal" data-raw="1">1</div>
      <div id="resources_crystal" data-raw="2">2</div>
      <div id="resources_deuterium" data-raw="3">3</div>`);
    expect(extractResources(local.window.document)).toEqual({ m: 1, c: 2, d: 3, e: 0 });
  });
});

describe("extractStorage", () => {
  it("parses Capacity from tooltip title for all 3 resources", () => {
    expect(extractStorage(doc)).toEqual({
      m_max: 5000000, c_max: 2500000, d_max: 1000000,
    });
  });

  it("returns null when any box title missing", () => {
    const local = new JSDOM(`<div id="metal_box" title="Capacity: 100"></div>`);
    expect(extractStorage(local.window.document)).toBeNull();
  });
});

describe("extractProduction", () => {
  it("parses 'Production per hour' from tooltip title", () => {
    expect(extractProduction(doc)).toEqual({
      m_h: 80000, c_h: 40000, d_h: 12000,
    });
  });

  it("returns null when any box title lacks 'Production per hour'", () => {
    const local = new JSDOM(`
      <div id="metal_box" title="Capacity: 1"></div>
      <div id="crystal_box" title="Capacity: 1"></div>
      <div id="deuterium_box" title="Capacity: 1"></div>`);
    expect(extractProduction(local.window.document)).toBeNull();
  });
});
