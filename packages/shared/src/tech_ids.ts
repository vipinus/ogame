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
  // v0.0.452: moon-only buildings. operator 2026-05-29 rule "月球只剩
  // 一个空间的时候必须先造月球基地" — needs lunarBase tracking to
  // compute used / max fields. lunarBase=41, sensorPhalanx=42, jumpgate=43.
  lunarBase: 41,
  sensorPhalanx: 42,
  jumpgate: 43,
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

// ─── Lifeform buildings ──────────────────────────────────────────────────
// Verified 2026-05-21 via real ogame POST sniffer:
//   body= technologyId=11102&amount=1&mode=1&token=...
// Same /scheduleEntry endpoint as regular buildings — no special component.
// Humans series 111xx, Rocktal 121xx, Mechas 131xx, Kaelesh 141xx.
export const LIFEFORM_BUILDING_IDS = {
  // Humans 111xx (verified: biosphereFarm=11102 via sniffer 2026-05-21)
  residentialSector: 11101,
  biosphereFarm: 11102,        // ✓ verified
  researchCentre: 11103,
  academyOfSciences: 11104,
  neuroCalibrationCentre: 11105,
  highEnergySmelting: 11106,
  foodSilo: 11107,
  fusionPoweredProduction: 11108,
  skyscraper: 11109,
  biotechLab: 11110,
  metropolis: 11111,
  plantationOfMostBenevolentBeing: 11112,
  // Rocktal 121xx — IDs need sniffer verification before use.
  meditationEnclave: 12101,
  crystalFarm: 12102,
  runeTechnologium: 12103,
  runeForge: 12104,
  oriktorium: 12105,
  magmaForge: 12106,
  disruptionChamber: 12107,
  megalith: 12108,
  crystalRefinery: 12109,
  // Mechas 131xx — IDs need sniffer verification.
  assemblyLine: 13101,
  fusionCellFactory: 13102,
  roboticsResearchCentre: 13103,
  updateNetwork: 13104,
  quantumComputerCentre: 13105,
  automatisedAssemblyCentre: 13106,
  highPerformanceTransformer: 13107,
  microchipAssemblyLine: 13108,
  productionAssemblyHall: 13109,
  // Kaelesh 141xx — IDs need sniffer verification.
  sanctuary: 14101,
  antimatterCondenser: 14102,
  vortexChamber: 14103,
  hallsOfRealisation: 14104,
  forumOfTranscendence: 14105,
  antimatterConvector: 14106,
  cloningLaboratory: 14107,
  chrysalisAccelerator: 14108,
  bioModifier: 14109,
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
  ...LIFEFORM_BUILDING_IDS,
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
export function idKind(id: number): "building" | "research" | "ship" | "defense" | "lifeform_building" | "unknown" {
  if (id >= 1 && id <= 99) return "building";
  if (id >= 100 && id <= 199) return "research";
  if (id >= 200 && id <= 299) return "ship";
  if (id >= 400 && id <= 599) return "defense";
  // Lifeform: 111xx (humans), 121xx (rocktal), 131xx (mechas), 141xx (kaelesh).
  if (id >= 11000 && id <= 15000) return "lifeform_building";
  return "unknown";
}
