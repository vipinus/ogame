/**
 * Phase 8a (v0.0.785) — optimizer.ts (port from
 * scripts/ogamex_discord_bridge.mjs:591-1106).
 *
 * Operator 2026-06-05: "为什么有两个处理逻辑，不能合并吗" → "方案 A, 远征
 * setInterval 这个 也不要和 Discord webhook 放一起". 核心 game logic 全部
 * 拉入 sidecar, daemon 只剩外部系统 (Discord webhook + Gemini config).
 *
 * 职责: 60s tick, 跑 acceleration math, 当 main/active goal 有 net savings
 * > AUTO_SAVINGS_THRESHOLD_SEC 时, 创建 opt-* goal (一个加速器 build goal),
 * priority_merger 下一 tick 就拿去 dispatch.
 *
 * 跟 daemon 版本同源 — 后续 daemon 那侧 setInterval 注释掉, 公共 helper
 * (accelFactor, costAtLevel, etc) 抽 shared 是 next pass.
 */

import { buildingSec as sharedBuildingSec } from "@ogamex/shared";
import type { WorldState } from "@ogamex/shared";
import type { GoalsStorePg } from "./goals_store_pg.js";
import type { WorldStateStorePg } from "./world_state_store_pg.js";

interface TechCost {
  kind: "research" | "building" | "ship" | "defense";
  base: { m: number; c: number; d?: number; e?: number };
  mult: number;
}

const TECH_COSTS: Record<string, TechCost> = {
  // research
  energyTech:                 { kind: "research", base: { m: 0,     c: 800,    d: 400  }, mult: 2 },
  laserTech:                  { kind: "research", base: { m: 200,   c: 100,    d: 0    }, mult: 2 },
  ionTech:                    { kind: "research", base: { m: 1000,  c: 300,    d: 100  }, mult: 2 },
  hyperspaceTech:             { kind: "research", base: { m: 0,     c: 4000,   d: 2000 }, mult: 2 },
  plasmaTech:                 { kind: "research", base: { m: 2000,  c: 4000,   d: 1000 }, mult: 2 },
  combustionDrive:            { kind: "research", base: { m: 400,   c: 0,      d: 600  }, mult: 2 },
  combustion:                 { kind: "research", base: { m: 400,   c: 0,      d: 600  }, mult: 2 },
  impulseDrive:               { kind: "research", base: { m: 2000,  c: 4000,   d: 600  }, mult: 2 },
  hyperspaceDrive:            { kind: "research", base: { m: 10000, c: 20000,  d: 6000 }, mult: 2 },
  espionageTech:              { kind: "research", base: { m: 200,   c: 1000,   d: 200  }, mult: 2 },
  computerTech:               { kind: "research", base: { m: 0,     c: 400,    d: 600  }, mult: 2 },
  astrophysics:               { kind: "research", base: { m: 4000,  c: 8000,   d: 4000 }, mult: 1.75 },
  intergalacticResearchNetwork:{ kind: "research", base: { m: 240000, c: 400000, d: 160000 }, mult: 2.5 },
  intergalactic:              { kind: "research", base: { m: 240000, c: 400000, d: 160000 }, mult: 2.5 },
  gravitonTech:               { kind: "research", base: { m: 0,     c: 0,      d: 0,  e: 300000 }, mult: 3 },
  weaponsTech:                { kind: "research", base: { m: 800,   c: 200,    d: 0    }, mult: 2 },
  weapons:                    { kind: "research", base: { m: 800,   c: 200,    d: 0    }, mult: 2 },
  shieldingTech:              { kind: "research", base: { m: 200,   c: 600,    d: 0    }, mult: 2 },
  shielding:                  { kind: "research", base: { m: 200,   c: 600,    d: 0    }, mult: 2 },
  armorTech:                  { kind: "research", base: { m: 1000,  c: 0,      d: 0    }, mult: 2 },
  armor:                      { kind: "research", base: { m: 1000,  c: 0,      d: 0    }, mult: 2 },
  // building
  metalMine:        { kind: "building", base: { m: 60,    c: 15,     d: 0     }, mult: 1.5 },
  crystalMine:      { kind: "building", base: { m: 48,    c: 24,     d: 0     }, mult: 1.6 },
  deuteriumSynth:   { kind: "building", base: { m: 225,   c: 75,     d: 0     }, mult: 1.5 },
  solarPlant:       { kind: "building", base: { m: 75,    c: 30,     d: 0     }, mult: 1.5 },
  fusionReactor:    { kind: "building", base: { m: 900,   c: 360,    d: 180   }, mult: 1.8 },
  roboticsFactory:  { kind: "building", base: { m: 400,   c: 120,    d: 200   }, mult: 2 },
  naniteFactory:    { kind: "building", base: { m: 1000000, c: 500000, d: 100000}, mult: 2 },
  shipyard:         { kind: "building", base: { m: 400,   c: 200,    d: 100   }, mult: 2 },
  metalStorage:     { kind: "building", base: { m: 1000,  c: 0,      d: 0     }, mult: 2 },
  crystalStorage:   { kind: "building", base: { m: 1000,  c: 500,    d: 0     }, mult: 2 },
  deuteriumTank:    { kind: "building", base: { m: 1000,  c: 1000,   d: 0     }, mult: 2 },
  researchLab:      { kind: "building", base: { m: 200,   c: 400,    d: 200   }, mult: 2 },
};

