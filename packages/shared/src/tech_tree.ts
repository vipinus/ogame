import type { Resources } from "./types.js";

export type TechKind = "building" | "research" | "ship" | "defense";

export interface TechEntry {
  id: string;
  kind: TechKind;
  requires: Record<string, number>;
  cost_at: (level: number) => Resources;
  duration_seconds?: (
    level: number,
    ctx: { roboticsFactory?: number; naniteFactory?: number; researchLab?: number; shipyard?: number },
  ) => number;
}

// Helper: exponential cost (base * factor^(level-1))
const pow = (base: number, k: number) => (lvl: number): number => Math.floor(base * Math.pow(k, lvl - 1));

// Helper: flat cost (unit cost — for ships/defenses, level ignored)
const flat = (x: number) => (_lvl: number): number => x;

// Helper: build a Resources object with all four fields
const res = (m: number, c: number, d: number, e = 0): Resources => ({ m, c, d, e });

// ──────────────────────────────────────────────────────────────────────────────
// Buildings (14)
// ──────────────────────────────────────────────────────────────────────────────
const buildings: Record<string, TechEntry> = {
  metalMine: {
    id: "metalMine",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(60, 1.5)(l), pow(15, 1.5)(l), 0),
  },
  crystalMine: {
    id: "crystalMine",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(48, 1.6)(l), pow(24, 1.6)(l), 0),
  },
  deuteriumSynth: {
    id: "deuteriumSynth",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(225, 1.5)(l), pow(75, 1.5)(l), 0),
  },
  solarPlant: {
    id: "solarPlant",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(75, 1.5)(l), pow(30, 1.5)(l), 0),
  },
  fusionReactor: {
    id: "fusionReactor",
    kind: "building",
    requires: { deuteriumSynth: 5, energyTech: 3 },
    cost_at: (l) => res(pow(900, 1.8)(l), pow(360, 1.8)(l), pow(180, 1.8)(l)),
  },
  metalStorage: {
    id: "metalStorage",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(1000, 2)(l), 0, 0),
  },
  crystalStorage: {
    id: "crystalStorage",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(1000, 2)(l), pow(500, 2)(l), 0),
  },
  deuteriumTank: {
    id: "deuteriumTank",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(1000, 2)(l), pow(1000, 2)(l), 0),
  },
  roboticsFactory: {
    id: "roboticsFactory",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(400, 2)(l), pow(120, 2)(l), pow(200, 2)(l)),
  },
  shipyard: {
    id: "shipyard",
    kind: "building",
    requires: { roboticsFactory: 2 },
    cost_at: (l) => res(pow(400, 2)(l), pow(200, 2)(l), pow(100, 2)(l)),
  },
  researchLab: {
    id: "researchLab",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(200, 2)(l), pow(400, 2)(l), pow(200, 2)(l)),
  },
  alliance_depot: {
    id: "alliance_depot",
    kind: "building",
    requires: {},
    cost_at: (l) => res(pow(20000, 2)(l), pow(40000, 2)(l), 0),
  },
  missile_silo: {
    id: "missile_silo",
    kind: "building",
    requires: { shipyard: 1 },
    cost_at: (l) => res(pow(20000, 2)(l), pow(20000, 2)(l), pow(1000, 2)(l)),
  },
  naniteFactory: {
    id: "naniteFactory",
    kind: "building",
    requires: { roboticsFactory: 10, computerTech: 10 },
    cost_at: (l) => res(pow(1_000_000, 2)(l), pow(500_000, 2)(l), pow(100_000, 2)(l)),
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Research (16)
// ──────────────────────────────────────────────────────────────────────────────
const research: Record<string, TechEntry> = {
  energyTech: {
    id: "energyTech",
    kind: "research",
    requires: { researchLab: 1 },
    cost_at: (l) => res(0, pow(800, 2)(l), pow(400, 2)(l)),
  },
  laserTech: {
    id: "laserTech",
    kind: "research",
    requires: { researchLab: 1, energyTech: 2 },
    cost_at: (l) => res(pow(200, 2)(l), pow(100, 2)(l), 0),
  },
  ionTech: {
    id: "ionTech",
    kind: "research",
    requires: { researchLab: 4, energyTech: 4, laserTech: 5 },
    cost_at: (l) => res(pow(1000, 2)(l), pow(300, 2)(l), pow(100, 2)(l)),
  },
  hyperspaceTech: {
    id: "hyperspaceTech",
    kind: "research",
    requires: { researchLab: 7, energyTech: 5, shielding: 5 },
    cost_at: (l) => res(0, pow(4000, 2)(l), pow(2000, 2)(l)),
  },
  plasmaTech: {
    id: "plasmaTech",
    kind: "research",
    requires: { researchLab: 4, energyTech: 8, laserTech: 10, ionTech: 5 },
    cost_at: (l) => res(pow(2000, 2)(l), pow(4000, 2)(l), pow(1000, 2)(l)),
  },
  combustion: {
    id: "combustion",
    kind: "research",
    requires: { researchLab: 1, energyTech: 1 },
    cost_at: (l) => res(pow(400, 2)(l), 0, pow(600, 2)(l)),
  },
  impulseDrive: {
    id: "impulseDrive",
    kind: "research",
    requires: { researchLab: 2, energyTech: 1 },
    cost_at: (l) => res(pow(2000, 2)(l), pow(4000, 2)(l), pow(600, 2)(l)),
  },
  hyperspaceDrive: {
    id: "hyperspaceDrive",
    kind: "research",
    requires: { researchLab: 7, hyperspaceTech: 3 },
    cost_at: (l) => res(pow(10000, 2)(l), pow(20000, 2)(l), pow(6000, 2)(l)),
  },
  espionageTech: {
    id: "espionageTech",
    kind: "research",
    requires: { researchLab: 3 },
    cost_at: (l) => res(pow(200, 2)(l), pow(1000, 2)(l), pow(200, 2)(l)),
  },
  computerTech: {
    id: "computerTech",
    kind: "research",
    requires: { researchLab: 1 },
    cost_at: (l) => res(0, pow(400, 2)(l), pow(600, 2)(l)),
  },
  astrophysics: {
    id: "astrophysics",
    kind: "research",
    requires: { researchLab: 3, espionageTech: 4, impulseDrive: 3 },
    cost_at: (l) => res(pow(4000, 1.75)(l), pow(8000, 1.75)(l), pow(4000, 1.75)(l)),
  },
  intergalactic: {
    id: "intergalactic",
    kind: "research",
    requires: { researchLab: 10, computerTech: 8, hyperspaceTech: 8 },
    cost_at: (l) => res(pow(240000, 2)(l), pow(400000, 2)(l), pow(160000, 2)(l)),
  },
  gravitonTech: {
    id: "gravitonTech",
    kind: "research",
    requires: { researchLab: 12, energyTech: 12, shielding: 5 },
    // Special: requires 300k energy (encoded in Resources.e)
    cost_at: (_l) => res(0, 0, 0, 300000),
  },
  weapons: {
    id: "weapons",
    kind: "research",
    requires: { researchLab: 4 },
    cost_at: (l) => res(pow(800, 2)(l), 0, 0),
  },
  shielding: {
    id: "shielding",
    kind: "research",
    requires: { researchLab: 6, energyTech: 3 },
    cost_at: (l) => res(pow(200, 2)(l), pow(600, 2)(l), 0),
  },
  armor: {
    id: "armor",
    kind: "research",
    requires: { researchLab: 2 },
    cost_at: (l) => res(pow(1000, 2)(l), 0, 0),
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Ships (17 — note: plan said 18 but there are 17 distinct ship ids in SHIP_IDS)
// Costs are per-unit; level param ignored.
// ──────────────────────────────────────────────────────────────────────────────
const ships: Record<string, TechEntry> = {
  smallCargo: {
    id: "smallCargo",
    kind: "ship",
    requires: { shipyard: 2, combustion: 2 },
    cost_at: (l) => res(flat(2000)(l), flat(2000)(l), 0),
  },
  largeCargo: {
    id: "largeCargo",
    kind: "ship",
    requires: { shipyard: 4, combustion: 6 },
    cost_at: (l) => res(flat(6000)(l), flat(6000)(l), 0),
  },
  lightFighter: {
    id: "lightFighter",
    kind: "ship",
    requires: { shipyard: 1, combustion: 1 },
    cost_at: (l) => res(flat(3000)(l), flat(1000)(l), 0),
  },
  heavyFighter: {
    id: "heavyFighter",
    kind: "ship",
    requires: { shipyard: 3, armor: 2, impulseDrive: 2 },
    cost_at: (l) => res(flat(6000)(l), flat(4000)(l), 0),
  },
  cruiser: {
    id: "cruiser",
    kind: "ship",
    requires: { shipyard: 5, impulseDrive: 4, ionTech: 2 },
    cost_at: (l) => res(flat(20000)(l), flat(7000)(l), flat(2000)(l)),
  },
  battleship: {
    id: "battleship",
    kind: "ship",
    requires: { shipyard: 7, hyperspaceDrive: 4 },
    cost_at: (l) => res(flat(45000)(l), flat(15000)(l), 0),
  },
  battlecruiser: {
    id: "battlecruiser",
    kind: "ship",
    requires: { shipyard: 8, hyperspaceTech: 5, hyperspaceDrive: 5, laserTech: 12 },
    cost_at: (l) => res(flat(30000)(l), flat(40000)(l), flat(15000)(l)),
  },
  bomber: {
    id: "bomber",
    kind: "ship",
    requires: { shipyard: 8, impulseDrive: 6, plasmaTech: 5 },
    cost_at: (l) => res(flat(50000)(l), flat(25000)(l), flat(15000)(l)),
  },
  destroyer: {
    id: "destroyer",
    kind: "ship",
    requires: { shipyard: 9, hyperspaceDrive: 6, hyperspaceTech: 5 },
    cost_at: (l) => res(flat(60000)(l), flat(50000)(l), flat(15000)(l)),
  },
  deathstar: {
    id: "deathstar",
    kind: "ship",
    requires: { shipyard: 12, hyperspaceDrive: 7, hyperspaceTech: 6, gravitonTech: 1 },
    cost_at: (l) => res(flat(5000000)(l), flat(4000000)(l), flat(1000000)(l)),
  },
  reaper: {
    id: "reaper",
    kind: "ship",
    requires: { shipyard: 10, hyperspaceTech: 6, hyperspaceDrive: 7, shielding: 6 },
    cost_at: (l) => res(flat(85000)(l), flat(55000)(l), flat(20000)(l)),
  },
  pathfinder: {
    id: "pathfinder",
    kind: "ship",
    requires: { shipyard: 5, hyperspaceDrive: 2, shielding: 4 },
    cost_at: (l) => res(flat(8000)(l), flat(15000)(l), flat(8000)(l)),
  },
  colonyShip: {
    id: "colonyShip",
    kind: "ship",
    requires: { shipyard: 4, impulseDrive: 3 },
    cost_at: (l) => res(flat(10000)(l), flat(20000)(l), flat(10000)(l)),
  },
  recycler: {
    id: "recycler",
    kind: "ship",
    requires: { shipyard: 4, combustion: 6, impulseDrive: 17 },
    cost_at: (l) => res(flat(10000)(l), flat(6000)(l), flat(2000)(l)),
  },
  espionageProbe: {
    id: "espionageProbe",
    kind: "ship",
    requires: { shipyard: 3, combustion: 3, espionageTech: 2 },
    cost_at: (l) => res(0, flat(1000)(l), 0),
  },
  solarSatellite: {
    id: "solarSatellite",
    kind: "ship",
    requires: { shipyard: 1 },
    cost_at: (l) => res(0, flat(2000)(l), flat(500)(l)),
  },
  crawler: {
    id: "crawler",
    kind: "ship",
    requires: { shipyard: 5, combustion: 4, armor: 4, laserTech: 4 },
    cost_at: (l) => res(flat(2000)(l), flat(2000)(l), flat(1000)(l)),
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Defenses (10) — per-unit cost, level ignored
// ──────────────────────────────────────────────────────────────────────────────
const defenses: Record<string, TechEntry> = {
  rocketLauncher: {
    id: "rocketLauncher",
    kind: "defense",
    requires: { shipyard: 1 },
    cost_at: (l) => res(flat(2000)(l), 0, 0),
  },
  lightLaser: {
    id: "lightLaser",
    kind: "defense",
    requires: { shipyard: 2, energyTech: 1, laserTech: 3 },
    cost_at: (l) => res(flat(1500)(l), flat(500)(l), 0),
  },
  heavyLaser: {
    id: "heavyLaser",
    kind: "defense",
    requires: { shipyard: 4, energyTech: 3, laserTech: 6 },
    cost_at: (l) => res(flat(6000)(l), flat(2000)(l), 0),
  },
  gaussCannon: {
    id: "gaussCannon",
    kind: "defense",
    requires: { shipyard: 6, energyTech: 6, weapons: 3, shielding: 1 },
    cost_at: (l) => res(flat(20000)(l), flat(15000)(l), flat(2000)(l)),
  },
  ionCannon: {
    id: "ionCannon",
    kind: "defense",
    requires: { shipyard: 4, ionTech: 4 },
    cost_at: (l) => res(flat(5000)(l), flat(3000)(l), 0),
  },
  plasmaCannon: {
    id: "plasmaCannon",
    kind: "defense",
    requires: { shipyard: 8, plasmaTech: 7 },
    cost_at: (l) => res(flat(50000)(l), flat(50000)(l), flat(30000)(l)),
  },
  smallShield: {
    id: "smallShield",
    kind: "defense",
    requires: { shipyard: 1, shielding: 2 },
    cost_at: (l) => res(flat(10000)(l), flat(10000)(l), 0),
  },
  largeShield: {
    id: "largeShield",
    kind: "defense",
    requires: { shipyard: 6, shielding: 6 },
    cost_at: (l) => res(flat(50000)(l), flat(50000)(l), 0),
  },
  anti_ballistic: {
    id: "anti_ballistic",
    kind: "defense",
    requires: { shipyard: 1, missile_silo: 2 },
    cost_at: (l) => res(flat(8000)(l), 0, flat(2000)(l)),
  },
  interplanetary: {
    id: "interplanetary",
    kind: "defense",
    requires: { shipyard: 1, missile_silo: 4, impulseDrive: 1 },
    cost_at: (l) => res(flat(12500)(l), flat(2500)(l), flat(10000)(l)),
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Public exports
// ──────────────────────────────────────────────────────────────────────────────
export const TECH_TREE: Record<string, TechEntry> = {
  ...buildings,
  ...research,
  ...ships,
  ...defenses,
};

export function prerequisitesFor(techId: string): Record<string, number> {
  const entry = TECH_TREE[techId];
  if (!entry) throw new Error(`Unknown tech id: ${techId}`);
  return entry.requires;
}

export function costFor(techId: string, level: number): Resources {
  const entry = TECH_TREE[techId];
  if (!entry) throw new Error(`Unknown tech id: ${techId}`);
  return entry.cost_at(level);
}

/**
 * Number of simultaneous expedition slots available for a given astrophysics level.
 * Formula: floor(sqrt(astrophysicsLevel)).
 *   astro=1 → 1, 3 → 1, 4 → 2, 8 → 2, 9 → 3, 15 → 3, 16 → 4, 25 → 5.
 */
export function expeditionSlots(astrophysicsLevel: number): number {
  return Math.floor(Math.sqrt(astrophysicsLevel));
}
