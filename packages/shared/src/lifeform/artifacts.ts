// Artifact catalog — draft skeleton.
// Data source: OGame community wiki (ogame.fandom.com/wiki/Lifeforms — artifacts section) — web fetch blocked in env;
// names follow community-translated 2026 expedition/discovery loot tables.
// TODO: verify artifact ids and rarity tier against live ogame 2026 (M6 audit will reconcile).
import type { ArtifactEntry, ArtifactId } from "./types.js";

export const ARTIFACTS: Record<ArtifactId, ArtifactEntry> = {
  ancient_relic: {
    id: "ancient_relic",
    display_name_zh: "古代遗物",
    display_name_en: "Ancient Relic",
    sources: ["expedition", "discovery"],
    rarity: "low",
  },
  alien_artifact: {
    id: "alien_artifact",
    display_name_zh: "外星造物",
    display_name_en: "Alien Artifact",
    sources: ["expedition", "discovery"],
    rarity: "medium",
  },
  bio_data_chip: {
    id: "bio_data_chip",
    display_name_zh: "生物数据芯片",
    display_name_en: "Bio Data Chip",
    sources: ["expedition"],
    rarity: "low",
  },
  crystal_shard: {
    id: "crystal_shard",
    display_name_zh: "水晶碎片",
    display_name_en: "Crystal Shard",
    sources: ["expedition", "discovery"],
    rarity: "low",
  },
  dark_matter_fragment: {
    id: "dark_matter_fragment",
    display_name_zh: "暗物质碎片",
    display_name_en: "Dark Matter Fragment",
    sources: ["expedition"],
    rarity: "high",
  },
  forgotten_blueprint: {
    id: "forgotten_blueprint",
    display_name_zh: "遗失蓝图",
    display_name_en: "Forgotten Blueprint",
    sources: ["discovery"],
    rarity: "medium",
  },
  ion_capsule: {
    id: "ion_capsule",
    display_name_zh: "离子胶囊",
    display_name_en: "Ion Capsule",
    sources: ["expedition"],
    rarity: "low",
  },
  meteorite_sample: {
    id: "meteorite_sample",
    display_name_zh: "陨石样本",
    display_name_en: "Meteorite Sample",
    sources: ["expedition", "discovery"],
    rarity: "low",
  },
  nano_seed: {
    id: "nano_seed",
    display_name_zh: "纳米种子",
    display_name_en: "Nano Seed",
    sources: ["discovery"],
    rarity: "medium",
  },
  precursor_core: {
    id: "precursor_core",
    display_name_zh: "先驱者核心",
    display_name_en: "Precursor Core",
    sources: ["discovery"],
    rarity: "high",
  },
  psionic_resonator: {
    id: "psionic_resonator",
    display_name_zh: "心灵共振器",
    display_name_en: "Psionic Resonator",
    sources: ["expedition", "discovery"],
    rarity: "high",
  },
  quantum_lens: {
    id: "quantum_lens",
    display_name_zh: "量子透镜",
    display_name_en: "Quantum Lens",
    sources: ["discovery"],
    rarity: "medium",
  },
  rune_tablet: {
    id: "rune_tablet",
    display_name_zh: "符文石板",
    display_name_en: "Rune Tablet",
    sources: ["expedition"],
    rarity: "medium",
  },
  signal_decoder: {
    id: "signal_decoder",
    display_name_zh: "信号解码器",
    display_name_en: "Signal Decoder",
    sources: ["discovery"],
    rarity: "medium",
  },
  stellar_map_fragment: {
    id: "stellar_map_fragment",
    display_name_zh: "星图碎片",
    display_name_en: "Stellar Map Fragment",
    sources: ["expedition", "discovery"],
    rarity: "low",
  },
};
