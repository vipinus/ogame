// Lifeform tech catalog types — shared shape for per-species building/research entries.
// All wiki-sourced entries should set verified_against_live: false until M6 audit reconciles.
import type { Resources, LifeformSpecies } from "../types.js";

export type LifeformBuildingId = string;
export type LifeformResearchId = string;
export type ArtifactId = string;

export interface LifeformBuildingEntry {
  id: LifeformBuildingId;
  display_name_zh: string;
  display_name_en: string;
  requires: Record<string, number>;
  cost_at: (level: number) => Resources;
  duration_seconds?: (level: number, ctx: any) => number;
  bonuses_at?: (level: number) => Record<string, number>;
  verified_against_live: boolean;
}

export interface LifeformResearchEntry {
  id: LifeformResearchId;
  display_name_zh: string;
  display_name_en: string;
  requires: Record<string, number>;
  artifact_cost?: Record<ArtifactId, number>;
  cost_at: (level: number) => Resources;
  duration_seconds?: (level: number, ctx: any) => number;
  bonuses_at?: (level: number) => Record<string, number>;
  verified_against_live: boolean;
}

export interface LifeformTechCatalog {
  species: LifeformSpecies;
  buildings: Record<LifeformBuildingId, LifeformBuildingEntry>;
  research: Record<LifeformResearchId, LifeformResearchEntry>;
}

export interface ArtifactEntry {
  id: ArtifactId;
  display_name_zh: string;
  display_name_en: string;
  sources: ("expedition" | "discovery")[];
  rarity: "low" | "medium" | "high";
}
