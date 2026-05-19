import type { ExpeditionOutcome } from "@ogamex/shared";

/**
 * Fraction of outcomes whose `outcome_type === "black_hole"`.
 * Empty input → 0.
 */
export function blackHoleRate(outcomes: ExpeditionOutcome[]): number {
  if (outcomes.length === 0) return 0;
  let n = 0;
  for (const o of outcomes) {
    if (o.outcome_type === "black_hole") n++;
  }
  return n / outcomes.length;
}

/**
 * sum(ships_lost values across all outcomes) / sum(fleet_sent values across all outcomes).
 * Empty input or zero total sent → 0 (no division by zero).
 */
export function lossRate(outcomes: ExpeditionOutcome[]): number {
  if (outcomes.length === 0) return 0;
  let sent = 0;
  let lost = 0;
  for (const o of outcomes) {
    for (const v of Object.values(o.fleet_sent)) {
      sent += v ?? 0;
    }
    for (const v of Object.values(o.ships_lost)) {
      lost += v ?? 0;
    }
  }
  if (sent === 0) return 0;
  return lost / sent;
}

/**
 * Mean of (resources_gained.m + resources_gained.c + resources_gained.d) across outcomes.
 * Energy (`e`) is ignored — it is not a real expedition yield.
 * Empty input → 0.
 */
export function avgResourceYield(outcomes: ExpeditionOutcome[]): number {
  if (outcomes.length === 0) return 0;
  let total = 0;
  for (const o of outcomes) {
    const r = o.resources_gained;
    total += r.m + r.c + r.d;
  }
  return total / outcomes.length;
}