function costAtLevel(techId: string, level: number): { m: number; c: number; d: number; e: number } | null {
  const t = TECH_COSTS[techId];
  if (!t) return null;
  const mult = Math.pow(t.mult, level - 1);
  return {
    m: Math.floor(t.base.m * mult),
    c: Math.floor(t.base.c * mult),
    d: Math.floor((t.base.d ?? 0) * mult),
    e: Math.floor((t.base.e ?? 0) * mult),
  };
}

function buildSecondsForRange(building: string, fromLvl: number, toLvl: number, robo: number, nano: number, speed = 1): number | null {
  let total = 0;
  let curRobo = robo;
  let curNano = nano;
  for (let L = fromLvl + 1; L <= toLvl; L++) {
    const c = costAtLevel(building, L);
    if (!c) return null;
    total += sharedBuildingSec(c, { robotics: curRobo, nanite: curNano }, speed);
    if (building === "roboticsFactory") curRobo = L;
    else if (building === "naniteFactory") curNano = L;
  }
  return total;
}

function cumulativeMineCost(building: string, fromLvl: number, toLvl: number): { m: number; c: number; d: number } | null {
  let m = 0, c = 0, d = 0;
  for (let L = fromLvl + 1; L <= toLvl; L++) {
    const cost = costAtLevel(building, L);
    if (!cost) return null;
    m += cost.m; c += cost.c; d += cost.d;
  }
  return { m, c, d };
}

function accelFactor(accelerator: string, lvl: number): number {
  if (accelerator === "roboticsFactory") return 2500 * (1 + lvl);
  if (accelerator === "naniteFactory")   return 2500 * Math.pow(2, lvl);
  if (accelerator === "researchLab")     return 1000 * (1 + lvl);
  if (accelerator === "shipyard")        return 2500 * (1 + lvl);
  return 0;
}

function appliesToGoalType(accelerator: string, goalType: string): boolean {
  if (goalType === "research") return accelerator === "researchLab";
  if (goalType === "build")    return accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  if (goalType === "build_ships") return accelerator === "shipyard" || accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  if (goalType === "colonize") return accelerator === "shipyard" || accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  return false; // lifeform_building: no known accelerator
}

interface PrereqTreeNodeShape {
  tech: string;
  kind: "research" | "building" | "ship";
  currentLevel: number;
  targetLevel: number;
  met?: boolean;
  children?: PrereqTreeNodeShape[];
  subtree_eta_seconds?: number;
}

function findMinRequiredAccelLevel(tree: PrereqTreeNodeShape, accelerator: string): number {
  let maxLvl = 0;
  function walk(n: PrereqTreeNodeShape): void {
    if (n.tech === accelerator) maxLvl = Math.max(maxLvl, n.targetLevel);
    for (const c of n.children ?? []) walk(c);
  }
  walk(tree);
  return maxLvl;
}

function sumAffectedCost(tree: PrereqTreeNodeShape, accelerator: string): number {
  let total = 0;
  function nodeAffected(n: PrereqTreeNodeShape): boolean {
    if (accelerator === "researchLab") return n.kind === "research";
    if (accelerator === "roboticsFactory" || accelerator === "naniteFactory") return n.kind === "building";
    if (accelerator === "shipyard") return n.kind === "ship";
    return false;
  }
  function walk(n: PrereqTreeNodeShape): void {
    if (!n.met && nodeAffected(n)) {
      for (let lvl = n.currentLevel + 1; lvl <= n.targetLevel; lvl++) {
        const c = costAtLevel(n.tech, lvl);
        if (c) {
          const intrinsicMult = (n.tech === "naniteFactory") ? Math.pow(2, lvl - 1) : 1;
          total += (c.m + c.c) / intrinsicMult;
        }
      }
    }
    for (const c of n.children ?? []) walk(c);
  }
  walk(tree);
  return total;
}

