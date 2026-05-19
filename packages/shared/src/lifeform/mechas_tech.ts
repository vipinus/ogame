// Mechas (机械族) Lifeform tech catalog — draft skeleton.
// Data source: OGame community wiki (ogame.fandom.com/wiki/Lifeforms#Mechas) — web fetch blocked in env;
// shape & ID conventions follow community OGotcha-style naming (lf_mechas_*).
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
  assemblyLine: {
    id: "assemblyLine",
    display_name_zh: "装配线",
    display_name_en: "Assembly Line",
    requires: {},
    cost_at: pow(8, 1.2),
    verified_against_live: false,
  },
  fusionCellFactory: {
    id: "fusionCellFactory",
    display_name_zh: "聚变电池工厂",
    display_name_en: "Fusion-Cell Factory",
    requires: { assemblyLine: 1 },
    cost_at: pow(7, 1.23),
    verified_against_live: false,
  },
  roboticsResearchCentre: {
    id: "roboticsResearchCentre",
    display_name_zh: "机器人研究中心",
    display_name_en: "Robotics Research Centre",
    requires: { assemblyLine: 1 },
    cost_at: pow(22_000, 1.4),
    verified_against_live: false,
  },
  updateNetwork: {
    id: "updateNetwork",
    display_name_zh: "更新网络",
    display_name_en: "Update Network",
    requires: { roboticsResearchCentre: 2 },
    cost_at: pow(35_000, 1.4),
    verified_against_live: false,
  },
  quantumComputerCentre: {
    id: "quantumComputerCentre",
    display_name_zh: "量子计算中心",
    display_name_en: "Quantum Computer Centre",
    requires: { roboticsResearchCentre: 3 },
    cost_at: pow(50_000, 1.5),
    verified_against_live: false,
  },
  automatisedAssemblyCentre: {
    id: "automatisedAssemblyCentre",
    display_name_zh: "自动化装配中心",
    display_name_en: "Automatised Assembly Centre",
    requires: { assemblyLine: 5 },
    cost_at: pow(60_000, 1.5),
    verified_against_live: false,
  },
  highPerformanceTransformer: {
    id: "highPerformanceTransformer",
    display_name_zh: "高性能变压器",
    display_name_en: "High-Performance Transformer",
    requires: { fusionCellFactory: 3 },
    cost_at: pow(40_000, 1.4),
    verified_against_live: false,
  },
  microchipAssemblyLine: {
    id: "microchipAssemblyLine",
    display_name_zh: "微芯片装配线",
    display_name_en: "Microchip Assembly Line",
    requires: { assemblyLine: 5, roboticsResearchCentre: 2 },
    cost_at: pow(75_000, 1.5),
    verified_against_live: false,
  },
  productionAssemblyHall: {
    id: "productionAssemblyHall",
    display_name_zh: "生产装配厅",
    display_name_en: "Production Assembly Hall",
    requires: { automatisedAssemblyCentre: 3 },
    cost_at: pow(100_000, 1.5),
    verified_against_live: false,
  },
  highPerformanceSynthesiser: {
    id: "highPerformanceSynthesiser",
    display_name_zh: "高性能合成器",
    display_name_en: "High-Performance Synthesiser",
    requires: { microchipAssemblyLine: 3 },
    cost_at: powD(120_000, 1.5),
    verified_against_live: false,
  },
  chipMassProduction: {
    id: "chipMassProduction",
    display_name_zh: "芯片量产工厂",
    display_name_en: "Chip Mass Production",
    requires: { microchipAssemblyLine: 5 },
    cost_at: pow(160_000, 1.5),
    verified_against_live: false,
  },
  nanoRepairBotFactory: {
    id: "nanoRepairBotFactory",
    display_name_zh: "纳米修复机器人工厂",
    display_name_en: "Nano Repair Bot Production",
    requires: { quantumComputerCentre: 3 },
    cost_at: powD(220_000, 1.5),
    verified_against_live: false,
  },
};

const research: Record<string, LifeformResearchEntry> = {
  catalyserTechnology: {
    id: "catalyserTechnology",
    display_name_zh: "催化剂技术",
    display_name_en: "Catalyser Technology",
    requires: { roboticsResearchCentre: 1 },
    cost_at: pow(6_500, 2),
    verified_against_live: false,
  },
  plasmaDrive: {
    id: "plasmaDrive",
    display_name_zh: "等离子驱动",
    display_name_en: "Plasma Drive",
    requires: { roboticsResearchCentre: 1 },
    cost_at: pow(9_000, 2),
    verified_against_live: false,
  },
  efficiencyModule: {
    id: "efficiencyModule",
    display_name_zh: "效率模块",
    display_name_en: "Efficiency Module",
    requires: { roboticsResearchCentre: 1 },
    cost_at: pow(7_000, 2),
    verified_against_live: false,
  },
  depotAi: {
    id: "depotAi",
    display_name_zh: "仓储 AI",
    display_name_en: "Depot AI",
    requires: { roboticsResearchCentre: 2 },
    cost_at: pow(12_000, 2),
    verified_against_live: false,
  },
  generalOverhaulLightFighter: {
    id: "generalOverhaulLightFighter",
    display_name_zh: "轻型战机大修",
    display_name_en: "General Overhaul: Light Fighter",
    requires: { roboticsResearchCentre: 2 },
    cost_at: pow(20_000, 2),
    verified_against_live: false,
  },
  automatedTransportLines: {
    id: "automatedTransportLines",
    display_name_zh: "自动化运输线",
    display_name_en: "Automated Transport Lines",
    requires: { roboticsResearchCentre: 2 },
    cost_at: pow(15_000, 2),
    verified_against_live: false,
  },
  improvedDroneAi: {
    id: "improvedDroneAi",
    display_name_zh: "改进无人机 AI",
    display_name_en: "Improved Drone AI",
    requires: { roboticsResearchCentre: 3 },
    cost_at: pow(28_000, 2),
    verified_against_live: false,
  },
  experimentalRecyclingTechnology: {
    id: "experimentalRecyclingTechnology",
    display_name_zh: "实验性回收技术",
    display_name_en: "Experimental Recycling Technology",
    requires: { roboticsResearchCentre: 3 },
    cost_at: pow(50_000, 2),
    verified_against_live: false,
  },
  generalOverhaulCruiser: {
    id: "generalOverhaulCruiser",
    display_name_zh: "巡洋舰大修",
    display_name_en: "General Overhaul: Cruiser",
    requires: { roboticsResearchCentre: 4 },
    cost_at: powD(80_000, 2),
    verified_against_live: false,
  },
  slingshotAutopilot: {
    id: "slingshotAutopilot",
    display_name_zh: "弹弓自动驾驶",
    display_name_en: "Slingshot Autopilot",
    requires: { roboticsResearchCentre: 4 },
    cost_at: powD(100_000, 2),
    verified_against_live: false,
  },
  highTemperatureSuperconductors: {
    id: "highTemperatureSuperconductors",
    display_name_zh: "高温超导",
    display_name_en: "High-Temperature Superconductors",
    requires: { roboticsResearchCentre: 5 },
    cost_at: powD(150_000, 2),
    verified_against_live: false,
  },
  generalOverhaulBattleship: {
    id: "generalOverhaulBattleship",
    display_name_zh: "战列舰大修",
    display_name_en: "General Overhaul: Battleship",
    requires: { roboticsResearchCentre: 5 },
    cost_at: powD(200_000, 2),
    verified_against_live: false,
  },
};

export default {
  species: "mechas",
  buildings,
  research,
} satisfies LifeformTechCatalog;
