// Rocktal (岩族) Lifeform tech catalog — draft skeleton.
// Data source: OGame community wiki (ogame.fandom.com/wiki/Lifeforms#Rocktal) — web fetch blocked in env;
// shape & ID conventions follow community OGotcha-style naming (lf_rocktal_*).
// TODO: verify cost/prereqs against live ogame 2026 (M6 audit will reconcile).
import type { LifeformTechCatalog, LifeformBuildingEntry, LifeformResearchEntry } from "./types.js";
import type { Resources } from "../types.js";

const pow = (base: number, k: number) => (l: number): Resources => ({
  m: Math.floor(base * Math.pow(k, l - 1)),
  c: Math.floor(base * 0.5 * Math.pow(k, l - 1)),
  d: 0,
  e: 0,
});
const powD = (base: number, k: number) => (l: number): Resources => ({
  m: Math.floor(base * Math.pow(k, l - 1)),
  c: Math.floor(base * 0.5 * Math.pow(k, l - 1)),
  d: Math.floor(base * 0.25 * Math.pow(k, l - 1)),
  e: 0,
});

const buildings: Record<string, LifeformBuildingEntry> = {
  meditationEnclave: {
    id: "meditationEnclave",
    display_name_zh: "冥想殿堂",
    display_name_en: "Meditation Enclave",
    requires: {},
    cost_at: pow(9, 1.2),
    verified_against_live: false,
  },
  crystalFarm: {
    id: "crystalFarm",
    display_name_zh: "水晶農場",
    display_name_en: "Crystal Farm",
    requires: {},
    cost_at: pow(6, 1.23),
    verified_against_live: false,
  },
  runeTechnologium: {
    id: "runeTechnologium",
    display_name_zh: "符文科技院",
    display_name_en: "Rune Technologium",
    requires: { meditationEnclave: 1 },
    cost_at: pow(25_000, 1.4),
    verified_against_live: false,
  },
  runeForge: {
    id: "runeForge",
    display_name_zh: "符文鍛造廠",
    display_name_en: "Rune Forge",
    requires: { runeTechnologium: 2 },
    cost_at: pow(40_000, 1.4),
    verified_against_live: false,
  },
  oriktorium: {
    id: "oriktorium",
    display_name_zh: "礦物精煉塔",
    display_name_en: "Oriktorium",
    requires: { crystalFarm: 1 },
    cost_at: pow(15_000, 1.3),
    verified_against_live: false,
  },
  magmaForge: {
    id: "magmaForge",
    display_name_zh: "巖漿熔爐",
    display_name_en: "Magma Forge",
    requires: { runeForge: 3 },
    cost_at: pow(60_000, 1.5),
    verified_against_live: false,
  },
  disruptionChamber: {
    id: "disruptionChamber",
    display_name_zh: "擾動腔室",
    display_name_en: "Disruption Chamber",
    requires: { runeTechnologium: 3 },
    cost_at: pow(75_000, 1.5),
    verified_against_live: false,
  },
  megalith: {
    id: "megalith",
    display_name_zh: "巨石陣",
    display_name_en: "Megalith",
    requires: { meditationEnclave: 5 },
    cost_at: pow(50_000, 1.4),
    verified_against_live: false,
  },
  crystalRefinery: {
    id: "crystalRefinery",
    display_name_zh: "水晶精煉",
    display_name_en: "Crystal Refinery",
    requires: { crystalFarm: 5 },
    cost_at: pow(80_000, 1.5),
    verified_against_live: false,
  },
  deuteriumSynthesiser: {
    id: "deuteriumSynthesiser",
    display_name_zh: "重氫合成器",
    display_name_en: "Deuterium Synthesiser",
    requires: { magmaForge: 3 },
    cost_at: powD(120_000, 1.5),
    verified_against_live: false,
  },
  mineralResearchCentre: {
    id: "mineralResearchCentre",
    display_name_zh: "礦物研究中心",
    display_name_en: "Mineral Research Centre",
    requires: { oriktorium: 5 },
    cost_at: pow(180_000, 1.5),
    verified_against_live: false,
  },
  advancedRecyclingPlant: {
    id: "advancedRecyclingPlant",
    display_name_zh: "高級回收廠",
    display_name_en: "Advanced Recycling Plant",
    // v0.0.742 — operator "其他种族一样的依赖关系". Final-tier mirror of
    // kaelesh supraRefractor pattern: 4 tier-2 buildings at L5.
    requires: { deuteriumSynthesiser: 5, crystalRefinery: 5, mineralResearchCentre: 5, megalith: 5 },
    cost_at: pow(250_000, 1.5),
    verified_against_live: false,
  },
};

