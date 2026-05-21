import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractProduction, extractResources } from "../../../src/probes/extractors/resources.js";

/**
 * Diagnostic: verify the extractor handles the EXACT title format pasted
 * from the user's live ogame page (Scorpius/zh-TW, v12.10). Helps bisect
 * "production=0 in state" between extractor-bug vs userscript-not-reloaded.
 */
describe("user real HTML — production extraction", () => {
  const realTitle = `金屬|<table class="resourceTooltip"><tr><th>現有量:</th><td><span class="">33,412</span></td></tr><tr><th>儲存容量</th><td><span class="">75,000</span></td></tr><tr><th>當前產量:</th><td><span class="undermark">+12,882</span></td></tr><tr><th>保護倉容量:</th><td><span class="middlemark">9,073</span></td></tr></table>`;
  const crystalTitle = `晶體|<table><tr><th>現有量:</th><td><span class="">3,147</span></td></tr><tr><th>儲存容量</th><td><span>75,000</span></td></tr><tr><th>當前產量:</th><td><span class="undermark">+5,141</span></td></tr></table>`;
  const deuteriumTitle = `重氫|<table><tr><th>現有量:</th><td><span>6,812</span></td></tr><tr><th>儲存容量</th><td><span>75,000</span></td></tr><tr><th>當前產量:</th><td><span>+1,688</span></td></tr></table>`;
  const energyTitle = `能源|<table><tr><th>現有量:</th><td><span>76</span></td></tr><tr><th>當前產量:</th><td><span>+1,355</span></td></tr></table>`;

  const html = `<!DOCTYPE html><html><body>
    <div id="metal_box" title='${realTitle.replace(/'/g, "&apos;")}'><span id="resources_metal" data-raw="33416">33,416</span></div>
    <div id="crystal_box" title='${crystalTitle.replace(/'/g, "&apos;")}'><span id="resources_crystal" data-raw="3148">3,148</span></div>
    <div id="deuterium_box" title='${deuteriumTitle.replace(/'/g, "&apos;")}'><span id="resources_deuterium" data-raw="6812">6,812</span></div>
    <div id="energy_box" title='${energyTitle.replace(/'/g, "&apos;")}'><span id="resources_energy" data-raw="76">76</span></div>
  </body></html>`;

  const { window } = new JSDOM(html);
  const doc = window.document;

  it("title attribute round-trips through DOM correctly", () => {
    const t = doc.getElementById("metal_box")?.getAttribute("title") ?? "";
    expect(t).toContain("當前產量");
    expect(t).toContain("+12,882");
  });

  it("extractResources reads raw data-raw values", () => {
    const r = extractResources(doc);
    expect(r).not.toBeNull();
    expect(r!.m).toBe(33416);
    expect(r!.c).toBe(3148);
    expect(r!.d).toBe(6812);
    expect(r!.e).toBe(76);
  });

  it("extractProduction returns non-null with per-hour values from titles", () => {
    const p = extractProduction(doc);
    expect(p).not.toBeNull();
    expect(p!.m_h).toBe(12882);
    expect(p!.c_h).toBe(5141);
    expect(p!.d_h).toBe(1688);
  });
});
