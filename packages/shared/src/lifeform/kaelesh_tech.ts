// Kaelesh (凯莱什) Lifeform tech catalog — draft skeleton.
// Data source: OGame community wiki (ogame.fandom.com/wiki/Lifeforms#Kaelesh) — web fetch blocked in env;
// shape & ID conventions follow community OGotcha-style naming (lf_kaelesh_*).
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
  sanctuary: {
    id: "sanctuary",
    display_name_zh: "聖殿",
    display_name_en: "Sanctuary",
    requires: {},
    cost_at: pow(10, 1.2),
    verified_against_live: false,
  },
  antimatterCondenser: {
    id: "antimatterCondenser",
    display_name_zh: "反物質凝聚器",
    display_name_en: "Antimatter Condenser",
    requires: { sanctuary: 1 },
    cost_at: pow(15, 1.23),
    verified_against_live: false,
  },
  vortexChamber: {
    id: "vortexChamber",
    display_name_zh: "漩渦室",
    display_name_en: "Vortex Chamber",
    requires: { sanctuary: 1 },
    cost_at: pow(30_000, 1.4),
    verified_against_live: false,
  },
  hallsOfRealisation: {
    id: "hallsOfRealisation",
    display_name_zh: "覺悟殿",
    display_name_en: "Halls of Realisation",
    requires: { vortexChamber: 2 },
    cost_at: pow(50_000, 1.5),
    verified_against_live: false,
  },
  forumOfTranscendence: {
    id: "forumOfTranscendence",
    display_name_zh: "超脫論壇",
    display_name_en: "Forum of Transcendence",
    requires: { hallsOfRealisation: 3 },
    cost_at: pow(80_000, 1.5),
    verified_against_live: false,
  },
  antimatterConvector: {
    id: "antimatterConvector",
    display_name_zh: "反物質對流器",
    display_name_en: "Antimatter Convector",
    requires: { antimatterCondenser: 5 },
    cost_at: powD(60_000, 1.4),
    verified_against_live: false,
  },
  cloningLaboratory: {
    id: "cloningLaboratory",
    display_name_zh: "克隆實驗室",
    display_name_en: "Cloning Laboratory",
    requires: { hallsOfRealisation: 2 },
    cost_at: pow(45_000, 1.5),
    verified_against_live: false,
  },
  chrysalisAccelerator: {
    id: "chrysalisAccelerator",
    display_name_zh: "蛹化加速器",
    display_name_en: "Chrysalis Accelerator",
    requires: { cloningLaboratory: 3 },
    cost_at: pow(90_000, 1.5),
    verified_against_live: false,
  },
  bioModifier: {
    id: "bioModifier",
    display_name_zh: "生物修飾器",
    display_name_en: "Bio Modifier",
    requires: { hallsOfRealisation: 4 },
    cost_at: powD(140_000, 1.5),
    verified_against_live: false,
  },
  psionicModulator: {
    id: "psionicModulator",
    display_name_zh: "心靈調節器",
    display_name_en: "Psionic Modulator",
    requires: { forumOfTranscendence: 3 },
    cost_at: powD(170_000, 1.5),
    verified_against_live: false,
  },
  shipManufacturingHall: {
    id: "shipManufacturingHall",
    display_name_zh: "艦船制造廳",
    display_name_en: "Ship Manufacturing Hall",
    requires: { antimatterConvector: 3 },
    cost_at: pow(200_000, 1.5),
    verified_against_live: false,
  },
  supraRefractor: {
    id: "supraRefractor",
    display_name_zh: "超頻折射器",
    display_name_en: "Supra Refractor",
    requires: { psionicModulator: 3 },
    cost_at: powD(260_000, 1.6),
    verified_against_live: false,
  },
};