interface OptimizationCandidate {
  mine: string;
  L_cur: number;
  L_new: number;
  dL: number;
  totalSec: number;
  savings: number;
  baseEffective: number;
  minRequired: number;
  affectedCost: number;
  note: string;
}

interface OptimizableGoal {
  id: string;
  type: string;
  status: string;
  planet?: string;
  target?: { building?: string; tech?: string; ship?: string };
  prereq_tree?: PrereqTreeNodeShape | null;
}

export function computeOptimizationForGoal(state: WorldState, main: OptimizableGoal):
  { candidates: OptimizationCandidate[]; planet: { id?: string; type?: string; coords?: readonly number[] } | null; note?: string } | { error: string } {
  if (!main || !main.prereq_tree) return { error: "no tree" };
  const astro = state.research?.levels?.astrophysics ?? 0;
  if (astro >= 4) {
    return { candidates: [], planet: null, note: "post-phase: optimizer skipped (resource-bottlenecked chain)" };
  }
  const planetsMap = state.planets ?? {};
  const MOON_ONLY = new Set(["lunarBase", "sensorPhalanx", "jumpgate"]);
  const findPlanet = (ref: string | undefined): { id?: string; type?: string; coords?: readonly number[]; resources?: { m?: number; c?: number; d?: number; e?: number }; production?: { m_h?: number; c_h?: number; d_h?: number }; buildings?: Record<string, number> } | null => {
    if (!ref) return null;
    const direct = (planetsMap as Record<string, unknown>)[ref] as { coords?: readonly number[] } | undefined;
    if (direct) return direct as never;
    const matches: Array<{ type?: string; coords?: readonly number[] }> = [];
    for (const p of Object.values(planetsMap)) {
      const coords = (p as { coords?: readonly number[] }).coords;
      if (Array.isArray(coords) && coords.join(":") === ref) matches.push(p as never);
    }
    if (matches.length === 0) return null;
    const tgtBuilding = main?.target?.building;
    const wantMoon = typeof tgtBuilding === "string" && MOON_ONLY.has(tgtBuilding);
    if (wantMoon) {
      const moon = matches.find((p) => p?.type === "moon");
      if (moon) return moon as never;
    }
    return matches[0] as never;
  };
  const planet = findPlanet(main.planet);
  if (!planet) return { error: `main goal planet not in state: ${main.planet}` };
  const tree = main.prereq_tree;
  const mainGoalType = main.type;
  const speed = state.server?.speed ?? 1;
  const robo = planet.buildings?.roboticsFactory ?? 0;
  const nano = planet.buildings?.naniteFactory ?? 0;
  const baselineTotalSec = tree.subtree_eta_seconds ?? 0;
  const candidates: OptimizationCandidate[] = [];
  for (const accel of ["roboticsFactory", "naniteFactory", "researchLab", "shipyard"]) {
    if (!appliesToGoalType(accel, mainGoalType)) continue;
    const curLvl = planet.buildings?.[accel] ?? 0;
    const minRequired = findMinRequiredAccelLevel(tree, accel);
    const baseEffective = Math.max(curLvl, minRequired);
    const affectedCost = sumAffectedCost(tree, accel);
    if (affectedCost === 0) continue;
    for (let dL = 1; dL <= 4; dL++) {
      const L_new = baseEffective + dL;
      const denomOld = accelFactor(accel, baseEffective);
      const denomNew = accelFactor(accel, L_new);
      if (denomOld <= 0 || denomNew <= 0) continue;
      const extraStructFactor =
        accel === "roboticsFactory" ? Math.pow(2, nano) :
        accel === "naniteFactory"   ? (1 + robo) :
        accel === "shipyard"        ? Math.pow(2, nano) :
        1;
      const buildSaving = affectedCost * 3600 * (1 / denomOld - 1 / denomNew) / speed / extraStructFactor;
      const extraCost = cumulativeMineCost(accel, baseEffective, L_new);
      if (!extraCost) continue;
      const extraBuildSec = buildSecondsForRange(accel, baseEffective, L_new, robo, nano, speed);
      if (extraBuildSec === null) continue;
      const netSavings = buildSaving - extraBuildSec;
      candidates.push({
        mine: accel, L_cur: curLvl, L_new, dL,
        totalSec: extraBuildSec + Math.max(0, baselineTotalSec - buildSaving),
        savings: netSavings,
        baseEffective, minRequired, affectedCost,
        note: dL <= (baseEffective - curLvl) ? "tracks natural plan" : "beyond prereq",
      });
    }
  }
  candidates.sort((a, b) => b.savings - a.savings);
  return { candidates, planet };
}

