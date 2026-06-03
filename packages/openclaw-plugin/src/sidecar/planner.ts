/**
 * M5.2+ Planner — backward-chaining over TECH_TREE with multi-goal-type support.
 *
 * Given a Goal + current WorldState, returns either the next executable
 * Directive or a blocked reason. For each unmet prerequisite of the goal's
 * target, the planner recurses with a synthetic sub-goal until it reaches a
 * leaf (a tech whose every prereq is met). That leaf is what gets emitted.
 *
 * Supported goal types: research, build, build_ships, expedition, colonize,
 * deploy, transport. Other types stub-block pending later milestones.
 *
 * 2026-05-21: state.planets refactored from Planet[] to Record<string,Planet>;
 * resolvePlanet() helper accepts ogame numeric id OR "G:S:P" coord string.
 */
import { randomUUID } from "node:crypto";
import type { Directive, Goal, GoalType, Planet, WorldState, ShipCount } from "@ogamex/shared";
import { TECH_TREE, nameToId, LIFEFORM_TECH } from "@ogamex/shared";

export type PlanResult = Directive | { blocked: string };

const DIRECTIVE_TTL_MS = 24 * 60 * 60 * 1000;
// Defensive cap so a malformed tech tree (e.g. accidental cycle) can't hang.
const MAX_RECURSION_DEPTH = 64;

// Ogame mission codes (kept local to avoid widening imports here).
const MISSION_TRANSPORT = 3;
const MISSION_DEPLOY = 4;
const MISSION_COLONIZE = 7;
const MISSION_EXPEDITION = 15;

// Buildings whose construction draws from energy; if energy is negative or the
// planet has 0 solar plant, recurse into solar plant upgrade first.
const ENERGY_GATED_BUILDINGS: ReadonlySet<string> = new Set([
  "metalMine",
  "crystalMine",
  "deuteriumSynth",
]);

// v0.0.696 — operator 2026-06-03 "保留计算矿产量，分成两部分":
//   pre-expedition phase (no fleet has flown mission=15)
//     → compute production + auto-upgrade STORAGE (crystalStorage/deuteriumTank).
//       metalStorage 永远不自动建 (operator: "金属永远过剩").
//   post-expedition phase (any expedition in flight or slots used > 0)
//     → no production calc, simple "waiting for resources" — state refresh
//       is event-driven via fleet-landing events.
function isPostExpeditionPhase(state: WorldState): boolean {
  // v0.0.697 — operator 2026-06-03 "astro >= 4 这个合理".
  // astro 是 capability 的第一性源头 (research level, 单调递增, 不依赖
  // class detection / 公式 / state push 链路). floor(sqrt(4)) = 2 = 首次解锁
  // 远征槽位的临界点。max_expedition_slots 是 derived, 上游漏算 class bonus
  // 就会失真。读 research.levels.astrophysics 直击根因。
  const astro = state.research?.levels?.["astrophysics"] ?? 0;
  return astro >= 4;
}

// Pre-phase storage strategy: when resource bottleneck is crystal or deuterium
// AND current storage is ≥95% full → recommend storage upgrade. metal is
// EXCLUDED per operator policy (metal永远过剩). Returns the storage building
// to upgrade, or null when wait-only path is appropriate.
function pickStorageUpgrade(planet: Planet, short: { m: number; c: number; d: number }): "crystalStorage" | "deuteriumTank" | null {
  const r = planet.resources ?? { m: 0, c: 0, d: 0 };
  const cap = (lvl: number): number => Math.floor(5000 * Math.pow(2.5, lvl));
  const cStorLvl = planet.buildings?.["crystalStorage"] ?? 0;
  const dStorLvl = planet.buildings?.["deuteriumTank"] ?? 0;
  if (short.c > 0 && r.c >= cap(cStorLvl) * 0.95) return "crystalStorage";
  if (short.d > 0 && r.d >= cap(dStorLvl) * 0.95) return "deuteriumTank";
  return null;
}

// ogame v12 vanilla energy formulas (per hour, universe-speed cancels in
// deltas). Mirrors the daemon's mineEnergyConsumption / solarProduction
// (ogamex_discord_bridge.mjs L683-700); kept inline to avoid pulling the
// daemon into a sidecar import. metalMine + crystalMine consume base=10,
// deuteriumSynth consume base=20, solarPlant produces 20, fusionReactor
// produces 50*(1+0.02*energyTech).
function mineEnergyConsumption(building: string, level: number): number {
  if (level <= 0) return 0;
  const base = building === "deuteriumSynth" ? 20 : 10;
  return base * level * Math.pow(1.1, level);
}

// Ogame v12 — list of buildings that can physically exist on a moon. Anything
// not in this set is planet-only (naniteFactory, terraformer, spaceDock, mines,
// solar/fusion, research lab, allianceDepot, etc.) and must be rejected when a
// goal targets a moon body, before any chain/fields work runs.
const MOON_ALLOWED_BUILDINGS: ReadonlySet<string> = new Set([
  "metalStorage",
  "crystalStorage",
  "deuteriumTank",
  "roboticsFactory",
  "shipyard",
  "lunarBase",
  "sensorPhalanx",
  "jumpgate",
  "missileSilo",
]);

// Reverse of MOON_ALLOWED: buildings that physically CANNOT exist on a planet,
// only on moons. Operator 2026-05-29 evidence: GoalRunner dispatched
// `lunarBase L1 planet_id=33637366` (a planet, not the matching moon) → ogame
// returned error 100001 "未知的錯誤". planner should reject before dispatch.
const MOON_ONLY_BUILDINGS: ReadonlySet<string> = new Set([
  "lunarBase",
  "sensorPhalanx",
  "jumpgate",
]);

/**
 * Resolve a planet reference. Accepts either an ogame numeric planet ID
 * ("33657770") or canonical coord string ("1:190:6"). Falls back to undefined
 * if neither lookup matches — callers must handle that.
 */


export function resolvePlanet(ref: string | undefined, state: WorldState): Planet | undefined {
  if (!ref) return undefined;
  const direct = state.planets?.[ref];
  if (direct) return direct;
  // Coord-style "G:S:P"
  const m = ref.match(/^\s*(\d+)\s*:\s*(\d+)\s*:\s*(\d+)\s*$/);
  if (m) {
    const key = `${m[1]}:${m[2]}:${m[3]}`;
    for (const p of Object.values(state.planets ?? {})) {
      if (p.coords.join(":") === key) return p;
    }
  }
  return undefined;
}

/**
 * Per-call recursion context. The source planet for research-level lookups is
 * the goal's planet (if provided) else the first planet — M5.6 will resolve
 * this from the goal's planet/research-lab pairing. The planet for build
 * recursion always comes from the build goal's target.planet.
 */
interface PlanCtx {
  state: WorldState;
  rootGoal: Goal;
  depth: number;
  sourcePlanetId: string;
}

export function planGoal(goal: Goal, state: WorldState): PlanResult {
  switch (goal.type) {
    case "research":
      return planResearchGoal(goal, state);
    case "build":
      return planBuildGoal(goal, state);
    case "build_ships":
      return planBuildShipsGoal(goal, state);
    case "expedition":
      return planExpeditionGoal(goal, state);
    case "colonize":
      return planColonizeGoal(goal, state);
    case "deploy":
    case "transport":
      return planFleetSendGoal(goal, state);
    case "lifeform_building":
      return planLifeformBuildingGoal(goal, state);
    case "lifeform_research":
      return planLifeformResearchGoal(goal, state);
    case "species_discovery":
      return planSpeciesDiscoveryGoal(goal, state);
    case "jumpgate":
      return planJumpgateGoal(goal, state);
    default:
      return { blocked: `goal type ${goal.type} not implemented` };
  }
}

