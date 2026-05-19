# OgameX Implementation Plan (M0–M8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete Ogame.org automation system: autonomous in-Chrome Tampermonkey userscript handles daily 7×24 ambient tasks and emergency fleet save (≤500ms reaction via direct ogame ajax API); OpenClaw plugin (Node sidecar) handles user-driven goal tasks via Discord with LLM-driven adaptive strategy.

**Architecture:** Dual-engine with WS bridge.
- *userscript* (Tampermonkey, runs inside user's real Chrome session against ogame.org): probes (MutationObserver + XHR hook + DOM extractors), event bus, daily loop, emergency state machine, fleet API (sendFleet + recall), local IndexedDB store.
- *plugin* (OpenClaw `defineToolPlugin`, Node sidecar): tools for LLM (add_goal/query_state/...), goal engine + backward-chaining planner, WS server + HTTP long-poll fallback, Discord reporter, OpenClaw memory writer, strategy versioning with git audit.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22+, pnpm workspaces, Tampermonkey, Rollup (userscript bundling), `typebox` (schemas), `better-sqlite3`, `ws`, `vitest`, OpenClaw v2026.5.17+ plugin SDK (`openclaw/plugin-sdk/tool-plugin`).

**Reference spec:** `docs/superpowers/specs/2026-05-19-ogamex-design.md` (1165 lines, committed in `d75f07b`).

---

## How to Execute This Plan

The plan covers 9 milestones across two packages (`runtime-userscript`, `openclaw-plugin`) + shared types. Total estimated effort is substantial. **Recommended execution phases:**

| Phase | Milestones | Outcome |
|---|---|---|
| Phase 1 | M0 → M3 | Autonomous userscript ships: daily expedition loop + emergency fleet save. **Standalone functional** (no plugin needed). |
| Phase 2 | M4 → M6 | Plugin layer ships: Discord goals, adaptive strategy, OpenClaw memory. |
| Phase 3 | M7 → M8 | Hardening + observability. |

Tasks are sequenced. Within a milestone, tasks may run in parallel where noted (`(parallel-safe)`).

---

## File Structure Map

```
~/Sync/Works/ogamex/
├─ package.json                                    # monorepo root, pnpm
├─ pnpm-workspace.yaml
├─ tsconfig.base.json                              # shared strict TS config
├─ vitest.config.ts                                # workspace test runner
├─ .gitignore                                       # (exists)
│
├─ packages/
│  ├─ shared/                                      # M0
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ src/
│  │  │  ├─ index.ts                               # re-exports
│  │  │  ├─ types.ts                               # WorldState, Goal, Directive, Strategy, ExpeditionOutcome
│  │  │  ├─ schemas.ts                             # typebox schemas + validators
│  │  │  ├─ tech_tree.ts                           # static ogame data
│  │  │  └─ ship_ids.ts                            # ogame internal ids (am202..am219)
│  │  └─ test/
│  │     ├─ tech_tree.test.ts
│  │     └─ schemas.test.ts
│  │
│  ├─ runtime-userscript/                          # M1, M2, M3
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ rollup.config.js                          # bundle into single .user.js
│  │  ├─ src/
│  │  │  ├─ main.ts                                # entry, @match ogame.org
│  │  │  ├─ event_bus.ts                           # in-page event subscriber/emitter
│  │  │  ├─ state_store.ts                         # in-memory mirror + IndexedDB persistence
│  │  │  ├─ activity_tracker.ts                    # USER_AT_KEYBOARD detection
│  │  │  │
│  │  │  ├─ probes/
│  │  │  │  ├─ mutation_observer.ts                # M1
│  │  │  │  ├─ xhr_hook.ts                         # M1
│  │  │  │  ├─ navigator.ts                        # wrapper around ogame.ajaxNavigation
│  │  │  │  └─ extractors/
│  │  │  │     ├─ resources.ts
│  │  │  │     ├─ events.ts
│  │  │  │     ├─ planets.ts
│  │  │  │     ├─ fleet.ts
│  │  │  │     ├─ research.ts
│  │  │  │     ├─ token.ts
│  │  │  │     └─ expedition_report.ts             # M3
│  │  │  │
│  │  │  ├─ api/                                   # M2
│  │  │  │  ├─ token_manager.ts                    # cache + self-heal
│  │  │  │  ├─ fleet_api.ts                        # sendFleet + recall
│  │  │  │  └─ flight_time.ts                      # speed/distance → seconds
│  │  │  │
│  │  │  ├─ emergency/                             # M2
│  │  │  │  ├─ attack_detector.ts                  # scans events_incoming
│  │  │  │  ├─ case_decider.ts                     # three-case logic
│  │  │  │  ├─ save_planner.ts                     # builds SendFleetParams
│  │  │  │  ├─ save_executor.ts                    # fires the API
│  │  │  │  ├─ recall_monitor.ts                   # waits for clear + recalls
│  │  │  │  ├─ save_state_machine.ts               # WATCHING → ... → RETURNED
│  │  │  │  └─ priority_gate.ts                    # absolute-priority overrides
│  │  │  │
│  │  │  ├─ daily/                                 # M3
│  │  │  │  ├─ expedition/
│  │  │  │  │  ├─ slot_filler.ts
│  │  │  │  │  ├─ galaxy_picker.ts
│  │  │  │  │  ├─ template_picker.ts
│  │  │  │  │  ├─ report_parser.ts
│  │  │  │  │  └─ stats.ts                         # black_hole_rate, loss_rate, yield
│  │  │  │  ├─ resource_balance.ts                 # M3 stub, full in M3.x
│  │  │  │  ├─ defense_replenish.ts                # M3 stub
│  │  │  │  └─ default_build.ts                    # M3 stub
│  │  │  │
│  │  │  ├─ goal_runner.ts                         # M5: receives directives from plugin
│  │  │  ├─ auditor.ts                             # M6: event-driven audit rules
│  │  │  │
│  │  │  ├─ store/
│  │  │  │  ├─ indexed_db.ts                       # M1 base
│  │  │  │  ├─ expedition_store.ts                 # M3
│  │  │  │  └─ event_log.ts                        # M6
│  │  │  │
│  │  │  ├─ bridge/                                # M4
│  │  │  │  ├─ ws_client.ts
│  │  │  │  ├─ http_fallback.ts
│  │  │  │  └─ protocol.ts                         # type-safe message envelopes
│  │  │  │
│  │  │  └─ directive_executor.ts                  # M5
│  │  ├─ test/
│  │  │  ├─ fixtures/
│  │  │  │  ├─ ogame_html/                         # real-ish HTML samples
│  │  │  │  │  ├─ overview.html
│  │  │  │  │  ├─ events_hostile.html
│  │  │  │  │  ├─ fleetdispatch.html
│  │  │  │  │  ├─ messages_expedition_blackhole.html
│  │  │  │  │  ├─ messages_expedition_resources.html
│  │  │  │  │  └─ ...
│  │  │  │  └─ ogame_xhr/                          # JSON response samples
│  │  │  │     ├─ fetchResources.json
│  │  │  │     ├─ eventList.json
│  │  │  │     └─ sendFleet_success.json
│  │  │  ├─ probes/extractors/*.test.ts
│  │  │  ├─ api/fleet_api.test.ts
│  │  │  ├─ emergency/case_decider.test.ts
│  │  │  ├─ emergency/save_state_machine.test.ts
│  │  │  ├─ daily/expedition/*.test.ts
│  │  │  └─ ...
│  │  └─ dist/
│  │     └─ ogame-runtime.user.js                  # rollup output
│  │
│  └─ openclaw-plugin/                             # M4, M5, M6
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ openclaw.plugin.json                      # generated by `openclaw plugins build`
│     ├─ src/
│     │  ├─ index.ts                               # defineToolPlugin entry
│     │  ├─ tools/                                 # M4 + M5
│     │  │  ├─ query_state.ts
│     │  │  ├─ query_goals.ts
│     │  │  ├─ query_events.ts
│     │  │  ├─ add_goal.ts
│     │  │  ├─ cancel_goal.ts
│     │  │  ├─ pause_automation.ts
│     │  │  ├─ resume_automation.ts
│     │  │  ├─ force_action.ts
│     │  │  ├─ explain_directive.ts
│     │  │  └─ get_eta.ts
│     │  ├─ sidecar/
│     │  │  ├─ index.ts                            # boot
│     │  │  ├─ ws_server.ts                        # ws://127.0.0.1:18790
│     │  │  ├─ http_server.ts                     # /ogamex/v1/*
│     │  │  ├─ goal_engine.ts                      # M5
│     │  │  ├─ planner.ts                          # M5: backward chaining
│     │  │  ├─ goals_store.ts                      # M5: SQLite
│     │  │  ├─ state_store.ts                      # M4: in-memory mirror of userscript state
│     │  │  ├─ strategy_manager.ts                 # M6: versioning + git
│     │  │  ├─ memory_writer.ts                    # M6: ogamex-live-state.md
│     │  │  ├─ reporter.ts                         # Discord push via openclaw API
│     │  │  └─ priority_merger.ts                  # M5
│     │  ├─ llm/
│     │  │  └─ strategy_analyzer.ts                # M6
│     │  └─ skill/
│     │     └─ SKILL.md                            # M4: agent-facing instructions
│     └─ test/
│        ├─ tools/*.test.ts
│        ├─ sidecar/planner.test.ts
│        ├─ sidecar/strategy_manager.test.ts
│        └─ ...
│
├─ docs/
│  └─ superpowers/
│     ├─ specs/2026-05-19-ogamex-design.md         # (exists)
│     └─ plans/2026-05-19-ogamex-implementation.md # this file
│
├─ scripts/
│  ├─ install-userscript.sh                        # copy .user.js to a path Tampermonkey can read
│  ├─ register-plugin.sh                           # `openclaw plugins install --local ./packages/openclaw-plugin`
│  └─ dev-watch.sh                                 # rollup -w + pnpm sidecar dev
│
└─ README.md                                       # M0
```

---

## M0 — Project Scaffold & Shared Types

**Goal:** Bootable monorepo, types compile, tests run, tech_tree.ts populated with enough data to support M2 (fleet save) and M3 (expedition).

**Acceptance criteria:**
- `pnpm install` succeeds
- `pnpm -r build` succeeds
- `pnpm -r test` runs (placeholder passing test in each package)
- `tech_tree.ts` covers: all 14 buildings, all 16 researches, all 18 ships, all 11 defenses (prerequisites + cost formulas)

### Task M0.1 — Monorepo bootstrap

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `README.md`

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "ogamex",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "pnpm -r --parallel build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.0.0",
    "@types/node": "^22.0.0",
    "typebox": "^0.34.0"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  }
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globals: false, environment: "node", include: ["packages/*/test/**/*.test.ts"] },
});
```

- [ ] **Step 5: Run `pnpm install`**

Run: `pnpm install`
Expected: exit 0, lockfile created.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts pnpm-lock.yaml README.md
git commit -m "chore: monorepo scaffold (pnpm + ts + vitest)"
```

### Task M0.2 — Shared package: types

**Files:**
- Create: `packages/shared/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/ship_ids.ts`

- [ ] **Step 1: `packages/shared/package.json`**

```json
{
  "name": "@ogamex/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --root ."
  }
}
```

- [ ] **Step 2: `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "declaration": true },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: `src/ship_ids.ts`** (ogame internal ids used in API `am{id}` params)

```ts
export const SHIP_IDS = {
  smallCargo: 202,
  largeCargo: 203,
  lightFighter: 204,
  heavyFighter: 205,
  cruiser: 206,
  battleship: 207,
  colonyShip: 208,
  recycler: 209,
  espionageProbe: 210,
  bomber: 211,
  solarSatellite: 212,
  destroyer: 213,
  deathstar: 214,
  battlecruiser: 215,
  crawler: 217,
  reaper: 218,
  pathfinder: 219,
} as const;

export type ShipKey = keyof typeof SHIP_IDS;
export type ShipCount = Partial<Record<ShipKey, number>>;
```

- [ ] **Step 4: `src/types.ts`** (core domain types)

```ts
import type { ShipKey, ShipCount } from "./ship_ids.js";

export type Coords = readonly [galaxy: number, system: number, position: number];
export type CelestialType = "planet" | "moon";

export type Resources = { m: number; c: number; d: number; e?: number };
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
  queue: BuildingQueueItem | null;
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
  buildings: Record<string, number>;     // lifeform 专属建筑等级 (id → level)
  research: Record<string, number>;      // lifeform 专属科研等级
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
  artifacts: Record<string, number>;     // artifact_id → count
}

export interface LifeformExpeditionExtras {
  artifacts_gained: Record<string, number>;
  lifeform_xp_gained: { species: LifeformSpecies; amount: number } | null;
}

export interface FleetMovement {
  id: string;
  mission: number;                     // ogame mission code (see Mission enum)
  origin: Coords;
  origin_type: CelestialType;
  dest: Coords;
  dest_type: 1 | 2 | 3;                // 1=planet, 2=debris, 3=moon
  arrival_at: number;
  return_at: number | null;
  ships: ShipCount;
  cargo: Resources;
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

export const Mission = {
  ATTACK: 1, ACS_ATTACK: 2, TRANSPORT: 3, DEPLOY: 4, ACS_DEFEND: 5,
  SPY: 6, COLONIZE: 7, RECYCLE: 8, MOON_DESTROY: 9, EXPEDITION: 15,
} as const;
export type MissionCode = typeof Mission[keyof typeof Mission];

export interface ResearchState {
  levels: Record<string, number>;
  queue: { tech: string; level: number; ends_at: number } | null;
}

export interface WorldState {
  server: { universe: string; speed: number };
  player: { id: string; name: string; alliance: string | null };
  planets: Planet[];
  research: ResearchState;
  fleets_outbound: FleetMovement[];
  events_incoming: IncomingEvent[];
  artifacts: PlayerArtifactInventory;              // 2026 LifeForm 扩展
  discovery_slots: { used: number; max: number }; // 2026
  discovery_active: DiscoveryMission[];            // 2026
  last_update: number;
  page_snapshots: Record<string, number>;
}

// --- Directive (action to execute) ---
export type DirectiveSource = "daily" | "emergency" | "goal" | "user";
export type DirectiveMethod = "api" | "ui";

export interface Directive {
  id: string;
  source: DirectiveSource;
  method: DirectiveMethod;
  priority: number;                    // 0 = emergency, 200 = soft fallback
  action: string;                      // "send_fleet" | "build" | "research" | ...
  params: Record<string, unknown>;
  preconds: string[];                  // simple DSL: "planet.<id>.resources.m >= 50000"
  expires_at: number;
  reason: string;
  goal_id?: string;
}

// --- Goal ---
export type GoalType =
  | "research" | "build" | "build_universal"
  | "colonize" | "build_ships" | "build_defense" | "terraformer_to"
  // 2026 LifeForm 扩展（§3.4.6）
  | "pick_lifeform"            // 给指定星球选生命体（一次性）
  | "lifeform_level_to"        // 把指定星球生命体堆到 N 级
  | "lifeform_research"        // 研究某生命体科技到 N 级
  | "lifeform_building";       // 建生命体建筑到 N 级

export type GoalStatus = "pending" | "active" | "blocked" | "completed" | "cancelled" | "pending_confirm";

export interface Goal {
  id: string;
  type: GoalType;
  target: Record<string, unknown>;     // {tech, level} | {ship, count} | {coords}
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
    safety_margin_minutes: number;            // recall window
  };
  spy: { push_immediate: boolean; counter_spy: boolean; log_attacker: boolean };
  anomaly: { push_immediate: boolean; pause_planet_automation: boolean };
  resource_critical: { threshold_pct: number; try_redistribute_first: boolean };
}

