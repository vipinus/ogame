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
    display_name_zh: "居住区",
    display_name_en: "Residential Sector",
    requires: {},
    cost_at: pow(7, 1.2),
    verified_against_live: false,
  },
  biosphereFarm: {
    id: "biosphereFarm",
    display_name_zh: "生物圈农场",
    display_name_en: "Biosphere Farm",
    requires: {},
    cost_at: pow(5, 1.23),
    verified_against_live: false,
  },
  researchCentre: {
    id: "researchCentre",
    display_name_zh: "研究中心",
    display_name_en: "Research Centre",
    requires: { residentialSector: 1 },
    cost_at: pow(20_000, 1.4),
    verified_against_live: false,
  },
  academyOfSciences: {
    id: "academyOfSciences",
    display_name_zh: "科学院",
    display_name_en: "Academy of Sciences",
    requires: { researchCentre: 5 },
    cost_at: pow(50_000, 1.5),
    verified_against_live: false,
  },
  neuroCalibrationCentre: {
    id: "neuroCalibrationCentre",
    display_name_zh: "神经校准中心",
    display_name_en: "Neuro-Calibration Centre",
    requires: { academyOfSciences: 3 },
    cost_at: pow(75_000, 1.5),
    verified_against_live: false,
  },
  highEnergySmelting: {
    id: "highEnergySmelting",
    display_name_zh: "高能熔炼厂",
    display_name_en: "High Energy Smelting",
    requires: { residentialSector: 5 },
    cost_at: pow(9_000, 1.3),
    verified_against_live: false,
  },
  foodSilo: {
    id: "foodSilo",
    display_name_zh: "食物仓库",
    display_name_en: "Food Silo",
    requires: { biosphereFarm: 1 },
    cost_at: pow(4_000, 1.3),
    verified_against_live: false,
  },
  fusionPoweredProduction: {
    id: "fusionPoweredProduction",
    display_name_zh: "聚变能源生产",
    display_name_en: "Fusion-Powered Production",
    requires: { highEnergySmelting: 5 },
    cost_at: pow(50_000, 1.4),
    verified_against_live: false,
  },
  skyscraper: {
    id: "skyscraper",
    display_name_zh: "摩天大楼",
    display_name_en: "Skyscraper",
    requires: { residentialSector: 5 },
    cost_at: pow(75_000, 1.4),
    verified_against_live: false,
  },
  biotechLab: {
    id: "biotechLab",
    display_name_zh: "生物科技实验室",
    display_name_en: "Biotech Lab",
    requires: { researchCentre: 3 },
    cost_at: pow(150_000, 1.5),
    verified_against_live: false,
  },
  metropolis: {
    id: "metropolis",
    display_name_zh: "大都会",
    display_name_en: "Metropolis",
    requires: { skyscraper: 5 },
    cost_at: pow(80_000, 1.5),
    verified_against_live: false,
  },
  plantationOfMostBenevolentBeing: {
    id: "plantationOfMostBenevolentBeing",
    display_name_zh: "至善种植园",
    display_name_en: "Plantation of the Most Benevolent Being",
    requires: { foodSilo: 5 },
    cost_at: pow(250_000, 1.5),
    verified_against_live: false,
  },
};

const research: Record<string, LifeformResearchEntry> = {
  intergalacticEnvoys: {
    id: "intergalacticEnvoys",
    display_name_zh: "星际特使",
    display_name_en: "Intergalactic Envoys",
    requires: { academyOfSciences: 1 },
    cost_at: pow(5_000, 2),
    verified_against_live: false,
  },
  highPerformanceExtractors: {
    id: "highPerformanceExtractors",
    display_name_zh: "高性能采掘机",
    display_name_en: "High-Performance Extractors",
    requires: { academyOfSciences: 1 },
    cost_at: pow(7_000, 2),
    verified_against_live: false,
  },
  fuelHaulers: {
    id: "fuelHaulers",
    display_name_zh: "燃料运输机",
    display_name_en: "Fuel Haulers",
    requires: { academyOfSciences: 1 },
    cost_at: pow(10_000, 2),
    verified_against_live: false,
  },
  rareMetalRefiners: {
    id: "rareMetalRefiners",
    display_name_zh: "稀有金属精炼",
    display_name_en: "Rare-Metal Refiners",
    requires: { academyOfSciences: 1 },
    cost_at: pow(8_500, 2),
    verified_against_live: false,
  },
  geneticResearch: {
    id: "geneticResearch",
    display_name_zh: "基因研究",
    display_name_en: "Genetic Research",
    requires: { academyOfSciences: 2 },
    cost_at: pow(20_000, 2),
    verified_against_live: false,
  },
  enhancedProductionTechnologies: {
    id: "enhancedProductionTechnologies",
    display_name_zh: "增强生产技术",
    display_name_en: "Enhanced Production Technologies",
    requires: { academyOfSciences: 2 },
    cost_at: pow(15_000, 2),
    verified_against_live: false,
  },
  networkOfTheLargeScaleBrain: {
    id: "networkOfTheLargeScaleBrain",
    display_name_zh: "大规模思维网络",
    display_name_en: "Network of the Large-Scale Brain",
    requires: { academyOfSciences: 3 },
    cost_at: pow(25_000, 2),
    verified_against_live: false,
  },
  projectColonisation: {
    id: "projectColonisation",
    display_name_zh: "殖民计划",
    display_name_en: "Project Colonisation",
    requires: { academyOfSciences: 3 },
    cost_at: pow(50_000, 2),
    verified_against_live: false,
  },
  researchAi: {
    id: "researchAi",
    display_name_zh: "研究 AI",
    display_name_en: "Research AI",
    requires: { academyOfSciences: 4 },
    cost_at: powD(75_000, 2),
    verified_against_live: false,
  },
  highPerformanceTerraformer: {
    id: "highPerformanceTerraformer",
    display_name_zh: "高性能地形改造",
    display_name_en: "High-Performance Terraformer",
    requires: { academyOfSciences: 4 },
    cost_at: powD(100_000, 2),
    verified_against_live: false,
  },
  enhancedProductiveTechnologiesUpgrade: {
    id: "enhancedProductiveTechnologiesUpgrade",
    display_name_zh: "增强生产技术升级",
    display_name_en: "Enhanced Productive Technologies Upgrade",
    requires: { academyOfSciences: 5 },
    cost_at: powD(150_000, 2),
    verified_against_live: false,
  },
  experimentalRecyclingTech: {
    id: "experimentalRecyclingTech",
    display_name_zh: "实验性回收技术",
    display_name_en: "Experimental Recycling Technology",
    requires: { academyOfSciences: 5 },
    cost_at: powD(200_000, 2),
    verified_against_live: false,
  },
};

export default {
  species: "humans",
  buildings,
  research,
} satisfies LifeformTechCatalog;
