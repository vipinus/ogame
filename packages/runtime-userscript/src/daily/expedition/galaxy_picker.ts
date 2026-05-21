import type {
  ExpeditionConfig,
  ExpeditionOutcome,
  WorldState,
} from "@ogamex/shared";
import { avgResourceYield, blackHoleRate } from "./stats.js";

export interface GalaxyPickContext {
  state: WorldState;
  recentOutcomes: ExpeditionOutcome[];
  config: ExpeditionConfig;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the source planet's galaxy from `config.source_planet`. Falls back
 * to the first planet in `state` if the configured id is missing/unknown, and
 * ultimately to galaxy `1` if `state.planets` is empty.
 */
function getSourceGalaxy(
  state: WorldState,
  config: ExpeditionConfig,
): number {
  if (config.source_planet !== null) {
    const found = Object.values(state.planets ?? {}).find((p) => p.id === config.source_planet);
    if (found !== undefined) return found.coords[0];
  }
  const first = Object.values(state.planets ?? {})[0];
  if (first !== undefined) return first.coords[0];
  return 1;
}

/**
 * Picks a target galaxy for the next expedition launch. Three modes:
 *
 * - `fixed`: always uses `preferred_galaxies[0]` (or source galaxy fallback).
 * - `rotate`: round-robins through `preferred_galaxies` keyed off the count of
 *    recent outcomes (so consecutive launches cycle through the list).
 * - `stats_based` (default): if `home_galaxy_first` is on and the source
 *    galaxy's 24h black-hole rate is within threshold, stays home; otherwise
 *    picks the galaxy with the lowest 24h black-hole rate among those with
 *    enough samples, breaking ties by highest resource yield.
 */
export function pickGalaxy(ctx: GalaxyPickContext): number {
  const { state, recentOutcomes, config } = ctx;
  const strategy = config.galaxy_strategy;
  const sourceGalaxy = getSourceGalaxy(state, config);

  if (strategy.mode === "fixed") {
    const first = strategy.preferred_galaxies?.[0];
    return first ?? sourceGalaxy;
  }

  if (strategy.mode === "rotate") {
    const list = strategy.preferred_galaxies;
    if (list === undefined || list.length === 0) return sourceGalaxy;
    const idx = recentOutcomes.length % list.length;
    return list[idx] ?? sourceGalaxy;
  }

  // mode === "stats_based"
  // `returned_at` is a millisecond epoch (see expedition_report.ts → Date.now()).
  const cutoff = Date.now() - DAY_MS;
  const recent = recentOutcomes.filter((o) => o.returned_at >= cutoff);

  if (strategy.home_galaxy_first) {
    const homeOutcomes = recent.filter((o) => o.target_galaxy === sourceGalaxy);
    const homeRate = blackHoleRate(homeOutcomes);
    if (homeRate <= strategy.switch_threshold.black_hole_rate_24h) {
      return sourceGalaxy;
    }
  }

  type Candidate = { galaxy: number; bhRate: number; yield_: number };
  const candidates: Candidate[] = [];
  for (let g = 1; g <= 9; g++) {
    const bucket = recent.filter((o) => o.target_galaxy === g);
    if (bucket.length < strategy.switch_threshold.sample_size_min) continue;
    candidates.push({
      galaxy: g,
      bhRate: blackHoleRate(bucket),
      yield_: avgResourceYield(bucket),
    });
  }

  if (candidates.length === 0) return sourceGalaxy;

  candidates.sort((a, b) => {
    if (a.bhRate !== b.bhRate) return a.bhRate - b.bhRate;
    return b.yield_ - a.yield_;
  });

  const winner = candidates[0];
  return winner === undefined ? sourceGalaxy : winner.galaxy;
}