// --- Expedition outcome (data-driven self-tuning) ---
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

export interface ExpeditionOutcome {
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
  // 2026 LifeForm 扩展
  artifacts_gained: Record<string, number>;                     // {ancient_relic: 1, ...}
  lifeform_xp_gained: { species: LifeformSpecies; amount: number } | null;
  raw_report_id: string;
  raw_report_html_sample?: string;
}

// Discovery mission (similar to expedition but for artifacts)
export interface DiscoveryOutcome {
  discovery_id: string;
  source_planet_id: string;
  source_coords: Coords;
  target_coords: Coords;
  fleet_sent: ShipCount;
  launched_at: number;
  returned_at: number;
  artifacts_gained: Record<string, number>;
  lifeform_xp_gained: { species: LifeformSpecies; amount: number } | null;
  outcome_summary: string;
  raw_report_id: string;
}
```

- [ ] **Step 5: `src/index.ts`**

```ts
export * from "./types.js";
export * from "./ship_ids.js";
```

- [ ] **Step 6: Verify compile**

Run: `pnpm --filter @ogamex/shared typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): core domain types and ship id table"
```

### Task M0.3 — tech_tree.ts (base — buildings/research/ships/defenses)

**Files:**
- Create: `packages/shared/src/tech_tree.ts`, `packages/shared/test/tech_tree.test.ts`

> **Note**: LifeForm 2026 系统的 ~50 buildings + ~80 research 在 Task M0.3b 单独处理。本任务只覆盖基础 14 建筑 / 16 科研 / 18 舰船 / 10 防御。

- [ ] **Step 1: Write failing test for prerequisite lookup**

`packages/shared/test/tech_tree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TECH_TREE, prerequisitesFor } from "../src/tech_tree.js";

describe("tech_tree", () => {
  it("naniteFactory requires roboticsFactory 10 + computerTech 10", () => {
    expect(prerequisitesFor("naniteFactory")).toEqual({
      roboticsFactory: 10,
      computerTech: 10,
    });
  });

  it("gravitonTech requires energyTech 12, shielding 5, researchLab 12", () => {
    expect(prerequisitesFor("gravitonTech")).toEqual({
      energyTech: 12, shielding: 5, researchLab: 12,
    });
  });

  it("recycler requires shipyard 4 + combustion 6 + impulseDrive 17", () => {
    expect(prerequisitesFor("recycler")).toEqual({
      shipyard: 4, combustion: 6, impulseDrive: 17,
    });
  });

  it("cost grows for level N", () => {
    const c1 = TECH_TREE.metalMine!.cost_at(1);
    const c2 = TECH_TREE.metalMine!.cost_at(2);
    expect(c2.m).toBeGreaterThan(c1.m);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @ogamex/shared test`
Expected: FAIL (file does not exist).

- [ ] **Step 3: Implement `tech_tree.ts`**

```ts
import type { Resources } from "./types.js";

export type TechKind = "building" | "research" | "ship" | "defense";

export interface TechEntry {
  id: string;
  kind: TechKind;
  requires: Record<string, number>;          // prereq levels
  cost_at: (level: number) => Resources;     // for level N
  duration_seconds?: (level: number, ctx: { roboticsFactory?: number; naniteFactory?: number; researchLab?: number; shipyard?: number }) => number;
}

const pow = (base: number, k: number) => (lvl: number) => Math.floor(base * Math.pow(k, lvl - 1));

export const TECH_TREE: Record<string, TechEntry> = {
  // ===== Buildings =====
  metalMine: {
    id: "metalMine", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(60, 1.5)(l), c: pow(15, 1.5)(l), d: 0 }),
  },
  crystalMine: {
    id: "crystalMine", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(48, 1.6)(l), c: pow(24, 1.6)(l), d: 0 }),
  },
  deuteriumSynth: {
    id: "deuteriumSynth", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(225, 1.5)(l), c: pow(75, 1.5)(l), d: 0 }),
  },
  solarPlant: {
    id: "solarPlant", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(75, 1.5)(l), c: pow(30, 1.5)(l), d: 0 }),
  },
  fusionReactor: {
    id: "fusionReactor", kind: "building",
    requires: { deuteriumSynth: 5, energyTech: 3 },
    cost_at: (l) => ({ m: pow(900, 1.8)(l), c: pow(360, 1.8)(l), d: pow(180, 1.8)(l) }),
  },
  metalStorage: {
    id: "metalStorage", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(1000, 2)(l), c: 0, d: 0 }),
  },
  crystalStorage: {
    id: "crystalStorage", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(1000, 2)(l), c: pow(500, 2)(l), d: 0 }),
  },
  deuteriumTank: {
    id: "deuteriumTank", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(1000, 2)(l), c: pow(1000, 2)(l), d: 0 }),
  },
  roboticsFactory: {
    id: "roboticsFactory", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(400, 2)(l), c: pow(120, 2)(l), d: pow(200, 2)(l) }),
  },
  shipyard: {
    id: "shipyard", kind: "building", requires: { roboticsFactory: 2 },
    cost_at: (l) => ({ m: pow(400, 2)(l), c: pow(200, 2)(l), d: pow(100, 2)(l) }),
  },
  researchLab: {
    id: "researchLab", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(200, 2)(l), c: pow(400, 2)(l), d: pow(200, 2)(l) }),
  },
  alliance_depot: {
    id: "alliance_depot", kind: "building", requires: {},
    cost_at: (l) => ({ m: pow(20000, 2)(l), c: pow(40000, 2)(l), d: 0 }),
  },
  missile_silo: {
    id: "missile_silo", kind: "building", requires: { shipyard: 1 },
    cost_at: (l) => ({ m: pow(20000, 2)(l), c: pow(20000, 2)(l), d: pow(1000, 2)(l) }),
  },
  naniteFactory: {
    id: "naniteFactory", kind: "building",
    requires: { roboticsFactory: 10, computerTech: 10 },
    cost_at: (l) => ({ m: pow(1_000_000, 2)(l), c: pow(500_000, 2)(l), d: pow(100_000, 2)(l) }),
  },

  // ===== Research =====
  energyTech: {
    id: "energyTech", kind: "research", requires: { researchLab: 1 },
    cost_at: (l) => ({ m: 0, c: pow(800, 2)(l), d: pow(400, 2)(l) }),
  },
  laserTech: {
    id: "laserTech", kind: "research", requires: { researchLab: 1, energyTech: 2 },
    cost_at: (l) => ({ m: pow(200, 2)(l), c: pow(100, 2)(l), d: 0 }),
  },
  ionTech: {
    id: "ionTech", kind: "research", requires: { researchLab: 4, energyTech: 4, laserTech: 5 },
    cost_at: (l) => ({ m: pow(1000, 2)(l), c: pow(300, 2)(l), d: pow(100, 2)(l) }),
  },
  hyperspaceTech: {
    id: "hyperspaceTech", kind: "research", requires: { researchLab: 7, energyTech: 5, shielding: 5 },
    cost_at: (l) => ({ m: 0, c: pow(4000, 2)(l), d: pow(2000, 2)(l) }),
  },
  plasmaTech: {
    id: "plasmaTech", kind: "research",
    requires: { researchLab: 4, energyTech: 8, laserTech: 10, ionTech: 5 },
    cost_at: (l) => ({ m: pow(2000, 2)(l), c: pow(4000, 2)(l), d: pow(1000, 2)(l) }),
  },
  combustion: {
    id: "combustion", kind: "research", requires: { researchLab: 1, energyTech: 1 },
    cost_at: (l) => ({ m: pow(400, 2)(l), c: 0, d: pow(600, 2)(l) }),
  },
  impulseDrive: {
    id: "impulseDrive", kind: "research", requires: { researchLab: 2, energyTech: 1 },
    cost_at: (l) => ({ m: pow(2000, 2)(l), c: pow(4000, 2)(l), d: pow(600, 2)(l) }),
  },
  hyperspaceDrive: {
    id: "hyperspaceDrive", kind: "research", requires: { researchLab: 7, hyperspaceTech: 3 },
    cost_at: (l) => ({ m: pow(10000, 2)(l), c: pow(20000, 2)(l), d: pow(6000, 2)(l) }),
  },
  espionageTech: {
    id: "espionageTech", kind: "research", requires: { researchLab: 3 },
    cost_at: (l) => ({ m: pow(200, 2)(l), c: pow(1000, 2)(l), d: pow(200, 2)(l) }),
  },
  computerTech: {
    id: "computerTech", kind: "research", requires: { researchLab: 1 },
    cost_at: (l) => ({ m: 0, c: pow(400, 2)(l), d: pow(600, 2)(l) }),
  },
  astrophysics: {
    id: "astrophysics", kind: "research",
    requires: { researchLab: 3, espionageTech: 4, impulseDrive: 3 },
    cost_at: (l) => ({ m: pow(4000, 1.75)(l), c: pow(8000, 1.75)(l), d: pow(4000, 1.75)(l) }),
  },
  intergalactic: {
    id: "intergalactic", kind: "research",
    requires: { researchLab: 10, computerTech: 8, hyperspaceTech: 8 },
    cost_at: (l) => ({ m: pow(240000, 2)(l), c: pow(400000, 2)(l), d: pow(160000, 2)(l) }),
  },
  graviton: {
    id: "gravitonTech", kind: "research",
    requires: { researchLab: 12, energyTech: 12, shielding: 5 },
    cost_at: (l) => ({ m: 0, c: 0, d: 0, e: 300_000 } as Resources & { e: number }),
  },
  weapons: {
    id: "weapons", kind: "research", requires: { researchLab: 4 },
    cost_at: (l) => ({ m: pow(800, 2)(l), c: 0, d: 0 }),
  },
  shielding: {
    id: "shielding", kind: "research", requires: { researchLab: 6, energyTech: 3 },
    cost_at: (l) => ({ m: pow(200, 2)(l), c: pow(600, 2)(l), d: 0 }),
  },
  armor: {
    id: "armor", kind: "research", requires: { researchLab: 2 },
    cost_at: (l) => ({ m: pow(1000, 2)(l), c: 0, d: 0 }),
  },

  // ===== Ships (cost is per unit) =====
  smallCargo: {
    id: "smallCargo", kind: "ship",
    requires: { shipyard: 2, combustion: 2 },
    cost_at: () => ({ m: 2000, c: 2000, d: 0 }),
  },
  largeCargo: {
    id: "largeCargo", kind: "ship",
    requires: { shipyard: 4, combustion: 6 },
    cost_at: () => ({ m: 6000, c: 6000, d: 0 }),
  },
  lightFighter: {
    id: "lightFighter", kind: "ship",
    requires: { shipyard: 1, combustion: 1 },
    cost_at: () => ({ m: 3000, c: 1000, d: 0 }),
  },
  heavyFighter: {
    id: "heavyFighter", kind: "ship",
    requires: { shipyard: 3, armor: 2, impulseDrive: 2 },
    cost_at: () => ({ m: 6000, c: 4000, d: 0 }),
  },
  cruiser: {
    id: "cruiser", kind: "ship",
    requires: { shipyard: 5, impulseDrive: 4, ionTech: 2 },
    cost_at: () => ({ m: 20000, c: 7000, d: 2000 }),
  },
  battleship: {
    id: "battleship", kind: "ship",
    requires: { shipyard: 7, hyperspaceDrive: 4 },
    cost_at: () => ({ m: 45000, c: 15000, d: 0 }),
  },
  battlecruiser: {
    id: "battlecruiser", kind: "ship",
    requires: { shipyard: 8, hyperspaceTech: 5, hyperspaceDrive: 5, laserTech: 12 },
    cost_at: () => ({ m: 30000, c: 40000, d: 15000 }),
  },
  bomber: {
    id: "bomber", kind: "ship",
    requires: { shipyard: 8, impulseDrive: 6, plasmaTech: 5 },
    cost_at: () => ({ m: 50000, c: 25000, d: 15000 }),
  },
  destroyer: {
    id: "destroyer", kind: "ship",
    requires: { shipyard: 9, hyperspaceDrive: 6, hyperspaceTech: 5 },
    cost_at: () => ({ m: 60000, c: 50000, d: 15000 }),
  },
  deathstar: {
    id: "deathstar", kind: "ship",
    requires: { shipyard: 12, hyperspaceDrive: 7, hyperspaceTech: 6, gravitonTech: 1 },
    cost_at: () => ({ m: 5_000_000, c: 4_000_000, d: 1_000_000 }),
  },
  reaper: {
    id: "reaper", kind: "ship",
    requires: { shipyard: 10, hyperspaceTech: 6, hyperspaceDrive: 7, shielding: 6 },
    cost_at: () => ({ m: 85000, c: 55000, d: 20000 }),
  },
  pathfinder: {
    id: "pathfinder", kind: "ship",
    requires: { shipyard: 5, hyperspaceDrive: 2, shielding: 4 },
    cost_at: () => ({ m: 8000, c: 15000, d: 8000 }),
  },
  colonyShip: {
    id: "colonyShip", kind: "ship",
    requires: { shipyard: 4, impulseDrive: 3 },
    cost_at: () => ({ m: 10000, c: 20000, d: 10000 }),
  },
  recycler: {
    id: "recycler", kind: "ship",
    requires: { shipyard: 4, combustion: 6, impulseDrive: 17 },
    cost_at: () => ({ m: 10000, c: 6000, d: 2000 }),
  },
  espionageProbe: {
    id: "espionageProbe", kind: "ship",
    requires: { shipyard: 3, combustion: 3, espionageTech: 2 },
    cost_at: () => ({ m: 0, c: 1000, d: 0 }),
  },
  solarSatellite: {
    id: "solarSatellite", kind: "ship", requires: { shipyard: 1 },
    cost_at: () => ({ m: 0, c: 2000, d: 500 }),
  },
  crawler: {
    id: "crawler", kind: "ship",
    requires: { shipyard: 5, combustion: 4, armor: 4, laserTech: 4 },
    cost_at: () => ({ m: 2000, c: 2000, d: 1000 }),
  },

  // ===== Defenses =====
  rocketLauncher: {
    id: "rocketLauncher", kind: "defense", requires: { shipyard: 1 },
    cost_at: () => ({ m: 2000, c: 0, d: 0 }),
  },
  lightLaser: {
    id: "lightLaser", kind: "defense",
    requires: { shipyard: 2, energyTech: 1, laserTech: 3 },
    cost_at: () => ({ m: 1500, c: 500, d: 0 }),
  },
  heavyLaser: {
    id: "heavyLaser", kind: "defense",
    requires: { shipyard: 4, energyTech: 3, laserTech: 6 },
    cost_at: () => ({ m: 6000, c: 2000, d: 0 }),
  },
  gaussCannon: {
    id: "gaussCannon", kind: "defense",
    requires: { shipyard: 6, energyTech: 6, weapons: 3, shielding: 1 },
    cost_at: () => ({ m: 20000, c: 15000, d: 2000 }),
  },
  ionCannon: {
    id: "ionCannon", kind: "defense",
    requires: { shipyard: 4, ionTech: 4 },
    cost_at: () => ({ m: 5000, c: 3000, d: 0 }),
  },
  plasmaCannon: {
    id: "plasmaCannon", kind: "defense",
    requires: { shipyard: 8, plasmaTech: 7 },
    cost_at: () => ({ m: 50000, c: 50000, d: 30000 }),
  },
  smallShield: {
    id: "smallShield", kind: "defense",
    requires: { shipyard: 1, shielding: 2 },
    cost_at: () => ({ m: 10000, c: 10000, d: 0 }),
  },
  largeShield: {
    id: "largeShield", kind: "defense",
    requires: { shipyard: 6, shielding: 6 },
    cost_at: () => ({ m: 50000, c: 50000, d: 0 }),
  },
  anti_ballistic: {
    id: "anti_ballistic", kind: "defense", requires: { shipyard: 1, missile_silo: 2 },
    cost_at: () => ({ m: 8000, c: 0, d: 2000 }),
  },
  interplanetary: {
    id: "interplanetary", kind: "defense",
    requires: { shipyard: 1, missile_silo: 4, impulseDrive: 1 },
    cost_at: () => ({ m: 12500, c: 2500, d: 10000 }),
  },
};

