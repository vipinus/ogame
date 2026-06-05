/**
 * Transport chain planner — extracted from runtime-userscript
 * goals_panel.ts:3140-3247 (operator 2026-06-04 "完全克隆 flagship") so the
 * userscript transport modal AND the ogame-next web dashboard share one
 * source of truth for chain generation.
 *
 * Inputs are UI-level intent (source/resource/target/stopover planets,
 * ship type+count, cargo, JG toggles). Output is the array of goal bodies
 * to POST to /v1/goals/create, in priority order. Pure data → data,
 * zero DOM/fetch — safe for any runtime (browser / Node / edge).
 *
 * Implements the operator's rules accumulated through v0.0.425 → v0.0.541:
 *   - same-coord shortcut (planet ↔ own moon → single local deploy)
 *   - JG ferry: 3-leg planet→moon→moon→planet, JG-only-empty-ships rule
 *   - all legs use mission=4 deploy (v0.0.465: 运输裏面不要有運輸)
 *   - moon-target +50K d buffer (v0.0.505)
 *   - moon-source 500K d reserve (v0.0.466)
 *   - 3 segments: source→resource (empty), resource→target (cargo),
 *     target→stopover (empty post-unload)
 *   - chain_id + chain_phase tagging for downstream scheduler dedup
 */

export interface PlannerPlanet {
  id: string;
  type: "planet" | "moon";
  coords: [number, number, number];
  resources?: { m?: number; c?: number; d?: number };
}

export interface PlanTransportInput {
  source: PlannerPlanet;
  /** Resource source — null/undefined ⇒ use `source` (no segment 1). */
  resource?: PlannerPlanet | null;
  target: PlannerPlanet;
  /** Optional empty-ferry destination after unload. */
  stopover?: PlannerPlanet | null;
  /** Ships record, e.g. `{ largeCargo: 100 }` or `{ smallCargo: 50 }`. */
  ships: Record<string, number>;
  /** Operator cargo input — m/c/d in resources, BEFORE moon adjustments. */
  cargo: { m: number; c: number; d: number };
  jgEnabled: boolean;
  jgTakeAll: boolean;
  /** Full planet/moon roster for sibling-moon resolution. */
  allPlanets: PlannerPlanet[];
  /** Caller-provided chain id (e.g. `txc-<base36ts>-<rand>`). */
  chainId: string;
}

export interface TransportGoalBody {
  type: "deploy" | "transport" | "jumpgate";
  target: Record<string, unknown>;
  planet?: string;
  priority?: number;
}

export interface PlanTransportOutput {
  chainId: string;
  goals: TransportGoalBody[];
}

const MOON_SOURCE_D_RESERVE = 500_000;
const MOON_TARGET_D_BUFFER = 50_000;

function coordKey(p: PlannerPlanet): string {
  return p.coords.join(":");
}

function findSiblingMoon(p: PlannerPlanet, all: PlannerPlanet[]): PlannerPlanet | undefined {
  const key = coordKey(p);
  return all.find(q => q.type === "moon" && coordKey(q) === key && q.id !== p.id);
}

