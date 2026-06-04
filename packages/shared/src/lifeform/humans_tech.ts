// Humans (人类) Lifeform tech catalog — draft skeleton.
// Data source: OGame community wiki (ogame.fandom.com/wiki/Lifeforms) — web fetch blocked in env;
// shape & ID conventions follow community OGotcha-style naming (lf_humans_*).
// TODO: verify cost/prereqs against live ogame 2026 (M6 audit will reconcile).
import type { LifeformTechCatalog, LifeformBuildingEntry, LifeformResearchEntry } from "./types.js";
import type { Resources } from "../types.js";

// Generic exponential cost curve. base=metal-base-cost at level 1; k=growth factor.
const pow = (base: number, k: number) => (l: number): Resources => ({
  m: Math.floor(base * Math.pow(k, l - 1)),
  c: Math.floor(base * 0.5 * Math.pow(k, l - 1)),
  d: 0,
  e: 0,
});

// Cost curve with deuterium component (some advanced lifeform research uses deut).
const powD = (base: number, k: number) => (l: number): Resources => ({
  m: Math.floor(base * Math.pow(k, l - 1)),
  c: Math.floor(base * 0.5 * Math.pow(k, l - 1)),
  d: Math.floor(base * 0.25 * Math.pow(k, l - 1)),
  e: 0,
});

const buildings: Record<string, LifeformBuildingEntry> = {
  // -- core human buildings (community-named lf_humans_*) --
  residentialSector: {
    id: "residentialSector",
    display_name_zh: "居住區",
    display_name_en: "Residential Sector",
    requires: {},
    cost_at: pow(7, 1.2),
    verified_against_live: false,
  },
  biosphereFarm: {
    id: "biosphereFarm",
    display_name_zh: "生物圈農場",
    display_name_en: "Biosphere Farm",
    requires: {},
    cost_at: pow(5, 1.23),
    verified_against_live: false,
  },
  researchCentre: {
    id: "researchCentre",
    display_name_zh: "研究中心",
    display_name_en: "Research Centre",
    // Official prereq (gameforge PTS forum + community guides 2026-05-21):
    // residentialSector L21 + biosphereFarm L22. Without these ogame UI
    // marks status="off" + "所需條件不足".
    requires: { residentialSector: 21, biosphereFarm: 22 },
    cost_at: pow(20_000, 1.4),
    verified_against_live: true,
  },
  academyOfSciences: {
    id: "academyOfSciences",
    display_name_zh: "科學院",
    display_name_en: "Academy of Sciences",
    requires: { researchCentre: 5 },
    cost_at: pow(50_000, 1.5),
    verified_against_live: false,
  },
  neuroCalibrationCentre: {
    id: "neuroCalibrationCentre",
    display_name_zh: "神經校準中心",
    display_name_en: "Neuro-Calibration Centre",
    requires: { academyOfSciences: 3 },
    cost_at: pow(75_000, 1.5),
    verified_against_live: false,
  },
  highEnergySmelting: {
    id: "highEnergySmelting",
    display_name_zh: "高能熔煉廠",
    display_name_en: "High Energy Smelting",
    requires: { residentialSector: 5 },
    cost_at: pow(9_000, 1.3),
    verified_against_live: false,
  },
  foodSilo: {
    id: "foodSilo",
    display_name_zh: "食物倉庫",
    display_name_en: "Food Silo",
    requires: { biosphereFarm: 1 },
    cost_at: pow(4_000, 1.3),
    verified_against_live: false,
  },
  fusionPoweredProduction: {
    id: "fusionPoweredProduction",
    display_name_zh: "聚變能源生產",
    display_name_en: "Fusion-Powered Production",
    requires: { highEnergySmelting: 5 },
    cost_at: pow(50_000, 1.4),
    verified_against_live: false,
  },
  skyscraper: {
    id: "skyscraper",
    display_name_zh: "摩天大樓",
    display_name_en: "Skyscraper",
    requires: { residentialSector: 5 },
    cost_at: pow(75_000, 1.4),
    verified_against_live: false,
  },
  biotechLab: {
    id: "biotechLab",
    display_name_zh: "生物科技實驗室",
    display_name_en: "Biotech Lab",
    requires: { researchCentre: 3 },
    cost_at: pow(150_000, 1.5),
    verified_against_live: false,
  },
  metropolis: {
    id: "metropolis",
    display_name_zh: "大都會",
    display_name_en: "Metropolis",
    requires: { skyscraper: 5 },
    cost_at: pow(80_000, 1.5),
    verified_against_live: false,
  },
  plantationOfMostBenevolentBeing: {
    id: "plantationOfMostBenevolentBeing",
    display_name_zh: "至善種植園",
    display_name_en: "Plantation of the Most Benevolent Being",
    // v0.0.742 — operator "其他种族一样的依赖关系". Final-tier mirror of
    // kaelesh supraRefractor pattern: 4 tier-2 buildings at L5.
    requires: { fusionPoweredProduction: 5, neuroCalibrationCentre: 5, biotechLab: 5, metropolis: 5 },
    cost_at: pow(250_000, 1.5),
    verified_against_live: false,
  },
};