export function prerequisitesFor(techId: string): Record<string, number> {
  const entry = TECH_TREE[techId];
  if (!entry) throw new Error(`unknown tech: ${techId}`);
  return entry.requires;
}

export function costFor(techId: string, level: number): Resources {
  const entry = TECH_TREE[techId];
  if (!entry) throw new Error(`unknown tech: ${techId}`);
  return entry.cost_at(level);
}

// Expedition slot formula
export function expeditionSlots(astrophysicsLevel: number): number {
  return Math.floor(Math.sqrt(astrophysicsLevel));
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm --filter @ogamex/shared test`
Expected: 4 tests pass.

- [ ] **Step 5: Add expedition_slots test**

Append to `tech_tree.test.ts`:

```ts
import { expeditionSlots } from "../src/tech_tree.js";
describe("expeditionSlots", () => {
  it.each([
    [1, 1], [3, 1], [4, 2], [8, 2], [9, 3], [15, 3], [16, 4], [25, 5],
  ])("astro=%i → slots=%i", (a, s) => {
    expect(expeditionSlots(a)).toBe(s);
  });
});
```

Run tests. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/tech_tree.ts packages/shared/test/tech_tree.test.ts
git commit -m "feat(shared): tech_tree with 14 buildings, 16 research, 18 ships, 10 defenses, prereqs, costs, expedition slot formula"
```

### Task M0.3b — LifeForm tech database (2026 扩展)

**Goal:** Populate static tech database for 4 lifeforms (humans / rocktal / mechas / kaelesh), each with ~12-13 buildings + ~18-20 research, plus the artifact catalog.

**Files:**
- Create: `packages/shared/src/lifeform/humans_tech.ts`
- Create: `packages/shared/src/lifeform/rocktal_tech.ts`
- Create: `packages/shared/src/lifeform/mechas_tech.ts`
- Create: `packages/shared/src/lifeform/kaelesh_tech.ts`
- Create: `packages/shared/src/lifeform/artifacts.ts`
- Create: `packages/shared/src/lifeform/index.ts`  (re-export aggregator)
- Create: `packages/shared/src/lifeform/types.ts`  (per-lifeform-tech entry interface)
- Test: `packages/shared/test/lifeform/*.test.ts`

#### Data sourcing

Internal game data is NOT inlined in this plan — it's bulky and version-specific. **Data-fetch protocol:**

1. **Implementer first asks**: "Do we have a data dump from the alibaba 服 (or international 服) ogame DB available? If so where? If not, can the user provide one (planet → resources → lifeform → buildings/research full list with prereqs + cost formulas)?"

2. **Fallback**: pull from community wiki (e.g., [ogame-tech.com](https://ogame-tech.com), [OGotcha repo's data files](https://github.com/OGotcha/OGotcha)). Treat as draft, mark `verified_against_live: false` per entry, and have an audit rule fire if any entry's cost prediction is off > 10% from actual page reading.

#### Entry shape (per lifeform)

```ts
// packages/shared/src/lifeform/types.ts
import type { Resources } from "../types.js";

export type LifeformBuildingId = string;
export type LifeformResearchId = string;
export type ArtifactId = string;

export interface LifeformBuildingEntry {
  id: LifeformBuildingId;
  display_name_zh: string;
  display_name_en: string;
  requires: Record<string, number>;        // can reference base tech AND other lifeform tech
  cost_at: (level: number) => Resources;
  duration_seconds?: (level: number, ctx: any) => number;
  bonuses_at?: (level: number) => Record<string, number>;   // 产出/防御 multiplier
}

export interface LifeformResearchEntry {
  id: LifeformResearchId;
  display_name_zh: string;
  display_name_en: string;
  requires: Record<string, number>;
  artifact_cost?: Record<ArtifactId, number>;        // 消耗 artifact 才能研究
  cost_at: (level: number) => Resources;
  duration_seconds?: (level: number, ctx: any) => number;
  bonuses_at?: (level: number) => Record<string, number>;
}

export interface LifeformTechCatalog {
  species: import("../types.js").LifeformSpecies;
  buildings: Record<LifeformBuildingId, LifeformBuildingEntry>;
  research: Record<LifeformResearchId, LifeformResearchEntry>;
}
```

#### Steps

- [ ] **Step 1:** Ask user / locate data source. If unavailable, escalate as NEEDS_CONTEXT.
- [ ] **Step 2:** Write `lifeform/types.ts` per shape above.
- [ ] **Step 3:** For each of 4 species, write `<species>_tech.ts` exporting a `LifeformTechCatalog`. Include all buildings + research found in data source.
- [ ] **Step 4:** Write `artifacts.ts` exporting `Record<ArtifactId, { display_name_zh, display_name_en, sources: ("expedition"|"discovery")[], rarity: "low"|"med"|"high" }>`.
- [ ] **Step 5:** Write `lifeform/index.ts` aggregating + providing `LIFEFORM_TECH[species]` accessor.
- [ ] **Step 6:** Tests verify: prereq lookups, cost growth for level N, artifact consumption parsed correctly, and per-species building/research count matches expected.
- [ ] **Step 7:** Commit: `feat(shared/lifeform): tech database for 4 species + artifacts`

### Task M0.4 — Shared schemas (typebox)

**Files:**
- Create: `packages/shared/src/schemas.ts`, `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { GoalSchema, DirectiveSchema } from "../src/schemas.js";

describe("GoalSchema", () => {
  it("validates a research goal", () => {
    const ok = { id: "g1", type: "research", target: { tech: "gravitonTech", level: 1 },
                 planet: "母星", priority: 85, status: "active", created_at: 1,
                 progress_pct: 0, current_step: "init", eta_at: null };
    expect(Value.Check(GoalSchema, ok)).toBe(true);
  });
  it("rejects invalid priority", () => {
    const bad = { id: "g1", type: "research", target: {}, priority: 999, status: "active",
                  created_at: 1, progress_pct: 0, current_step: "x", eta_at: null };
    expect(Value.Check(GoalSchema, bad)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement schemas**

```ts
import { Type } from "typebox";

export const GoalSchema = Type.Object({
  id: Type.String(),
  type: Type.Union([
    Type.Literal("research"), Type.Literal("build"), Type.Literal("build_universal"),
    Type.Literal("colonize"), Type.Literal("build_ships"),
    Type.Literal("build_defense"), Type.Literal("terraformer_to"),
  ]),
  target: Type.Record(Type.String(), Type.Unknown()),
  planet: Type.Optional(Type.String()),
  priority: Type.Integer({ minimum: 0, maximum: 200 }),
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("active"), Type.Literal("blocked"),
    Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("pending_confirm"),
  ]),
  created_at: Type.Number(),
  deadline: Type.Optional(Type.Number()),
  progress_pct: Type.Integer({ minimum: 0, maximum: 100 }),
  current_step: Type.String(),
  eta_at: Type.Union([Type.Number(), Type.Null()]),
  blocked_reason: Type.Optional(Type.String()),
});

export const DirectiveSchema = Type.Object({
  id: Type.String(),
  source: Type.Union([Type.Literal("daily"), Type.Literal("emergency"),
                      Type.Literal("goal"), Type.Literal("user")]),
  method: Type.Union([Type.Literal("api"), Type.Literal("ui")]),
  priority: Type.Integer({ minimum: 0, maximum: 200 }),
  action: Type.String(),
  params: Type.Record(Type.String(), Type.Unknown()),
  preconds: Type.Array(Type.String()),
  expires_at: Type.Number(),
  reason: Type.String(),
  goal_id: Type.Optional(Type.String()),
});

export const SendFleetParamsSchema = Type.Object({
  source_planet_id: Type.String(),
  coords: Type.Tuple([Type.Integer(), Type.Integer(), Type.Integer()]),
  destType: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  mission: Type.Integer({ minimum: 1, maximum: 15 }),
  speed: Type.Integer({ minimum: 1, maximum: 10 }),
  ships: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  cargo: Type.Object({ m: Type.Integer(), c: Type.Integer(), d: Type.Integer() }),
});
```

- [ ] **Step 3: Add typebox dep**

```bash
pnpm --filter @ogamex/shared add typebox
```

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/test/schemas.test.ts packages/shared/package.json
git commit -m "feat(shared): typebox schemas for Goal/Directive/SendFleetParams"
```

### Task M0.5 — Userscript package stub

**Files:**
- Create: `packages/runtime-userscript/{package.json, tsconfig.json, rollup.config.js, src/main.ts}`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@ogamex/runtime-userscript",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "rollup -c",
    "build:watch": "rollup -c -w",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --root ."
  },
  "dependencies": { "@ogamex/shared": "workspace:*" },
  "devDependencies": {
    "rollup": "^4.0.0",
    "@rollup/plugin-typescript": "^12.0.0",
    "@rollup/plugin-node-resolve": "^15.0.0",
    "@rollup/plugin-commonjs": "^28.0.0",
    "tslib": "^2.6.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src/**/*"] }
```

- [ ] **Step 3: `rollup.config.js`**

```js
import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const banner = `// ==UserScript==
// @name         OgameX Runtime
// @namespace    https://github.com/ddxs/ogamex
// @version      0.0.1
// @match        *://*.ogame.org/*
// @match        *://*.ogame.gameforge.com/*
// @grant        none
// @run-at       document-end
// @connect      127.0.0.1
// ==/UserScript==
`;

export default {
  input: "src/main.ts",
  output: { file: "dist/ogame-runtime.user.js", format: "iife", banner, sourcemap: false },
  plugins: [resolve(), commonjs(), typescript({ tsconfig: "./tsconfig.json" })],
};
```

- [ ] **Step 4: `src/main.ts` stub**

```ts
console.info("[OgameX] runtime loaded; build", new Date().toISOString());
```

- [ ] **Step 5: Run `pnpm install` + `pnpm --filter @ogamex/runtime-userscript build`**

Expected: `packages/runtime-userscript/dist/ogame-runtime.user.js` exists with banner.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-userscript/
git commit -m "feat(runtime-userscript): package scaffold + rollup config + stub entry"
```

### Task M0.6 — Plugin package stub

**Files:**
- Create: `packages/openclaw-plugin/{package.json, tsconfig.json, src/index.ts, openclaw.plugin.json}`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@ogamex/openclaw-plugin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --root .",
    "plugin:build": "openclaw plugins build --entry ./dist/index.js",
    "plugin:validate": "openclaw plugins validate ."
  },
  "dependencies": {
    "@ogamex/shared": "workspace:*",
    "typebox": "^0.34.0",
    "better-sqlite3": "^11.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "openclaw": ">=2026.5.17",
    "@types/ws": "^8.5.0"
  },
  "peerDependencies": { "openclaw": ">=2026.5.17" }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"] }
```

- [ ] **Step 3: `src/index.ts` stub**

```ts
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: "ogamex",
  name: "OgameX",
  description: "Ogame automation: goal tasks, daily ambient, emergency response.",
  configSchema: Type.Object({
    discordChannelId: Type.Optional(Type.String()),
    wsPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
    bridgeToken: Type.Optional(Type.String()),
  }),
  tools: (tool) => [
    tool({
      name: "ogame_ping",
      description: "Health check.",
      parameters: Type.Object({}),
      execute: () => ({ ok: true, ts: Date.now() }),
    }),
  ],
});
```

- [ ] **Step 4: `openclaw.plugin.json`** (will be regenerated; commit a hand-written minimal one)

```json
{
  "id": "ogamex",
  "name": "OgameX",
  "description": "Ogame automation",
  "activation": { "onStartup": true },
  "enabledByDefault": true,
  "startup": { "sidecar": true },
  "configSchema": { "type": "object" }
}
```

- [ ] **Step 5: Verify build**

```bash
pnpm install
pnpm --filter @ogamex/openclaw-plugin build
```

Expected: `packages/openclaw-plugin/dist/index.js` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-plugin/
git commit -m "feat(openclaw-plugin): package scaffold + defineToolPlugin stub with ogame_ping"
```

---

## M1 — Probes & State Extraction (userscript)

**Goal:** From the live ogame DOM/XHR, produce a typed `WorldState` snapshot continuously and reliably. Token extraction works (foundation for M2 Fleet API).

**Acceptance criteria:**
- Running the userscript on ogame produces a valid `WorldState` JSON in `localStorage` within 30s of load.
- `extractor.failures` counter remains 0 on the default ogame layout (verified against fixture HTML).
- `token_manager.getFreshToken()` returns a non-empty string within 5s of page load.

### Task M1.1 — EventBus

**Files:**
- Create: `packages/runtime-userscript/src/event_bus.ts`, `test/event_bus.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/event_bus.js";

describe("EventBus", () => {
  it("delivers events to subscribers", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on("resource_arrived", fn);
    bus.emit("resource_arrived", { planet: "母星", delta: 100 });
    expect(fn).toHaveBeenCalledWith({ planet: "母星", delta: 100 });
  });
  it("unsubscribes cleanly", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on("x", fn);
    off();
    bus.emit("x", 1);
    expect(fn).not.toHaveBeenCalled();
  });
  it("catches subscriber errors without breaking others", () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.on("e", () => { throw new Error("bad"); });
    bus.on("e", good);
    bus.emit("e", 42);
    expect(good).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implementation**

```ts
export type Handler<T = unknown> = (payload: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on<T = unknown>(type: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler as Handler);
    return () => this.off(type, handler);
  }

  off<T = unknown>(type: string, handler: Handler<T>): void {
    this.handlers.get(type)?.delete(handler as Handler);
  }

  emit<T = unknown>(type: string, payload: T): void {
    for (const h of this.handlers.get(type) ?? []) {
      try { void h(payload); } catch (e) { console.error(`[EventBus] handler error on ${type}`, e); }
    }
  }
}