// v0.0.666 — operator 2026-06-02 "LF 科技都是中文 / 中文名称不是 ogame
// 专有名词": catalog rewritten to align canonical keys with tech_ids.ts
// (14201-14218 series). Previous entries used non-canonical keys like
// "neuromodal_compressor" (snake) / "neuroIfm" / "signalTransmission"
// which DOM scraper's canonical-name lookup never produced → all LF
// research items 14206+ silently fell through to scraped TC label.
// display_name_zh values lifted from operator's live TC page DOM via
// techLabels[]; runtime pickLfName still prefers techLabels (ground
// truth) over these handcrafted values.
const research: Record<string, LifeformResearchEntry> = {
  heatRecovery: {
    id: "heatRecovery",
    display_name_zh: "熱量回收",
    display_name_en: "Heat Recovery",
    requires: { vortexChamber: 1 },
    cost_at: pow(7_000, 2),
    verified_against_live: false,
  },
  sulphideProcess: {
    id: "sulphideProcess",
    display_name_zh: "硫化物過程",
    display_name_en: "Sulphide Process",
    requires: { vortexChamber: 1 },
    cost_at: pow(8_500, 2),
    verified_against_live: false,
  },
  psionicNetwork: {
    id: "psionicNetwork",
    display_name_zh: "靈能網路",
    display_name_en: "Psionic Network",
    requires: { vortexChamber: 1 },
    cost_at: pow(10_500, 2),
    verified_against_live: false,
  },
  telekineticTractorBeam: {
    id: "telekineticTractorBeam",
    display_name_zh: "心靈致動牽引光束",
    display_name_en: "Telekinetic Tractor Beam",
    requires: { vortexChamber: 2 },
    cost_at: pow(18_000, 2),
    verified_against_live: false,
  },
  enhancedSensorTechnology: {
    id: "enhancedSensorTechnology",
    display_name_zh: "增強感測器技術",
    display_name_en: "Enhanced Sensor Technology",
    requires: { vortexChamber: 2 },
    cost_at: pow(22_000, 2),
    verified_against_live: false,
  },
  neuromodalCompressor: {
    id: "neuromodalCompressor",
    display_name_zh: "神經模態壓縮機",
    display_name_en: "Neuromodal Compressor",
    requires: { vortexChamber: 2 },
    cost_at: pow(26_000, 2),
    verified_against_live: false,
  },
  neuroInterface: {
    id: "neuroInterface",
    display_name_zh: "神經介面",
    display_name_en: "Neuro-Interface",
    requires: { vortexChamber: 3 },
    cost_at: pow(40_000, 2),
    verified_against_live: false,
  },
  interplanetaryAnalysisNetwork: {
    id: "interplanetaryAnalysisNetwork",
    display_name_zh: "星際分析網路",
    display_name_en: "Interplanetary Analysis Network",
    requires: { vortexChamber: 3 },
    cost_at: pow(50_000, 2),
    verified_against_live: false,
  },
  overclockingHeavyFighter: {
    id: "overclockingHeavyFighter",
    display_name_zh: "超頻（重型戰鬥機）",
    display_name_en: "Overclocking — Heavy Fighter",
    requires: { vortexChamber: 3 },
    cost_at: pow(60_000, 2),
    verified_against_live: false,
  },
  telekineticDrive: {
    id: "telekineticDrive",
    display_name_zh: "心靈致動器",
    display_name_en: "Telekinetic Drive",
    requires: { vortexChamber: 3 },
    cost_at: pow(55_000, 2),
    verified_against_live: false,
  },
  sixthSense: {
    id: "sixthSense",
    display_name_zh: "第六感",
    display_name_en: "Sixth Sense",
    requires: { vortexChamber: 4 },
    cost_at: powD(80_000, 2),
    verified_against_live: false,
  },
  psychoharmoniser: {
    id: "psychoharmoniser",
    display_name_zh: "精神調諧器",
    display_name_en: "Psychoharmoniser",
    requires: { vortexChamber: 4 },
    cost_at: powD(90_000, 2),
    verified_against_live: false,
  },
  efficientSwarmIntelligence: {
    id: "efficientSwarmIntelligence",
    display_name_zh: "高效蜂群智能",
    display_name_en: "Efficient Swarm Intelligence",
    requires: { vortexChamber: 4 },
    cost_at: powD(100_000, 2),
    verified_against_live: false,
  },
  overclockingLargeCargo: {
    id: "overclockingLargeCargo",
    display_name_zh: "超頻（大型運輸艦）",
    display_name_en: "Overclocking — Large Cargo",
    requires: { vortexChamber: 4 },
    cost_at: powD(120_000, 2),
    verified_against_live: false,
  },
  gravitationSensors: {
    id: "gravitationSensors",
    display_name_zh: "重力感測器",
    display_name_en: "Gravitation Sensors",
    requires: { vortexChamber: 5 },
    cost_at: powD(150_000, 2),
    verified_against_live: false,
  },
  overclockingBattleship: {
    id: "overclockingBattleship",
    display_name_zh: "超頻（戰列艦）",
    display_name_en: "Overclocking — Battleship",
    requires: { vortexChamber: 5 },
    cost_at: powD(180_000, 2),
    verified_against_live: false,
  },
  psionicShieldMatrix: {
    id: "psionicShieldMatrix",
    display_name_zh: "靈能護盾矩陣",
    display_name_en: "Psionic Shield Matrix",
    requires: { vortexChamber: 5 },
    cost_at: powD(200_000, 2),
    verified_against_live: false,
  },
  kaeleshDiscovererEnhancement: {
    id: "kaeleshDiscovererEnhancement",
    display_name_zh: "凱雷斯探索者強化",
    display_name_en: "Kaelesh Discoverer Enhancement",
    requires: { vortexChamber: 5 },
    cost_at: powD(250_000, 2),
    verified_against_live: false,
  },
};

export default {
  species: "kaelesh",
  buildings,
  research,
} satisfies LifeformTechCatalog;