// v0.0.666 — operator 2026-06-02 "catalog 走自己造的 key 把这个改成
// 标准 key": rewritten with canonical keys matching tech_ids.ts
// 11201-11218. Previous catalog used non-canonical names (fuelHaulers,
// rareMetalRefiners, geneticResearch, etc.) that DOM scraper's reverse
// lookup never produced. display_name_zh handcrafted; runtime
// pickLfName prefers techLabels[k] (ogame DOM ground truth) anyway.
const research: Record<string, LifeformResearchEntry> = {
  intergalacticEnvoys: {
    id: "intergalacticEnvoys",
    display_name_zh: "星際特使",
    display_name_en: "Intergalactic Envoys",
    requires: { academyOfSciences: 1 },
    cost_at: pow(5_000, 2),
    verified_against_live: false,
  },
  highPerformanceExtractors: {
    id: "highPerformanceExtractors",
    display_name_zh: "高性能採掘機",
    display_name_en: "High-Performance Extractors",
    requires: { academyOfSciences: 1 },
    cost_at: pow(7_000, 2),
    verified_against_live: false,
  },
  fusionDrives: {
    id: "fusionDrives",
    display_name_zh: "核融合引擎",
    display_name_en: "Fusion Drives",
    requires: { academyOfSciences: 1 },
    cost_at: pow(10_000, 2),
    verified_against_live: false,
  },
  stealthFieldGenerator: {
    id: "stealthFieldGenerator",
    display_name_zh: "隱形場發生器",
    display_name_en: "Stealth Field Generator",
    requires: { academyOfSciences: 1 },
    cost_at: pow(8_500, 2),
    verified_against_live: false,
  },
  orbitalDen: {
    id: "orbitalDen",
    display_name_zh: "軌道窩點",
    display_name_en: "Orbital Den",
    requires: { academyOfSciences: 2 },
    cost_at: pow(20_000, 2),
    verified_against_live: false,
  },
  researchAI: {
    id: "researchAI",
    display_name_zh: "研究 AI",
    display_name_en: "Research AI",
    requires: { academyOfSciences: 2 },
    cost_at: pow(15_000, 2),
    verified_against_live: false,
  },
  highPerformanceTerraformer: {
    id: "highPerformanceTerraformer",
    display_name_zh: "高性能地形改造",
    display_name_en: "High-Performance Terraformer",
    requires: { academyOfSciences: 3 },
    cost_at: pow(25_000, 2),
    verified_against_live: false,
  },
  enhancedProductionTechnologies: {
    id: "enhancedProductionTechnologies",
    display_name_zh: "增強生產技術",
    display_name_en: "Enhanced Production Technologies",
    requires: { academyOfSciences: 3 },
    cost_at: pow(50_000, 2),
    verified_against_live: false,
  },
  lightFighterMkII: {
    id: "lightFighterMkII",
    display_name_zh: "輕型戰鬥機 Mk II",
    display_name_en: "Light Fighter Mk II",
    requires: { academyOfSciences: 4 },
    cost_at: powD(75_000, 2),
    verified_against_live: false,
  },
  cruiserMkII: {
    id: "cruiserMkII",
    display_name_zh: "巡洋艦 Mk II",
    display_name_en: "Cruiser Mk II",
    requires: { academyOfSciences: 4 },
    cost_at: powD(100_000, 2),
    verified_against_live: false,
  },
  improvedLabTechnology: {
    id: "improvedLabTechnology",
    display_name_zh: "改良實驗室技術",
    display_name_en: "Improved Lab Technology",
    requires: { academyOfSciences: 5 },
    cost_at: powD(150_000, 2),
    verified_against_live: false,
  },
  plasmaTerraformer: {
    id: "plasmaTerraformer",
    display_name_zh: "電漿地形改造",
    display_name_en: "Plasma Terraformer",
    requires: { academyOfSciences: 5 },
    cost_at: powD(200_000, 2),
    verified_against_live: false,
  },
  lowTemperatureDrives: {
    id: "lowTemperatureDrives",
    display_name_zh: "低溫引擎",
    display_name_en: "Low Temperature Drives",
    requires: { academyOfSciences: 5 },
    cost_at: powD(250_000, 2),
    verified_against_live: false,
  },
  bomberMkII: {
    id: "bomberMkII",
    display_name_zh: "導彈艦 Mk II",
    display_name_en: "Bomber Mk II",
    requires: { academyOfSciences: 6 },
    cost_at: powD(300_000, 2),
    verified_against_live: false,
  },
  destroyerMkII: {
    id: "destroyerMkII",
    display_name_zh: "毀滅者 Mk II",
    display_name_en: "Destroyer Mk II",
    requires: { academyOfSciences: 6 },
    cost_at: powD(350_000, 2),
    verified_against_live: false,
  },
  battlecruiserMkII: {
    id: "battlecruiserMkII",
    display_name_zh: "戰鬥巡洋艦 Mk II",
    display_name_en: "Battlecruiser Mk II",
    requires: { academyOfSciences: 6 },
    cost_at: powD(400_000, 2),
    verified_against_live: false,
  },
  robotAssistants: {
    id: "robotAssistants",
    display_name_zh: "機器人助手",
    display_name_en: "Robot Assistants",
    requires: { academyOfSciences: 7 },
    cost_at: powD(500_000, 2),
    verified_against_live: false,
  },
  supercomputer: {
    id: "supercomputer",
    display_name_zh: "超級計算機",
    display_name_en: "Supercomputer",
    requires: { academyOfSciences: 7 },
    cost_at: powD(600_000, 2),
    verified_against_live: false,
  },
};

export default {
  species: "humans",
  buildings,
  research,
} satisfies LifeformTechCatalog;
