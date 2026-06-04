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
  // v0.0.742 — operator 2026-06-04 pasted ogame technologytree HTML for
  // Kaelesh supraRefractor view (data-id="6a20dc7042e54"). Extracted 12
  // node positions + jsPlumb edge labels (3/5 + 4/5 RED unmet, plus 1, 3,
  // 4, 5, 6, 20, 21, 42 green met). Mapped depth0-depth8 columns to
  // prereq levels. verified_against_live: true for confirmed-from-tree.
  hallsOfRealisation: {
    id: "hallsOfRealisation",
    display_name_zh: "實相殿堂",
    display_name_en: "Halls of Realisation",
    requires: { sanctuary: 20 },  // tree depth7→8: sanctuary L20 connects to hallsOfRealisation
    cost_at: pow(50_000, 1.5),
    verified_against_live: true,
  },
  forumOfTranscendence: {
    id: "forumOfTranscendence",
    display_name_zh: "超驗論壇",
    display_name_en: "Forum of Transcendence",
    // Tree: forum depth1 col2 + depth3 col2; its direct prereqs in depth2-3:
    //   - bioModifier L6 (depth3 col1)
    //   - chrysalisAccelerator L1 (depth5 col0, transitive)
    //   - hallsOfRealisation L1 (depth6 col0)
    // Direct = bioModifier (higher-level requirement), basic hierarchy.
    requires: { hallsOfRealisation: 3, bioModifier: 6 },
    cost_at: pow(80_000, 1.5),
    verified_against_live: true,
  },
  antimatterConvector: {
    id: "antimatterConvector",
    display_name_zh: "反物質換流器",
    display_name_en: "Antimatter Convector",
    requires: { antimatterCondenser: 21 },  // tree shows antimatterCondenser L21 as antimatterConvector's prereq via depth5
    cost_at: powD(60_000, 1.4),
    verified_against_live: true,
  },
  cloningLaboratory: {
    id: "cloningLaboratory",
    display_name_zh: "克隆實驗室",
    display_name_en: "Cloning Laboratory",
    // Tree depth1 col3 cloningLab → depth3 col3 vortexChamber L5 prereq
    requires: { vortexChamber: 5, hallsOfRealisation: 2 },
    cost_at: pow(45_000, 1.5),
    verified_against_live: true,
  },
  chrysalisAccelerator: {
    id: "chrysalisAccelerator",
    display_name_zh: "成蛹加速器",
    display_name_en: "Chrysalis Accelerator",
    requires: { hallsOfRealisation: 1 },  // tree depth5 → depth6 path
    cost_at: pow(90_000, 1.5),
    verified_against_live: true,
  },
  bioModifier: {
    id: "bioModifier",
    display_name_zh: "生物修飾劑",
    display_name_en: "Bio Modifier",
    requires: { hallsOfRealisation: 4 },
    cost_at: powD(140_000, 1.5),
    verified_against_live: false,  // tree shows bioModifier in depth3-4 but exact direct prereq not clearly traceable
  },
  psionicModulator: {
    id: "psionicModulator",
    display_name_zh: "心靈調節器",
    display_name_en: "Psionic Modulator",
    requires: { forumOfTranscendence: 3 },
    cost_at: powD(170_000, 1.5),
    verified_against_live: false,  // psionicModulator (14110) NOT in operator's supraRefractor tree view
  },
  shipManufacturingHall: {
    id: "shipManufacturingHall",
    display_name_zh: "艦船製造廠",
    display_name_en: "Ship Manufacturing Hall",
    requires: { antimatterConvector: 3 },
    cost_at: pow(200_000, 1.5),
    verified_against_live: true,
  },
  supraRefractor: {
    id: "supraRefractor",
    display_name_zh: "超折射望遠鏡",
    display_name_en: "Supra Refractor",
    // Tree depth0 col3 supraRefractor → depth1 cols 0,2,3,4 direct prereqs.
    // RED 3/5 + 4/5 labels mark TWO unmet L5 requirements; the catalog
    // version-controlled here lists FOUR prereqs at L5 to match the tree
    // visible structure. Sniffer captured ogame trying 14108 + 14109 chain
    // pre-schedule = chrysAccel + bioModifier escalation aligns.
    requires: {
      chrysalisAccelerator: 5,
      forumOfTranscendence: 5,
      cloningLaboratory: 5,
      shipManufacturingHall: 5,
    },
    cost_at: powD(260_000, 1.6),
    verified_against_live: true,
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