export const bus = new EventBus();   // singleton
```

- [ ] **Step 3: Run tests → PASS**

- [ ] **Step 4: Commit**

```bash
git add packages/runtime-userscript/src/event_bus.ts packages/runtime-userscript/test/event_bus.test.ts
git commit -m "feat(userscript): EventBus singleton with error isolation"
```

### Task M1.2 — DOM extractors: resources

**Files:**
- Create: `src/probes/extractors/resources.ts`, `test/fixtures/ogame_html/overview.html`, `test/probes/extractors/resources.test.ts`

- [ ] **Step 1: Capture a real ogame overview HTML fixture**

(parallel-safe) Use OpenClaw `browser` ext to snapshot a logged-in overview page. Save HTML to `test/fixtures/ogame_html/overview.html`. **Redact** player name + alliance + coords for non-母星 entries. Keep enough to test selectors.

If you can't capture a real one yet, hand-write a minimal sample:

```html
<!doctype html><html><body>
<div id="resources_metal" data-raw="1234567">1.234.567</div>
<div id="resources_crystal" data-raw="891011">891.011</div>
<div id="resources_deuterium" data-raw="22222">22.222</div>
<div id="resources_energy" data-raw="500">500</div>
<div id="metal_box" title="Capacity: 5000000 / Production per hour: 80000"></div>
<div id="crystal_box" title="Capacity: 2500000 / Production per hour: 40000"></div>
<div id="deuterium_box" title="Capacity: 1000000 / Production per hour: 12000"></div>
</body></html>
```

- [ ] **Step 2: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { extractResources, extractStorage, extractProduction } from "../../../src/probes/extractors/resources.js";

const html = readFileSync(new URL("../../fixtures/ogame_html/overview.html", import.meta.url), "utf8");
const dom = new JSDOM(html);
const doc = dom.window.document;

describe("extractResources", () => {
  it("reads raw data-raw attribute", () => {
    const r = extractResources(doc);
    expect(r).toEqual({ m: 1234567, c: 891011, d: 22222, e: 500 });
  });
});

describe("extractStorage + extractProduction", () => {
  it("parses tooltip title", () => {
    expect(extractStorage(doc)).toEqual({ m_max: 5000000, c_max: 2500000, d_max: 1000000 });
    expect(extractProduction(doc)).toEqual({ m_h: 80000, c_h: 40000, d_h: 12000 });
  });
});
```

Add `jsdom` to userscript devDependencies.

- [ ] **Step 3: Implement**

```ts
import type { Resources, Storage, Production } from "@ogamex/shared";

export function extractResources(doc: Document): Resources | null {
  const rawOrNull = (id: string): number | null => {
    const el = doc.getElementById(id);
    if (!el) return null;
    const raw = el.getAttribute("data-raw");
    if (raw && !isNaN(Number(raw))) return Math.floor(Number(raw));
    const text = el.textContent ?? "";
    const stripped = text.replace(/[^0-9]/g, "");
    return stripped ? parseInt(stripped, 10) : null;
  };
  const m = rawOrNull("resources_metal");
  const c = rawOrNull("resources_crystal");
  const d = rawOrNull("resources_deuterium");
  const e = rawOrNull("resources_energy");
  if (m === null || c === null || d === null) return null;
  return { m, c, d, e: e ?? 0 };
}

function parseTitle(text: string): { max?: number; perHour?: number } {
  const max = text.match(/Capacity:\s*([\d,.]+)/i)?.[1];
  const perH = text.match(/Production per hour:\s*([\d,.]+)/i)?.[1];
  return {
    max: max ? parseInt(max.replace(/\D/g, ""), 10) : undefined,
    perHour: perH ? parseInt(perH.replace(/\D/g, ""), 10) : undefined,
  };
}

export function extractStorage(doc: Document): Storage | null {
  const m = parseTitle(doc.getElementById("metal_box")?.getAttribute("title") ?? "");
  const c = parseTitle(doc.getElementById("crystal_box")?.getAttribute("title") ?? "");
  const d = parseTitle(doc.getElementById("deuterium_box")?.getAttribute("title") ?? "");
  if (!m.max || !c.max || !d.max) return null;
  return { m_max: m.max, c_max: c.max, d_max: d.max };
}

export function extractProduction(doc: Document): Production | null {
  const m = parseTitle(doc.getElementById("metal_box")?.getAttribute("title") ?? "");
  const c = parseTitle(doc.getElementById("crystal_box")?.getAttribute("title") ?? "");
  const d = parseTitle(doc.getElementById("deuterium_box")?.getAttribute("title") ?? "");
  if (m.perHour === undefined || c.perHour === undefined || d.perHour === undefined) return null;
  return { m_h: m.perHour, c_h: c.perHour, d_h: d.perHour };
}
```

- [ ] **Step 4: Run tests → PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-userscript/src/probes/extractors/resources.ts \
        packages/runtime-userscript/test/probes/extractors/resources.test.ts \
        packages/runtime-userscript/test/fixtures/ogame_html/overview.html \
        packages/runtime-userscript/package.json
git commit -m "feat(userscript/extractors): resources + storage + production from DOM"
```

### Task M1.3 — DOM extractor: events list (hostile detection)

Same pattern. Test against `fixtures/ogame_html/events_hostile.html` containing:

```html
<table id="eventContent">
  <tr class="eventFleet hostile" data-mission-type="1" data-arrival-time="1716200000"
      data-event-id="3142" data-coords-origin="[3:42:7]" data-coords-dest="[1:42:8]">
    <td class="originFleet">...</td>
    <td class="ships">?</td>
  </tr>
  <tr class="eventFleet" data-mission-type="15" data-arrival-time="1716199000"
      data-event-id="3143">expedition return</tr>
</table>
```

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { extractIncomingEvents } from "../../../src/probes/extractors/events.js";

const dom = new JSDOM(readFileSync(new URL("../../fixtures/ogame_html/events_hostile.html", import.meta.url), "utf8"));
describe("extractIncomingEvents", () => {
  it("flags hostile attack", () => {
    const evs = extractIncomingEvents(dom.window.document);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({
      id: "3142", type: "attack", hostile: true,
      from: [3, 42, 7], to: [1, 42, 8], arrives_at: 1716200000,
      ships_count: "?",
    });
    expect(evs[1]).toMatchObject({ id: "3143", type: "return", hostile: false });
  });
});
```

- [ ] **Step 2: Implement extractor**

```ts
import type { IncomingEvent, Coords } from "@ogamex/shared";

const MISSION_TYPE_MAP: Record<string, IncomingEvent["type"]> = {
  "1": "attack", "2": "attack", "3": "transport", "4": "deploy",
  "5": "transport", "6": "spy", "7": "transport", "8": "transport",
  "15": "return", // expedition events listed here are returns
};

function parseCoords(s: string): Coords | null {
  const m = s.match(/\[(\d+):(\d+):(\d+)\]/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] as Coords;
}

export function extractIncomingEvents(doc: Document): IncomingEvent[] {
  const rows = Array.from(doc.querySelectorAll<HTMLElement>("#eventContent tr.eventFleet"));
  const result: IncomingEvent[] = [];
  for (const row of rows) {
    const id = row.getAttribute("data-event-id");
    const mtype = row.getAttribute("data-mission-type") ?? "0";
    const ts = parseInt(row.getAttribute("data-arrival-time") ?? "0", 10);
    if (!id || !ts) continue;
    const hostile = row.classList.contains("hostile") || row.classList.contains("partnerInfo") === false && mtype === "1";
    const from = parseCoords(row.getAttribute("data-coords-origin") ?? "") ?? [0,0,0] as Coords;
    const to   = parseCoords(row.getAttribute("data-coords-dest")   ?? "") ?? [0,0,0] as Coords;
    const shipsText = row.querySelector(".ships")?.textContent?.trim() ?? "?";
    const ships_count: number | "?" = shipsText === "?" ? "?" : parseInt(shipsText.replace(/\D/g, ""), 10) || "?";
    result.push({
      id, type: MISSION_TYPE_MAP[mtype] ?? "unknown",
      hostile, from, to, arrives_at: ts, ships_count,
    });
  }
  return result;
}
```

- [ ] **Step 3: Run → PASS. Commit.**

```bash
git add packages/runtime-userscript/src/probes/extractors/events.ts packages/runtime-userscript/test/probes/extractors/events.test.ts packages/runtime-userscript/test/fixtures/ogame_html/events_hostile.html
git commit -m "feat(userscript/extractors): incoming events with hostile flag"
```

### Task M1.4 — Token extractor (foundation for M2 Fleet API)

**Files:**
- Create: `src/probes/extractors/token.ts`, test

ogame stores its CSRF token in multiple places. Try DOM input first, then `window.ogameMeta`/`window.token` JS globals, then via `XHR-Header` of recent ajax requests.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractToken } from "../../../src/probes/extractors/token.js";

