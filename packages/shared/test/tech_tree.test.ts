import { describe, it, expect } from "vitest";
import { TECH_TREE, prerequisitesFor, costFor, expeditionSlots } from "../src/tech_tree.js";

describe("tech_tree", () => {
  it("naniteFactory requires roboticsFactory 10 + computerTech 10", () => {
    expect(prerequisitesFor("naniteFactory")).toEqual({
      roboticsFactory: 10,
      computerTech: 10,
    });
  });

  it("gravitonTech requires energyTech 12, shielding 5, researchLab 12", () => {
    expect(prerequisitesFor("gravitonTech")).toEqual({
      energyTech: 12,
      shielding: 5,
      researchLab: 12,
    });
  });

  it("recycler requires shipyard 4 + combustion 6 + impulseDrive 17", () => {
    expect(prerequisitesFor("recycler")).toEqual({
      shipyard: 4,
      combustion: 6,
      impulseDrive: 17,
    });
  });

  it("cost grows for level N", () => {
    const c1 = TECH_TREE.metalMine!.cost_at(1);
    const c2 = TECH_TREE.metalMine!.cost_at(2);
    expect(c2.m).toBeGreaterThan(c1.m);
  });

  it("costFor throws on unknown tech", () => {
    expect(() => costFor("doesnotexist", 1)).toThrow();
  });

  it("gravitonTech cost has e=300000", () => {
    const c = costFor("gravitonTech", 1);
    expect(c.e).toBe(300000);
    expect(c.m).toBe(0);
    expect(c.c).toBe(0);
    expect(c.d).toBe(0);
  });

  it("every cost_at returns full Resources shape (m, c, d, e)", () => {
    for (const [id, entry] of Object.entries(TECH_TREE)) {
      const c = entry.cost_at(1);
      expect(c, `tech ${id} missing m`).toHaveProperty("m");
      expect(c, `tech ${id} missing c`).toHaveProperty("c");
      expect(c, `tech ${id} missing d`).toHaveProperty("d");
      expect(c, `tech ${id} missing e`).toHaveProperty("e");
      expect(typeof c.m, `tech ${id} m must be number`).toBe("number");
      expect(typeof c.c, `tech ${id} c must be number`).toBe("number");
      expect(typeof c.d, `tech ${id} d must be number`).toBe("number");
      expect(typeof c.e, `tech ${id} e must be number`).toBe("number");
    }
  });

  it("contains 14 buildings, 16 research, 17 ships, 10 defenses (= 57 total)", () => {
    const byKind = { building: 0, research: 0, ship: 0, defense: 0 };
    for (const entry of Object.values(TECH_TREE)) {
      byKind[entry.kind]++;
    }
    expect(byKind.building).toBe(14);
    expect(byKind.research).toBe(16);
    expect(byKind.ship).toBe(17);
    expect(byKind.defense).toBe(10);
    expect(Object.keys(TECH_TREE).length).toBe(57);
  });

  it("prerequisitesFor throws on unknown tech", () => {
    expect(() => prerequisitesFor("doesnotexist")).toThrow();
  });
});

describe("expeditionSlots", () => {
  it.each([
    [1, 1],
    [3, 1],
    [4, 2],
    [8, 2],
    [9, 3],
    [15, 3],
    [16, 4],
    [25, 5],
  ])("astro=%i → slots=%i", (a, s) => expect(expeditionSlots(a)).toBe(s));
});