/**
 * planSpeciesDiscoveryGoal — drive Galaxy-view DNA discovery missions.
 *
 * target: {
 *   source_planet: string;   // planet id (cp=PID)
 *   galaxy: number;
 *   base_system: number;
 *   range: number;           // ±N systems around base_system
 *   completed?: string[];    // "G:S:P" coords already dispatched THIS goal
 * }
 *
 * Iteration order: base_system, base-1, base+1, base-2, base+2, ... (radial).
 * Each system: positions 1..15. One directive per coord per tick.
 *
 * Slot management: keep 1 fleet slot empty
 *  (used_fleet_slots + 1 <= max_fleet_slots - 1).
 *
 * Goal completes when (range*2 + 1) * 15 coords all attempted.
 */
function planSpeciesDiscoveryGoal(goal: Goal, state: WorldState): PlanResult {
  const t = goal.target as {
    source_planet?: string;
    galaxy?: number;
    base_system?: number;
    range?: number;
    completed?: string[];
  };
  const planetId = t.source_planet ?? "";
  const galaxy = t.galaxy ?? 0;
  const baseSystem = t.base_system ?? 0;
  const range = t.range ?? 10;
  if (!planetId) return { blocked: "species_discovery: missing source_planet" };
  if (!galaxy || !baseSystem) return { blocked: "species_discovery: missing galaxy/base_system" };
  const planet = state.planets[planetId];
  if (!planet) return { blocked: `species_discovery: planet ${planetId} not in state` };

  // Operator 2026-05-28: "sidecar planner 加 expedition > discover 优先级".
  // Sort-priority alone (compareRows: expedition=10 > discover=5) only
  // orders dispatch within a tick; slot competition happens at ApiExec
  // POST time which is async. To truly let expedition win the fleet-slot
  // race, the discover gate must RESERVE enough fleet slots for every
  // expedition slot ogame still has room for, plus 1 for emergency FS.
  //
  // Reserve = freeExpSlots + 1
  //   - freeExpSlots: how many expedition fleets ogame would still accept
  //   - +1: emergency FS save (FSM bypass still works regardless, but
  //         leaving headroom avoids 140043 on FS save burst)
  const server = (state.server ?? {}) as {
    used_fleet_slots?: number; max_fleet_slots?: number;
    used_expedition_slots?: number; max_expedition_slots?: number;
  };
  const used = server.used_fleet_slots ?? 0;
  const max = server.max_fleet_slots ?? 0;
  const usedExp = server.used_expedition_slots ?? 0;
  const maxExp = server.max_expedition_slots ?? 0;
  const freeExpSlots = Math.max(0, maxExp - usedExp);
  const reserveForExp = freeExpSlots + 1; // +1 emergency FS
  if (max > 0 && used >= max - reserveForExp) {
    return { blocked: `species_discovery: reserve ${reserveForExp} fleet slot(s) for expedition+emergency (used=${used} max=${max} freeExp=${freeExpSlots})` };
  }

  // Build radial iteration order and find next coord not in completed[].
  const completed = new Set(t.completed ?? []);
  const orderedSystems: number[] = [baseSystem];
  for (let d = 1; d <= range; d++) {
    orderedSystems.push(baseSystem - d);
    orderedSystems.push(baseSystem + d);
  }
  let nextSystem = -1;
  let nextPosition = -1;
  outer: for (const sys of orderedSystems) {
    if (sys < 1) continue; // ogame systems start at 1
    for (let pos = 1; pos <= 15; pos++) {
      const key = `${galaxy}:${sys}:${pos}`;
      if (!completed.has(key)) {
        nextSystem = sys;
        nextPosition = pos;
        break outer;
      }
    }
  }
  if (nextSystem < 0) {
    return { blocked: `species_discovery: all ${(range * 2 + 1) * 15} coords attempted — goal complete` };
  }

  const directive: Directive = {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "discover",
    // goal_id MUST be at top level (per Directive type + sidecar handlers
    // that read d.goal_id directly). Earlier version placed it in params
    // which is silently ignored by directiveToGoal mapping + optimistic
    // completed[] update → planner kept selecting same coord 50+ times.
    goal_id: goal.id,
    params: {
      planet_id: planetId,
      galaxy,
      system: nextSystem,
      position: nextPosition,
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `species_discovery ${galaxy}:${nextSystem}:${nextPosition}`,
  };
  return directive;
}

/**
 * Lifeform building goal — same scheduleEntry endpoint as regular buildings
 * (verified via sniffer 2026-05-21: technologyId=11102 biosphereFarm), but
 * prereq chain lives in LIFEFORM_TECH catalog (humans/rocktal/mechas/kaelesh).
 * Target shape: {building:"researchCentre", level:N, planet?:string}.
 */
// Common LLM-hallucinated names → real catalog keys. Add new aliases here
// when Gemini (or operator typo) generates a wrong name that maps clearly
// to a known building. Wiki/ogame.fandom commonly uses different English
// names than our internal slugs.
const LF_BUILDING_ALIASES: Record<string, string> = {
  // Kaelesh
  templeOfTheBenevolentBeing: "sanctuary",  // wiki name → catalog key
  // (add more aliases here as discovered)
};

// Per-species "housing → food" balance rule. When the operator's goal is
// to upgrade a population-housing building and the planet's `living_space`
// resource already exceeds `well_fed`, divert one upgrade into the food
// building first. Mirrors humans' "升居住区前先补生物圈农场" rule.
//
// Living-space / well-fed resource fields are species-agnostic in the
// userscript's lifeform_resources extractor — each species' own buildings
// drive the values; the planner just compares numbers.
const POPULATION_FOOD_BY_SPECIES: Record<string, { population: readonly string[]; food: string }> = {
  humans: {
    population: ["residentialSector", "skyscraper", "metropolis"],
    food: "biosphereFarm",
  },
  kaelesh: {
    // Sanctuary (圣殿) is kaelesh's primary housing; antimatterCondenser
    // (反物质凝聚器) is the satiety counterpart. Other kaelesh buildings
    // can be added here later if/when they also drive living_space.
    population: ["sanctuary"],
    food: "antimatterCondenser",
  },
  // rocktal / mechas — not yet wired (no operator goals against them yet).
};

function planLifeformBuildingGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { building?: string; level?: number; planet?: string };
  let building = target.building ?? "";
  const level = target.level ?? 0;
  if (!building) return { blocked: "lifeform_building goal missing target.building" };
  if (level <= 0) return { blocked: "lifeform_building goal needs target.level > 0" };
  // Resolve alias before lookup so LLM hallucinations don't get stuck blocked.
  if (LF_BUILDING_ALIASES[building]) {
    building = LF_BUILDING_ALIASES[building]!;
  }
  const planet = resolvePlanet(target.planet ?? goal.planet, state) ?? Object.values(state.planets)[0];
  if (!planet) return { blocked: "lifeform_building: no planet" };

  // Determine species from planet.lifeform (set by userscript). Default to
  // humans if unknown — verified species path. Other species need sniffer.
  const species = ((planet.lifeform as { species?: string } | null)?.species ?? "humans") as keyof typeof LIFEFORM_TECH;
  const catalog = LIFEFORM_TECH[species];
  if (!catalog) return { blocked: `lifeform: unknown species ${species}` };
  const entry = catalog.buildings[building];
  if (!entry) return { blocked: `lifeform_building: ${building} not in ${species} catalog` };

  // lifeform_buildings tracked on planet — separate from regular buildings.
  const lfBldg = (planet as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {};
  const current = lfBldg[building] ?? 0;
  if (current >= level) {
    return { blocked: `already at or above target — ${building} L${current} ≥ ${level}` };
  }
  // Is this building already in ogame's build queue? lifeform builds use
  // lf_build_q; regular ones use build_q. Either occupies the planet's
  // single queue slot — block to prevent stacking duplicate directives.
  // Operator: "sanctuary 已经到达目标了 还在继续建造" — without this gate,
  // the planner kept firing directives while ogame already had a sanctuary
  // upgrade running (ours invisible because we matched only buildQ.item==
  // sanctuary, not lf_build_q.building==sanctuary).
  const lfBuildQ = (planet as { lf_build_q?: { building?: string; ends_at?: number } }).lf_build_q;
  const buildQ2 = (planet as { build_q?: { building?: string; ends_at?: number } }).build_q;
  if (lfBuildQ && lfBuildQ.building === building && (lfBuildQ.ends_at ?? 0) > Date.now()) {
    return { blocked: `${building} already in lf_build_q (ends ${new Date(lfBuildQ.ends_at!).toISOString()})` };
  }
  if (buildQ2 && (buildQ2.ends_at ?? 0) > Date.now()) {
    // Any other queued item also blocks (ogame allows 1 build at a time).
    return { blocked: `another build active in queue (${buildQ2.building}, ends ${new Date(buildQ2.ends_at!).toISOString()})` };
  }

  // Population/Food balance — auto-build food when housing grows. Without
  // this, owner ends up with overcrowded planets → workers starve → mines
  // run at reduced output. Operator rule, applied per-species via
  // POPULATION_FOOD_BY_SPECIES lookup:
  //   humans:   sanctuary-equivalent residentialSector → food biosphereFarm
  //   kaelesh:  sanctuary → food antimatterCondenser
  // Compare RESOURCE quantities (not building levels) from ogame's own UI:
  //   生活空間 = planet.lifeform_resources.living_space  (housing capacity)
  //   酒足飯飽 = planet.lifeform_resources.well_fed      (satiety capacity)
  // Food is the supporter — only divert when housing capacity > food capacity.
  const balanceRule = POPULATION_FOOD_BY_SPECIES[species];
  if (balanceRule && balanceRule.population.includes(building)) {
    const lfr = (planet as { lifeform_resources?: { living_space?: number | null; well_fed?: number | null } }).lifeform_resources;
    const livingSpace = lfr?.living_space ?? null;
    const wellFed = lfr?.well_fed ?? null;
    if (livingSpace !== null && wellFed !== null && livingSpace > wellFed) {
      const currentFood = lfBldg[balanceRule.food] ?? 0;
      const subGoal: Goal = { ...goal, target: { building: balanceRule.food, level: currentFood + 1, planet: planet.id } } as Goal;
      return planLifeformBuildingGoal(subGoal, state);
    }
    // Otherwise: food still adequate; let housing build.
  }

  // Prereq check — recurse into missing prereqs first.
  for (const [prereqName, reqLvl] of Object.entries(entry.requires)) {
    if ((lfBldg[prereqName] ?? 0) < reqLvl) {
      const subGoal: Goal = { ...goal, target: { building: prereqName, level: reqLvl, planet: planet.id } } as Goal;
      return planLifeformBuildingGoal(subGoal, state);
    }
  }

  // Resource strategy — cost-aware comparator (wait vs upgrade mine).
  // Executes optimal path deterministically (block on wait, no doomed POST).
  const costFnLf = entry.cost_at as ((l: number) => { m: number; c: number; d?: number; e?: number }) | undefined;
  if (costFnLf) {
    const rawCost = costFnLf(current + 1);
    const lfCost = { m: rawCost.m, c: rawCost.c, d: rawCost.d ?? 0, e: rawCost.e ?? 0 };
    const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
    const affordable = r.m >= lfCost.m && r.c >= lfCost.c && r.d >= lfCost.d;
    if (!affordable) {
      const sM = Math.max(0, lfCost.m - r.m), sC = Math.max(0, lfCost.c - r.c), sD = Math.max(0, lfCost.d - r.d);
      if (isPostExpeditionPhase(state)) {
        return { blocked: `waiting for resources (m=${sM} c=${sC} d=${sD} short)` };
      }
      // Pre-phase: try storage upgrade first
      const storUp = pickStorageUpgrade(planet, { m: sM, c: sC, d: sD });
      if (storUp) {
        const curLvl = planet.buildings?.[storUp] ?? 0;
        const elevatedRoot = { ...goal, priority: Math.min(10, goal.priority + 3) } as Goal;
        const ctx: PlanCtx = { state, rootGoal: elevatedRoot, depth: 0, sourcePlanetId: planet.id };
        return planBuild(storUp, curLvl + 1, planet.id, ctx);
      }
      // Else: production-rate wait ETA in reason
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      // v0.0.726 — operator 2026-06-03 "建造 重氫合成器 32 时间评估错误 实际
      // 时间是27分钟" (panel showed 11h12m ≈ 24× over). Root cause: 服务器
      // 经济倍率没乘进 wait formula. ogame's prod field is base per-second
      // before universe economy speed (server.speed, typically 1-10). Real
      // hourly rate = prod * 3600 * server.speed. Skipping server.speed
      // makes wait ETA scale with reciprocal of speed (speed=8 → wait 8×
      // too high; combined with bonus drift → operator's observed 24×).
      const econSpeed = state.server?.speed ?? 1;
      const tM = (prod.m_h ?? 0) > 0 ? sM / ((prod.m_h ?? 1) * econSpeed) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / ((prod.c_h ?? 1) * econSpeed) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / ((prod.d_h ?? 1) * econSpeed) * 3600 : (sD > 0 ? 999999 : 0);
      const wait = Math.round(Math.max(tM, tC, tD));
      return { blocked: `waiting ${wait}s for resources (m=${sM} c=${sC} d=${sD} short)` };
    }
  }

  // Emit directive — reuse "build" action (ApiExec routes scheduleEntry).
  const techId = nameToId(building);
  if (!techId) return { blocked: `lifeform_building: no numeric id for ${building}` };
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "build",
    params: { building, technology_id: techId, target_level: current + 1, planet_id: planet.id },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `lifeform build ${building} L${current + 1} on ${planet.coords?.join(":") ?? planet.id}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// lifeform_research (v0.0.602 — operator 2026-06-01)
// ────────────────────────────────────────────────────────────────────────────

function planLifeformResearchGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { tech?: string; level?: number; planet?: string };
  const tech = typeof target.tech === "string" ? target.tech : "";
  const level = typeof target.level === "number" ? target.level : 0;
  if (!tech) return { blocked: "lifeform_research goal missing target.tech" };
  if (level <= 0) return { blocked: "lifeform_research goal needs target.level > 0" };
  const planet = resolvePlanet(target.planet ?? goal.planet, state) ?? Object.values(state.planets ?? {})[0];
  if (!planet) return { blocked: "lifeform_research: no planet" };
  const species = ((planet.lifeform as { species?: string } | null)?.species ?? "humans") as keyof typeof LIFEFORM_TECH;
  const catalog = LIFEFORM_TECH[species];
  if (!catalog) return { blocked: `lifeform_research: unknown species ${species}` };
  const entry = catalog.research[tech];
  if (!entry) return { blocked: `lifeform_research: ${tech} not in ${species} catalog` };
  // Current level lookup — ogame stores lifeform research per-planet too,
  // but our extractor doesn't surface it yet (TODO: add lifeform_research
  // field to planet state). For now compare against 0 → always allow up to
  // target. ApiExec will dispatch via lfresearch component endpoint; if
  // already at target ogame returns no-op + ack.
  const lfResearch = (planet as { lifeform_research?: Record<string, number> }).lifeform_research ?? {};
  const current = lfResearch[tech] ?? 0;
  if (current >= level) {
    return { blocked: `lifeform_research: already at or above target — ${tech} L${current} ≥ ${level}` };
  }
  // Output directive — ApiExec dispatch handles via lfresearch component.
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "lifeform_research",
    params: {
      planet_id: planet.id,
      tech,
      level: current + 1,
      species,
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `lifeform research ${tech} L${current + 1} on ${planet.coords?.join(":") ?? planet.id} (${species})`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// research
// ────────────────────────────────────────────────────────────────────────────

function planResearchGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { tech?: unknown; level?: unknown };
  const tech = typeof target.tech === "string" ? target.tech : "";
  const level = typeof target.level === "number" ? target.level : 0;
  if (!tech) return { blocked: "research goal missing target.tech" };

  // Source planet for research lab lookup. If goal.planet is set but doesn't
  // match any actual planet id (e.g. the LLM wrote a friendly name like
  // "homeworld"), fall back to first planet.
  const goalPlanetMatches =
    typeof goal.planet === "string" &&
    Object.values(state.planets ?? {}).some((p) => p.id === goal.planet);
  const sourcePlanetId = goalPlanetMatches
    ? (goal.planet as string)
    : Object.values(state.planets ?? {})[0]?.id ?? "";

  const ctx: PlanCtx = {
    state,
    rootGoal: goal,
    depth: 0,
    sourcePlanetId,
  };

  return planResearch(tech, level, ctx);
}

function planResearch(tech: string, targetLevel: number, ctx: PlanCtx): PlanResult {
  if (ctx.depth > MAX_RECURSION_DEPTH) {
    return { blocked: `recursion depth exceeded while planning research ${tech}` };
  }
  const entry = TECH_TREE[tech];
  if (!entry) return { blocked: `unknown tech: ${tech}` };
  if (entry.kind !== "research") {
    return { blocked: `tech ${tech} is not a research (kind=${entry.kind})` };
  }

  const current = ctx.state.research.levels[tech] ?? 0;
  if (current >= targetLevel) {
    return { blocked: `already at or above target level (${current} >= ${targetLevel}) for ${tech}` };
  }

  const nextLevel = current + 1;

  for (const [reqTech, reqLevel] of Object.entries(entry.requires)) {
    const reqEntry = TECH_TREE[reqTech];
    if (!reqEntry) {
      return { blocked: `unknown prereq tech: ${reqTech} (required by ${tech})` };
    }
    if (reqEntry.kind === "building") {
      // v0.0.456: research's building prereqs (researchLab, etc.) are
      // network-wide — operator rule "星球上的研究所有效，月球不需要建研究所".
      // Scan all planets, pick the highest level. If sourcePlanetId is a moon
      // and the building is planet-only, the moon lookup would be 0 → planner
      // tries to build planet-only on moon → blocked by planet-only gate.
      // Fix: use highest-level planet for both the level check and the upgrade
      // target. Buildings allowed on moons (rare for research prereqs) still
      // fall through to the global scan since planet-network is the canonical
      // truth for research requirements.
      let bestPlanetId = ctx.sourcePlanetId;
      let actual = 0;
      for (const p of Object.values(ctx.state.planets ?? {})) {
        if (p.type !== "planet") continue;
        const lvl = p.buildings?.[reqTech] ?? 0;
        if (lvl > actual) { actual = lvl; bestPlanetId = p.id; }
      }
      if (actual < reqLevel) {
        return planBuild(reqTech, reqLevel, bestPlanetId, { ...ctx, depth: ctx.depth + 1, sourcePlanetId: bestPlanetId });
      }
    } else if (reqEntry.kind === "research") {
      const actual = ctx.state.research.levels[reqTech] ?? 0;
      if (actual < reqLevel) {
        return planResearch(reqTech, reqLevel, { ...ctx, depth: ctx.depth + 1 });
      }
    } else {
      return { blocked: `unsupported prereq kind ${reqEntry.kind} for ${reqTech}` };
    }
  }

  return makeResearchDirective(tech, nextLevel, ctx);
}

function makeResearchDirective(tech: string, nextLevel: number, ctx: PlanCtx): Directive {
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: ctx.rootGoal.priority,
    action: "research",
    params: {
      tech,
      target_level: nextLevel,
      planet_id: ctx.sourcePlanetId,
      technology_id: nameToId(tech),
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `research ${tech} → ${nextLevel}`,
    goal_id: ctx.rootGoal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// build
// ────────────────────────────────────────────────────────────────────────────

function planBuildGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { building?: unknown; level?: unknown; planet?: unknown };
  const building = typeof target.building === "string" ? target.building : "";
  const level = typeof target.level === "number" ? target.level : 0;
  // Planet resolution: target.planet wins, then goal.planet. Either may be
  // an ogame numeric id OR a coord string ("G:S:P").
  const planetRef =
    (typeof target.planet === "string" && target.planet) ||
    goal.planet ||
    "";

  if (!building) return { blocked: "build goal missing target.building" };
  if (!planetRef) return { blocked: "build goal missing target.planet" };

  let planet = resolvePlanet(planetRef, state);
  if (!planet) return { blocked: `planet not found: ${planetRef}` };
  // v0.0.470: moon-only building disambiguation (operator 2026-05-30
  // "build jumpgate 2 ↳ moon-only building jumpgate cannot be built on
  // planet"). When the goal targets a moon-only building (lunarBase,
  // sensorPhalanx, jumpgate) but resolvePlanet picked the same-coord
  // planet (due to ambiguous coord ref), auto-switch to the moon. Without
  // this, the planet-only gate downstream would block forever even though
  // the same coord has a perfectly valid moon for the build.
  if (MOON_ONLY_BUILDINGS.has(building) && planet.type !== "moon") {
    const coord = planet.coords?.join(":");
    if (coord) {
      const moonAtCoord = Object.values(state.planets ?? {})
        .find((p) => p.type === "moon" && p.coords?.join(":") === coord);
      if (moonAtCoord) planet = moonAtCoord;
    }
  }

  const ctx: PlanCtx = {
    state,
    rootGoal: goal,
    depth: 0,
    sourcePlanetId: planet.id,
  };

  return planBuild(building, level, planet.id, ctx);
}

function planBuild(building: string, targetLevel: number, planetId: string, ctx: PlanCtx): PlanResult {
  if (ctx.depth > MAX_RECURSION_DEPTH) {
    return { blocked: `recursion depth exceeded while planning build ${building}` };
  }
  // v0.0.453: alias map — operator types common alternative names.
  // moonBase → lunarBase, moon_base → lunarBase, lunar_base → lunarBase.
  const BUILDING_ALIASES: Record<string, string> = {
    moonBase: "lunarBase",
    moon_base: "lunarBase",
    lunar_base: "lunarBase",
    sensor_phalanx: "sensorPhalanx",
    sensorphalanx: "sensorPhalanx",
    jump_gate: "jumpgate",
  };
  const canonical = BUILDING_ALIASES[building] ?? BUILDING_ALIASES[building.toLowerCase()] ?? building;
  const entry = TECH_TREE[canonical];
  if (!entry) return { blocked: `unknown tech: ${building}` };
  building = canonical;
  if (entry.kind !== "building") {
    return { blocked: `tech ${building} is not a building (kind=${entry.kind})` };
  }

  const planet = Object.values(ctx.state.planets ?? {}).find((p) => p.id === planetId);
  if (!planet) return { blocked: `planet not found: ${planetId}` };

  // v0.0.455: planet-only gate — reject up-front if the goal asks for a
  // building that physically can't exist on a moon. Catches optimizer
  // mistakes like naniteFactory L7 on a moon (operator hit this 2026-05-29,
  // goal stuck active forever). Whitelist is MOON_ALLOWED_BUILDINGS.
  if (planet.type === "moon" && !MOON_ALLOWED_BUILDINGS.has(building)) {
    return {
      blocked: `planet-only building ${building} cannot be built on moon (${planet.id}); allowed on moon: ${Array.from(MOON_ALLOWED_BUILDINGS).join(", ")}`,
    };
  }

  // v0.0.456: moon-only gate (reverse direction) — reject up-front if the goal
  // asks for a moon-only building (lunarBase / sensorPhalanx / jumpgate) on a
  // planet body. Operator 2026-05-29 evidence: `lunarBase L1 planet_id=33637366
  // → error 100001 "未知的錯誤"`. Suggest the matching moon's id in the
  // blocked reason so the optimizer or operator can re-target cleanly.
  if (planet.type === "planet" && MOON_ONLY_BUILDINGS.has(building)) {
    const coord = planet.coords?.join(":") ?? "?";
    const matchingMoon = Object.values(ctx.state.planets ?? {})
      .find((p) => p.type === "moon" && p.coords?.join(":") === coord);
    const moonHint = matchingMoon
      ? ` — re-target to moon at same coord (id=${matchingMoon.id})`
      : ` — no moon found at ${coord}, build a moon first`;
    return {
      blocked: `moon-only building ${building} cannot be built on planet (${planet.id} @ ${coord})${moonHint}`,
    };
  }

  // v0.0.694 — operator 2026-06-03 "主任务已经做完成，怎么还有后续任务".
  // FIRST check whether goal target is already met. moon jumpgate L2 already
  // achieved → goal terminal → NO moon-fields recursion needed.
  const current = planet.buildings?.[building] ?? 0;
  if (current >= targetLevel) {
    return {
      blocked: `already at or above target level (${current} >= ${targetLevel}) for ${building} on ${planetId}`,
    };
  }

  // v0.0.452: moon-fields gate. Operator 2026-05-29 rule "月球只剩一个
  // 空间的时候必须先造月球基地,再建其他建筑". When the target body is
  // a moon and the requested building is NOT lunarBase, check whether
  // remaining fields ≤ 1; if so, AUTO-RECURSE into lunarBase upgrade as
  // a prereq (operator 2026-05-29 "按照最优解走就好了，最终目标只有一
  // 个"). v0.0.468: instead of returning blocked, emit a planBuild
  // directive for lunarBase L+1 so the single user goal drives its own
  // fields-expansion prereqs across multiple dispatch ticks — no need for
  // operator to manually create separate lunarBase goals.
  // v0.0.694 — moved BELOW the "already at target" gate so completed
  // moon goals don't trigger spurious lunarBase recursion.
  if (planet.type === "moon" && building !== "lunarBase") {
    const b = (planet.buildings as Record<string, number | undefined>) ?? {};
    let usedFields = 0;
    for (const name of MOON_ALLOWED_BUILDINGS) usedFields += (b[name] ?? 0);
    const lunarBaseLevel = b["lunarBase"] ?? 0;
    const maxFields = 1 + 3 * lunarBaseLevel;
    const free = maxFields - usedFields;
    if (free <= 1) {
      return planBuild("lunarBase", lunarBaseLevel + 1, planetId, { ...ctx, depth: ctx.depth + 1 });
    }
  }

  // Is this building currently upgrading? Only treat as in-flight if the
  // queue entry actually targets THIS building AND hasn't already ended.
  const buildQ = planet.build_q;
  if (buildQ && buildQ.item === building && (buildQ.ends_at ?? 0) > Date.now()) {
    return { blocked: `${building} already upgrading in ogame queue on ${planetId}` };
  }

  // researchLab is a facility that affects research speed network-wide.
  // ogame rejects researchLab upgrade with error 120024 ("目前研究正在開展中"
  // / "research in progress") when ANY research is currently running on
  // any planet — the queue is global, not per-planet. Gate the dispatch
  // until the active research finishes, otherwise we burn a directive
  // round-trip and a goal gets parked "blocked" until manual resume.
  // Operator incident 2026-06-02: build researchLab 15 vs intergalactic L9
  // research → endless retry until intergalactic finished.
  if (building === "researchLab") {
    const rq = ctx.state.research?.queue;
    if (rq && (rq.ends_at ?? 0) > Date.now()) {
      const etaS = Math.max(0, Math.round((rq.ends_at - Date.now()) / 1000));
      return { blocked: `researchLab needs idle research — ${rq.tech} L${rq.level} still running (~${etaS}s)` };
    }
  }

  const nextLevel = current + 1;

  // Energy gate: mines need positive net energy. v0.0.675 — operator
  // 2026-06-03 拍板两条：
  //   (1) 预判: 当前 energy - 升级后多消耗的 energy < 0 → 先建电厂
  //   (2) 太阳能 vs 核融合两种电厂二选一：next level cost (m+c+d) 谁低
  //       建谁。核融合 D 不够买不起 → 退到太阳能（核融合还有 prereqs:
  //       deuteriumSynth≥5 + energyTech≥3, 不满足也退太阳能）。
  // Skip the recursion for the power plants themselves so we don't loop.
  if (
    ENERGY_GATED_BUILDINGS.has(building) &&
    building !== "solarPlant" &&
    building !== "fusionReactor"
  ) {
    const curEnergy = planet.resources?.e ?? 0;
    const solar = planet.buildings?.["solarPlant"] ?? 0;
    const fusion = planet.buildings?.["fusionReactor"] ?? 0;
    // Predictive — energy delta from upgrading this mine.
    const extraConsumption =
      mineEnergyConsumption(building, nextLevel) - mineEnergyConsumption(building, current);
    const projectedEnergy = curEnergy - extraConsumption;
    const needsPowerPlant =
      curEnergy < 0 ||
      (solar === 0 && fusion === 0) ||
      projectedEnergy < 0;
    if (needsPowerPlant) {
      // Pick cheaper next-level power plant.
      const solarCostFn = TECH_TREE.solarPlant?.cost_at as
        | ((l: number) => { m: number; c: number; d?: number; e?: number })
        | undefined;
      const fusionCostFn = TECH_TREE.fusionReactor?.cost_at as
        | ((l: number) => { m: number; c: number; d?: number; e?: number })
        | undefined;
      const solarCost = solarCostFn ? solarCostFn(solar + 1) : { m: 0, c: 0, d: 0 };
      const fusionCost = fusionCostFn ? fusionCostFn(fusion + 1) : { m: 0, c: 0, d: 0 };
      // Fusion viability: prereqs (deuteriumSynth≥5, energyTech≥3) AND
      // planet has enough deuterium in stock to PAY the build cost.
      const dSynth = planet.buildings?.["deuteriumSynth"] ?? 0;
      const energyTech = ctx.state.research?.levels?.["energyTech"] ?? 0;
      const planetD = planet.resources?.d ?? 0;
      const fusionPrereqsMet = dSynth >= 5 && energyTech >= 3;
      const fusionAffordable = planetD >= (fusionCost.d ?? 0);
      const fusionViable = fusionPrereqsMet && fusionAffordable;
      // Total cost compare (m+c+d). Equal → prefer solar (no D drain).
      const solarTotal = solarCost.m + solarCost.c + (solarCost.d ?? 0);
      const fusionTotal = fusionCost.m + fusionCost.c + (fusionCost.d ?? 0);
      const pickFusion = fusionViable && fusionTotal < solarTotal;
      const pickBuilding = pickFusion ? "fusionReactor" : "solarPlant";
      const pickLevel = pickFusion ? fusion + 1 : solar + 1;
      const pickCost = pickFusion ? fusionCost : solarCost;
      // v0.0.676 — break the deuteriumSynth → solar → metalMine → solar
      // infinite-recursion cycle observed in production (planet 33639762
      // deuteriumSynth L32 blocked with "recursion depth exceeded while
      // planning build solarPlant"). When the chosen power plant is
      // itself unaffordable (deleted in v0.0.696: pickResourceStrategy)
      // we used to recurse into a mine upgrade — that mine re-triggered the
      // energy gate, looped back to the power plant, hit recursion ceiling.
      // Bail out when the power plant is unaffordable so the original mine's
      // cost check below returns the "waiting for resources" message.
      const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
      const pickAffordable =
        r.m >= pickCost.m &&
        r.c >= pickCost.c &&
        r.d >= (pickCost.d ?? 0);
      if (pickAffordable) {
        const bumped = Math.min(10, ctx.rootGoal.priority + 5);
        const elevCtx: PlanCtx = {
          ...ctx,
          depth: ctx.depth + 1,
          rootGoal: { ...ctx.rootGoal, priority: bumped },
        };
        return planBuild(pickBuilding, pickLevel, planetId, elevCtx);
      }
      // else: fall through; original mine cost check will block with a
      // resource-wait reason that names the deficit.
    }
  }

  for (const [reqTech, reqLevel] of Object.entries(entry.requires)) {
    const reqEntry = TECH_TREE[reqTech];
    if (!reqEntry) {
      return { blocked: `unknown prereq tech: ${reqTech} (required by ${building})` };
    }
    if (reqEntry.kind === "building") {
      const actual = planet?.buildings?.[reqTech] ?? 0;
      if (actual < reqLevel) {
        return planBuild(reqTech, reqLevel, planetId, { ...ctx, depth: ctx.depth + 1 });
      }
    } else if (reqEntry.kind === "research") {
      const actual = ctx.state.research.levels[reqTech] ?? 0;
      if (actual < reqLevel) {
        return planResearch(reqTech, reqLevel, { ...ctx, depth: ctx.depth + 1 });
      }
    } else {
      return { blocked: `unsupported prereq kind ${reqEntry.kind} for ${reqTech}` };
    }
  }

  // v0.0.695 — operator 2026-06-03 "等待资源的 先检查资源是否够了，再发api请求，
  // 不够就不用发". Affordability check now applies to ALL buildings (including
  // mines). Previously mines skipped the check entirely → planner emitted
  // directive when short → ogame returned "資源不足" → goal hit backoff_60s.
  const costFn = entry.cost_at as ((l: number) => { m: number; c: number; d?: number; e?: number }) | undefined;
  if (costFn) {
    const rawCost = costFn(nextLevel);
    const buildCost = { m: rawCost.m, c: rawCost.c, d: rawCost.d ?? 0, e: rawCost.e ?? 0 };
    const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
    const affordable = r.m >= buildCost.m && r.c >= buildCost.c && r.d >= buildCost.d;
    if (!affordable) {
      const sM = Math.max(0, buildCost.m - r.m), sC = Math.max(0, buildCost.c - r.c), sD = Math.max(0, buildCost.d - r.d);
      if (isPostExpeditionPhase(ctx.state)) {
        return { blocked: `waiting for resources (m=${sM} c=${sC} d=${sD} short)` };
      }
      // Pre-phase: storage strategy first, then production wait ETA
      const storUp = pickStorageUpgrade(planet, { m: sM, c: sC, d: sD });
      if (storUp) {
        const curLvl = planet.buildings?.[storUp] ?? 0;
        return planBuild(storUp, curLvl + 1, planetId, { ...ctx, depth: ctx.depth + 1 });
      }
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      // v0.0.726 — operator 2026-06-03 "建造 重氫合成器 32 时间评估错误 实际
      // 时间是27分钟" (panel showed 11h12m ≈ 24× over). Root cause: 服务器
      // 经济倍率没乘进 wait formula. ogame's prod field is base per-second
      // before universe economy speed (server.speed, typically 1-10). Real
      // hourly rate = prod * 3600 * server.speed. Skipping server.speed
      // makes wait ETA scale with reciprocal of speed (speed=8 → wait 8×
      // too high; combined with bonus drift → operator's observed 24×).
      const econSpeed = ctx.state.server?.speed ?? 1;
      const tM = (prod.m_h ?? 0) > 0 ? sM / ((prod.m_h ?? 1) * econSpeed) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / ((prod.c_h ?? 1) * econSpeed) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / ((prod.d_h ?? 1) * econSpeed) * 3600 : (sD > 0 ? 999999 : 0);
      const wait = Math.round(Math.max(tM, tC, tD));
      return { blocked: `waiting ${wait}s for resources (m=${sM} c=${sC} d=${sD} short)` };
    }
  }

  return makeBuildDirective(building, nextLevel, planetId, ctx);
}

function makeBuildDirective(building: string, nextLevel: number, planetId: string, ctx: PlanCtx): Directive {
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: ctx.rootGoal.priority,
    action: "build",
    params: {
      building,
      target_level: nextLevel,
      planet_id: planetId,
      technology_id: nameToId(building),
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `build ${building} → ${nextLevel} on ${planetId}`,
    goal_id: ctx.rootGoal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// build_ships
// ────────────────────────────────────────────────────────────────────────────

function planBuildShipsGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { ship?: unknown; amount?: unknown; planet?: unknown };
  const ship = typeof target.ship === "string" ? target.ship : "";
  const amount = typeof target.amount === "number" ? target.amount : 0;
  if (!ship) return { blocked: "build_ships goal missing target.ship" };
  if (amount <= 0) {
    return { blocked: `already at or above target — build_ships amount=${amount}` };
  }

  const planetRef =
    (typeof target.planet === "string" && target.planet) ||
    goal.planet ||
    "";
  const planet = resolvePlanet(planetRef, state);
  if (!planet) return { blocked: `planet not found: ${planetRef}` };

  // Already a shipyard queue item targeting this ship and not yet done?
  const sq = planet.shipyard_q;
  if (sq && sq.ship === ship && sq.ends_at > Date.now()) {
    return { blocked: `already at or above target — production started for ${ship} on ${planet.id}` };
  }

  // Resource shortfall → auto-upgrade the bottleneck mine. Without this the
  // ship build sits at ogame "資源不足" forever waiting on natural accumulation.
  const shipEntry = TECH_TREE[ship];
  const cost = shipEntry?.cost_at ? shipEntry.cost_at(1) : null;
  if (cost) {
    const totalCost = { m: cost.m * amount, c: cost.c * amount, d: cost.d * amount, e: cost.e * amount };
    const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
    const affordable = r.m >= totalCost.m && r.c >= totalCost.c && r.d >= totalCost.d;
    if (!affordable) {
      const sM = Math.max(0, totalCost.m - r.m), sC = Math.max(0, totalCost.c - r.c), sD = Math.max(0, totalCost.d - r.d);
      if (isPostExpeditionPhase(state)) {
        return { blocked: `waiting for resources (m=${sM} c=${sC} d=${sD} short)` };
      }
      const storUp = pickStorageUpgrade(planet, { m: sM, c: sC, d: sD });
      if (storUp) {
        const curLvl = (planet.buildings as Record<string, number>)[storUp] ?? 0;
        const elevatedRoot = { ...goal, priority: Math.min(10, goal.priority + 3) } as Goal;
        const ctx: PlanCtx = { state, rootGoal: elevatedRoot, depth: 0, sourcePlanetId: planet.id };
        return planBuild(storUp, curLvl + 1, planet.id, ctx);
      }
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      // v0.0.726 — operator 2026-06-03 "建造 重氫合成器 32 时间评估错误 实际
      // 时间是27分钟" (panel showed 11h12m ≈ 24× over). Root cause: 服务器
      // 经济倍率没乘进 wait formula. ogame's prod field is base per-second
      // before universe economy speed (server.speed, typically 1-10). Real
      // hourly rate = prod * 3600 * server.speed. Skipping server.speed
      // makes wait ETA scale with reciprocal of speed (speed=8 → wait 8×
      // too high; combined with bonus drift → operator's observed 24×).
      const econSpeed = state.server?.speed ?? 1;
      const tM = (prod.m_h ?? 0) > 0 ? sM / ((prod.m_h ?? 1) * econSpeed) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / ((prod.c_h ?? 1) * econSpeed) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / ((prod.d_h ?? 1) * econSpeed) * 3600 : (sD > 0 ? 999999 : 0);
      const wait = Math.round(Math.max(tM, tC, tD));
      return { blocked: `waiting ${wait}s for resources (m=${sM} c=${sC} d=${sD} short)` };
    }
  }

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "build_ships",
    params: {
      ship,
      amount,
      planet_id: planet.id,
      technology_id: nameToId(ship),
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `build ${amount}× ${ship} on ${planet.id}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// expedition
// ────────────────────────────────────────────────────────────────────────────

function planExpeditionGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as {
    source_planet?: unknown;
    ships?: unknown;
    target_position?: unknown;
  };
  const sourcePlanetRaw = typeof target.source_planet === "string" ? target.source_planet : undefined;
  const planet =
    resolvePlanet(sourcePlanetRaw, state) ??
    resolvePlanet(goal.planet, state) ??
    Object.values(state.planets ?? {})[0];
  if (!planet) return { blocked: "expedition goal: no planets available" };

  const ships = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  const targetPosition = typeof target.target_position === "number" ? target.target_position : 16;

  const sourceCoordsKey = planet.coords.join(":");
  // No "1 expedition per planet" block — owner runs multiple parallel
  // expeditions up to ogame's slot cap (max=4 for explorer). Slot
  // capacity check happens at the daemon level (bridge expeditionTick).
  // Each exp- goal here = one launch attempt regardless of how many
  // fleets are already outbound. ogame will reject 140019 if cap full.

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "expedition",
    params: {
      planet_id: planet.id,
      source_planet: planet.id,
      source_coords: sourceCoordsKey,
      ships,
      target_position: targetPosition,
      mission: MISSION_EXPEDITION,
    },
    preconds: [],
    // Operator 2026-05-27: "也不要有 ttl". Expedition directive must never
    // expire — fleet returns asynchronously and may sit cross-boundary;
    // expiring leads to silent miss + slot underuse.
    expires_at: Number.MAX_SAFE_INTEGER,
    reason: `expedition from ${sourceCoordsKey} → pos ${targetPosition}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// colonize
// ────────────────────────────────────────────────────────────────────────────

function planColonizeGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as {
    target_coords?: unknown;
    source_planet?: unknown;
    // v0.0.689 — range-scan shape (operator 2026-06-03 "舰船任务改成殖民任务"):
    galaxy_min?: unknown; galaxy_max?: unknown;
    system_min?: unknown; system_max?: unknown;
    position_min?: unknown; position_max?: unknown;
  };
  const targetCoords = typeof target.target_coords === "string" ? target.target_coords : "";
  const hasRange =
    typeof target.galaxy_min === "number" && typeof target.galaxy_max === "number" &&
    typeof target.system_min === "number" && typeof target.system_max === "number" &&
    typeof target.position_min === "number" && typeof target.position_max === "number";
  if (!targetCoords && !hasRange) {
    return { blocked: "colonize goal missing target.target_coords or range" };
  }

  const sourceRaw = typeof target.source_planet === "string" ? target.source_planet : undefined;
  const sourcePlanet =
    resolvePlanet(sourceRaw, state) ??
    resolvePlanet(goal.planet, state) ??
    Object.values(state.planets ?? {})[0];
  if (!sourcePlanet) return { blocked: "colonize goal: no source planet available" };

  // Terminal: a colonize fleet (mission=7) is already in flight from this
  // planet — treat as completed so we don't double-send.
  const srcKey = sourcePlanet.coords.join(":");
  for (const f of state.fleets_outbound ?? []) {
    if (f.mission === MISSION_COLONIZE && f.origin.join(":") === srcKey) {
      return { blocked: "already at or above target — colonize fleet in flight" };
    }
  }

  // v0.0.689 — auto-build colonyShip when missing. Operator's flow step 1
  // ("在出发星球建造殖民船") becomes implicit: planner emits build_ships when
  // hangar is empty; next tick re-enters this fn and finds it ready.
  const colonyShips = sourcePlanet.ships?.colonyShip ?? 0;
  if (colonyShips < 1) {
    return {
      id: `dir-${randomUUID()}`,
      source: "goal",
      method: "ui",
      priority: goal.priority,
      action: "build_ships",
      params: {
        planet_id: sourcePlanet.id,
        ship: "colonyShip",
        amount: 1,
        technology_id: 208,  // colonyShip ogame numeric id
      },
      preconds: [],
      expires_at: Date.now() + DIRECTIVE_TTL_MS,
      reason: `colonize prereq: build 1 colonyShip on ${sourcePlanet.id}`,
      goal_id: goal.id,
    };
  }

  // ColonyShip ready. Emit colonize directive — legacy single-coord or
  // new range-scan (api_executor handles galaxy scan at dispatch time).
  const params: Record<string, unknown> = {
    planet_id: sourcePlanet.id,
    source_planet: sourcePlanet.id,
    mission: MISSION_COLONIZE,
    ships: { colonyShip: 1 } satisfies ShipCount,
  };
  let reason: string;
  if (hasRange) {
    params["range"] = {
      galaxy_min: target.galaxy_min, galaxy_max: target.galaxy_max,
      system_min: target.system_min, system_max: target.system_max,
      position_min: target.position_min, position_max: target.position_max,
    };
    reason = `colonize scan g[${String(target.galaxy_min)}-${String(target.galaxy_max)}] s[${String(target.system_min)}-${String(target.system_max)}] p[${String(target.position_min)}-${String(target.position_max)}] from ${sourcePlanet.id}`;
  } else {
    params["target_coords"] = targetCoords;
    reason = `colonize ${targetCoords} from ${sourcePlanet.id}`;
  }

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "colonize",
    params,
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// deploy / transport (mission 4 / 3)
// ────────────────────────────────────────────────────────────────────────────

function planFleetSendGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as {
    target_coords?: unknown;
    target_type?: unknown;     // v0.0.428: "planet" | "moon" | "debris"
    ships?: unknown;
    resources?: unknown;
    cargo?: unknown;           // v0.0.428: panel writes `cargo`, accept both
    source_planet?: unknown;
  };
  const targetCoords = typeof target.target_coords === "string" ? target.target_coords : "";
  if (!targetCoords) return { blocked: `${goal.type} goal missing target.target_coords` };
  const targetType = typeof target.target_type === "string" ? target.target_type : "planet";

  const ships = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  const shipsList = Object.entries(ships).filter(([, n]) => typeof n === "number" && (n as number) > 0);
  if (shipsList.length === 0) {
    return { blocked: `${goal.type} goal: ships map is empty` };
  }

  // v0.0.428: panel writes `cargo` (m/c/d); legacy callers use `resources`.
  // Accept either; cargo wins if both present.
  const resources =
    typeof target.cargo === "object" && target.cargo !== null
      ? (target.cargo as { m?: number; c?: number; d?: number })
      : typeof target.resources === "object" && target.resources !== null
        ? (target.resources as { m?: number; c?: number; d?: number })
        : undefined;

  const sourceRaw = typeof target.source_planet === "string" ? target.source_planet : undefined;
  const sourcePlanet =
    resolvePlanet(sourceRaw, state) ??
    resolvePlanet(goal.planet, state) ??
    Object.values(state.planets ?? {})[0];
  if (!sourcePlanet) return { blocked: `${goal.type} goal: no source planet available` };

  // v0.0.485 — same-body no-op guard. Operator 2026-05-30: chain Seg 3
  // "to_stop_load" with fromP=moon emitted deploy with source=moon AND
  // target_coords=that moon's coord (moon→self). userscript sendFleet
  // fallback-rewrote source to a planet at OTHER coord, dispatching a
  // duplicate of Seg 2's cargo fleet. Backend backstop: when source body's
  // coord matches target coord AND types align → refuse to dispatch.
  const sourceCoordStr = (sourcePlanet.coords ?? []).join(":");
  const sourceType = (sourcePlanet as { type?: string }).type ?? "planet";
  if (sourceCoordStr && sourceCoordStr === targetCoords && sourceType === targetType) {
    return { blocked: `${goal.type} no-op: source body ${sourcePlanet.id} (${sourceType}) is already at ${targetCoords} — same body, nothing to deploy` };
  }

  const mission = goal.type === "deploy" ? MISSION_DEPLOY : MISSION_TRANSPORT;

  // v0.0.547 — operator 2026-05-31 "这次根本就没飞 你看一下最后一个运输任务"
  // chain leg 1 (ferry_to_res_load planet→moon at 4:299:8) was auto-completed
  // 71ms after creation because this check returned `blocked: already at or
  // above target — ... fleet in flight ...` and ALREADY_AT_TARGET_RE matched
  // "in flight" → priority_merger flipped to "completed" (terminal).
  // But the in-flight fleet was UNRELATED (different chain, same coord pair).
  // For chain legs, "fleet in flight" means WAIT (transient), NOT done.
  // Drop the "already at or above target" prefix so the regex doesn't match
  // and the goal stays blocked (will retry when fleet clears outbound).
  const srcKey = sourcePlanet.coords.join(":");
  for (const f of state.fleets_outbound ?? []) {
    if (
      f.mission === mission &&
      f.origin.join(":") === srcKey &&
      f.dest.join(":") === targetCoords
    ) {
      return { blocked: `${goal.type} pre-empted by existing fleet (mission ${mission} ${srcKey}→${targetCoords}); waiting for clear outbound` };
    }
  }

  // Block when source has insufficient ships.
  for (const [shipKey, want] of shipsList) {
    const have = (sourcePlanet.ships as Record<string, number | undefined>)?.[shipKey] ?? 0;
    if (have < (want as number)) {
      return {
        blocked: `${goal.type} blocked: ${sourcePlanet.id} has ${have}× ${shipKey}, need ${want as number}`,
      };
    }
  }

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: goal.type, // "deploy" | "transport"
    params: {
      target_coords: targetCoords,
      target_type: targetType,
      ships,
      ...(resources ? { resources } : {}),
      planet_id: sourcePlanet.id,
      source_planet: sourcePlanet.id,
      mission,
      // v0.0.431: forward chain_id so goal_runner slot-gate + api_executor
      // slot-gate can detect chain-bound deploy and bypass keep-1-empty.
      ...(typeof (target as { chain_id?: unknown }).chain_id === "string" && (target as { chain_id?: string }).chain_id
        ? { chain_id: (target as { chain_id: string }).chain_id } : {}),
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `${goal.type} from ${srcKey} → ${targetCoords}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// jumpgate (Phase 2b — sibling-moon hop via ogame /component=jumpgate)
// ────────────────────────────────────────────────────────────────────────────

function planJumpgateGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as {
    source_moon?: string;          // moon planet_id where the JG fires
    target_moon?: string;          // sibling moon planet_id to land on
    ships?: unknown;               // ShipCount of what to send
    chain_id?: string;             // forwarded to bridge for debug
  };
  const sourceMoonId = typeof target.source_moon === "string" ? target.source_moon : undefined;
  const targetMoonId = typeof target.target_moon === "string" ? target.target_moon : undefined;
  if (!sourceMoonId) return { blocked: "jumpgate: missing source_moon" };
  if (!targetMoonId) return { blocked: "jumpgate: missing target_moon" };
  const srcMoon = state.planets?.[sourceMoonId];
  const tgtMoon = state.planets?.[targetMoonId];
  if (!srcMoon) return { blocked: `jumpgate: source_moon ${sourceMoonId} not in state` };
  if (tgtMoon === undefined) return { blocked: `jumpgate: target_moon ${targetMoonId} not in state` };
  // Cooldown check — frontend captures jumpgate_cooldown_sec on each click;
  // we treat absence as "ready" (operator's overlay GET will refresh).
  // v0.0.720 — operator 2026-06-03 "JG 没有跳" 真因: ogame v12 JG lock 是
  // bilateral — A→B 完成后 A 跟 B 都进 cd, 期间任何方向 JG 都拒。Planner
  // 之前只查 source moon cd, target 还在 cd 时 dispatch → ogame 空 error 拒。
  // Evidence: 3:279:7 月球 cd=1596 (paired with 2:279:8 19:38 UTC JG), 1:486:7
  // → 3:279:7 dispatch 5 次, ogame 全 reject 空 error。Fix: 同样 cd 检查 also
  // 跑 target moon。Block reason 区分 src vs tgt 便于 operator 看 panel。
  const cdSec = (srcMoon as { jumpgate_cooldown_sec?: number | null }).jumpgate_cooldown_sec;
  const harvestedAt = (srcMoon as { jumpgate_harvested_at?: number | null }).jumpgate_harvested_at;
  if (typeof cdSec === "number" && cdSec > 0 && typeof harvestedAt === "number") {
    const elapsedSec = Math.floor((Date.now() - harvestedAt) / 1000);
    const remaining = cdSec - elapsedSec;
    if (remaining > 0) {
      return { blocked: `jumpgate: source_moon ${sourceMoonId} cooldown ${remaining}s remaining` };
    }
  }
  const tgtCdSec = (tgtMoon as { jumpgate_cooldown_sec?: number | null } | undefined)?.jumpgate_cooldown_sec;
  const tgtHarvestedAt = (tgtMoon as { jumpgate_harvested_at?: number | null } | undefined)?.jumpgate_harvested_at;
  if (typeof tgtCdSec === "number" && tgtCdSec > 0 && typeof tgtHarvestedAt === "number") {
    const tgtElapsedSec = Math.floor((Date.now() - tgtHarvestedAt) / 1000);
    const tgtRemaining = tgtCdSec - tgtElapsedSec;
    if (tgtRemaining > 0) {
      return { blocked: `jumpgate: target_moon ${targetMoonId} cooldown ${tgtRemaining}s remaining (ogame v12 bilateral lock — both moons must be ready)` };
    }
  }
  // v0.0.469: take-all-ships mode (operator 2026-05-30 "用跳跃门往回走的
  // 时候带走月球上所有的船"). When target.take_all is true OR ships ==="all",
  // SUBSTITUTE the static ships count with whatever is currently on the
  // source moon at dispatch time. JG ferry leg sweeps up everything, not
  // just what operator originally configured. Static ship count still
  // supported for fine-grained chains.
  const takeAll = (target as { take_all?: unknown }).take_all === true || target.ships === "all";
  let ships: ShipCount;
  if (takeAll) {
    const onMoonAll = srcMoon.ships ?? {};
    ships = {} as ShipCount;
    for (const [name, n] of Object.entries(onMoonAll)) {
      if ((n ?? 0) > 0) (ships as Record<string, number>)[name] = n as number;
    }
  } else {
    ships = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  }
  // v0.0.547 — operator 2026-05-31 "JG 没有跳" → take_all JG with 0 ships on
  // source moon → dispatched ships={} → userscript throws "empty ships payload"
  // → ack failure → WS-flap loses ack → goal stuck active → stuck-recovery
  // re-dispatches in a loop. Fix: refuse to dispatch JG with empty ships.
  // Wait for upstream ferry to actually deliver ships before generating the
  // JG directive.
  if (Object.values(ships).every((n) => !(n as number) || (n as number) <= 0)) {
    return { blocked: `jumpgate: source_moon ${sourceMoonId} has no ships available yet (waiting for upstream ferry)` };
  }
  // Ship availability gate — sum of requested ships vs source-moon current.
  const onMoon = srcMoon.ships ?? {};
  for (const [name, n] of Object.entries(ships)) {
    if ((n ?? 0) <= 0) continue;
    if ((onMoon[name as keyof ShipCount] ?? 0) < (n ?? 0)) {
      return { blocked: `jumpgate: source_moon ${sourceMoonId} only has ${onMoon[name as keyof ShipCount] ?? 0}× ${name}, needs ${n}` };
    }
  }
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "jumpgate",
    params: {
      planet_id: sourceMoonId,            // session-cp source for the POST
      source_moon_id: sourceMoonId,
      target_moon_id: targetMoonId,
      ships,
      chain_id: target.chain_id ?? "",
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `jumpgate ${sourceMoonId} → ${targetMoonId}`,
    goal_id: goal.id,
  };
}

// Re-export GoalType for callers who want to switch on it; keeps the module
// self-contained as the canonical planner entry point.
export type { GoalType };
