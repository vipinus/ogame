/**
 * Unified ogame build time formula — single source of truth.
 *
 * Previously duplicated in:
 *   - packages/openclaw-plugin/src/sidecar/index.ts (simulate.buildSec)
 *   - packages/openclaw-plugin/scripts/ogamex_discord_bridge.mjs (buildSecondsForRange)
 *
 * Operator 2026-06-04 "为什么有两套算法 统一一下" → consolidated here.
 *
 * ogame v12 formulas:
 *   building: t = ((m + c) / (2500 * (1 + R) * 2^N * speed)) * 3600
 *   research: t = ((m + c) / (1000 * (1 + L) * researchSpeed)) * 3600
 *
 *   R = roboticsFactory level
 *   N = naniteFactory level
 *   L = researchLab level
 *   speed = universe speed (e.g. 8 on s274-en)
 *   researchSpeed = research_speed from server meta (defaults to universe speed)
 */
export interface BuildTimeAccel {
  robotics: number;
  nanite: number;
  lab: number;
}

export function buildingSec(
  cost: { m: number; c: number },
  accel: Pick<BuildTimeAccel, "robotics" | "nanite">,
  universeSpeed: number,
): number {
  const denom = 2500 * (1 + accel.robotics) * Math.pow(2, accel.nanite) * Math.max(1, universeSpeed);
  return denom > 0 ? ((cost.m + cost.c) / denom) * 3600 : 3600;
}

export function researchSec(
  cost: { m: number; c: number },
  accel: Pick<BuildTimeAccel, "lab">,
  researchSpeed: number,
): number {
  const denom = 1000 * (1 + accel.lab) * Math.max(1, researchSpeed);
  return denom > 0 ? ((cost.m + cost.c) / denom) * 3600 : 3600;
}

/**
 * Dispatch by tech kind. `kind === "research"` uses researchSec, else buildingSec.
 */
export function techSec(
  cost: { m: number; c: number },
  kind: "research" | "building" | string,
  accel: BuildTimeAccel,
  universeSpeed: number,
  researchSpeed: number,
): number {
  if (kind === "research") return researchSec(cost, accel, researchSpeed);
  return buildingSec(cost, accel, universeSpeed);
}
