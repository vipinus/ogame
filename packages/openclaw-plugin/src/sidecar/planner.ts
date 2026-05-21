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
    default:
      return { blocked: `goal type ${goal.type} not implemented` };
  }
}

/**
 * Lifeform building goal — same scheduleEntry endpoint as regular buildings
 * (verified via sniffer 2026-05-21: technologyId=11102 biosphereFarm), but
 * prereq chain lives in LIFEFORM_TECH catalog (humans/rocktal/mechas/kaelesh).
 * Target shape: {building:"researchCentre", level:N, planet?:string}.
 */
function planLifeformBuildingGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { building?: string; level?: number; planet?: string };
  const building = target.building ?? "";
  const level = target.level ?? 0;
  if (!building) return { blocked: "lifeform_building goal missing target.building" };
  if (level <= 0) return { blocked: "lifeform_building goal needs target.level > 0" };
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

  // Population/Food balance — auto-build food when housing grows. Without
  // this, owner ends up with overcrowded planets → workers starve → mines
  // run at reduced output. Rule: biosphereFarm must keep up with all
  // population buildings.
  const POPULATION_BLDGS = ["residentialSector", "skyscraper", "metropolis"];
  const FOOD_BLDG = "biosphereFarm";
  // Food MUST stay ahead of population — owner rule "酒足饭饱大于生活空间".
  // expectedFood = (sum of all population building levels) + FOOD_SAFETY_MARGIN
  // so workers never starve, even if owner queues multiple housing in a row.
  const FOOD_SAFETY_MARGIN = 2;
  if (POPULATION_BLDGS.includes(building)) {
    const otherPop = POPULATION_BLDGS
      .filter((b) => b !== building)
      .reduce((sum, b) => sum + (lfBldg[b] ?? 0), 0);
    const expectedFoodLvl = level + otherPop + FOOD_SAFETY_MARGIN;
    const currentFood = lfBldg[FOOD_BLDG] ?? 0;
    if (currentFood < expectedFoodLvl) {
      const subGoal: Goal = { ...goal, target: { building: FOOD_BLDG, level: expectedFoodLvl, planet: planet.id } } as Goal;
      return planLifeformBuildingGoal(subGoal, state);
    }
  }

  // Prereq check — recurse into missing prereqs first.
  for (const [prereqName, reqLvl] of Object.entries(entry.requires)) {
    if ((lfBldg[prereqName] ?? 0) < reqLvl) {
      const subGoal: Goal = { ...goal, target: { building: prereqName, level: reqLvl, planet: planet.id } } as Goal;
      return planLifeformBuildingGoal(subGoal, state);
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

  // In-flight: an EXPEDITION fleet already outbound from this planet's coords.
  const sourceCoordsKey = planet.coords.join(":");
  for (const f of state.fleets_outbound ?? []) {
    if (f.mission === MISSION_EXPEDITION && f.origin.join(":") === sourceCoordsKey) {
      return { blocked: "already at or above target — expedition fleet in flight" };
    }
  }

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
