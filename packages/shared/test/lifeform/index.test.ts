import { describe, it, expect } from "vitest";
import { LIFEFORM_TECH, ARTIFACTS } from "../../src/lifeform/index.js";

describe("LIFEFORM_TECH", () => {
  it("has all 4 species", () => {
    expect(Object.keys(LIFEFORM_TECH).sort())
      .toEqual(["humans", "kaelesh", "mechas", "rocktal"]);
  });

  for (const species of ["humans", "rocktal", "mechas", "kaelesh"] as const) {
    it(`${species}: has buildings + research`, () => {
      const cat = LIFEFORM_TECH[species];
      expect(cat.species).toBe(species);
      expect(Object.keys(cat.buildings).length).toBeGreaterThan(0);
      expect(Object.keys(cat.research).length).toBeGreaterThan(0);
    });

    it(`${species}: every building has cost_at returning Resources`, () => {
      for (const [id, b] of Object.entries(LIFEFORM_TECH[species].buildings)) {
        const r = b.cost_at(1);
        expect(r).toHaveProperty("m");
        expect(r).toHaveProperty("c");
        expect(r).toHaveProperty("d");
        expect(r).toHaveProperty("e");
        expect(b.id).toBe(id);
      }
    });

    it(`${species}: every research has cost_at returning Resources`, () => {
      for (const [id, r] of Object.entries(LIFEFORM_TECH[species].research)) {
        const c = r.cost_at(1);
        expect(c).toHaveProperty("m");
        expect(c).toHaveProperty("c");
        expect(c).toHaveProperty("d");
        expect(c).toHaveProperty("e");
        expect(r.id).toBe(id);
      }
    });
  }
});

describe("ARTIFACTS", () => {
  it("has entries", () => {
    expect(Object.keys(ARTIFACTS).length).toBeGreaterThan(0);
  });

  it("every entry has required shape", () => {
    for (const [id, a] of Object.entries(ARTIFACTS)) {
      expect(a.id).toBe(id);
      expect(a.display_name_zh).toBeTruthy();
      expect(a.display_name_en).toBeTruthy();
      expect(a.sources.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(a.rarity);
    }
  });
});