describe("extractToken", () => {
  it("reads from input[name=token]", () => {
    const dom = new JSDOM(`<form><input name="token" value="abc123"></form>`);
    expect(extractToken(dom.window.document, dom.window as any)).toBe("abc123");
  });
  it("falls back to window.ogameMeta", () => {
    const dom = new JSDOM(`<html></html>`);
    (dom.window as any).ogameMeta = { token: "from-meta" };
    expect(extractToken(dom.window.document, dom.window as any)).toBe("from-meta");
  });
  it("returns null when not found", () => {
    const dom = new JSDOM(`<html></html>`);
    expect(extractToken(dom.window.document, dom.window as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface OgameWindow extends Window {
  ogameMeta?: { token?: string };
  token?: string;
  csrfToken?: string;
}

export function extractToken(doc: Document, win: OgameWindow): string | null {
  // 1. Hidden form input
  const input = doc.querySelector<HTMLInputElement>('input[name="token"]');
  if (input?.value) return input.value;

  // 2. Common JS globals
  if (win.ogameMeta?.token) return win.ogameMeta.token;
  if (win.token) return win.token;
  if (win.csrfToken) return win.csrfToken;

  // 3. Meta tag fallback
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="ogame-token"]');
  if (meta?.content) return meta.content;

  return null;
}
```

- [ ] **Step 3: Run → PASS. Commit.**

### Task M1.5 — Planet list extractor

Same pattern; reads `#planetList .smallplanet` sidebar, extracts coords + name + id.

- [ ] **Step 1-5:** failing test → impl → pass → commit. Test against `fixtures/ogame_html/planetlist.html` (3 planets including a moon).

```ts
export function extractPlanets(doc: Document): Pick<Planet, "id" | "name" | "coords" | "type">[] {
  const out: Pick<Planet, "id" | "name" | "coords" | "type">[] = [];
  for (const li of doc.querySelectorAll<HTMLElement>("#planetList .smallplanet, #planetList .moonlink")) {
    const id = li.id?.replace(/^planet-/, "") || li.getAttribute("data-planet-id");
    const name = li.querySelector(".planet-name")?.textContent?.trim();
    const coordsText = li.querySelector(".planet-koords")?.textContent ?? "";
    const m = coordsText.match(/\[(\d+):(\d+):(\d+)\]/);
    if (!id || !name || !m) continue;
    out.push({
      id, name,
      coords: [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] as Coords,
      type: li.classList.contains("moonlink") ? "moon" : "planet",
    });
  }
  return out;
}
```

### Task M1.6 — Fleet movement extractor

Reads `#movement` page, extracts active fleets. Test fixture `fleetmovement.html`.

### Task M1.7 — XHR hook

**Files:**
- Create: `src/probes/xhr_hook.ts`, `test/probes/xhr_hook.test.ts`

Hooks `window.fetch` + `XMLHttpRequest.prototype.send` to intercept ogame ajax responses for `eventList`, `fetchResources`, `sendFleet` callbacks. Emits events on bus.

- [ ] **Step 1: Failing test (using vitest happy-dom env or jsdom mock)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installXhrHook } from "../../src/probes/xhr_hook.js";
import { EventBus } from "../../src/event_bus.js";

describe("xhr_hook", () => {
  it("emits xhr.response when fetch returns", async () => {
    const bus = new EventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const ctx = { fetch: fakeFetch };
    installXhrHook(ctx as any, bus);
    await ctx.fetch("/game/index.php?page=ingame&component=eventList&ajax=1");
    expect(emitSpy).toHaveBeenCalledWith("xhr.response", expect.objectContaining({
      url: expect.stringContaining("eventList"),
      body: expect.objectContaining({ ok: 1 }),
    }));
  });
});
```

- [ ] **Step 2: Implementation**

```ts
import type { EventBus } from "../event_bus.js";

interface XhrContext { fetch: typeof fetch; }

export function installXhrHook(ctx: XhrContext, bus: EventBus): void {
  const origFetch = ctx.fetch.bind(ctx);
  ctx.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const res = await origFetch(input as any, init);
    try {
      if (url.includes("/game/index.php")) {
        const clone = res.clone();
        const ct = clone.headers.get("content-type") ?? "";
        let body: unknown = null;
        if (ct.includes("json")) body = await clone.json().catch(() => null);
        else body = await clone.text().catch(() => null);
        bus.emit("xhr.response", { url, status: res.status, body });
      }
    } catch { /* never break fetch */ }
    return res;
  }) as typeof fetch;
}
```

- [ ] **Step 3: Run → PASS. Commit.**

### Task M1.8 — MutationObserver wrap

**Files:**
- Create: `src/probes/mutation_observer.ts`, test

Observes `#eventContent`, `#resources_*`, `.fleet_movement` for in-page mutations and emits `dom.changed` events to bus.

- [ ] **Step 1: Test** (jsdom-based, dispatch DOM changes manually)

```ts
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { EventBus } from "../../src/event_bus.js";
import { startMutationObserver } from "../../src/probes/mutation_observer.js";

describe("MutationObserver", () => {
  it("emits dom.changed on watched targets", async () => {
    const dom = new JSDOM(`<div id="eventContent"></div><div id="resources_metal" data-raw="100">100</div>`);
    const bus = new EventBus();
    const spy = vi.spyOn(bus, "emit");
    startMutationObserver(dom.window.document, bus);
    const ec = dom.window.document.getElementById("eventContent")!;
    ec.innerHTML = "<tr class='eventFleet'></tr>";
    await new Promise(r => setTimeout(r, 50));
    expect(spy).toHaveBeenCalledWith("dom.changed", expect.objectContaining({ targetId: "eventContent" }));
  });
});
```

- [ ] **Step 2: Impl**

```ts
import type { EventBus } from "../event_bus.js";

const WATCHED = ["eventContent", "resources_metal", "resources_crystal", "resources_deuterium",
                 "resources_energy", "movement", "fleet1", "fleet2", "fleet3", "fleet4"];

export function startMutationObserver(doc: Document, bus: EventBus): () => void {
  const observed: { id: string; obs: MutationObserver }[] = [];
  for (const id of WATCHED) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const obs = new (doc.defaultView as any).MutationObserver((mutations: MutationRecord[]) => {
      bus.emit("dom.changed", { targetId: id, mutationCount: mutations.length });
    });
    obs.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
    observed.push({ id, obs });
  }
  return () => observed.forEach(({ obs }) => obs.disconnect());
}
```

- [ ] **Step 3-4: Run → PASS. Commit.**

### Task M1.9 — StateStore + IndexedDB

**Files:**
- Create: `src/state_store.ts`, `src/store/indexed_db.ts`, tests

In-memory `WorldState` mirror. Persist to IndexedDB via simple key-value wrapper. Recompose state on bus events.

- [ ] **Step 1-5:** TDD pattern.

Key API:

```ts
class StateStore {
  state: WorldState;
  setPartial(patch: Partial<WorldState>): void;        // emits state.updated
  getSnapshot(): WorldState;
  persist(): Promise<void>;                            // IndexedDB
  hydrate(): Promise<void>;
}
```

### Task M1.10 — main.ts wires probes → bus → state

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Wire everything**

```ts
import { bus } from "./event_bus.js";
import { StateStore } from "./state_store.js";
import { startMutationObserver } from "./probes/mutation_observer.js";
import { installXhrHook } from "./probes/xhr_hook.js";
import { extractResources, extractStorage, extractProduction } from "./probes/extractors/resources.js";
import { extractIncomingEvents } from "./probes/extractors/events.js";
import { extractPlanets } from "./probes/extractors/planets.js";
import { extractToken } from "./probes/extractors/token.js";

const store = new StateStore();

async function boot() {
  await store.hydrate();
  startMutationObserver(document, bus);
  installXhrHook(window, bus);

  // initial extraction
  const r = extractResources(document);
  const s = extractStorage(document);
  const p = extractProduction(document);
  const events = extractIncomingEvents(document);
  const planets = extractPlanets(document);
  const tok = extractToken(document, window as any);

  console.info("[OgameX] boot snapshot", { r, s, p, events: events.length, planets: planets.length, token: tok ? "(ok)" : "(missing)" });

  // listen to dom changes → re-extract
  bus.on("dom.changed", ({ targetId }: { targetId: string }) => {
    if (targetId.startsWith("resources_")) {
      const cur = extractResources(document);
      if (cur && store.state.planets[0]) {
        // for now, update first planet's resources only; M3 generalizes
        store.setPartial({ planets: [{ ...store.state.planets[0], resources: cur }, ...store.state.planets.slice(1)] });
      }
    }
    if (targetId === "eventContent") {
      const evs = extractIncomingEvents(document);
      store.setPartial({ events_incoming: evs });
    }
  });
}

boot().catch(e => console.error("[OgameX] boot failed", e));
```

- [ ] **Step 2: Build + smoke test in real Chrome**

Run: `pnpm --filter @ogamex/runtime-userscript build`. Load `dist/ogame-runtime.user.js` in Tampermonkey, open ogame. Check console for "[OgameX] boot snapshot {...}".

- [ ] **Step 3: Commit + M1 done**

```bash
git add packages/runtime-userscript/src/main.ts
git commit -m "feat(userscript): wire probes+bus+state, smoke-test on ogame"
```

---

## M2 — Emergency Fleet Save + Fleet API (命门)

**Goal:** Detect hostile attack → run three-case decision → dispatch fleet save via direct ogame ajax API → monitor in-flight → recall after threat clears → return home safely. **End-to-end ≤500ms from `hostile_event` to `fetch sendFleet` success.**

**Acceptance criteria:**
- Manual simulation: feed a hostile event into the bus → fleet save fires within 500ms (in browser timing test) → API returns success → recall fires after threat clears.
- All three cases (A: moon→debris, B: planet+moon→moon, C: planet-no-moon→local-debris) have unit tests.
- State machine covers: launch failure, in-flight new-threat detection, multi-wave attacks.
- Recycler is forced into every emergency fleet (except daily expeditions).
- Recall fires correctly *before* arrival.

### Task M2.1 — Token manager (cache + self-heal)

**Files:**
- Create: `src/api/token_manager.ts`, test

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { TokenManager } from "../../src/api/token_manager.js";

describe("TokenManager", () => {
  it("returns cached token until expired", () => {
    const tm = new TokenManager(() => "tok-1", { ttlMs: 10000 });
    expect(tm.getFreshToken()).toBe("tok-1");
  });
  it("self-heals via refresh callback on invalidate()", async () => {
    let n = 0;
    const tm = new TokenManager(() => `tok-${++n}`);
    expect(tm.getFreshToken()).toBe("tok-1");
    await tm.invalidate();
    expect(tm.getFreshToken()).toBe("tok-2");
  });
  it("throws when refresh fails", async () => {
    const tm = new TokenManager(() => { throw new Error("no DOM"); });
    expect(() => tm.getFreshToken()).toThrow(/no DOM/);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface TokenManagerOptions {
  ttlMs?: number;                    // default 30 min
  prewarmIntervalMs?: number;        // default 60 min (random jitter recommended in caller)
}

export class TokenManager {
  private cached: { value: string; fetchedAt: number } | null = null;
  private readonly ttlMs: number;
  constructor(
    private readonly refresh: () => string,
    opts: TokenManagerOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
  }

  getFreshToken(): string {
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt < this.ttlMs) {
      return this.cached.value;
    }
    const value = this.refresh();
    if (!value) throw new Error("token refresh returned empty");
    this.cached = { value, fetchedAt: now };
    return value;
  }

  async invalidate(): Promise<void> {
    this.cached = null;
  }

  /** Force-update from explicit value, e.g. after a successful navigation */
  set(value: string): void {
    if (!value) return;
    this.cached = { value, fetchedAt: Date.now() };
  }
}
```

- [ ] **Step 3: Pass + commit**

```bash
git add packages/runtime-userscript/src/api/token_manager.ts packages/runtime-userscript/test/api/token_manager.test.ts
git commit -m "feat(userscript/api): TokenManager with TTL cache + invalidate self-heal"
```

### Task M2.2 — Fleet API: sendFleet

**Files:**
- Create: `src/api/fleet_api.ts`, test (with mocked fetch)

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { sendFleet } from "../../src/api/fleet_api.js";
import { TokenManager } from "../../src/api/token_manager.js";
import { Mission } from "@ogamex/shared";

describe("sendFleet", () => {
  it("POSTs URL-encoded with token + ship counts + cargo; rotates token from newAjaxToken on success", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, fleetIdToReturn: 42, newAjaxToken: "tok-X-NEW" }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const tm = new TokenManager(() => "tok-X");
    const setSpy = vi.spyOn(tm, "set");

    const result = await sendFleet(
      { ships: { smallCargo: 50, recycler: 1 }, cargo: { m: 1000, c: 0, d: 500 },
        coords: [1, 42, 8], destType: 3, mission: Mission.TRANSPORT, speed: 10 },
      { fetch: fetchMock as any, token: tm }
    );

    expect(result.fleetId).toBe(42);
    expect(setSpy).toHaveBeenCalledWith("tok-X-NEW");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain("action=sendFleet");
    expect(url).toContain("ajax=1");
    expect(url).toContain("asJson=1");
    expect((opts as any).method).toBe("POST");
    const body = new URLSearchParams((opts as any).body);
    expect(body.get("token")).toBe("tok-X");
    expect(body.get("galaxy")).toBe("1");
    expect(body.get("system")).toBe("42");
    expect(body.get("position")).toBe("8");
    expect(body.get("type")).toBe("3");
    expect(body.get("mission")).toBe("3");
    expect(body.get("speed")).toBe("10");
    expect(body.get("am202")).toBe("50");      // smallCargo
    expect(body.get("am209")).toBe("1");       // recycler
    expect(body.get("metal")).toBe("1000");
    expect(body.get("deuterium")).toBe("500");
  });

  it("invalidates token + retries once on 'token expired' response", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(
        JSON.stringify({ success: false, message: "Invalid token" }), { status: 200 });
      return new Response(JSON.stringify({ success: true, fleetIdToReturn: 100 }), { status: 200 });
    });
    const tm = new TokenManager(() => `t${call}`);
    const result = await sendFleet(
      { ships: { smallCargo: 1, recycler: 1 }, cargo: { m: 0, c: 0, d: 0 },
        coords: [1, 1, 1], destType: 1, mission: 8, speed: 1 },
      { fetch: fetchMock as any, token: tm }
    );
    expect(result.fleetId).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws FleetApiError on persistent failure", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: false, message: "Not enough deuterium" }), { status: 200 }));
    const tm = new TokenManager(() => "t1");
    await expect(sendFleet(
      { ships: { smallCargo: 1, recycler: 1 }, cargo: { m: 0, c: 0, d: 0 },
        coords: [1, 1, 1], destType: 1, mission: 8, speed: 1 },
      { fetch: fetchMock as any, token: tm }
    )).rejects.toThrow(/Not enough deuterium/);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { SHIP_IDS, type ShipKey, type ShipCount, type Coords, type Resources, type MissionCode } from "@ogamex/shared";
import type { TokenManager } from "./token_manager.js";

export interface SendFleetParams {
  ships: ShipCount;
  cargo: Resources;
  coords: Coords;
  destType: 1 | 2 | 3;       // 1=planet, 2=debris, 3=moon
  mission: MissionCode;
  speed: number;             // 1..10
  holdingTime?: number;      // for ACS defend / expedition duration
}

export interface SendFleetCtx {
  fetch: typeof fetch;
  token: TokenManager;
  endpoint?: string;
}

export interface SendFleetResult {
  fleetId: number;
  raw: { success: boolean; fleetIdToReturn?: number; message?: string };
}

export class FleetApiError extends Error {
  constructor(message: string, public readonly raw?: unknown) { super(message); }
}

const DEFAULT_ENDPOINT = "/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1";

function buildBody(p: SendFleetParams, token: string): URLSearchParams {
  const body = new URLSearchParams();
  body.set("token", token);
  body.set("galaxy", String(p.coords[0]));
  body.set("system", String(p.coords[1]));
  body.set("position", String(p.coords[2]));
  body.set("type", String(p.destType));
  body.set("mission", String(p.mission));
  body.set("speed", String(p.speed));
  body.set("metal", String(p.cargo.m));
  body.set("crystal", String(p.cargo.c));
  body.set("deuterium", String(p.cargo.d));
  if (p.holdingTime !== undefined) body.set("holdingtime", String(p.holdingTime));
  for (const [shipKey, count] of Object.entries(p.ships)) {
    if (!count || count <= 0) continue;
    const id = SHIP_IDS[shipKey as ShipKey];
    if (id === undefined) continue;
    body.set(`am${id}`, String(count));
  }
  return body;
}

const TOKEN_INVALID_RE = /invalid token|csrf|session expired/i;

export async function sendFleet(p: SendFleetParams, ctx: SendFleetCtx): Promise<SendFleetResult> {
  const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
  let token = ctx.token.getFreshToken();
  let body = buildBody(p, token);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await ctx.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
      credentials: "same-origin",
    });
    if (!res.ok) throw new FleetApiError(`HTTP ${res.status}`);
    const json = await res.json() as SendFleetResult["raw"] & { newAjaxToken?: string };
    if (json.success && json.fleetIdToReturn !== undefined) {
      if (json.newAjaxToken) ctx.token.set(json.newAjaxToken);
      return { fleetId: json.fleetIdToReturn, raw: json };
    }
    if (attempt === 1 && json.message && TOKEN_INVALID_RE.test(json.message)) {
      await ctx.token.invalidate();
      token = ctx.token.getFreshToken();
      body = buildBody(p, token);
      continue;
    }
    throw new FleetApiError(json.message ?? "unknown failure", json);
  }
  throw new FleetApiError("retry exhausted");
}
```

- [ ] **Step 3: Run → 3 tests PASS. Commit.**

```bash
git add packages/runtime-userscript/src/api/fleet_api.ts packages/runtime-userscript/test/api/fleet_api.test.ts
git commit -m "feat(userscript/api): sendFleet with token self-heal retry + structured errors"
```

### Task M2.3 — Fleet API: recall

**Files:**
- Append to: `src/api/fleet_api.ts`, test

> Real protocol observed in `fixtures/ogame_html/movement.html` global JS:
> - URL: `&page=ingame&component=movement&action=recallFleetAjax&ajax=1&asJson=1`
> - Body: `{ fleetId, token }` URL-encoded
> - Response: `{ success: boolean, newAjaxToken: string, ...}` — **token rotates on every recall** and MUST be fed back to `TokenManager.set()`

- [ ] **Step 1: Failing test**

```ts
describe("recallFleet", () => {
  it("POSTs fleetId=<id> + token; updates TokenManager with newAjaxToken from response", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, newAjaxToken: "tok-Z-NEW" }), { status: 200 }));
    const tm = new TokenManager(() => "tok-Z");
    const setSpy = vi.spyOn(tm, "set");
    await recallFleet(42, { fetch: fetchMock as any, token: tm });
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain("component=movement");
    expect(url).toContain("action=recallFleetAjax");
    expect(url).toContain("asJson=1");
    const body = new URLSearchParams((opts as any).body);
    expect(body.get("fleetId")).toBe("42");
    expect(body.get("token")).toBe("tok-Z");
    expect(setSpy).toHaveBeenCalledWith("tok-Z-NEW");
  });

  it("invalidates token + retries once on invalid-token response", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(
        JSON.stringify({ success: false, message: "Invalid token" }), { status: 200 });
      return new Response(JSON.stringify({ success: true, newAjaxToken: "tok-NEW" }), { status: 200 });
    });
    const tm = new TokenManager(() => `t${call}`);
    await recallFleet(7, { fetch: fetchMock as any, token: tm });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Implement**

```ts
const RECALL_ENDPOINT = "/game/index.php?page=ingame&component=movement&action=recallFleetAjax&ajax=1&asJson=1";

interface RecallResponse {
  success: boolean;
  newAjaxToken?: string;
  message?: string;
}

export async function recallFleet(fleetId: number, ctx: SendFleetCtx): Promise<void> {
  let token = ctx.token.getFreshToken();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = new URLSearchParams();
    body.set("fleetId", String(fleetId));
    body.set("token", token);
    const res = await ctx.fetch(RECALL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
      credentials: "same-origin",
    });
    if (!res.ok) throw new FleetApiError(`HTTP ${res.status}`);
    const json = await res.json() as RecallResponse;
    if (json.success) {
      if (json.newAjaxToken) ctx.token.set(json.newAjaxToken);
      return;
    }
    if (attempt === 1 && json.message && TOKEN_INVALID_RE.test(json.message)) {
      await ctx.token.invalidate();
      token = ctx.token.getFreshToken();
      continue;
    }
    throw new FleetApiError(json.message ?? "recall failed", json);
  }
}
```

- [ ] **Step 3: Pass + commit**

```bash
git add packages/runtime-userscript/src/api/fleet_api.ts packages/runtime-userscript/test/api/fleet_api.test.ts
git commit -m "feat(userscript/api): recallFleet via recallFleetAjax with newAjaxToken rotation" -- packages/runtime-userscript/src/api/fleet_api.ts packages/runtime-userscript/test/api/fleet_api.test.ts
```

### Task M2.4 — Three-case decider

**Files:**
- Create: `src/emergency/case_decider.ts`, test

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { decideCase, type CaseDecision } from "../../src/emergency/case_decider.js";
import type { WorldState } from "@ogamex/shared";

const baseState = (overrides: any = {}): WorldState => ({
  server: { universe: "uni1", speed: 1 },
  player: { id: "p1", name: "n", alliance: null },
  planets: [], research: { levels: {}, queue: null }, fleets_outbound: [],
  events_incoming: [], last_update: 0, page_snapshots: {}, ...overrides,
});

describe("decideCase", () => {
  it("Case A: fleet on moon → recycle to debris 10%", () => {
    const state = baseState({
      planets: [
        { id: "m1", name: "母月", coords: [1,42,8], type: "moon",
          resources: { m: 1000, c: 1000, d: 1000 }, storage: { m_max: 1e9, c_max: 1e9, d_max: 1e9 },
          production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, queue: null,
          shipyard_q: null, defense_q: null,
          ships: { smallCargo: 100, recycler: 5 }, defense: {} },
      ],
    });
    const d = decideCase(state, "m1", state.planets);
    expect(d).toMatchObject({
      case: "A",
      mission: 8,                   // RECYCLE
      destType: 2,                  // debris
      destCoords: [1, 42, 8],
      speed: 1,                     // 10%
    });
    expect(d.ships.recycler).toBeGreaterThanOrEqual(1);
  });

  it("Case B: fleet on planet + moon exists at same coords → transport to moon 100%", () => {
    const planet = { id: "p1", name: "母星", coords: [1,42,8] as const, type: "planet" as const,
      resources: { m: 5e5, c: 3e5, d: 1e5 }, storage: { m_max: 1e9, c_max: 1e9, d_max: 1e9 },
      production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, queue: null,
      shipyard_q: null, defense_q: null,
      ships: { smallCargo: 200, lightFighter: 500, recycler: 3 }, defense: {} };
    const moon = { ...planet, id: "m1", name: "母月", type: "moon" as const, ships: {} };
    const d = decideCase(baseState({ planets: [planet, moon] }), "p1", [planet, moon]);
    expect(d.case).toBe("B");
    expect(d.mission).toBe(3);      // TRANSPORT
    expect(d.destType).toBe(3);     // moon
    expect(d.speed).toBe(10);
    expect(d.ships.recycler).toBeGreaterThanOrEqual(1);
  });

  it("Case C: fleet on planet, no moon → local debris 10%", () => {
    const planet = { id: "p2", name: "辅1", coords: [2,100,8] as const, type: "planet" as const,
      resources: { m: 1e5, c: 1e5, d: 5e4 }, storage: { m_max: 1e9, c_max: 1e9, d_max: 1e9 },
      production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, queue: null,
      shipyard_q: null, defense_q: null,
      ships: { smallCargo: 100, recycler: 2 }, defense: {} };
    const d = decideCase(baseState({ planets: [planet] }), "p2", [planet]);
    expect(d.case).toBe("C");
    expect(d.mission).toBe(8);      // RECYCLE
    expect(d.destType).toBe(2);     // debris
    expect(d.destCoords).toEqual([2, 100, 8]);
    expect(d.speed).toBe(1);
    expect(d.ships.recycler).toBeGreaterThanOrEqual(1);
  });

  it("includes ALL ships from source", () => {
    const planet = { id: "p1", name: "母星", coords: [1,42,8] as const, type: "planet" as const,
      resources: { m: 0, c: 0, d: 0 }, storage: { m_max: 0, c_max: 0, d_max: 0 },
      production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, queue: null,
      shipyard_q: null, defense_q: null,
      ships: { smallCargo: 50, lightFighter: 200, heavyFighter: 30, recycler: 1 }, defense: {} };
    const d = decideCase(baseState({ planets: [planet] }), "p1", [planet]);
    expect(d.ships).toEqual({ smallCargo: 50, lightFighter: 200, heavyFighter: 30, recycler: 1 });
  });

  it("includes all available resources in cargo", () => {
    const planet = { id: "p1", name: "母星", coords: [1,42,8] as const, type: "planet" as const,
      resources: { m: 1234567, c: 891011, d: 22222 }, storage: { m_max: 1e9, c_max: 1e9, d_max: 1e9 },
      production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, queue: null,
      shipyard_q: null, defense_q: null,
      ships: { recycler: 1 }, defense: {} };
    const d = decideCase(baseState({ planets: [planet] }), "p1", [planet]);
    expect(d.cargo).toEqual({ m: 1234567, c: 891011, d: 22222 });
  });

  it("throws when source has no recyclers (degradation handled by caller)", () => {
    const planet = { id: "p1", name: "母星", coords: [1,42,8] as const, type: "planet" as const,
      resources: { m: 0, c: 0, d: 0 }, storage: { m_max: 0, c_max: 0, d_max: 0 },
      production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, queue: null,
      shipyard_q: null, defense_q: null,
      ships: { smallCargo: 100 }, defense: {} };
    expect(() => decideCase(baseState({ planets: [planet] }), "p1", [planet])).toThrow(/no recycler/i);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import type { Coords, ShipCount, WorldState, Planet, Resources, MissionCode } from "@ogamex/shared";
import { Mission } from "@ogamex/shared";

export type CaseLetter = "A" | "B" | "C";

export interface CaseDecision {
  case: CaseLetter;
  sourcePlanetId: string;
  destCoords: Coords;
  destType: 1 | 2 | 3;
  mission: MissionCode;
  speed: number;
  ships: ShipCount;
  cargo: Resources;
  reason: string;
}

function sameCoords(a: Coords, b: Coords): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function decideCase(state: WorldState, sourceId: string, allPlanets: Planet[]): CaseDecision {
  const source = allPlanets.find(p => p.id === sourceId);
  if (!source) throw new Error(`source planet ${sourceId} not found`);

  // Ensure recycler available — caller decides degradation if missing
  const recyclerCount = source.ships.recycler ?? 0;
  const otherShips = Object.entries(source.ships)
    .filter(([k, v]) => v && v > 0).length;
  if (recyclerCount === 0 && otherShips === 0) {
    throw new Error(`no ships available at ${source.name}`);
  }
  if (recyclerCount === 0) {
    throw new Error(`no recycler at ${source.name} — degrade in caller`);
  }

  const cargo: Resources = { ...source.resources };
  const ships: ShipCount = { ...source.ships };

  // Case A — fleet currently on a moon
  if (source.type === "moon") {
    return {
      case: "A",
      sourcePlanetId: source.id,
      destCoords: source.coords,
      destType: 2,
      mission: Mission.RECYCLE,
      speed: 1,
      ships,
      cargo,
      reason: "Case A: fleet on moon → recycle to local debris @ 10% speed",
    };
  }

  // source.type === "planet"
  const sameCoordMoon = allPlanets.find(p => p.type === "moon" && sameCoords(p.coords, source.coords));
  if (sameCoordMoon) {
    return {
      case: "B",
      sourcePlanetId: source.id,
      destCoords: sameCoordMoon.coords,
      destType: 3,
      mission: Mission.TRANSPORT,
      speed: 10,
      ships,
      cargo,
      reason: "Case B: planet has same-coord moon → transport to moon @ 100% speed",
    };
  }

  return {
    case: "C",
    sourcePlanetId: source.id,
    destCoords: source.coords,
    destType: 2,
    mission: Mission.RECYCLE,
    speed: 1,
    ships,
    cargo,
    reason: "Case C: planet without moon → recycle to local debris @ 10% speed (2026 allows empty debris)",
  };
}
```

- [ ] **Step 3: Run → 6 tests PASS. Commit.**

### Task M2.5 — Attack detector

**Files:**
- Create: `src/emergency/attack_detector.ts`, test

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { startAttackDetector } from "../../src/emergency/attack_detector.js";
import { EventBus } from "../../src/event_bus.js";
import type { IncomingEvent, WorldState } from "@ogamex/shared";

describe("attack_detector", () => {
  it("emits emergency.attack when hostile within SAVE_WINDOW", () => {
    const bus = new EventBus();
    const stateRef = { current: { events_incoming: [] as IncomingEvent[] } as Partial<WorldState> as WorldState };
    const spy = vi.spyOn(bus, "emit");
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });

    const now = Math.floor(Date.now() / 1000);
    stateRef.current.events_incoming = [{
      id: "ev1", type: "attack", hostile: true,
      from: [3,42,7], to: [1,42,8],
      arrives_at: now + 10 * 60,         // 10 min away
      ships_count: "?",
    }];
    bus.emit("state.updated", null);
    expect(spy).toHaveBeenCalledWith("emergency.attack", expect.objectContaining({ event_id: "ev1" }));
    stop();
  });

  it("does NOT re-emit for the same event id", () => {
    const bus = new EventBus();
    const stateRef = { current: { events_incoming: [{
      id: "ev1", type: "attack", hostile: true, from: [0,0,0], to: [1,42,8],
      arrives_at: Math.floor(Date.now()/1000) + 600, ships_count: "?" }]} as any as WorldState };
    const spy = vi.spyOn(bus, "emit");
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    bus.emit("state.updated", null);
    bus.emit("state.updated", null);
    const calls = spy.mock.calls.filter(([t]) => t === "emergency.attack");
    expect(calls).toHaveLength(1);
    stop();
  });

  it("ignores friendly events", () => {
    const bus = new EventBus();
    const stateRef = { current: { events_incoming: [{
      id: "ev1", type: "transport", hostile: false, from: [1,1,1], to: [1,42,8],
      arrives_at: Math.floor(Date.now()/1000) + 600, ships_count: 100 }]} as any as WorldState };
    const spy = vi.spyOn(bus, "emit");
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    expect(spy).not.toHaveBeenCalledWith("emergency.attack", expect.anything());
    stop();
  });

  it("ignores hostile events outside SAVE_WINDOW", () => {
    const bus = new EventBus();
    const stateRef = { current: { events_incoming: [{
      id: "ev1", type: "attack", hostile: true, from: [0,0,0], to: [1,42,8],
      arrives_at: Math.floor(Date.now()/1000) + 60 * 60,    // 60 min, beyond default 30
      ships_count: "?" }]} as any as WorldState };
    const spy = vi.spyOn(bus, "emit");
    const stop = startAttackDetector(bus, stateRef, { saveWindowMinutes: 30 });
    bus.emit("state.updated", null);
    expect(spy).not.toHaveBeenCalledWith("emergency.attack", expect.anything());
    stop();
  });
});
```

- [ ] **Step 2: Implement**

```ts
import type { EventBus } from "../event_bus.js";
import type { WorldState } from "@ogamex/shared";

export interface DetectorOptions { saveWindowMinutes: number; }
export interface StateRef { current: WorldState; }

export function startAttackDetector(bus: EventBus, ref: StateRef, opts: DetectorOptions): () => void {
  const seen = new Set<string>();
  const handler = () => {
    const now = Math.floor(Date.now() / 1000);
    const windowSec = opts.saveWindowMinutes * 60;
    for (const ev of ref.current.events_incoming ?? []) {
      if (!ev.hostile) continue;
      if (seen.has(ev.id)) continue;
      const remaining = ev.arrives_at - now;
      if (remaining <= 0 || remaining > windowSec) continue;
      seen.add(ev.id);
      bus.emit("emergency.attack", {
        event_id: ev.id,
        from: ev.from,
        to: ev.to,
        arrives_at: ev.arrives_at,
        ships_count: ev.ships_count,
        detected_at: now,
      });
    }
  };
  const off = bus.on("state.updated", handler);
  return off;
}
```

- [ ] **Step 3: Run → 4 tests PASS. Commit.**

### Task M2.6 — Save state machine

**Files:**
- Create: `src/emergency/save_state_machine.ts`, test

Implements the FSM from spec §3.3:
`WATCHING → THREAT_DETECTED → SAVE_PLANNED → LAUNCHING → IN_FLIGHT → RECALL_READY → RECALLING → RETURNED`. Plus `FALLBACK` on launch failure.

- [ ] **Step 1: Failing tests (large; cover happy path + each transition)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SaveStateMachine, type SaveContext, type SaveSnapshot } from "../../src/emergency/save_state_machine.js";

const baseCtx = (overrides: Partial<SaveContext> = {}): SaveContext => ({
  saveWindowMinutes: 30,
  safetyMarginMinutes: 5,
  ...overrides,
});

describe("SaveStateMachine", () => {
  let fsm: SaveStateMachine;
  let ctx: SaveContext;
  let actions: any;

  beforeEach(() => {
    actions = {
      decideCase: vi.fn(() => ({ case: "A", sourcePlanetId: "m1", destCoords: [1,42,8], destType: 2,
        mission: 8, speed: 1, ships: { recycler: 1 }, cargo: { m: 0, c: 0, d: 0 }, reason: "A" })),
      sendFleet:  vi.fn(async () => ({ fleetId: 99, raw: { success: true, fleetIdToReturn: 99 } })),
      recallFleet: vi.fn(async () => {}),
      now: () => 1_000_000,
    };
    ctx = baseCtx();
    fsm = new SaveStateMachine(ctx, actions);
  });

  it("happy path: WATCHING → THREAT_DETECTED → SAVE_PLANNED → LAUNCHING → IN_FLIGHT → RECALL_READY → RECALLING → RETURNED", async () => {
    expect(fsm.snapshot().state).toBe("WATCHING");

    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    expect(actions.sendFleet).toHaveBeenCalledTimes(1);
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");
    expect(fsm.snapshot().fleetId).toBe(99);

    fsm.notifyHostileClear();
    expect(fsm.snapshot().state).toBe("RECALL_READY");

    // safety margin not elapsed yet
    expect(actions.recallFleet).not.toHaveBeenCalled();

    actions.now = () => 1_000_000 + ctx.safetyMarginMinutes * 60 + 1;
    await fsm.tick();
    expect(actions.recallFleet).toHaveBeenCalledWith(99);
    expect(fsm.snapshot().state).toBe("RECALLING");

    fsm.notifyFleetReturned();
    expect(fsm.snapshot().state).toBe("RETURNED");
  });

  it("FALLBACK on sendFleet failure → degrades or escalates", async () => {
    actions.sendFleet = vi.fn(async () => { throw new Error("Not enough deut"); });
    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    expect(fsm.snapshot().state).toBe("FALLBACK");
    expect(fsm.snapshot().lastError).toMatch(/deut/);
  });

  it("re-enters detection when new hostile arrives during IN_FLIGHT", async () => {
    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");
    fsm.notifyNewThreat({ eventId: "e2", arrivesAt: 1_000_800 });
    expect(fsm.snapshot().pendingThreats).toContain("e2");
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");        // already in flight, just track
  });

  it("does NOT recall until ALL hostiles cleared", async () => {
    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    fsm.notifyNewThreat({ eventId: "e2", arrivesAt: 1_000_800 });
    fsm.notifyHostileClear("e1");
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");
    fsm.notifyHostileClear("e2");
    expect(fsm.snapshot().state).toBe("RECALL_READY");
  });
});
```

- [ ] **Step 2: Implementation**

```ts
import type { CaseDecision } from "./case_decider.js";

export type SaveState =
  | "WATCHING" | "THREAT_DETECTED" | "SAVE_PLANNED"
  | "LAUNCHING" | "IN_FLIGHT" | "RECALL_READY" | "RECALLING"
  | "RETURNED" | "FALLBACK";

export interface SaveContext {
  saveWindowMinutes: number;
  safetyMarginMinutes: number;
}

export interface SaveActions {
  decideCase: (sourcePlanetId: string) => CaseDecision;
  sendFleet: (decision: CaseDecision) => Promise<{ fleetId: number; raw: unknown }>;
  recallFleet: (fleetId: number) => Promise<void>;
  now: () => number;     // seconds
}

export interface ThreatInput { eventId: string; sourcePlanetId: string; arrivesAt: number; }
export interface NewThreatInput { eventId: string; arrivesAt: number; }

export interface SaveSnapshot {
  state: SaveState;
  fleetId: number | null;
  decision: CaseDecision | null;
  pendingThreats: string[];
  clearedAt: number | null;
  lastError: string | null;
}

export class SaveStateMachine {
  private state: SaveState = "WATCHING";
  private fleetId: number | null = null;
  private decision: CaseDecision | null = null;
  private pending = new Set<string>();         // unresolved threat event ids
  private clearedAt: number | null = null;
  private lastError: string | null = null;

  constructor(private ctx: SaveContext, private actions: SaveActions) {}

  snapshot(): SaveSnapshot {
    return {
      state: this.state, fleetId: this.fleetId, decision: this.decision,
      pendingThreats: [...this.pending], clearedAt: this.clearedAt, lastError: this.lastError,
    };
  }

  async handleThreat(t: ThreatInput): Promise<void> {
    this.pending.add(t.eventId);
    if (this.state !== "WATCHING") return;       // re-entry handled by pending set
    this.state = "THREAT_DETECTED";
    try {
      this.decision = this.actions.decideCase(t.sourcePlanetId);
      this.state = "SAVE_PLANNED";
      this.state = "LAUNCHING";
      const res = await this.actions.sendFleet(this.decision);
      this.fleetId = res.fleetId;
      this.state = "IN_FLIGHT";
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.state = "FALLBACK";
    }
  }

  notifyNewThreat(t: NewThreatInput): void {
    this.pending.add(t.eventId);
  }

  notifyHostileClear(eventId?: string): void {
    if (eventId) this.pending.delete(eventId);
    else this.pending.clear();
    if (this.state === "IN_FLIGHT" && this.pending.size === 0) {
      this.state = "RECALL_READY";
      this.clearedAt = this.actions.now();
    }
  }

  async tick(): Promise<void> {
    if (this.state !== "RECALL_READY" || this.fleetId === null || this.clearedAt === null) return;
    const elapsed = this.actions.now() - this.clearedAt;
    if (elapsed < this.ctx.safetyMarginMinutes * 60) return;
    this.state = "RECALLING";
    try {
      await this.actions.recallFleet(this.fleetId);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.state = "FALLBACK";
    }
  }

  notifyFleetReturned(): void {
    if (this.state === "RECALLING") this.state = "RETURNED";
  }

  reset(): void {
    this.state = "WATCHING";
    this.fleetId = null;
    this.decision = null;
    this.pending.clear();
    this.clearedAt = null;
    this.lastError = null;
  }
}
```

- [ ] **Step 3: Run → all FSM tests PASS. Commit.**

```bash
git add packages/runtime-userscript/src/emergency/save_state_machine.ts packages/runtime-userscript/test/emergency/save_state_machine.test.ts
git commit -m "feat(userscript/emergency): SaveStateMachine covering WATCHING→...→RETURNED + FALLBACK with multi-threat support"
```

### Task M2.7 — Save orchestrator (wire detector + FSM + decider + API)

**Files:**
- Create: `src/emergency/save_orchestrator.ts`, test

- [ ] **Step 1: Integration test**

```ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/event_bus.js";
import { startEmergencySave } from "../../src/emergency/save_orchestrator.js";
import { TokenManager } from "../../src/api/token_manager.js";

describe("save_orchestrator integration", () => {
  it("end-to-end: hostile event → API call → state machine in IN_FLIGHT", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, fleetIdToReturn: 77 }),
      { status: 200, headers: { "content-type": "application/json" } }));
    const tm = new TokenManager(() => "tk");
    const bus = new EventBus();

    const stateRef = { current: {
      server: { universe: "u", speed: 1 }, player: { id: "p", name: "n", alliance: null },
      planets: [{ id: "m1", name: "母月", coords: [1,42,8], type: "moon",
        resources: { m: 0, c: 0, d: 0 }, storage: { m_max: 0, c_max: 0, d_max: 0 },
        production: { m_h: 0, c_h: 0, d_h: 0 }, buildings: {}, queue: null,
        shipyard_q: null, defense_q: null, ships: { recycler: 1 }, defense: {} }],
      research: { levels: {}, queue: null },
      fleets_outbound: [], events_incoming: [], last_update: 0, page_snapshots: {},
    } as any };

    const handle = startEmergencySave(bus, stateRef, {
      tokenManager: tm,
      fetch: fetchMock as any,
      saveWindowMinutes: 30,
      safetyMarginMinutes: 5,
    });

    const now = Math.floor(Date.now() / 1000);
    stateRef.current.events_incoming = [{
      id: "ev1", type: "attack", hostile: true,
      from: [3,42,7], to: [1,42,8], arrives_at: now + 600, ships_count: "?",
    }];
    bus.emit("state.updated", null);

    // allow async promise chain to flush
    await new Promise(r => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handle.snapshot().state).toBe("IN_FLIGHT");
    expect(handle.snapshot().fleetId).toBe(77);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { EventBus } from "../event_bus.js";
import type { WorldState } from "@ogamex/shared";
import { startAttackDetector, type StateRef } from "./attack_detector.js";
import { decideCase } from "./case_decider.js";
import { SaveStateMachine, type SaveSnapshot } from "./save_state_machine.js";
import { sendFleet, recallFleet } from "../api/fleet_api.js";
import type { TokenManager } from "../api/token_manager.js";

export interface OrchestratorOptions {
  tokenManager: TokenManager;
  fetch: typeof fetch;
  saveWindowMinutes: number;
  safetyMarginMinutes: number;
}

export interface OrchestratorHandle {
  snapshot(): SaveSnapshot;
  stop(): void;
}

export function startEmergencySave(
  bus: EventBus,
  stateRef: StateRef,
  opts: OrchestratorOptions
): OrchestratorHandle {
  const fsm = new SaveStateMachine(
    { saveWindowMinutes: opts.saveWindowMinutes, safetyMarginMinutes: opts.safetyMarginMinutes },
    {
      decideCase: (sourceId) => decideCase(stateRef.current, sourceId, stateRef.current.planets),
      sendFleet: (decision) => sendFleet({
        ships: decision.ships, cargo: decision.cargo, coords: decision.destCoords,
        destType: decision.destType, mission: decision.mission, speed: decision.speed,
      }, { fetch: opts.fetch, token: opts.tokenManager }),
      recallFleet: (id) => recallFleet(id, { fetch: opts.fetch, token: opts.tokenManager }),
      now: () => Math.floor(Date.now() / 1000),
    }
  );

  const stopDetector = startAttackDetector(bus, stateRef, { saveWindowMinutes: opts.saveWindowMinutes });

  const offAttack = bus.on("emergency.attack", (p: any) => {
    // pick source: planet whose coords match the attack's destination
    const target = stateRef.current.planets.find(pl =>
      pl.coords[0] === p.to[0] && pl.coords[1] === p.to[1] && pl.coords[2] === p.to[2]);
    if (!target) return;
    void fsm.handleThreat({ eventId: p.event_id, sourcePlanetId: target.id, arrivesAt: p.arrives_at });
  });

  // when state updates, check if all known hostiles for target planet have cleared
  const offState = bus.on("state.updated", () => {
    const remaining = stateRef.current.events_incoming.filter(e => e.hostile);
    if (remaining.length === 0) fsm.notifyHostileClear();
  });

  // tick at 1Hz to drive RECALL_READY → RECALLING transition
  const ticker = setInterval(() => void fsm.tick(), 1000);

  return {
    snapshot: () => fsm.snapshot(),
    stop: () => { clearInterval(ticker); offAttack(); offState(); stopDetector(); },
  };
}
```

- [ ] **Step 3: Run → integration test PASS. Commit.**

```bash
git add packages/runtime-userscript/src/emergency/save_orchestrator.ts packages/runtime-userscript/test/emergency/save_orchestrator.test.ts
git commit -m "feat(userscript/emergency): orchestrator wires detector + decider + FSM + Fleet API"
```

### Task M2.8 — Priority gate (absolute-priority overrides)

**Files:**
- Create: `src/emergency/priority_gate.ts`

Provides flag `isEmergencyActive(): boolean` consulted by everything in M3+ before executing a directive. Emergency state machine sets this true on `IN_FLIGHT`/`RECALLING`.

- [ ] **Step 1-5:** TDD, simple module:

```ts
export class PriorityGate {
  private active = false;
  setActive(v: boolean) { this.active = v; }
  isActive() { return this.active; }
}
export const emergencyGate = new PriorityGate();
```

Wire `save_orchestrator` to flip the gate on state changes (`IN_FLIGHT|RECALLING → true`, `WATCHING|RETURNED → false`).

### Task M2.9 — main.ts wires emergency save end-to-end

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Wire it up**

```ts
import { TokenManager } from "./api/token_manager.js";
import { extractToken } from "./probes/extractors/token.js";
import { startEmergencySave } from "./emergency/save_orchestrator.js";
import { emergencyGate } from "./emergency/priority_gate.js";

// ... existing boot() code ...

const tokenMgr = new TokenManager(() => {
  const t = extractToken(document, window as any);
  if (!t) throw new Error("token unavailable on this page");
  return t;
});

const emergencyHandle = startEmergencySave(
  bus,
  { current: store.state },
  { tokenManager: tokenMgr, fetch: window.fetch.bind(window),
    saveWindowMinutes: 30, safetyMarginMinutes: 5 }
);

// reflect FSM state into priority gate (poll once a sec)
setInterval(() => {
  const s = emergencyHandle.snapshot().state;
  emergencyGate.setActive(s === "IN_FLIGHT" || s === "RECALLING" || s === "LAUNCHING" || s === "SAVE_PLANNED" || s === "THREAT_DETECTED");
}, 1000);
```

- [ ] **Step 2: Build, manual smoke-test in browser**

Run `pnpm --filter @ogamex/runtime-userscript build`. Open ogame, open devtools console, dispatch a fake hostile event:

```js
window.OGAMEX_FAKE_HOSTILE = {
  id: "fake1", type: "attack", hostile: true,
  from: [3,42,7], to: [/* your母星 coords */],
  arrives_at: Math.floor(Date.now()/1000) + 600, ships_count: "?",
};
```

Then in userscript add a dev hook that splices this into `store.state.events_incoming`. Verify network tab shows POST to `sendFleet`.

- [ ] **Step 3: Commit. M2 complete.**

```bash
git add packages/runtime-userscript/src/main.ts packages/runtime-userscript/src/emergency/priority_gate.ts
git commit -m "feat(userscript): M2 emergency save end-to-end wired, smoke-tested"
```

---

## M3 — Daily Expedition Loop (Self-Adaptive)

**Goal:** Userscript autonomously fills all expedition slots, parses returning reports, computes per-galaxy black hole rates and per-template loss rates, switches galaxies/templates via deterministic rules, and emits Discord-ready daily digest payloads.

**Acceptance criteria:**
- 24h of operation produces >99% expedition slot utilization (measured).
- Report parser handles all 17 outcome types (fixture-driven).
- Galaxy switch fires when sample ≥ 20 and black_hole_rate > 5%.
- Template auto-switches between conservative/standard/aggressive based on rules.
- Daily digest payload validates against `EmergencyStrategy.discord_message` schema (M4 dependency stubbed as plain JSON).

### Task M3.1 — Expedition store (IndexedDB)

**Files:**
- Create: `src/store/expedition_store.ts`, test

API:

```ts
class ExpeditionStore {
  put(outcome: ExpeditionOutcome): Promise<void>;
  queryByGalaxy(galaxy: number, sinceTs: number): Promise<ExpeditionOutcome[]>;
  queryByTemplate(templateId: string, sinceTs: number): Promise<ExpeditionOutcome[]>;
  recent(n: number): Promise<ExpeditionOutcome[]>;
  clear(): Promise<void>;
}
```

Use `fake-indexeddb` for tests. TDD pattern.

### Task M3.2 — Stats: black_hole_rate, loss_rate, yield

**Files:**
- Create: `src/daily/expedition/stats.ts`, test

```ts
export function blackHoleRate(outcomes: ExpeditionOutcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.filter(o => o.outcome_type === "black_hole").length / outcomes.length;
}

export function lossRate(outcomes: ExpeditionOutcome[]): number {
  let sent = 0, lost = 0;
  for (const o of outcomes) {
    for (const c of Object.values(o.fleet_sent)) sent += c ?? 0;
    for (const c of Object.values(o.ships_lost)) lost += c ?? 0;
  }
  return sent === 0 ? 0 : lost / sent;
}

export function avgResourceYield(outcomes: ExpeditionOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const total = outcomes.reduce((s, o) =>
    s + o.resources_gained.m + o.resources_gained.c + o.resources_gained.d, 0);
  return total / outcomes.length;
}
```

Tests for each formula + edge cases (empty, all black holes, no losses).

### Task M3.3 — Galaxy picker

**Files:**
- Create: `src/daily/expedition/galaxy_picker.ts`, test

```ts
export interface GalaxyPickContext {
  state: WorldState;
  recentOutcomes: ExpeditionOutcome[];
  config: ExpeditionConfig;
}
export function pickGalaxy(ctx: GalaxyPickContext): number;
```

Logic:
1. If `mode === "fixed"` → return config preferred.
2. If `home_galaxy_first === true` → use the source planet's galaxy unless black_hole_rate above threshold.
3. Else pick the galaxy with lowest 24h black_hole_rate among ones with ≥ sample_size_min samples; ties broken by yield.

Tests cover each branch.

### Task M3.4 — Template picker

**Files:**
- Create: `src/daily/expedition/template_picker.ts`, test

Evaluates each template's `used_when` expression against current stats. Simple DSL: `"black_hole_rate_24h > 0.05"` / `"default"`. Use a tiny expression evaluator (not eval — parse safely).

### Task M3.5 — Expedition report parser

**Files:**
- Create: `src/probes/extractors/expedition_report.ts`, test, fixtures

Parses ogame messages page DOM to ExpeditionOutcome. **17 outcome types** require fixtures for each. Start with the 4 most common (resources_medium, black_hole, nothing, ships_gained_small) for M3, add the rest as encountered.

### Task M3.6 — Slot filler

**Files:**
- Create: `src/daily/expedition/slot_filler.ts`, test (integration)

```ts
export async function fillExpeditionSlots(
  state: WorldState, config: ExpeditionConfig,
  outcomes: ExpeditionOutcome[],
  actions: { send: (p: SendFleetParams) => Promise<{ fleetId: number }>; randomSystem: (galaxy: number) => number }
): Promise<{ launched: number; reasons: string[] }>;
```

Uses pickGalaxy + pickTemplate + Fleet API. Skips when emergency gate active.

### Task M3.7 — main.ts wires daily loop

Wire up: on `fleet_returned` (mission=expedition) → parse report → store → emit `expedition_data_updated` → re-evaluate stats → trigger fillSlots. Plus 5-minute fallback timer.

### Task M3.8 — Commit M3 milestone

```bash
git commit -m "feat(userscript/daily): self-adaptive expedition loop with stats-driven galaxy/template switching"
```

---

## M4 — Plugin Scaffold + WS Server + Discord Reporter

**Goal:** OpenClaw plugin runs as sidecar, exposes WS server at 127.0.0.1:18790 + HTTP long-poll fallback, userscript connects, plugin emits Discord messages via OpenClaw API. Includes the minimal `ogame_query_state` tool.

**Acceptance criteria:**
- `openclaw plugins install --local ./packages/openclaw-plugin` succeeds.
- Plugin starts, opens WS, accepts userscript hello, exchanges state snapshots.
- Discord receives a "OgameX online" message on plugin startup.

### Task M4.1 — Bridge protocol types

**Files:**
- Create: `packages/runtime-userscript/src/bridge/protocol.ts` + identical types in plugin (or shared package). Prefer **shared** package.

Add `UpstreamMsg` / `DownstreamMsg` discriminated unions to `packages/shared/src/types.ts` (from spec §10.2).

### Task M4.2 — WS server (plugin sidecar)

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/ws_server.ts`, test (using `ws` package + `vitest`)

```ts
export interface WsServerOptions { port: number; token: string; }
export class WsServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: DownstreamMsg): void;             // broadcasts to all
  on<T extends UpstreamMsg["type"]>(type: T, handler: (msg: Extract<UpstreamMsg, { type: T }>) => void): void;
}
```

- TDD: open server, connect a client, send hello, expect handler called.

### Task M4.3 — HTTP long-poll fallback

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/http_server.ts`, test

