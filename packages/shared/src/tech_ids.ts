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

// v0.0.609 — Lifeform research IDs sourced from alaingilbert/ogame
// (https://github.com/alaingilbert/ogame/blob/master/pkg/ogame/constants.go),
// the canonical OGame protocol library — battle-tested against live ogame
// servers. 18 research per species × 4 species = 72 entries.
// Operator 2026-06-01 "别猜了, 不懂要去看官方文档".
export const LIFEFORM_RESEARCH_IDS = {
  // Humans 11201-11218
  intergalacticEnvoys: 11201,
  highPerformanceExtractors: 11202,
  fusionDrives: 11203,
  stealthFieldGenerator: 11204,
  orbitalDen: 11205,
  researchAI: 11206,
  highPerformanceTerraformer: 11207,
  enhancedProductionTechnologies: 11208,
  lightFighterMkII: 11209,
  cruiserMkII: 11210,
  improvedLabTechnology: 11211,
  plasmaTerraformer: 11212,
  lowTemperatureDrives: 11213,
  bomberMkII: 11214,
  destroyerMkII: 11215,
  battlecruiserMkII: 11216,
  robotAssistants: 11217,
  supercomputer: 11218,
  // Rocktal 12201-12218
  volcanicBatteries: 12201,
  acousticScanning: 12202,
  highEnergyPumpSystems: 12203,
  cargoHoldExpansionCivilianShips: 12204,
  magmaPoweredProduction: 12205,
  geothermalPowerPlants: 12206,
  depthSounding: 12207,
  ionCrystalEnhancementHeavyFighter: 12208,
  improvedStellarator: 12209,
  hardenedDiamondDrillHeads: 12210,
  seismicMiningTechnology: 12211,
  magmaPoweredPumpSystems: 12212,
  ionCrystalModules: 12213,
  optimisedSiloConstructionMethod: 12214,
  diamondEnergyTransmitter: 12215,
  obsidianShieldReinforcement: 12216,
  runeShields: 12217,
  rocktalCollectorEnhancement: 12218,
  // Mechas 13201-13218
  catalyserTechnology: 13201,
  plasmaDrive: 13202,
  efficiencyModule: 13203,
  depotAI: 13204,
  generalOverhaulLightFighter: 13205,
  automatedTransportLines: 13206,
  improvedDroneAI: 13207,
  experimentalRecyclingTechnology: 13208,
  generalOverhaulCruiser: 13209,
  slingshotAutopilot: 13210,
  highTemperatureSuperconductors: 13211,
  generalOverhaulBattleship: 13212,
  artificialSwarmIntelligence: 13213,
  generalOverhaulBattlecruiser: 13214,
  generalOverhaulBomber: 13215,
  generalOverhaulDestroyer: 13216,
  experimentalWeaponsTechnology: 13217,
  mechanGeneralEnhancement: 13218,
  // Kaelesh 14201-14218
  heatRecovery: 14201,
  sulphideProcess: 14202,
  psionicNetwork: 14203,
  telekineticTractorBeam: 14204,
  enhancedSensorTechnology: 14205,
  neuromodalCompressor: 14206,
  neuroInterface: 14207,
  interplanetaryAnalysisNetwork: 14208,
  overclockingHeavyFighter: 14209,
  telekineticDrive: 14210,
  sixthSense: 14211,
  psychoharmoniser: 14212,
  efficientSwarmIntelligence: 14213,
  overclockingLargeCargo: 14214,
  gravitationSensors: 14215,
  overclockingBattleship: 14216,
  psionicShieldMatrix: 14217,
  kaeleshDiscovererEnhancement: 14218,
} as const;

// ─── Unified registry ─────────────────────────────────────────────────────
export const TECH_ID_BY_NAME: Record<string, number> = {
  ...BUILDING_IDS,
  ...RESEARCH_IDS,
  ...SHIP_IDS_BY_NAME,
  ...DEFENSE_IDS,
  ...LIFEFORM_BUILDING_IDS,
  ...LIFEFORM_RESEARCH_IDS,
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
export function idKind(id: number): "building" | "research" | "ship" | "defense" | "lifeform_building" | "lifeform_research" | "unknown" {
  if (id >= 1 && id <= 99) return "building";
  if (id >= 100 && id <= 199) return "research";
  if (id >= 200 && id <= 299) return "ship";
  if (id >= 400 && id <= 599) return "defense";
  // v0.0.609 — lifeform building/research range split (verified via
  // alaingilbert/ogame): xxx01-xxx99 building, xxx201-xxx218 research.
  // 11xxx humans / 12xxx rocktal / 13xxx mechas / 14xxx kaelesh.
  const tens = id % 1000;
  if (id >= 11000 && id < 15000) {
    if (tens >= 200 && tens < 300) return "lifeform_research";
    return "lifeform_building";
  }
  return "unknown";
}
