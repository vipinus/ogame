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

import { buildingSec as sharedBuildingSec, TECH_TREE } from "@ogamex/shared";
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

// v0.0.787 — operator 2026-06-05 "不是说所有都走优化的吗". 顶层设计扩展:
// 当前 optimizer 只算"建造加速器" (robotics/nanite/researchLab/shipyard)
// 缩短建造时间. 资源源头 (mine) 升级 缩短的是"资源累积 wait_sec", 不在
// accelFactor 公式里. operator 心智: 资源加速器 (metalMine/crystalMine/
// deuteriumSynth) 应该平行作为 saving 候选, 适用所有 goalType. 公式:
//   - 算 cascade tree 总资源 cost (sumTreeResourceCost)
//   - 当前每秒产能 (planet.production.[m|c|d]_h * server.speed / 3600)
//   - 升级后产能 = 当前 * mineProdRatio (ogame: prod ~ L * 1.1^L)
//   - saving = old_wait_sec - new_wait_sec (针对对应资源 m/c/d)
function isResourceAccelerator(a: string): boolean {
  return a === "metalMine" || a === "crystalMine" || a === "deuteriumSynth";
}

function resourceKeyForMine(mine: string): "m" | "c" | "d" {
  if (mine === "metalMine") return "m";
  if (mine === "crystalMine") return "c";
  return "d";
}

function mineProdRatio(fromL: number, toL: number): number {
  // ogame v12 mine production scales as L * 1.1^L (per-level multiplier).
  // L=0 produces nothing (除 base 30/h floor); +1 → ratio ≈ infinity.
  // 对 +1 of L=0 用 sentinel 比 base 高 100×, 保 saving 总比 build sec 大.
  if (fromL === 0) return 100;
  const f = (L: number): number => L * Math.pow(1.1, L);
  return f(toL) / f(fromL);
}

