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
    display_name_zh: "水晶农场",
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
    display_name_zh: "符文锻造厂",
    display_name_en: "Rune Forge",
    requires: { runeTechnologium: 2 },
    cost_at: pow(40_000, 1.4),
    verified_against_live: false,
  },
  oriktorium: {
    id: "oriktorium",
    display_name_zh: "矿物精炼塔",
    display_name_en: "Oriktorium",
    requires: { crystalFarm: 1 },
    cost_at: pow(15_000, 1.3),
    verified_against_live: false,
  },
  magmaForge: {
    id: "magmaForge",
    display_name_zh: "岩浆熔炉",
    display_name_en: "Magma Forge",
    requires: { runeForge: 3 },
    cost_at: pow(60_000, 1.5),
    verified_against_live: false,
  },
  disruptionChamber: {
    id: "disruptionChamber",
    display_name_zh: "扰动腔室",
    display_name_en: "Disruption Chamber",
    requires: { runeTechnologium: 3 },
    cost_at: pow(75_000, 1.5),
    verified_against_live: false,
  },
  megalith: {
    id: "megalith",
    display_name_zh: "巨石阵",
    display_name_en: "Megalith",
    requires: { meditationEnclave: 5 },
    cost_at: pow(50_000, 1.4),
    verified_against_live: false,
  },
  crystalRefinery: {
    id: "crystalRefinery",
    display_name_zh: "水晶精炼",
    display_name_en: "Crystal Refinery",
    requires: { crystalFarm: 5 },
    cost_at: pow(80_000, 1.5),
    verified_against_live: false,
  },
  deuteriumSynthesiser: {
    id: "deuteriumSynthesiser",
    display_name_zh: "重氢合成器",
    display_name_en: "Deuterium Synthesiser",
    requires: { magmaForge: 3 },
    cost_at: powD(120_000, 1.5),
    verified_against_live: false,
  },
  mineralResearchCentre: {
    id: "mineralResearchCentre",
    display_name_zh: "矿物研究中心",
    display_name_en: "Mineral Research Centre",
    requires: { oriktorium: 5 },
    cost_at: pow(180_000, 1.5),
    verified_against_live: false,
  },
  advancedRecyclingPlant: {
    id: "advancedRecyclingPlant",
    display_name_zh: "高级回收厂",
    display_name_en: "Advanced Recycling Plant",
    requires: { mineralResearchCentre: 3 },
    cost_at: pow(250_000, 1.5),
    verified_against_live: false,
  },
};

const research: Record<string, LifeformResearchEntry> = {
  volcanicBatteries: {
    id: "volcanicBatteries",
    display_name_zh: "火山电池",
    display_name_en: "Volcanic Batteries",
    requires: { runeTechnologium: 1 },
    cost_at: pow(6_000, 2),
    verified_against_live: false,
  },
  acousticScanning: {
    id: "acousticScanning",
    display_name_zh: "声学扫描",
    display_name_en: "Acoustic Scanning",
    requires: { runeTechnologium: 1 },
    cost_at: pow(8_000, 2),
    verified_against_live: false,
  },
  highEnergyPyrolysis: {
    id: "highEnergyPyrolysis",
    display_name_zh: "高能热解",
    display_name_en: "High-Energy Pyrolysis",
    requires: { runeTechnologium: 1 },
    cost_at: pow(11_000, 2),
    verified_against_live: false,
  },
  nanoRepairBots: {
    id: "nanoRepairBots",
    display_name_zh: "纳米修复机器人",
    display_name_en: "Nano Repair Bots",
    requires: { runeTechnologium: 2 },
    cost_at: pow(20_000, 2),
    verified_against_live: false,
  },
  magmaPoweredProduction: {
    id: "magmaPoweredProduction",
    display_name_zh: "岩浆能源生产",
    display_name_en: "Magma Powered Production",
    requires: { runeTechnologium: 2 },
    cost_at: pow(15_000, 2),
    verified_against_live: false,
  },
  geothermalPowerPlants: {
    id: "geothermalPowerPlants",
    display_name_zh: "地热发电站",
    display_name_en: "Geothermal Power Plants",
    requires: { runeTechnologium: 2 },
    cost_at: pow(25_000, 2),
    verified_against_live: false,
  },
  depthSounding: {
    id: "depthSounding",
    display_name_zh: "深度探测",
    display_name_en: "Depth Sounding",
    requires: { runeTechnologium: 3 },
    cost_at: pow(50_000, 2),
    verified_against_live: false,
  },
  ionCrystalEnhancement: {
    id: "ionCrystalEnhancement",
    display_name_zh: "离子水晶增强",
    display_name_en: "Ion Crystal Enhancement",
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
    display_name_zh: "强化钻石钻头",
    display_name_en: "Hardened Diamond Drill Heads",
    requires: { runeTechnologium: 4 },
    cost_at: powD(100_000, 2),
    verified_against_live: false,
  },
  seismicMiningTechnology: {
    id: "seismicMiningTechnology",
    display_name_zh: "地震采矿技术",
    display_name_en: "Seismic Mining Technology",
    requires: { runeTechnologium: 5 },
    cost_at: powD(150_000, 2),
    verified_against_live: false,
  },
  magmaPropulsion: {
    id: "magmaPropulsion",
    display_name_zh: "岩浆推进器",
    display_name_en: "Magma Propulsion",
    requires: { runeTechnologium: 5 },
    cost_at: powD(200_000, 2),
    verified_against_live: false,
  },
};

export default {
  species: "rocktal",
  buildings,
  research,
} satisfies LifeformTechCatalog;
