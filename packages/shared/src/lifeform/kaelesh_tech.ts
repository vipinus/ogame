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

const research: Record<string, LifeformResearchEntry> = {
  heatRecovery: {
    id: "heatRecovery",
    display_name_zh: "熱能回收",
    display_name_en: "Heat Recovery",
    requires: { vortexChamber: 1 },
    cost_at: pow(7_000, 2),
    verified_against_live: false,
  },
  sulphideProcess: {
    id: "sulphideProcess",
    display_name_zh: "硫化處理",
    display_name_en: "Sulphide Process",
    requires: { vortexChamber: 1 },
    cost_at: pow(8_500, 2),
    verified_against_live: false,
  },
  psionicNetwork: {
    id: "psionicNetwork",
    display_name_zh: "心靈網絡",
    display_name_en: "Psionic Network",
    requires: { vortexChamber: 1 },
    cost_at: pow(10_500, 2),
    verified_against_live: false,
  },
  telekineticTractorBeam: {
    id: "telekineticTractorBeam",
    display_name_zh: "心靈牽引波束",
    display_name_en: "Telekinetic Tractor Beam",
    requires: { vortexChamber: 2 },
    cost_at: pow(18_000, 2),
    verified_against_live: false,
  },
  enhancedSensorTechnology: {
    id: "enhancedSensorTechnology",
    display_name_zh: "增強傳感器技術",
    display_name_en: "Enhanced Sensor Technology",
    requires: { vortexChamber: 2 },
    cost_at: pow(22_000, 2),
    verified_against_live: false,
  },
  neuromodal_compressor: {
    id: "neuromodal_compressor",
    display_name_zh: "神經模態壓縮器",
    display_name_en: "Neuromodal Compressor",
    requires: { vortexChamber: 2 },
    cost_at: pow(26_000, 2),
    verified_against_live: false,
  },
  neuroIfm: {
    id: "neuroIfm",
    display_name_zh: "神經界面調制",
    display_name_en: "NeuroIFM",
    requires: { vortexChamber: 3 },
    cost_at: pow(40_000, 2),
    verified_against_live: false,
  },
  telekineticDrive: {
    id: "telekineticDrive",
    display_name_zh: "心靈推進器",
    display_name_en: "Telekinetic Drive",
    requires: { vortexChamber: 3 },
    cost_at: pow(55_000, 2),
    verified_against_live: false,
  },
  signalTransmission: {
    id: "signalTransmission",
    display_name_zh: "信號傳輸",
    display_name_en: "Sixth Sense / Signal Transmission",
    requires: { vortexChamber: 4 },
    cost_at: powD(80_000, 2),
    verified_against_live: false,
  },
  mindClone: {
    id: "mindClone",
    display_name_zh: "心靈克隆",
    display_name_en: "Mind Clone",
    requires: { vortexChamber: 4 },
    cost_at: powD(100_000, 2),
    verified_against_live: false,
  },
  telekineticDrive2: {
    id: "telekineticDrive2",
    display_name_zh: "心靈推進 II",
    display_name_en: "Telekinetic Drive II",
    requires: { vortexChamber: 5 },
    cost_at: powD(150_000, 2),
    verified_against_live: false,
  },
  enhancedDiscoveryNetwork: {
    id: "enhancedDiscoveryNetwork",
    display_name_zh: "增強探索網絡",
    display_name_en: "Enhanced Discovery Network",
    requires: { vortexChamber: 5 },
    cost_at: powD(200_000, 2),
    verified_against_live: false,
  },
};

export default {
  species: "kaelesh",
  buildings,
  research,
} satisfies LifeformTechCatalog;