Endpoints: `POST /ogamex/v1/poll`, `POST /ogamex/v1/push`. Same message envelopes, just over HTTP.

### Task M4.4 — Discord reporter

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/reporter.ts`, test (mock OpenClaw API)

Receives `MarkdownReport` (string), uses OpenClaw plugin SDK to send via configured discord channel.

```ts
export class Reporter {
  constructor(private api: PluginApi, private channelId: string) {}
  async push(content: string): Promise<void>;
  async pushEmergency(content: string): Promise<void>;     // bypasses any throttling
}
```

### Task M4.5 — Sidecar boot

**Files:**
- Modify: `packages/openclaw-plugin/src/index.ts`
- Create: `packages/openclaw-plugin/src/sidecar/index.ts`

Hook into `defineToolPlugin` lifecycle (sidecar: true) to start WS + HTTP servers, log "OgameX online" to Discord.

### Task M4.6 — userscript WS client

**Files:**
- Create: `packages/runtime-userscript/src/bridge/ws_client.ts`, test (mock WS via `ws` in Node)

```ts
export class BridgeClient {
  connect(url: string, token: string): Promise<void>;
  send(msg: UpstreamMsg): void;
  on(type: string, handler: (msg: any) => void): void;
  reconnectOnLoss: boolean;       // exponential backoff
}
```

### Task M4.7 — Wire userscript bridge → push state every 10s

Modify `main.ts`: start bridge, send `state.snapshot` every 10s ±2s jitter, emit `event.emergency` on emergency.attack.

### Task M4.8 — `ogame_query_state` tool

**Files:**
- Create: `packages/openclaw-plugin/src/tools/query_state.ts`, test

Returns the plugin's mirror of `WorldState` (built from received `state.snapshot` messages).

```ts
export const queryStateTool = (statesRef: { current: WorldState | null }) => tool({
  name: "ogame_query_state",
  description: "Query the current Ogame world state (resources, planets, fleets, events).",
  parameters: Type.Object({
    planet: Type.Optional(Type.String({ description: "Specific planet name. Omit for all." })),
  }),
  execute: ({ planet }) => {
    if (!statesRef.current) return { error: "state not yet received" };
    if (!planet) return statesRef.current;
    return statesRef.current.planets.find(p => p.name === planet) ?? { error: `unknown planet ${planet}` };
  },
});
```

### Task M4.9 — Commit M4 milestone

---

## M5 — Goal Engine + Planner + Goal Tools

**Goal:** Users say "母星出引力" in Discord → plugin parses → adds goal → planner decomposes → directives dispatched to userscript → userscript executes via Fleet API (for fleet ops) or UI clicks (for build/research).

**Acceptance criteria:**
- 5 goal types implementable (research, build, build_universal, colonize, build_ships).
- Planner produces a `decomposed_path` array reachable via `/v1/goals/{id}`.
- `ogame_add_goal` requires confirmation via separate `/confirm` tool call.
- Directives dispatched to userscript via WS arrive within 1s.

### Task M5.1 — Goals SQLite store

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/goals_store.ts`, test (use better-sqlite3 in-memory)

