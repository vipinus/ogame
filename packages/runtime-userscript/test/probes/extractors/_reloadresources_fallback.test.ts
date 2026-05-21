import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractProduction } from "../../../src/probes/extractors/resources.js";

describe("extractProduction — reloadResources script fallback", () => {
  it("returns per-hour values when box tooltips are missing but script JSON present", () => {
    const inlineScript = `(function($){
      reloadResources({"resources":{"metal":{"amount":33416,"production":3.578333333333333},"crystal":{"amount":3148,"production":1.4280555555555556},"deuterium":{"amount":6812,"production":0.4688888888888889},"energy":{"amount":76}}});
    })(jQuery);`;
    const html = `<!DOCTYPE html><html><body><script>${inlineScript}</script></body></html>`;
    const { window } = new JSDOM(html);
    const p = extractProduction(window.document);
    expect(p).not.toBeNull();
    // 3.5783... * 3600 = 12882 (rounded), 1.428... * 3600 = 5141, 0.469... * 3600 = 1688
    expect(p!.m_h).toBe(12882);
    expect(p!.c_h).toBe(5141);
    expect(p!.d_h).toBe(1688);
  });
});