export function planTransportChain(input: PlanTransportInput): PlanTransportOutput {
  const { source, resource: resourceInput, target, stopover, ships, cargo, jgEnabled, jgTakeAll, allPlanets, chainId } = input;
  const resource = resourceInput ?? source;

  // Moon buffer adjustments — happen BEFORE chain planning, applied once.
  // Target moon: +50K d buffer for post-arrival build allowance.
  // Source moon: cap d cargo so 500K stays on the moon (recall + JG cd fuel).
  let cargoDFinal = cargo.d;
  if (target.type === "moon") {
    cargoDFinal += MOON_TARGET_D_BUFFER;
  }
  if (resource.type === "moon") {
    const sourceD = resource.resources?.d ?? 0;
    const sourceDMax = Math.max(0, sourceD - MOON_SOURCE_D_RESERVE);
    cargoDFinal = Math.min(cargoDFinal, sourceDMax);
  }
  const cargoAdjusted = { m: cargo.m, c: cargo.c, d: cargoDFinal };

  const genFerry = (
    from: PlannerPlanet,
    to: PlannerPlanet,
    carryCargo: boolean,
    finalLegType: "deploy" | "transport",
    phasePrefix: string,
    basePriority: number,
  ): TransportGoalBody[] => {
    if (from.id === to.id) return [];
    const fromCoords = coordKey(from);
    const toCoords = coordKey(to);

    // Same-coord shortcut — planet↔own moon at G:S:P → single local deploy.
    if (fromCoords === toCoords) {
      return [{
        type: finalLegType,
        target: {
          target_coords: toCoords,
          target_type: to.type,
          ships,
          cargo: carryCargo ? cargoAdjusted : undefined,
          source_planet: from.id,
          chain_id: chainId,
          chain_phase: `${phasePrefix}_local`,
        },
        planet: from.id,
        priority: basePriority,
      }];
    }

    const fromMoon = findSiblingMoon(from, allPlanets);
    const toMoon = findSiblingMoon(to, allPlanets);
    // JG-only-empty-ships rule — if carrying cargo, force direct sublight.
    const useJgHere = jgEnabled && !!fromMoon && !!toMoon && !carryCargo;
    const cargoArg = carryCargo ? cargoAdjusted : undefined;

    if (useJgHere && fromMoon && toMoon) {
      const fromMoonCoords = coordKey(fromMoon);
      const legs: TransportGoalBody[] = [];
      // Leg A: planet → own moon (skip if `from` is already a moon).
      if (from.type !== "moon") {
        legs.push({
          type: "deploy",
          target: {
            target_coords: fromMoonCoords,
            target_type: "moon",
            ships,
            cargo: cargoArg,
            source_planet: from.id,
            chain_id: chainId,
            chain_phase: `${phasePrefix}_load`,
          },
          planet: from.id,
          priority: basePriority,
        });
      }
      // Leg B: moon → moon (jumpgate).
      legs.push({
        type: "jumpgate",
        target: {
          source_moon: fromMoon.id,
          target_moon: toMoon.id,
          ships,
          take_all: jgTakeAll,
          chain_id: chainId,
          chain_phase: `${phasePrefix}_hop`,
        },
        planet: fromMoon.id,
        priority: basePriority - 1,
      });
      // Leg C: moon → planet (skip if `to` is already a moon). When the
      // JG hop ran with take_all, the source moon's fleet was swept onto
      // toMoon, so the unload should also take_all to ferry whatever's
      // there instead of only the originally-allocated ships. Operator
      // 2026-06-05 "按照参数 空船走JG 带回JG上的其他船".
      if (to.type !== "moon") {
        legs.push({
          type: "deploy",
          target: {
            target_coords: toCoords,
            target_type: to.type,
            ships,
            cargo: cargoArg,
            source_planet: toMoon.id,
            chain_id: chainId,
            chain_phase: `${phasePrefix}_unload`,
            take_all: jgTakeAll,
          },
          planet: toMoon.id,
          priority: basePriority - 2,
        });
      }
      return legs;
    }

    // Direct sublight hop.
    return [{
      type: finalLegType,
      target: {
        target_coords: toCoords,
        target_type: to.type,
        ships,
        cargo: cargoArg,
        source_planet: from.id,
        chain_id: chainId,
        chain_phase: `${phasePrefix}_direct`,
      },
      planet: from.id,
      priority: basePriority,
    }];
  };

  const goals: TransportGoalBody[] = [];
  // Segment 1: source → resource (empty ferry into position). Skip if same.
  if (resource.id !== source.id) {
    goals.push(...genFerry(source, resource, false, "deploy", "ferry_to_res", 12));
  }
  // Segment 2: resource → target (cargo). Always fires.
  goals.push(...genFerry(resource, target, true, "deploy", "to_target", 9));
  // Segment 3: target → stopover (empty post-unload). Optional.
  if (stopover && stopover.id !== target.id) {
    goals.push(...genFerry(target, stopover, false, "deploy", "to_stop", 6));
  }

  return { chainId, goals };
}

/** Helper for callers — generates a `txc-<base36ts>-<rand>` chain id. */
export function makeTransportChainId(nowMs: number, rand?: string): string {
  const r = rand ?? Math.random().toString(36).slice(2, 6);
  return `txc-${nowMs.toString(36)}-${r}`;
}