// Threshold — same as daemon's AUTO_SAVINGS_THRESHOLD_SEC (commit 1aa78e0
// set to 60s when operator daigang's s275 colonize needed optimizer entry).
const AUTO_SAVINGS_THRESHOLD_SEC = 60;
const AUTO_TICK_MS = 60_000;

/**
 * Per-tenant optimizer tick. Sidecar-side equivalent of daemon's
 * optimizerTickAllTenants. Reads active goals per uid, computes best
 * accelerator candidate, upserts an opt-* goal when net savings positive
 * and > threshold. priority_merger picks up next tick.
 */
export async function runOptimizerOnce(
  uid: string,
  getStateForUid: (uid: string) => WorldState | null,
  goalsStorePg: GoalsStorePg,
  pgStore: WorldStateStorePg,
): Promise<{ actioned: number; skipped: number }> {
  const state = getStateForUid(uid);
  if (!state) return { actioned: 0, skipped: 0 };
  const allRows = await goalsStorePg.list(uid);
  const activeUserGoals = allRows
    .filter((r) => !r.goal.id.startsWith("opt-") && !r.goal.id.startsWith("exp-") && !r.goal.id.startsWith("expb-"))
    .filter((r) => ["active", "blocked", "pending"].includes(r.status))
    .map((r) => r.goal as unknown as OptimizableGoal);
  if (activeUserGoals.length === 0) return { actioned: 0, skipped: 0 };
  let actioned = 0;
  let skipped = 0;
  for (const g of activeUserGoals) {
    const r = computeOptimizationForGoal(state, g);
    if ("error" in r) { skipped++; continue; }
    const best = r.candidates[0];
    if (!best || best.savings < AUTO_SAVINGS_THRESHOLD_SEC) { skipped++; continue; }
    // Found a worthwhile accelerator. Upsert opt-<accel>-L<new> goal.
    const optId = `opt-${best.mine}-L${best.L_new}-${uid.slice(0, 8)}`;
    const existing = allRows.find((row) => row.goal.id === optId);
    if (existing && ["active", "blocked", "pending"].includes(existing.status)) {
      skipped++;
      continue; // Already queued
    }
    const planetId = (r.planet as { id?: string })?.id ?? g.planet ?? "";
    const optRow = {
      goal: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        id: optId, type: "build" as any,
        target: { building: best.mine, level: best.L_new } as Record<string, unknown>,
        planet: planetId,
        priority: 8,
        is_main_goal: false,
        status: "pending" as const,
        created_at: Date.now(),
        progress_pct: 0,
        current_step: "queued",
        eta_at: null,
      },
      status: "pending" as const,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    try {
      await pgStore.upsertGoal(uid, optRow);
      console.log(`[optimizer] uid=${uid.slice(0, 8)} emit ${optId} (savings=${Math.round(best.savings)}s for ${g.id})`);
      actioned++;
    } catch (e) {
      console.warn(`[optimizer] upsert opt failed for ${uid.slice(0, 8)}:`, e instanceof Error ? e.message : e);
      skipped++;
    }
  }
  return { actioned, skipped };
}

/**
 * Start the 60s tick that loops all active tenants. Each tick fetches
 * tenants from PG user_settings (only ones with bridge_token + 1+ active
 * goal), runs optimizer per uid.
 */
export function startOptimizer(deps: {
  goalsStorePg: GoalsStorePg;
  pgStore: WorldStateStorePg;
  getStateForUid: (uid: string) => WorldState | null;
  loadActiveTenantUids: () => Promise<string[]>;
}): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const uids = await deps.loadActiveTenantUids();
      for (const uid of uids) {
        try {
          await runOptimizerOnce(uid, deps.getStateForUid, deps.goalsStorePg, deps.pgStore);
        } catch (e) {
          console.warn(`[optimizer] tick uid=${uid.slice(0, 8)} threw:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.warn("[optimizer] outer tick threw:", e instanceof Error ? e.message : e);
    }
  };
  const t = setInterval(() => { void tick(); }, AUTO_TICK_MS);
  if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
    (t as unknown as { unref: () => void }).unref();
  }
  console.info(`[optimizer] sidecar tick started (${AUTO_TICK_MS / 1000}s, threshold=${AUTO_SAVINGS_THRESHOLD_SEC}s)`);
  return { stop: () => clearInterval(t) };
}
