import type { ShipKey, ShipCount } from "./ship_ids.js";

export type Coords = readonly [galaxy: number, system: number, position: number];
export type CelestialType = "planet" | "moon";

export type Resources = { m: number; c: number; d: number; e: number };  // planet state (energy required)
export type CargoResources = { m: number; c: number; d: number };         // fleet cargo (no energy)
export type Storage = { m_max: number; c_max: number; d_max: number };
export type Production = { m_h: number; c_h: number; d_h: number };

export type BuildingQueueItem = { item: string; level: number; ends_at: number };
export type ShipyardQueueItem = { ship: ShipKey; count: number; ends_at: number };
export type DefenseQueueItem  = { item: string; count: number; ends_at: number };

export interface Planet {
  id: string;
  name: string;
  coords: Coords;
  type: CelestialType;
  resources: Resources;
  storage: Storage;
  production: Production;
  buildings: Record<string, number>;
  build_q: BuildingQueueItem | null;
  shipyard_q: ShipyardQueueItem | null;
  defense_q: DefenseQueueItem | null;
  ships: ShipCount;
  defense: Record<string, number>;
  lifeform: LifeformState | null;        // 2026 LifeForm 扩展，§3.4
}

// === LifeForm 2026 系统 ===
export type LifeformSpecies = "humans" | "rocktal" | "mechas" | "kaelesh";

export const LIFEFORM_DISPLAY_NAME: Record<LifeformSpecies, string> = {
  humans: "人类",
  rocktal: "岩族",
  mechas: "机械族",
  kaelesh: "凯莱什",
};

export interface LifeformState {
  species: LifeformSpecies;
  level: number;
  exp: number;
  buildings: Record<string, number>;
  research: Record<string, number>;
  slots: {
    building: { used: number; max: number };
    research: { used: number; max: number };
  };
  active_bonuses: Record<string, number>;
  unlocked_bonuses: string[];
}

export interface DiscoveryMission {
  id: string;
  origin: Coords;
  origin_type: CelestialType;
  dest: Coords;
  arrival_at: number;
  return_at: number | null;
  ships: ShipCount;                      // 必含 pathfinder ≥ 1
}

export interface PlayerArtifactInventory {
  artifacts: Record<string, number>;
}

export interface FleetMovement {
  id: string;
  mission: number;
  origin: Coords;
  origin_type: CelestialType;
  dest: Coords;
  dest_type: DestTypeCode;
  arrival_at: number;
  return_at: number | null;
  ships: ShipCount;
  cargo: CargoResources;
}

export interface IncomingEvent {
  id: string;
  type: "attack" | "spy" | "transport" | "return" | "deploy" | "unknown";
  hostile: boolean;
  from: Coords;
  to: Coords;
  arrives_at: number;
  ships_count: number | "?";
  raw_html_id?: string;
}

export const DestType = {
  planet: 1,
  debris: 2,
  moon: 3,
} as const;
export type DestTypeCode = typeof DestType[keyof typeof DestType];

export const Mission = {
  ATTACK: 1, ACS_ATTACK: 2, TRANSPORT: 3, DEPLOY: 4, ACS_DEFEND: 5,
  SPY: 6, COLONIZE: 7, RECYCLE: 8, MOON_DESTROY: 9, EXPEDITION: 15,
} as const;
export type MissionCode = typeof Mission[keyof typeof Mission];

export type ResearchQueueItem = { tech: string; level: number; ends_at: number };

export interface ResearchState {
  levels: Record<string, number>;
  queue: ResearchQueueItem | null;
}

export interface WorldState {
  server: { universe: string; speed: number };
  player: { id: string; name: string; alliance: string | null };
  planets: Planet[];
  research: ResearchState;
  fleets_outbound: FleetMovement[];
  events_incoming: IncomingEvent[];
  artifacts: PlayerArtifactInventory;              // 2026
  discovery_slots: { used: number; max: number }; // 2026
  discovery_active: DiscoveryMission[];            // 2026
  last_update: number;
  page_snapshots: Record<string, number>;
}

// --- Directive ---
export type DirectiveSource = "daily" | "emergency" | "goal" | "user";
export type DirectiveMethod = "api" | "ui";

export interface Directive {
  id: string;
  source: DirectiveSource;
  method: DirectiveMethod;
  priority: number;
  action: string;
  params: Record<string, unknown>;
  preconds: string[];
  expires_at: number;
  reason: string;
  goal_id?: string;
}

