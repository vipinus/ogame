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

/**
 * Resolve a planet reference. Accepts either an ogame numeric planet ID
 * ("33657770") or canonical coord string ("1:190:6"). Falls back to undefined
 * if neither lookup matches — callers must handle that.
 */

// ─── Resource strategy: wait vs mine upgrade ─────────────────────────────
// When resources are insufficient for a build/research/ship, the planner
// can either (A) wait for production to accumulate, or (B) upgrade the
// bottleneck mine to a higher level first (more production, but mine
// itself costs resources + build time). This helper computes BOTH options'
// total seconds and returns the cheaper path. Used by planBuild,
// planBuildShipsGoal, planLifeformBuildingGoal.
//
// Returns:
//   { action: "wait" }                       — direct wait is faster (or equal)
//   { action: "upgrade_mine", mine: <name> } — upgrade this mine first
function pickResourceStrategy(
  planet: Planet,
  cost: { m: number; c: number; d: number; e: number },
  universeSpeed: number,
): { action: "wait" } | { action: "upgrade_mine"; mine: string } {
  const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
  const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
  // (A) Direct wait time = max across short resources
  const waitTime = (short: { m: number; c: number; d: number }) => {
    const tM = (prod.m_h ?? 0) > 0 ? short.m / (prod.m_h ?? 1) * 3600 : (short.m > 0 ? Infinity : 0);
    const tC = (prod.c_h ?? 0) > 0 ? short.c / (prod.c_h ?? 1) * 3600 : (short.c > 0 ? Infinity : 0);
    const tD = (prod.d_h ?? 0) > 0 ? short.d / (prod.d_h ?? 1) * 3600 : (short.d > 0 ? Infinity : 0);
    return Math.max(tM, tC, tD, 0);
  };
  const shortDirect = {
    m: Math.max(0, cost.m - r.m),
    c: Math.max(0, cost.c - r.c),
    d: Math.max(0, cost.d - r.d),
  };
  const waitA = waitTime(shortDirect);
  if (waitA === 0) return { action: "wait" }; // already affordable
  // Per-level build duration formula (uses robotics + nanite factors).
  const robotics = planet.buildings?.["roboticsFactory"] ?? 0;
  const nanite = planet.buildings?.["naniteFactory"] ?? 0;
  const buildSec = (c: { m: number; c: number }) => {
    const denom = 2500 * (1 + robotics) * Math.pow(2, nanite) * Math.max(1, universeSpeed);
    return denom > 0 ? ((c.m + c.c) / denom) * 3600 : 3600;
  };
  // Mine production at level L (ogame standard, ignoring temperature for D).
  const mineProdAt = (mine: string, lvl: number): number => {
    if (lvl <= 0) return 0;
    if (mine === "metalMine") return 30 * lvl * Math.pow(1.1, lvl) * universeSpeed;
    if (mine === "crystalMine") return 20 * lvl * Math.pow(1.1, lvl) * universeSpeed;
    if (mine === "deuteriumSynth") return 10 * lvl * Math.pow(1.1, lvl) * universeSpeed;
    return 0;
  };
  // (B) For each candidate mine, compute total = upgrade time + remainder wait.
  const candidates: Array<{ mine: string; total: number }> = [];
  for (const mine of ["metalMine", "crystalMine", "deuteriumSynth"]) {
    // Skip if this mine doesn't fix the bottleneck. Pick by which resource
    // is short relative to cost.
    const currLvl = planet.buildings?.[mine] ?? 0;
    if (currLvl >= 35) continue; // upgrade cost gets pathological at high levels
    const tech = TECH_TREE[mine];
    if (!tech || typeof tech.cost_at !== "function") continue;
    const mineCost = tech.cost_at(currLvl + 1);
    const mineCostMC = { m: mineCost.m, c: mineCost.c, d: mineCost.d };
    // Time to afford the mine upgrade (we don't have it yet either)
    const mineShort = {
      m: Math.max(0, mineCostMC.m - r.m),
      c: Math.max(0, mineCostMC.c - r.c),
      d: Math.max(0, mineCostMC.d - r.d),
    };
    const mineWait = waitTime(mineShort);
    if (!Number.isFinite(mineWait)) continue;
    const mineBuild = buildSec(mineCost);
    const mineUpgradeTotal = mineWait + mineBuild;
    // Resources accumulated during the upgrade + remaining after paying mine cost.
    const resAfter = {
      m: r.m + (prod.m_h ?? 0) * mineUpgradeTotal / 3600 - mineCostMC.m,
      c: r.c + (prod.c_h ?? 0) * mineUpgradeTotal / 3600 - mineCostMC.c,
      d: r.d + (prod.d_h ?? 0) * mineUpgradeTotal / 3600 - mineCostMC.d,
    };
    // New production rates (only the upgraded mine increases; others unchanged).
    const newProd = {
      m_h: mine === "metalMine" ? mineProdAt(mine, currLvl + 1) : (prod.m_h ?? 0),
      c_h: mine === "crystalMine" ? mineProdAt(mine, currLvl + 1) : (prod.c_h ?? 0),
      d_h: mine === "deuteriumSynth" ? mineProdAt(mine, currLvl + 1) : (prod.d_h ?? 0),
    };
    const shortAfter = {
      m: Math.max(0, cost.m - resAfter.m),
      c: Math.max(0, cost.c - resAfter.c),
      d: Math.max(0, cost.d - resAfter.d),
    };
    const waitAfter = ((): number => {
      const tM = newProd.m_h > 0 ? shortAfter.m / newProd.m_h * 3600 : (shortAfter.m > 0 ? Infinity : 0);
      const tC = newProd.c_h > 0 ? shortAfter.c / newProd.c_h * 3600 : (shortAfter.c > 0 ? Infinity : 0);
      const tD = newProd.d_h > 0 ? shortAfter.d / newProd.d_h * 3600 : (shortAfter.d > 0 ? Infinity : 0);
      return Math.max(tM, tC, tD, 0);
    })();
    if (!Number.isFinite(waitAfter)) continue;
    candidates.push({ mine, total: mineUpgradeTotal + waitAfter });
  }
  const best = candidates.sort((a, b) => a.total - b.total)[0];
  if (best && best.total < waitA) {
    return { action: "upgrade_mine", mine: best.mine };
  }
  return { action: "wait" };
}

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
    case "species_discovery":
      return planSpeciesDiscoveryGoal(goal, state);
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

  // Slot capacity check — keep 1 slot empty. server.used_fleet_slots /
  // max_fleet_slots written at runtime; not in strict WorldState.server
  // type, so cast.
  const server = (state.server ?? {}) as { used_fleet_slots?: number; max_fleet_slots?: number };
  const used = server.used_fleet_slots ?? 0;
  const max = server.max_fleet_slots ?? 0;
  if (max > 0 && used >= max - 1) {
    return { blocked: `species_discovery: keep 1 fleet slot empty (used=${used} max=${max})` };
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
    params: {
      planet_id: planetId,
      galaxy,
      system: nextSystem,
      position: nextPosition,
      goal_id: goal.id, // so directive_completed handler can write back
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
      const universeSpeed = state.server?.speed ?? 1;
      const strategy = pickResourceStrategy(planet, lfCost, universeSpeed);
      if (strategy.action === "upgrade_mine") {
        const currentLvl = (planet.buildings as Record<string, number>)[strategy.mine] ?? 0;
        const elevatedRoot = { ...goal, priority: Math.min(10, goal.priority + 3) } as Goal;
        const ctx: PlanCtx = { state, rootGoal: elevatedRoot, depth: 0, sourcePlanetId: planet.id };
        return planBuild(strategy.mine, currentLvl + 1, planet.id, ctx);
      }
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      const sM = Math.max(0, lfCost.m - r.m), sC = Math.max(0, lfCost.c - r.c), sD = Math.max(0, lfCost.d - r.d);
      const tM = (prod.m_h ?? 0) > 0 ? sM / (prod.m_h ?? 1) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / (prod.c_h ?? 1) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / (prod.d_h ?? 1) * 3600 : (sD > 0 ? 999999 : 0);
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
      const planet = Object.values(ctx.state.planets ?? {}).find((p) => p.id === ctx.sourcePlanetId);
      const actual = planet?.buildings?.[reqTech] ?? 0;
      if (actual < reqLevel) {
        return planBuild(reqTech, reqLevel, ctx.sourcePlanetId, { ...ctx, depth: ctx.depth + 1 });
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

  const planet = resolvePlanet(planetRef, state);
  if (!planet) return { blocked: `planet not found: ${planetRef}` };

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
  const entry = TECH_TREE[building];
  if (!entry) return { blocked: `unknown tech: ${building}` };
  if (entry.kind !== "building") {
    return { blocked: `tech ${building} is not a building (kind=${entry.kind})` };
  }

  const planet = Object.values(ctx.state.planets ?? {}).find((p) => p.id === planetId);
  if (!planet) return { blocked: `planet not found: ${planetId}` };

  const current = planet.buildings?.[building] ?? 0;
  if (current >= targetLevel) {
    return {
      blocked: `already at or above target level (${current} >= ${targetLevel}) for ${building} on ${planetId}`,
    };
  }

  // Is this building currently upgrading? Only treat as in-flight if the
  // queue entry actually targets THIS building AND hasn't already ended.
  const buildQ = planet.build_q;
  if (buildQ && buildQ.item === building && (buildQ.ends_at ?? 0) > Date.now()) {
    return { blocked: `${building} already upgrading in ogame queue on ${planetId}` };
  }

  const nextLevel = current + 1;

  // Energy gate: mines need positive net energy; if a mine upgrade is queued
  // but energy is negative (or no solar plant exists yet), recurse into a
  // solar plant upgrade first. Skip recursion when the target IS solarPlant
  // — otherwise we'd loop forever.
  if (
    ENERGY_GATED_BUILDINGS.has(building) &&
    building !== "solarPlant"
  ) {
    const energy = planet.resources?.e ?? 0;
    const solar = planet.buildings?.["solarPlant"] ?? 0;
    if (energy < 0 || solar === 0) {
      const bumped = Math.min(10, ctx.rootGoal.priority + 5);
      const elevCtx: PlanCtx = {
        ...ctx,
        depth: ctx.depth + 1,
        rootGoal: { ...ctx.rootGoal, priority: bumped },
      };
      return planBuild("solarPlant", solar + 1, planetId, elevCtx);
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

  // Resource strategy — same wait-vs-upgrade-mine comparison as for ships/lf.
  // For mine builds themselves the inner check is degenerate (the mine
  // would need to upgrade itself), pickResourceStrategy excludes that.
  const costFn = entry.cost_at as ((l: number) => { m: number; c: number; d?: number; e?: number }) | undefined;
  if (costFn && !["metalMine", "crystalMine", "deuteriumSynth"].includes(building)) {
    const rawCost = costFn(nextLevel);
    const buildCost = { m: rawCost.m, c: rawCost.c, d: rawCost.d ?? 0, e: rawCost.e ?? 0 };
    const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
    const affordable = r.m >= buildCost.m && r.c >= buildCost.c && r.d >= buildCost.d;
    if (!affordable) {
      const universeSpeed = ctx.state.server?.speed ?? 1;
      const strategy = pickResourceStrategy(planet, buildCost, universeSpeed);
      if (strategy.action === "upgrade_mine") {
        const currentLvl = planet.buildings?.[strategy.mine] ?? 0;
        return planBuild(strategy.mine, currentLvl + 1, planetId, { ...ctx, depth: ctx.depth + 1 });
      }
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      const sM = Math.max(0, buildCost.m - r.m), sC = Math.max(0, buildCost.c - r.c), sD = Math.max(0, buildCost.d - r.d);
      const tM = (prod.m_h ?? 0) > 0 ? sM / (prod.m_h ?? 1) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / (prod.c_h ?? 1) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / (prod.d_h ?? 1) * 3600 : (sD > 0 ? 999999 : 0);
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
      // Resource-bound. pickResourceStrategy compares (wait) vs (upgrade-mine-then-wait)
      // and returns the faster path. Execute it deterministically:
      //   upgrade_mine → recurse into mine build
      //   wait         → block (don't emit a doomed POST), include eta in reason
      const universeSpeed = state.server?.speed ?? 1;
      const strategy = pickResourceStrategy(planet, totalCost, universeSpeed);
      if (strategy.action === "upgrade_mine") {
        const currentLvl = (planet.buildings as Record<string, number>)[strategy.mine] ?? 0;
        const elevatedRoot = { ...goal, priority: Math.min(10, goal.priority + 3) } as Goal;
        const ctx: PlanCtx = { state, rootGoal: elevatedRoot, depth: 0, sourcePlanetId: planet.id };
        return planBuild(strategy.mine, currentLvl + 1, planet.id, ctx);
      }
      // wait path → block. Compute remaining wait seconds for the reason.
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      const sM = Math.max(0, totalCost.m - r.m), sC = Math.max(0, totalCost.c - r.c), sD = Math.max(0, totalCost.d - r.d);
      const tM = (prod.m_h ?? 0) > 0 ? sM / (prod.m_h ?? 1) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / (prod.c_h ?? 1) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / (prod.d_h ?? 1) * 3600 : (sD > 0 ? 999999 : 0);
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
    duration?: unknown;
  };
  const sourcePlanetRaw = typeof target.source_planet === "string" ? target.source_planet : undefined;
  const planet =
    resolvePlanet(sourcePlanetRaw, state) ??
    resolvePlanet(goal.planet, state) ??
    Object.values(state.planets ?? {})[0];
  if (!planet) return { blocked: "expedition goal: no planets available" };

  const ships = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  const targetPosition = typeof target.target_position === "number" ? target.target_position : 16;
  const duration = typeof target.duration === "string" ? target.duration : "short";

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
      duration,
      mission: MISSION_EXPEDITION,
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `expedition from ${sourceCoordsKey} → pos ${targetPosition} (${duration})`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// colonize
// ────────────────────────────────────────────────────────────────────────────

function planColonizeGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { target_coords?: unknown; source_planet?: unknown };
  const targetCoords = typeof target.target_coords === "string" ? target.target_coords : "";
  if (!targetCoords) return { blocked: "colonize goal missing target.target_coords" };

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

  // Need at least one colonyShip on the source planet.
  const colonyShips = sourcePlanet.ships?.colonyShip ?? 0;
  if (colonyShips < 1) {
    return { blocked: `colonize blocked: no colonyShip on ${sourcePlanet.id}` };
  }

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: goal.priority,
    action: "colonize",
    params: {
      planet_id: sourcePlanet.id,
      source_planet: sourcePlanet.id,
      target_coords: targetCoords,
      mission: MISSION_COLONIZE,
      ships: { colonyShip: 1 } satisfies ShipCount,
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `colonize ${targetCoords} from ${sourcePlanet.id}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// deploy / transport (mission 4 / 3)
// ────────────────────────────────────────────────────────────────────────────

function planFleetSendGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as {
    target_coords?: unknown;
    ships?: unknown;
    resources?: unknown;
    source_planet?: unknown;
  };
  const targetCoords = typeof target.target_coords === "string" ? target.target_coords : "";
  if (!targetCoords) return { blocked: `${goal.type} goal missing target.target_coords` };

  const ships = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  const shipsList = Object.entries(ships).filter(([, n]) => typeof n === "number" && (n as number) > 0);
  if (shipsList.length === 0) {
    return { blocked: `${goal.type} goal: ships map is empty` };
  }

  const resources =
    typeof target.resources === "object" && target.resources !== null
      ? (target.resources as { m?: number; c?: number; d?: number })
      : undefined;

  const sourceRaw = typeof target.source_planet === "string" ? target.source_planet : undefined;
  const sourcePlanet =
    resolvePlanet(sourceRaw, state) ??
    resolvePlanet(goal.planet, state) ??
    Object.values(state.planets ?? {})[0];
  if (!sourcePlanet) return { blocked: `${goal.type} goal: no source planet available` };

  const mission = goal.type === "deploy" ? MISSION_DEPLOY : MISSION_TRANSPORT;

  // Terminal: matching mission fleet already outbound from this planet to
  // those coords.
  const srcKey = sourcePlanet.coords.join(":");
  for (const f of state.fleets_outbound ?? []) {
    if (
      f.mission === mission &&
      f.origin.join(":") === srcKey &&
      f.dest.join(":") === targetCoords
    ) {
      return { blocked: `already at or above target — ${goal.type} fleet in flight from ${srcKey} → ${targetCoords}` };
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
      ships,
      ...(resources ? { resources } : {}),
      planet_id: sourcePlanet.id,
      source_planet: sourcePlanet.id,
      mission,
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `${goal.type} from ${srcKey} → ${targetCoords}`,
    goal_id: goal.id,
  };
}

// Re-export GoalType for callers who want to switch on it; keeps the module
// self-contained as the canonical planner entry point.
export type { GoalType };