function appliesToGoalType(accelerator: string, goalType: string): boolean {
  // Resource accelerator → 资源源头, 适用所有 goal type (建造/research/船/远征/colonize/lifeform 都吃资源).
  if (isResourceAccelerator(accelerator)) return true;
  if (goalType === "research") return accelerator === "researchLab";
  if (goalType === "build")    return accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  if (goalType === "build_ships") return accelerator === "shipyard" || accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  if (goalType === "colonize") return accelerator === "shipyard" || accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  return false; // lifeform_building: 建造类无 building accelerator; 仍走 mine 路径
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

// v0.0.787 — operator 2026-06-05 "只要 optimizer 所有任务都要优化". optimizer
// 之前死活拿不到 prereq_tree 因为 PG goal_json 不存 (panel 端是 GET /v1/goals
// 内 simulate enrich). 顶层 fix: optimizer 自己 walk shared/tech_tree synthesize
// 一棵 cascade. 不依赖 sidecar handler 内 closure. 任何 goal 都能算 saving.
function lookupCurrentLevel(tech: string, kind: "research" | "building" | "ship", state: WorldState, planetId?: string): number {
  if (kind === "research") return state.research?.levels?.[tech] ?? 0;
  if (kind === "ship") {
    const planets = state.planets ?? {};
    const p = planetId ? (planets as Record<string, unknown>)[planetId] as { ships?: Record<string, number> } | undefined : Object.values(planets)[0] as { ships?: Record<string, number> } | undefined;
    return p?.ships?.[tech] ?? 0;
  }
  // building — research prereqs (researchLab etc) 是网络-wide, 取 max
  const planets = state.planets ?? {};
  let maxLvl = 0;
  for (const p of Object.values(planets)) {
    const lvl = (p as { buildings?: Record<string, number> })?.buildings?.[tech] ?? 0;
    if (lvl > maxLvl) maxLvl = lvl;
  }
  return maxLvl;
}

function synthesizeCascade(rootTech: string, rootTargetLvl: number, rootKind: "research" | "building" | "ship", state: WorldState, planetId: string | undefined, depth = 0): PrereqTreeNodeShape {
  const MAX_D = 12;
  if (depth > MAX_D) return { tech: rootTech, kind: rootKind === "ship" ? "building" : rootKind, currentLevel: 0, targetLevel: rootTargetLvl, met: false, children: [] };
  const curLvl = lookupCurrentLevel(rootTech, rootKind, state, planetId);
  const entry = TECH_TREE[rootTech];
  const children: PrereqTreeNodeShape[] = [];
  if (entry) {
    for (const [reqTech, reqLvl] of Object.entries(entry.requires)) {
      const reqEntry = TECH_TREE[reqTech];
      if (!reqEntry) continue;
      const reqKind = reqEntry.kind === "research" ? "research" : "building";
      const reqCur = lookupCurrentLevel(reqTech, reqKind, state, planetId);
      if (reqCur < reqLvl) {
        children.push(synthesizeCascade(reqTech, reqLvl, reqKind, state, planetId, depth + 1));
      }
    }
  }
  // Normalize "ship" kind to "building" (PrereqTreeNodeShape 只支持 3 种).
  const reportKind: "research" | "building" | "ship" = rootKind;
  return { tech: rootTech, kind: reportKind, currentLevel: curLvl, targetLevel: rootTargetLvl, met: curLvl >= rootTargetLvl, children };
}

function syntheticTreeForGoal(goal: OptimizableGoal, state: WorldState): PrereqTreeNodeShape | null {
  const target = goal.target as { tech?: string; building?: string; ship?: string; amount?: number; level?: number; target_level?: number; source_planet?: string } | undefined;
  if (!target) return null;
  const planetRef = typeof goal.planet === "string" ? goal.planet : undefined;
  const lvl = target.target_level ?? target.level ?? 1;
  if (goal.type === "research" && target.tech) {
    return synthesizeCascade(target.tech, lvl, "research", state, planetRef);
  }
  if (goal.type === "build" && target.building) {
    return synthesizeCascade(target.building, lvl, "building", state, planetRef);
  }
  if (goal.type === "lifeform_building" && target.building) {
    // lifeform 暂用同一 walker (shared/tech_tree 不含 LF 树, sumTreeResourceCost
    // walk single root + 自身 cost via costAtLevel; LF cost 不在 TECH_COSTS,
    // 资源 saving 退化为单 root cost — 比无 tree 好).
    return synthesizeCascade(target.building, lvl, "building", state, planetRef);
  }
  if (goal.type === "build_ships" && target.ship) {
    return synthesizeCascade(target.ship, target.amount ?? 1, "ship", state, planetRef);
  }
  if (goal.type === "colonize") {
    // colonize 是 mission 不是 build target, 需双根 cascade:
    //   1) colonyShip 1 ship (含 shipyard/impulseDrive 链路)
    //   2) astrophysics → owned*2 (max_planets gate)
    const ownedPlanets = Object.values(state.planets ?? {}).filter((p) => (p as { type?: string }).type === "planet").length;
    // v0.0.793 — ogame v12 真公式: max_total = floor((L+1)/2)+1.
    // target = 2*owned-1 让 maxAt(target) > owned. owned=1 时 target=1.
    const astroTarget = Math.max(1, 2 * ownedPlanets - 1);
    const astroCur = state.research?.levels?.astrophysics ?? 0;
    const colSource = target.source_planet ?? planetRef;
    const children: PrereqTreeNodeShape[] = [];
    children.push(synthesizeCascade("colonyShip", 1, "ship", state, colSource));
    if (astroCur < astroTarget) {
      children.push(synthesizeCascade("astrophysics", astroTarget, "research", state, colSource));
    }
    return { tech: "__colonize_root", kind: "building", currentLevel: 0, targetLevel: 1, met: false, children };
  }
  return null;
}

function sumTreeResourceCost(tree: PrereqTreeNodeShape): { m: number; c: number; d: number } {
  // Sum of all not-yet-built level costs across cascade tree. Used for
  // resource-accelerator saving math: cascade fully consuming this much
  // m/c/d, so reducing wait_sec per unit accumulates linearly.
  let m = 0, c = 0, d = 0;
  function walk(n: PrereqTreeNodeShape): void {
    if (n.kind === "building" || n.kind === "research" || n.kind === "ship") {
      const from = n.currentLevel ?? 0;
      const to = n.targetLevel ?? from;
      for (let L = from + 1; L <= to; L++) {
        const c1 = costAtLevel(n.tech, L);
        if (c1) { m += c1.m; c += c1.c; d += c1.d; }
      }
    }
    for (const ch of n.children ?? []) walk(ch);
  }
  walk(tree);
  return { m, c, d };
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
  // v0.0.788 — operator "所有任务都要优化". 老 gate (v0.0.697/v0.0.773
  // post-phase 整段 skip optimizer, 理由"用 transport 掌控资源") 跟新 directive
  // 冲突. 拉通修法: post-phase 只跳"资源加速器" (mine cascade, 因 transport
  // 接管资源 supply), 仍算"建造加速器" (robotics/nanite/researchLab/shipyard),
  // 给 operator 决策颗粒度. mine skip 用 closure 变量, 主循环判断.
  const postPhaseSkipMine = astro >= 4;
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
  // v0.0.787 — 资源源头预计算 (cascade tree 总资源 cost, 用于 mine saving 公式).
  const totalResourceCost = sumTreeResourceCost(tree);
  for (const accel of ["roboticsFactory", "naniteFactory", "researchLab", "shipyard", "metalMine", "crystalMine", "deuteriumSynth"]) {
    if (!appliesToGoalType(accel, mainGoalType)) continue;
    // v0.0.788 — post-phase mine skip 在这里收口, 保持 build-accel 候选活着.
    if (isResourceAccelerator(accel) && postPhaseSkipMine) continue;
    const curLvl = planet.buildings?.[accel] ?? 0;
    // Resource accelerator (mine) — saving 公式: wait_sec(对应资源) 缩短.
    // mineral 没有 minRequired (不是 prereq), baseEffective = curLvl.
    if (isResourceAccelerator(accel)) {
      const rk = resourceKeyForMine(accel);
      const total = rk === "m" ? totalResourceCost.m : rk === "c" ? totalResourceCost.c : totalResourceCost.d;
      if (total <= 0) continue;
      const prodH = (planet.production?.[`${rk}_h`] ?? 0);
      // operator 2026-06-05 "注意加服务器速度因子" — ogame raw prod 字段是
      // base-per-hour 未乘 universe.speed, planner.ts:1040 已经用同一公式.
      const prodPerSec = prodH * speed / 3600;
      if (prodPerSec <= 0) continue;
      const oldWaitSec = total / prodPerSec;
      for (let dL = 1; dL <= 3; dL++) {
        const L_new = curLvl + dL;
        const ratio = mineProdRatio(curLvl, L_new);
        if (ratio <= 1) continue;
        const newWaitSec = oldWaitSec / ratio;
        const buildSaving = oldWaitSec - newWaitSec;
        const extraBuildSec = buildSecondsForRange(accel, curLvl, L_new, robo, nano, speed);
        if (extraBuildSec === null) continue;
        const netSavings = buildSaving - extraBuildSec;
        candidates.push({
          mine: accel, L_cur: curLvl, L_new, dL,
          totalSec: extraBuildSec + Math.max(0, baselineTotalSec - buildSaving),
          savings: netSavings,
          baseEffective: curLvl, minRequired: 0, affectedCost: total,
          note: `resource-accel ${rk} cascade-cost=${total} oldWait=${Math.round(oldWaitSec)}s`,
        });
      }
      continue; // skip build-accel公式
    }
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
  enrichGoalWithTree?: (goal: OptimizableGoal, state: WorldState) => OptimizableGoal,
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
  let noTree = 0;
  for (const rawGoal of activeUserGoals) {
    // v0.0.787 — operator "只要 optimizer 所有任务都要优化". PG goal_json 不
    // 存 prereq_tree, optimizer 自己 synthesize cascade (基于 shared/tech_tree).
    // enrichGoalWithTree dep 是历史可选 hook, 优先它; 否则走自合成.
    const enriched = enrichGoalWithTree ? enrichGoalWithTree(rawGoal, state) : rawGoal;
    const g: OptimizableGoal = enriched.prereq_tree
      ? enriched
      : { ...enriched, prereq_tree: syntheticTreeForGoal(enriched, state) };
    const r = computeOptimizationForGoal(state, g);
    if ("error" in r) {
      skipped++;
      if (r.error === "no tree") noTree++;
      console.info(`[optimizer/dbg] uid=${uid.slice(0, 8)} goal=${rawGoal.id} type=${rawGoal.type} ERROR ${r.error}`);
      continue;
    }
    const top3 = r.candidates.slice(0, 3).map(c => `${c.mine}+${c.dL}=${Math.round(c.savings)}s`).join(",");
    console.info(`[optimizer/dbg] uid=${uid.slice(0, 8)} goal=${rawGoal.id} type=${rawGoal.type} cands=${r.candidates.length} top3=[${top3}]`);
    const best = r.candidates[0];
    if (!best || best.savings < AUTO_SAVINGS_THRESHOLD_SEC) { skipped++; continue; }
    // Found a worthwhile accelerator. Upsert opt-<accel>-L<new> goal.
    const optId = `opt-${best.mine}-L${best.L_new}-${uid.slice(0, 8)}`;
    const planetId = (r.planet as { id?: string })?.id ?? g.planet ?? "";
    // v0.0.791 — operator 2026-06-05 "最优解只有一个". 同 planet + 同 mine
    // 只 keep 最高 L_new 的 opt-* 活着, 其他 lower-level cancel (老 tick emit
    // L8, 这 tick cur=L8 后 best=L10 → L8 已被 ogame 真起建走完, 但 sidecar
    // PG 还 active; 同理 L9). cancel 老的 owner-clean.
    const sameAccelPrefix = `opt-${best.mine}-L`;
    const uidSuffix = uid.slice(0, 8);
    const sameAccelActive = allRows.filter((r) => {
      if (!r.goal.id.startsWith(sameAccelPrefix)) return false;
      if (!r.goal.id.endsWith(uidSuffix)) return false;
      if (r.goal.planet !== planetId) return false;
      return ["active", "blocked", "pending"].includes(r.status);
    });
    const higherActive = sameAccelActive.find((r) => {
      const lvl = (r.goal.target as { level?: number })?.level ?? 0;
      return lvl > best.L_new;
    });
    if (higherActive) {
      // Existing already covers stronger upgrade — skip emit + don't cancel it.
      skipped++;
      continue;
    }
    const existing = sameAccelActive.find((r) => r.goal.id === optId);
    // Cancel lower-level same-accel actives (best L_new > their L) — keep one truth.
    for (const old of sameAccelActive) {
      if (old.goal.id === optId) continue;
      const oldLvl = (old.goal.target as { level?: number })?.level ?? 0;
      if (oldLvl >= best.L_new) continue;
      try {
        await pgStore.updateGoalStatus(uid, old.goal.id, "cancelled", `optimizer: superseded by ${optId}`);
        console.info(`[optimizer] uid=${uid.slice(0, 8)} cancel ${old.goal.id} (superseded by L${best.L_new})`);
      } catch (e) {
        console.warn(`[optimizer] cancel superseded ${old.goal.id} threw:`, e instanceof Error ? e.message : e);
      }
    }
    if (existing) {
      skipped++;
      continue; // current best already queued
    }
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
        // v0.0.790 — operator 2026-06-05 "为什么 9 10 没在树里面" + "补的电厂
        // 没有在里面". opt-* 是 optimizer 为加速 g.id (e.g. colonize) 而 emit
        // 的派生 sub-goal. 记 parent 让 listGoals 把它挂回 parent tree, owner
        // 看一棵 cascade 全貌, 不再 N 张独立卡片.
        parent_goal_id: g.id,
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
  if (noTree > 0) console.info(`[optimizer] uid=${uid.slice(0, 8)} no-tree=${noTree} actioned=${actioned} skipped=${skipped} (enrich callback ${enrichGoalWithTree ? "wired" : "missing"})`);
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
  enrichGoalWithTree?: (goal: OptimizableGoal, state: WorldState) => OptimizableGoal;
}): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const uids = await deps.loadActiveTenantUids();
      for (const uid of uids) {
        try {
          await runOptimizerOnce(uid, deps.getStateForUid, deps.goalsStorePg, deps.pgStore, deps.enrichGoalWithTree);
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