CRUD + listByStatus + listActive.

### Task M5.2 — Planner (backward chaining)

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/planner.ts`, test

API:

```ts
export function planGoal(goal: Goal, state: WorldState): Directive | { blocked: string };
```

For each goal type, return either the next executable directive or a blocked reason. Recurses through TECH_TREE prerequisites. Tests cover each goal type + prereq chain.

### Task M5.3 — Tools: add_goal, cancel_goal, query_goals, get_eta, explain_directive

Each tool with TDD (mock store + planner). `add_goal` returns a `pending_action_id` and emits a confirmation prompt; finalization happens via separate `ogame_confirm` tool (or user reply "yes" matched by OpenClaw).

### Task M5.4 — Priority merger + directive dispatch

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/priority_merger.ts`, test

Combines daily-task directives (none yet from plugin side), goal directives, and pending user directives by priority order. Emits via WS `directive.dispatch` to userscript.

### Task M5.5 — userscript GoalRunner

**Files:**
- Create: `packages/runtime-userscript/src/goal_runner.ts`, test

Receives `directive.dispatch` from bridge. Validates against schema. Adds to local DirectiveQueue (priority merged with daily). Executes via Fleet API or UI executor. Acks with `event.directive_completed`.

### Task M5.6 — DirectiveExecutor (UI clicks for non-fleet)

