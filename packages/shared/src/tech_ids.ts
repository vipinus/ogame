/**
 * Single source of truth for ogame v12 technology numeric IDs.
 *
 * Architecture rule (per operator decision 2026-05-21):
 *   - Internal API/comparison/storage uses NUMERIC ID (stable, unique, i18n-immune)
 *   - External display/logs uses NAME (human-readable, locale-aware)
 *   - This file is the boundary translator.
 *
 * Numeric IDs are ogame's own protocol IDs (sent in POST scheduleEntry as
 * technologyId=N, returned in fetchResources techs map, etc). They never
 * change. The canonical name strings here match TECH_TREE keys.
 */

// ─── Buildings (planet) ───────────────────────────────────────────────────
export const BUILDING_IDS = {
  metalMine: 1,
  crystalMine: 2,
  deuteriumSynth: 3,
  solarPlant: 4,
  fusionReactor: 12,
  roboticsFactory: 14,
  naniteFactory: 15,
  shipyard: 21,
  metalStorage: 22,
  crystalStorage: 23,
  deuteriumTank: 24,
  researchLab: 31,
  allianceDepot: 34,
  missileSilo: 44,
} as const;

// ─── Research (player-global) ─────────────────────────────────────────────
export const RESEARCH_IDS = {
  espionageTech: 106,
  computerTech: 108,
  weapons: 109,
  shielding: 110,
  armor: 111,
  energyTech: 113,
  hyperspaceTech: 114,
  combustion: 115,
  impulseDrive: 117,
  hyperspaceDrive: 118,
  laserTech: 120,
  ionTech: 121,
  plasmaTech: 122,
  intergalactic: 123,
  astrophysics: 124,
  gravitonTech: 199,
} as const;

// ─── Ships ────────────────────────────────────────────────────────────────
export const SHIP_IDS_BY_NAME = {
  smallCargo: 202, largeCargo: 203, lightFighter: 204, heavyFighter: 205,
  cruiser: 206, battleship: 207, colonyShip: 208, recycler: 209,
  espionageProbe: 210, bomber: 211, solarSatellite: 212, destroyer: 213,
  deathstar: 214, battlecruiser: 215, crawler: 217, reaper: 218, explorer: 219,
} as const;

// ─── Defenses ─────────────────────────────────────────────────────────────
export const DEFENSE_IDS = {
  rocketLauncher: 401,
  lightLaser: 402,
  heavyLaser: 403,
  gaussCannon: 404,
  ionCannon: 405,
  plasmaTurret: 406,
  smallShieldDome: 407,
  largeShieldDome: 408,
  antiBallisticMissile: 502,
  interplanetaryMissile: 503,
} as const;

// ─── Unified registry ─────────────────────────────────────────────────────
export const TECH_ID_BY_NAME: Record<string, number> = {
  ...BUILDING_IDS,
  ...RESEARCH_IDS,
  ...SHIP_IDS_BY_NAME,
  ...DEFENSE_IDS,
};

/** Reverse map: numeric id → canonical name. */
export const TECH_NAME_BY_ID: Record<number, string> = Object.fromEntries(
  Object.entries(TECH_ID_BY_NAME).map(([name, id]) => [id, name]),
);

/** Convert any name (canonical or known alias) to numeric ID, or undefined. */
export function nameToId(name: string): number | undefined {
  return TECH_ID_BY_NAME[name];
}

/** Convert numeric ID to canonical name, or undefined. */
export function idToName(id: number): string | undefined {
  return TECH_NAME_BY_ID[id];
}

/** Kind classification by ID range — useful for routing logic. */
export function idKind(id: number): "building" | "research" | "ship" | "defense" | "unknown" {
  if (id >= 1 && id <= 99) return "building";
  if (id >= 100 && id <= 199) return "research";
  if (id >= 200 && id <= 299) return "ship";
  if (id >= 400 && id <= 599) return "defense";
  return "unknown";
}
