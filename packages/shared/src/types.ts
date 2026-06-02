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
  /** Jumpgate cooldown for moons only. 0 = ready, >0 = seconds until next use.
   *  null = unknown / no jumpgate built. Snapshot value at jumpgate_harvested_at.
   *  Consumer should compute live remaining = max(0, snapshot - (now_ms - harvested_at_ms) / 1000). */
  jumpgate_cooldown_sec?: number | null;
  /** ms epoch when jumpgate_cooldown_sec was captured (for live mm:ss countdown). */
  jumpgate_harvested_at?: number | null;
  /** Planet id of the moon this jump's TARGET was — for pair display
   *  "[源]/[目标] mm:ss". Set on the SOURCE moon when sniffer captures a
   *  jump event. null = source-only cooldown (legacy, no pair known). */
  jumpgate_pair_with?: string | null;
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
  /** Destination body type — disambiguates planet vs moon at same coords.
   *  Operator 2026-05-25: "敌人探测和进攻的是月球，星球上的舰队不要FS,
   *  威胁指向的具体位置上面的舰队FS". Without this, planet+moon share
   *  G:S:P and emergency orchestrator picked the wrong source. */
  to_type?: "planet" | "moon";
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
  server: {
    universe: string;
    /** Economy speed — applies to build time + mine production.
     *  From <meta name="ogame-universe-speed"> at boot. */
    speed: number;
    /** Research speed — separate multiplier on modern ogame servers
     *  (e.g. Scorpius: eco=8, research=16). From /api/serverData.xml.
     *  Falls back to `speed` when absent. */
    research_speed?: number;
    /** Fleet speed multipliers (transport/expedition/attack/defend/harvest). */
    fleet_peaceful_speed?: number;
    fleet_war_speed?: number;
    fleet_holding_speed?: number;
  };
  player: { id: string; name: string; alliance: string | null };
  /** Planets keyed by ogame numeric planet ID. Refactored 2026-05-21
   *  from Array to remove planets[0]-as-special-home assumption.
   *  Iterate with Object.values(state.planets). */
  planets: Record<string, Planet>;
  research: ResearchState;
  fleets_outbound: FleetMovement[];
  events_incoming: IncomingEvent[];
  artifacts: PlayerArtifactInventory;              // 2026
  discovery_slots: { used: number; max: number }; // 2026
  discovery_active: DiscoveryMission[];            // 2026
  last_update: number;
  page_snapshots: Record<string, number>;
  /** Harvested tech labels from ogame DOM (zh per server locale). Keyed by
   *  canonical tech name (heatRecovery, psionicNetwork, ...). Operator
   *  2026-06-01 "不要兜底，网页上有名字" — DOM is the source of truth, no
   *  hardcoded catalog fallback. Populated lazily as operator visits
   *  pages (supplies / lfbuildings / lfresearch / research / shipyard). */
  tech_labels?: Record<string, string>;
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
  | "expedition" | "deploy" | "transport"
  // 2026 LifeForm 扩展
  | "pick_lifeform"
  | "lifeform_level_to"
  | "lifeform_research"
  | "lifeform_building"
  // 种族发现 (Galaxy view 紫色 DNA → 派遣探索飛船)
  // POST .../action=sendDiscoveryFleet body=galaxy/system/position/token
  | "species_discovery"
  // 跳跃门 (sibling-moon hop, instant)
  // POST .../component=jumpgate&action=executeJump body=token+targetSpaceObjectId+ship counts
  | "jumpgate";

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
  /**
   * Marks this goal as the player's PRIMARY OBJECTIVE. The PriorityMerger
   * plans the main goal FIRST every tick; the planner's recursive prereq
   * descent ensures all dependencies are scheduled before the goal itself.
   * Other goals only consume a dispatch slot (per-planet build slot, global
   * research slot) if the main chain didn't already claim it.
   *
   * At most one goal should have `is_main_goal: true` at any time; the
   * GoalsStore's setMainGoal() helper enforces this by clearing others
   * before flipping the target.
   */
  is_main_goal?: boolean;

  /**
   * Optional parent goal id. When set, this goal is a SUB-GOAL of `parent_goal_id`
   * (e.g. an accelerator prereq or a lunarBase prereq feeding a jumpgate goal).
   *
   * Semantics:
   *   - cancelling parent → cascade-cancels all children
   *   - panel renders children indented under parent
   *   - children may have their own children (depth not capped, but UI shows ≤3)
   *
   * Architecture: parent-child graph is informational, NOT a scheduling
   * dependency — slot allocation is still per-(body, slot-family). If the
   * planner cares whether a child must precede its parent, that's encoded in
   * `prereq_tree` independently.
   */
  parent_goal_id?: string;
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

// --- M4 Bridge protocol (userscript ↔ OpenClaw plugin sidecar) ---
// Spec §10.2. WS at ws://127.0.0.1:18790 + HTTP long-poll fallback.

export type UpstreamMsg =
  | { type: "hello"; strategy_version: number; userscript_version: string }
  | { type: "state.snapshot"; ts: number; snapshot: WorldState; strategy_version: number }
  | { type: "event.emergency"; subtype: string; data: unknown; markdown_report: string }
  | { type: "event.daily_failure"; task: string; attempts: number; last_error: string; context: unknown }
  | { type: "event.directive_completed"; directive_id: string; result: unknown }
  | { type: "event.extractor_failure"; extractor: string; raw_html_sample: string }
  | { type: "audit.condition_unmet"; rule_id: string; evidence: unknown }
  | { type: "pong"; ts: number };

export type DownstreamMsg =
  | { type: "strategy.full"; strategy: Strategy }
  | { type: "strategy.update"; version: number; patch: Record<string, unknown>; reason: string }
  | { type: "directive.dispatch"; directive: Directive }
  | { type: "directive.cancel"; id: string; reason: string }
  /** Sidecar asks userscript to refresh given scope of data and push back.
   *  Used by event-driven decision flow: daemon sends refresh request,
   *  waits ~2s, then reads /v1/state confident it's fresh. */
  | { type: "data.refresh"; scope: "fleets" | "resources" | "all"; reason?: string }
  | { type: "config.set"; key: string; value: unknown }
  /** Sidecar's backend SaveCoordinator owns multi-planet FSM state. When a
   *  planet's pending hostiles are all clear AND the safety margin has
   *  elapsed, sidecar emits this msg. Userscript receives it and POSTs
   *  the recall directly to ogame (cookies + token live in the page). */
  | { type: "save.recall_now"; planet_id: string; fleet_id: number; reason?: string }
  /** v0.0.472: when an expedition fleet returns (mission=15 fleet just left
   *  fleets_outbound), check galaxy:system:16 for debris field. If present,
   *  dispatch explorers from origin planet to collect (mission=8, destType=2).
   *  Operator 2026-05-30 "有舰队开始返回，检查该银河系16号位置外太空是否有
   *  残骸，如果有就派探路者去回收". */
  | { type: "expedition.debris_check"; galaxy: number; system: number; origin_planet_id: string; reason?: string }
  | { type: "ping"; ts: number };

export type BridgeMsg = UpstreamMsg | DownstreamMsg;