// --- Goal (with LifeForm extensions) ---
export type GoalType =
  | "research" | "build" | "build_universal"
  | "colonize" | "build_ships" | "build_defense" | "terraformer_to"
  // 2026 LifeForm 扩展
  | "pick_lifeform"
  | "lifeform_level_to"
  | "lifeform_research"
  | "lifeform_building";

export type GoalStatus = "pending" | "active" | "blocked" | "completed" | "cancelled" | "pending_confirm";

export interface Goal {
  id: string;
  type: GoalType;
  target: Record<string, unknown>;
  planet?: string;
  priority: number;
  status: GoalStatus;
  created_at: number;
  deadline?: number;
  progress_pct: number;
  current_step: string;
  eta_at: number | null;
  blocked_reason?: string;
}

// --- Strategy ---
export interface Strategy {
  version: number;
  updated_at: number;
  updated_by: "openclaw-llm" | "user-discord" | "userscript-bootstrap";
  reason: string;
  daily: DailyStrategy;
  emergency: EmergencyStrategy;
  audit_rules_thresholds: Record<string, number>;
}

export interface DailyStrategy {
  expedition: ExpeditionConfig;
  resource_balance: { enabled: boolean; trigger_overflow_pct: number };
  defense_replenish: { enabled: boolean; keep_minimum: Record<string, number> };
  default_build: { enabled: boolean; strategy: string; ratio: Record<string, number> };
  heartbeat: { enabled: boolean; schedule: string[] };
}

export interface FleetTemplate {
  fleet: ShipCount;
  used_when: string;
  reason?: string;
}

export interface ExpeditionConfig {
  enabled: boolean;
  auto_fill_slots: boolean;
  source_planet: string | null;
  duration: "short" | "medium" | "long";
  target_position: number;
  fleet_templates: Record<string, FleetTemplate>;
  galaxy_strategy: {
    mode: "stats_based" | "fixed" | "rotate";
    home_galaxy_first: boolean;
    switch_threshold: { black_hole_rate_24h: number; sample_size_min: number };
    cross_galaxy_deut_budget: number;
    preferred_galaxies?: number[];
  };
  cargo_load: { smallCargo_capacity_pct: number; largeCargo_capacity_pct: number };
}

export interface EmergencyStrategy {
  attack: {
    save_window_minutes: number;
    prefer_moon: boolean;
    alliance_safe_planets: { coords: Coords; name: string }[];
    safety_margin_minutes: number;
  };
  spy: { push_immediate: boolean; counter_spy: boolean; log_attacker: boolean };
  anomaly: { push_immediate: boolean; pause_planet_automation: boolean };
  resource_critical: { threshold_pct: number; try_redistribute_first: boolean };
}

// --- Expedition outcome (extended with LifeForm types) ---
export interface LifeformExpeditionExtras {
  artifacts_gained: Record<string, number>;
  lifeform_xp_gained: { species: LifeformSpecies; amount: number } | null;
}

export type ExpeditionOutcomeType =
  | "resources_small" | "resources_medium" | "resources_large"
  | "ships_gained_small" | "ships_gained_medium" | "ships_gained_large"
  | "aliens_easy" | "aliens_hard"
  | "pirates_easy" | "pirates_hard"
  | "merchant" | "explorer"
  | "delay_short" | "delay_long"
  | "early_return" | "black_hole"
  | "nothing" | "item_dark_matter" | "item_other"
  // 2026 LifeForm 扩展
  | "artifact_small" | "artifact_medium" | "artifact_large"
  | "lifeform_xp" | "discovery_signal";

export interface ExpeditionOutcome extends LifeformExpeditionExtras {
  expedition_id: string;
  source_planet_id: string;
  source_coords: Coords;
  target_galaxy: number;
  target_system: number;
  target_position: number;
  template_id: string;
  fleet_sent: ShipCount;
  launched_at: number;
  returned_at: number;
  duration_actual_seconds: number;
  outcome_type: ExpeditionOutcomeType;
  resources_gained: Resources;
  ships_gained: ShipCount;
  ships_lost: ShipCount;
  raw_report_id: string;
  raw_report_html_sample?: string;
}

// Discovery mission outcome (new in 2026)
export interface DiscoveryOutcome extends LifeformExpeditionExtras {
  discovery_id: string;
  source_planet_id: string;
  source_coords: Coords;
  target_coords: Coords;
  fleet_sent: ShipCount;
  launched_at: number;
  returned_at: number;
  outcome_summary: string;
  raw_report_id: string;
}
