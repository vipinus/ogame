/**
 * M5.2 Planner — backward-chaining over TECH_TREE.
 *
 * Given a Goal + current WorldState, returns either the next executable
 * Directive or a blocked reason. For each unmet prerequisite of the goal's
 * target, the planner recurses with a synthetic sub-goal until it reaches a
 * leaf (a tech whose every prereq is met). That leaf is what gets emitted.
 *
 * In M5.2 only "research" and "build" goal types are wired up. Other goal
 * types stub-block pending later milestones (build_universal/colonize/
 * build_ships/build_defense/terraformer_to/lifeform_*).
 */
import { randomUUID } from "node:crypto";
import type { Directive, Goal, GoalType, WorldState } from "@ogamex/shared";
import { TECH_TREE } from "@ogamex/shared";

export type PlanResult = Directive | { blocked: string };

const DIRECTIVE_TTL_MS = 24 * 60 * 60 * 1000;
// Defensive cap so a malformed tech tree (e.g. accidental cycle) can't hang.
const MAX_RECURSION_DEPTH = 64;

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
    default:
      return { blocked: `goal type ${goal.type} not implemented in M5.2` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// research
// ────────────────────────────────────────────────────────────────────────────

function planResearchGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { tech?: unknown; level?: unknown };
  const tech = typeof target.tech === "string" ? target.tech : "";
  const level = typeof target.level === "number" ? target.level : 0;
  if (!tech) return { blocked: "research goal missing target.tech" };

  // Source planet for research lab lookup: M5.6 will resolve this from the
  // goal's planet/research-lab pairing; for M5.2 we fall back to planets[0].
  // If goal.planet is set but doesn't match any actual planet id (e.g. the LLM
  // wrote a friendly name like "homeworld"), fall back to first planet too.
  const goalPlanetMatches =
    typeof goal.planet === "string" &&
    state.planets.some((p) => p.id === goal.planet);
  const sourcePlanetId = goalPlanetMatches
    ? (goal.planet as string)
    : state.planets[0]?.id ?? "";

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

  // The actual NEXT step is current+1, regardless of the goal's final target.
  const nextLevel = current + 1;

  // Check prerequisites. Recurse via synthetic sub-goals (not full Goal records —
  // just enough state to call planResearch / planBuild recursively).
  for (const [reqTech, reqLevel] of Object.entries(entry.requires)) {
    const reqEntry = TECH_TREE[reqTech];
    if (!reqEntry) {
      return { blocked: `unknown prereq tech: ${reqTech} (required by ${tech})` };
    }
    if (reqEntry.kind === "building") {
      const planet = ctx.state.planets.find((p) => p.id === ctx.sourcePlanetId);
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
      // ship / defense as prereq is unusual for research; treat as blocker for now.
      return { blocked: `unsupported prereq kind ${reqEntry.kind} for ${reqTech}` };
    }
  }

  // All prereqs satisfied → emit the directive for this research step.
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
  // Planet resolution: target.planet wins, then goal.planet.
  const planetId =
    (typeof target.planet === "string" && target.planet) ||
    goal.planet ||
    "";

  if (!building) return { blocked: "build goal missing target.building" };
  if (!planetId) return { blocked: "build goal missing target.planet" };

  const planet = state.planets.find((p) => p.id === planetId);
  if (!planet) return { blocked: `planet not found: ${planetId}` };

  const ctx: PlanCtx = {
    state,
    rootGoal: goal,
    depth: 0,
    sourcePlanetId: planetId,
  };

  return planBuild(building, level, planetId, ctx);
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

  const planet = ctx.state.planets.find((p) => p.id === planetId);
  if (!planet) return { blocked: `planet not found: ${planetId}` };

  const current = planet.buildings?.[building] ?? 0;
  if (current >= targetLevel) {
    return {
      blocked: `already at or above target level (${current} >= ${targetLevel}) for ${building} on ${planetId}`,
    };
  }

  const nextLevel = current + 1;

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
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `build ${building} → ${nextLevel} on ${planetId}`,
    goal_id: ctx.rootGoal.id,
  };
}

// Re-export GoalType for callers who want to switch on it; keeps the module
// self-contained as the canonical planner entry point.
export type { GoalType };