// v0.0.666 — canonical keys per tech_ids.ts 12201-12218. Old non-
// canonical entries (highEnergyPyrolysis / nanoRepairBots / etc.)
// produced no DOM scrape hits, so panel always showed scraped TC.
const research: Record<string, LifeformResearchEntry> = {
  volcanicBatteries: {
    id: "volcanicBatteries",
    display_name_zh: "火山電池",
    display_name_en: "Volcanic Batteries",
    requires: { runeTechnologium: 1 },
    cost_at: pow(6_000, 2),
    verified_against_live: false,
  },
  acousticScanning: {
    id: "acousticScanning",
    display_name_zh: "聲學掃描",
    display_name_en: "Acoustic Scanning",
    requires: { runeTechnologium: 1 },
    cost_at: pow(8_000, 2),
    verified_against_live: false,
  },
  highEnergyPumpSystems: {
    id: "highEnergyPumpSystems",
    display_name_zh: "高能泵浦系統",
    display_name_en: "High-Energy Pump Systems",
    requires: { runeTechnologium: 1 },
    cost_at: pow(11_000, 2),
    verified_against_live: false,
  },
  cargoHoldExpansionCivilianShips: {
    id: "cargoHoldExpansionCivilianShips",
    display_name_zh: "民用艦貨艙擴展",
    display_name_en: "Cargo Hold Expansion — Civilian Ships",
    requires: { runeTechnologium: 2 },
    cost_at: pow(20_000, 2),
    verified_against_live: false,
  },
  magmaPoweredProduction: {
    id: "magmaPoweredProduction",
    display_name_zh: "巖漿能源生產",
    display_name_en: "Magma Powered Production",
    requires: { runeTechnologium: 2 },
    cost_at: pow(15_000, 2),
    verified_against_live: false,
  },
  geothermalPowerPlants: {
    id: "geothermalPowerPlants",
    display_name_zh: "地熱發電站",
    display_name_en: "Geothermal Power Plants",
    requires: { runeTechnologium: 2 },
    cost_at: pow(25_000, 2),
    verified_against_live: false,
  },
  depthSounding: {
    id: "depthSounding",
    display_name_zh: "深度探測",
    display_name_en: "Depth Sounding",
    requires: { runeTechnologium: 3 },
    cost_at: pow(50_000, 2),
    verified_against_live: false,
  },
  ionCrystalEnhancementHeavyFighter: {
    id: "ionCrystalEnhancementHeavyFighter",
    display_name_zh: "離子水晶強化（重型戰鬥機）",
    display_name_en: "Ion Crystal Enhancement — Heavy Fighter",
    requires: { runeTechnologium: 3 },
    cost_at: pow(40_000, 2),
    verified_against_live: false,
  },
  improvedStellarator: {
    id: "improvedStellarator",
    display_name_zh: "改良仿星器",
    display_name_en: "Improved Stellarator",
    requires: { runeTechnologium: 4 },
    cost_at: powD(80_000, 2),
    verified_against_live: false,
  },
  hardenedDiamondDrillHeads: {
    id: "hardenedDiamondDrillHeads",
    display_name_zh: "強化鑽石鑽頭",
    display_name_en: "Hardened Diamond Drill Heads",
    requires: { runeTechnologium: 4 },
    cost_at: powD(100_000, 2),
    verified_against_live: false,
  },
  seismicMiningTechnology: {
    id: "seismicMiningTechnology",
    display_name_zh: "地震採礦技術",
    display_name_en: "Seismic Mining Technology",
    requires: { runeTechnologium: 5 },
    cost_at: powD(150_000, 2),
    verified_against_live: false,
  },
  magmaPoweredPumpSystems: {
    id: "magmaPoweredPumpSystems",
    display_name_zh: "巖漿能源泵浦系統",
    display_name_en: "Magma Powered Pump Systems",
    requires: { runeTechnologium: 5 },
    cost_at: powD(200_000, 2),
    verified_against_live: false,
  },
  ionCrystalModules: {
    id: "ionCrystalModules",
    display_name_zh: "離子水晶模組",
    display_name_en: "Ion Crystal Modules",
    requires: { runeTechnologium: 5 },
    cost_at: powD(220_000, 2),
    verified_against_live: false,
  },
  optimisedSiloConstructionMethod: {
    id: "optimisedSiloConstructionMethod",
    display_name_zh: "最佳化發射井建造法",
    display_name_en: "Optimised Silo Construction Method",
    requires: { runeTechnologium: 6 },
    cost_at: powD(260_000, 2),
    verified_against_live: false,
  },
  diamondEnergyTransmitter: {
    id: "diamondEnergyTransmitter",
    display_name_zh: "鑽石能量傳輸器",
    display_name_en: "Diamond Energy Transmitter",
    requires: { runeTechnologium: 6 },
    cost_at: powD(300_000, 2),
    verified_against_live: false,
  },
  obsidianShieldReinforcement: {
    id: "obsidianShieldReinforcement",
    display_name_zh: "黑曜石護盾強化",
    display_name_en: "Obsidian Shield Reinforcement",
    requires: { runeTechnologium: 6 },
    cost_at: powD(350_000, 2),
    verified_against_live: false,
  },
  runeShields: {
    id: "runeShields",
    display_name_zh: "符文護盾",
    display_name_en: "Rune Shields",
    requires: { runeTechnologium: 7 },
    cost_at: powD(500_000, 2),
    verified_against_live: false,
  },
  rocktalCollectorEnhancement: {
    id: "rocktalCollectorEnhancement",
    display_name_zh: "巖族採集者強化",
    display_name_en: "Rocktal Collector Enhancement",
    requires: { runeTechnologium: 7 },
    cost_at: powD(600_000, 2),
    verified_against_live: false,
  },
};

export default {
  species: "rocktal",
  buildings,
  research,
} satisfies LifeformTechCatalog;