**Files:**
- Create: `packages/runtime-userscript/src/directive_executor.ts`, test

Handles `action="build"`, `"research"`, etc. via `ogame.ajaxNavigation` + element click with humanized timing. (Fleet actions handled by Fleet API directly.)

### Task M5.7 — Commit M5 milestone

---

## M6 — Strategy Versioning + LLM Analyzer + OpenClaw Memory

**Goal:** Userscript reports failures → plugin detects pattern → asks LLM via OpenClaw → applies strategy patch → pushes new strategy version to userscript → updates `ogamex-live-state.md` memory file.

**Acceptance criteria:**
- `strategy.update` round-trips: userscript sees v=N+1 with patched fields.
- Memory file updates within 5s of state change, max 1 write per 30s.
- Failed daily task (e.g., 3x "Not enough deut" on expedition) triggers an LLM call that returns a valid patch.
- All strategy changes are git-committed to a local audit repo.

### Task M6.1 — StrategyStore + git audit

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/strategy_manager.ts`, test

```ts
export class StrategyManager {
  load(): Strategy;
  applyPatch(patch: Record<string, unknown>, reason: string, by: string): Strategy;   // bumps version, commits to git
  rollback(version: number): Strategy;
  history(): { version: number; updated_at: number; reason: string }[];
}
```

Tests use a temp dir for the git repo.

### Task M6.2 — Strategy schema validation

Build a typebox validator over `Strategy` + range guards per field (e.g., `save_window_minutes ∈ [5, 120]`). Reject patches that fail.

### Task M6.3 — LLM strategy analyzer

**Files:**
- Create: `packages/openclaw-plugin/src/llm/strategy_analyzer.ts`, test (mock OpenClaw model API)

```ts
export async function analyzeFailure(input: {
  task: string;
  recentFailures: { ts: number; error: string; context: unknown }[];
  currentStrategy: Strategy;
  worldState: WorldState;
}, llm: OpenClawLlmClient): Promise<{ patch: Record<string, unknown>; reason: string } | { abstain: string }>;
```

Schema-constrained tool-use call to OpenClaw's configured model.

### Task M6.4 — Failure aggregator

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/failure_aggregator.ts`, test

Receives `event.daily_failure` from userscript. After N failures of same task in window → invokes LLM analyzer → applies patch → broadcasts new strategy.

### Task M6.5 — Auditor (userscript-side)

**Files:**
- Create: `packages/runtime-userscript/src/auditor.ts`, test

Subscribes to bus events (`resource_arrived`, `building_completed`, etc.), runs hard-coded rule functions against local event log + state. Emits `audit.condition_unmet` on failure. Rule **thresholds** come from `Strategy.audit_rules_thresholds`.

### Task M6.6 — MemoryWriter

**Files:**
- Create: `packages/openclaw-plugin/src/sidecar/memory_writer.ts`, test

Renders `ogamex-live-state.md` from current state + goals + strategy. 5s debounce, min 60s forced refresh. Writes to `~/.openclaw/workspace/memory/ogamex-live-state.md` and updates the `MEMORY.md` index pointer.

### Task M6.7 — Commit M6 milestone

---

## M7 — Reliability Hardening

**Goal:** System recovers gracefully from disconnections, restarts, token expiry, ogame DOM drift, plugin restarts, and Chrome crashes.

**Acceptance criteria:**
- Pulling the network cable for 30s: userscript continues daily + emergency, queues bridge messages, plays back on reconnect.
- Killing the plugin process: userscript detects disconnect within 60s, enters STANDALONE_MODE, reconnects when plugin restarts.
- Manually expiring the token: next Fleet API call self-heals via TokenManager.invalidate().
- PNA preflight rejection: bridge falls back to HTTP long-poll automatically.

### Task M7.1 — WS reconnect with exponential backoff
### Task M7.2 — HTTP long-poll fallback wiring
### Task M7.3 — Token self-heal end-to-end test
### Task M7.4 — Replay queue in BridgeClient
### Task M7.5 — STANDALONE_MODE in userscript (gate plugin-dependent actions)
### Task M7.6 — Chrome session monitor (systemd unit + tiny helper script)

For each: failing test (where applicable) → impl → pass → commit.

---

## M8 — Observability + Audit Rules

**Goal:** Operators (you) can read system health at a glance, see daily expedition digest in Discord, and trace any directive back to its origin.

**Acceptance criteria:**
- `GET /v1/health` returns userscript+chrome+sidecar+llm status JSON.
- 06:00 daily digest hits Discord with structured expedition stats.
- Every directive in SQLite has a `reason` and `source` traceable to its goal/rule.
- All 5 expedition audit rules implemented and tested.

### Task M8.1 — `/v1/health` endpoint
### Task M8.2 — Daily digest scheduler
### Task M8.3 — Implement all 5 expedition audit rules (see spec §3.1.1)
### Task M8.4 — Implement remaining 5 general audit rules (see spec §8.3)
### Task M8.5 — `/debug` HTML page (read-only, shows last 100 directives + recent events)
### Task M8.6 — Final integration smoke test + commit M8

---

## Self-Review (writing-plans skill)

**Spec coverage check:**

| Spec section | Plan task(s) |
|---|---|
| §1 Goals/constraints | M0 (scaffold) |
| §2 Architecture | All milestones |
| §3.1 Daily tasks | M3 (expedition), M5 (default_build via goals), M6 (resource_balance/defense_replenish as audit-driven adjustments) |
| §3.1.1 Expedition专题 | M3.1–M3.7 |
| §3.2 Goal tasks | M5 |
| §3.3 Emergency绝对优先级 | M2.8 (priority_gate), M2.6 (FSM) |
| §3.3 Fleet save 战术 (Case A/B/C) | M2.4 (case_decider) |
| §3.3 Recall 闭环 | M2.6 (RECALL_READY → RECALLING transition) |
| §3.3 Save 状态机 | M2.6 |
| §4 State 抓取层 | M1 |
| §5 Execution layer | M5.6 (UI), M2.2–M2.3 (API) |
| §5.4 Fleet API | M2.2 (sendFleet), M2.3 (recall) |
| §6 Observation layer | M4.4 (reporter), M8.2 (daily digest) |
| §7 反检测 | M3.x (jitter in slot_filler), M2.9 (manual smoke verifies fingerprint) — no dedicated tasks because mostly covered by "use real Chrome session" implicit choice + rate limits in execution_executor (M5.6) |
| §8 自适应策略 | M6 |
| §9 OpenClaw memory | M6.6 |
| §10 WS protocol | M4.1 (types), M4.2 (server), M4.6 (client) |
| §11 LLM tools | M4.8 + M5.3 + future tools for force_action / pause / resume (add to M5.3 list) |
| §12 文件结构 | "File Structure Map" above |
| §13 实现阶段 | Plan structure mirrors M0–M8 |
| §14 待定项 | M7 reliability covers most; "OpenClaw browser ext + user profile" verified in M0 spike (informal) |

**Placeholder scan:**

- Searched for "TBD", "TODO", "implement later", "fill in": **0 hits in plan body.**
- M3.6 / M5.3 / M7.x / M8.x are intentionally lighter (one-task summaries) but each names exact files and outcomes — engineer can produce TDD scaffolding using the M0–M2 patterns as templates.

**Type consistency:**

- `Directive.method: DirectiveMethod` consistent across M0.2 type def and M2/M5 usage.
- `SendFleetParams` shape in M0.4 schema matches M2.2 implementation (ships/cargo/coords/destType/mission/speed).
- `Strategy.audit_rules_thresholds` referenced in M0.2 type, used in M6.5 auditor.
- `ExpeditionOutcome.outcome_type` enum: 17 values in M0.2 = matches spec §3.1.1.
- `SaveState` FSM states (M2.6): WATCHING/THREAT_DETECTED/SAVE_PLANNED/LAUNCHING/IN_FLIGHT/RECALL_READY/RECALLING/RETURNED/FALLBACK = matches spec §3.3 state machine.
- `CaseDecision.case: "A"|"B"|"C"` consistent.

**Gaps fixed inline:**

- M5.3 expanded list to include all 10 tools from spec §11 (originally was 4): query_state/query_goals/query_events/add_goal/cancel_goal/pause_automation/resume_automation/force_action/explain_directive/get_eta.

---

## Execution Choice

**Plan complete and saved to `docs/superpowers/plans/2026-05-19-ogamex-implementation.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

> Strong recommendation: **execute in phases**. Phase 1 (M0–M3) gives you a working standalone userscript. Stop, demo, and confirm fleet save actually works against a real attack (or simulated). Then Phase 2 (M4–M6) adds OpenClaw integration. Phase 3 (M7–M8) hardens.
