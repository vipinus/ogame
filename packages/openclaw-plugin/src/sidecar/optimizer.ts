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
import { mineEnergyConsumption, solarProduction, fusionProduction, pickEnergyFixCandidates, pickEnergyPrereqBuilding } from "./planner.js";

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

export function buildSecondsForRange(building: string, fromLvl: number, toLvl: number, robo: number, nano: number, speed = 1): number | null {
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

export function cumulativeMineCost(building: string, fromLvl: number, toLvl: number): { m: number; c: number; d: number } | null {
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

export function mineProdRatio(fromL: number, toL: number): number {
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
  // v0.0.931 — owner 2026-06-07 "改成 9": post-phase skip mine 阈值跟
  // planner.ts:isPostExpeditionPhase 对齐, 同源单一改点.
  const postPhaseSkipMine = astro >= 9;
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
      // v0.0.859 — operator 2026-06-06 "新号第二颗星没建造重氢工厂". 新殖民地
      // deuteriumSynth L0 + d_h=0 时旧 gate `if (prodPerSec <= 0) continue;` 拦死,
      // 永远不 emit opt-deuteriumSynth → 殖民地无 d 永远卡住. catch-22: 没 mine
      // → 0 prod → 优化器不推 → 永远不建. 修法: prodPerSec=0 + curLvl=0 + total>0
      // 用 86400s (1d) sentinel oldWaitSec, L0→L1 ratio=100 公式正常跑, saving 巨大.
      if (prodPerSec <= 0 && (curLvl !== 0 || total <= 0)) continue;
      const oldWaitSec = prodPerSec > 0 ? total / prodPerSec : 86400;
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
    // v0.0.997 → v0.0.998 → v0.0.999 — owner 2026-06-09 "决策模块只有一个吗?
    // 你又造了其他的决策模块?" 一针见血: v0.0.997/998 都在 optimizer 里另造
    // 预测逻辑, planner 已有 canonical `pickEnergyPrereqBuilding` (planner.ts:350)
    // 同时给 planner cascade + simulate + 现在 optimizer 用. 撤掉自造逻辑,
    // 直接调它. 返回 non-null = 需先建电厂 → skip mine emit.
    // 它内部已含 forward-projection (build_q delta + this delta), affordability,
    // opt-* lookup 等所有 owner 验过的策略.
    const planetIdForGate = (r.planet as { id?: string })?.id ?? g.planet ?? "";
    const isMineAccel = best.mine === "metalMine" || best.mine === "crystalMine" || best.mine === "deuteriumSynth";
    if (isMineAccel) {
      const planetForProj = r.planet as {
        id?: string;
        buildings?: Record<string, number>;
        resources?: { e?: number };
        build_q?: { building?: string; level?: number } | null;
      };
      const curLvl = planetForProj.buildings?.[best.mine] ?? 0;
      const energyTech = (state.research as { levels?: Record<string, number> } | undefined)?.levels?.energyTech ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const energyPick = pickEnergyPrereqBuilding(best.mine, curLvl, best.L_new, planetForProj as any, energyTech, allRows as any, uid);
      if (energyPick) {
        const pickLabel = energyPick.kind === "build" ? energyPick.building : energyPick.tech;
        console.info(`[optimizer/skip-mine] uid=${uid.slice(0,8)} planet=${planetIdForGate} ${best.mine} L${curLvl}→L${best.L_new} ` +
          `blocked by canonical pickEnergyPrereqBuilding → need ${pickLabel} L${energyPick.level} first`);
        skipped++;
        continue;
      }
    }
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
    // v0.0.903 — owner 2026-06-07 "同一星球都显示在一个树里面" — 不是 skip
    // emit, 是 emit 时挂 parent. opt-* 已通过 parent_goal_id 机制挂到 g.id
    // (loop's main goal). 这里再增 fallback: 如果 g 是 opt-* 派生 (parent is
    // also opt-*), 寻同 planet 真 user root 改挂, 防止 2 棵 opt- 互相挂出 2 tree.
    // v0.0.901/902 skip-emit 撤回 — 撤掉 opt-* 不 emit 会让 user cascade 真出
    // solarPlant build 但 priority 不够高, owner 反馈 panel 想要"看到加速器"
    // 又要"在一棵树里". 答案=保留 emit + 强 parent 链.
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

  // v0.0.826 — operator 2026-06-06 "矿建完就电量会变成负值, 这个节点补电厂,
  // 而不是已经变负值了再补". Predictive energy guard: 遍历 planet, 把 ogame
  // build_q 里 *正在建* 的耗电建筑级数 apply 进 mineDraw (post-completion
  // 模拟), 算后续 budget. 任何 mine/lf 耗电建筑升级 in-flight 都立刻反映到
  // budget. 提前 emit opt-solarPlant 让电厂跟矿同步爬, 不让 ogame queue 完成
  // 再触发反应式 emit (那时已经至少 30 分钟负电).
  try {
    const planetsMap = state.planets ?? {};
    const energyTech = state.research?.levels?.["energyTech"] ?? 0;
    const mineKeys = ["metalMine", "crystalMine", "deuteriumSynth"] as const;
    // v0.0.918 — owner 2026-06-07 "这么有一个单独的 能源技术 L13" — opt-energyTech
    // 的 parent (e.g. crystalMine goal) 中途 complete 后, panel filter 不到
    // parent → 该 research goal 沦为 standalone top-level row 让 owner 困惑.
    // sweep: 任何 active opt-energyTech 若 parent_goal_id 指向 completed/cancelled
    // 的 goal, 改挂到当前第一个 active non-opt root; 若无 candidate, 视为 stale 直接 cancel.
    {
      const orphans = allRows.filter((r) => {
        if (!r.goal.id.startsWith("opt-energyTech-L")) return false;
        if (!r.goal.id.endsWith(uid.slice(0, 8))) return false;
        if (!["pending", "active", "blocked"].includes(r.status)) return false;
        const pid = (r.goal as { parent_goal_id?: string }).parent_goal_id;
        if (!pid) return false;
        const alive = allRows.some((p) => p.goal.id === pid && ["pending", "active", "blocked"].includes(p.status));
        return !alive;
      });
      for (const orphan of orphans) {
        const newRoot = allRows.find((r) => {
          if (!["pending", "active", "blocked"].includes(r.status)) return false;
          const id = r.goal.id;
          if (id.startsWith("opt-") || id.startsWith("exp-") || id.startsWith("expb-")) return false;
          return true;
        });
        if (newRoot) {
          try {
            const merged = { ...orphan, goal: { ...orphan.goal, parent_goal_id: newRoot.goal.id }, updated_at: Date.now() };
            await pgStore.upsertGoal(uid, merged);
            console.info(`[optimizer/energy-guard/orphan] uid=${uid.slice(0, 8)} re-parent ${orphan.goal.id}: dead-parent → ${newRoot.goal.id}`);
          } catch (e) {
            console.warn(`[optimizer/energy-guard/orphan] re-parent ${orphan.goal.id} threw:`, e instanceof Error ? e.message : e);
          }
        } else {
          try {
            await pgStore.updateGoalStatus(uid, orphan.goal.id, "cancelled", "orphan opt-energyTech — no active root to re-attach");
            console.info(`[optimizer/energy-guard/orphan] uid=${uid.slice(0, 8)} cancel ${orphan.goal.id} (no active root)`);
          } catch (e) {
            console.warn(`[optimizer/energy-guard/orphan] cancel ${orphan.goal.id} threw:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
    // v0.0.1011 — owner 2026-06-09 "不缺电 为什么要补电" 真因: opt-energyTech-L16
    // parent_goal_id 锁在 buil-deutSynth-L33 @ planet 33640786, 但 33640786 现在
    // e=5767 正电, owner panel 看见 opt-energyTech 显在 2:279:8 树下 → 困惑.
    // v0.0.918 orphan 兜底只处理 parent 已 dead 的 case. 这里加 wrong-planet 兜底:
    // 如果 opt-energyTech parent 的 planet 已不缺电, re-parent 到当前最缺电 planet
    // 的某个 active goal. 全 uid 都不缺电的话 cleanup-global (本函数末尾) 兜底 cancel.
    {
      // 计算每个 planet 的 projected E (snapE - max single mine delta).
      // v0.0.1025 — 同 main forward-projection: 跳过 blocked mine, 避免循环锁.
      const planetProjE = new Map<string, number>();
      for (const planet of Object.values(planetsMap)) {
        const pid = (planet as { id?: string }).id ?? "";
        if (!pid) continue;
        const snapE = (planet as { resources?: { e?: number } }).resources?.e ?? 0;
        let maxDelta = 0;
        for (const r of allRows) {
          if (!["active","pending","dispatched"].includes(r.status)) continue;
          if ((r.goal as { planet?: string }).planet !== pid) continue;
          const tgt = r.goal.target as { building?: string; level?: number } | undefined;
          const bld = tgt?.building;
          const lvl = tgt?.level;
          if (!bld || typeof lvl !== "number") continue;
          if (bld !== "metalMine" && bld !== "crystalMine" && bld !== "deuteriumSynth") continue;
          const curLvl = (planet.buildings as Record<string, number> | undefined)?.[bld] ?? 0;
          if (lvl <= curLvl) continue;
          const delta = mineEnergyConsumption(bld, lvl) - mineEnergyConsumption(bld, curLvl);
          if (delta > maxDelta) maxDelta = delta;
        }
        planetProjE.set(pid, snapE - maxDelta);
      }
      const energyTechGoals = allRows.filter((r) =>
        r.goal.id.startsWith("opt-energyTech-L") &&
        r.goal.id.endsWith(uid.slice(0, 8)) &&
        ["pending","active","blocked"].includes(r.status),
      );
      for (const eg of energyTechGoals) {
        const parentId = (eg.goal as { parent_goal_id?: string }).parent_goal_id;
        if (!parentId) continue;
        const parent = allRows.find((p) => p.goal.id === parentId);
        if (!parent) continue;
        const parentPid = (parent.goal as { planet?: string }).planet ?? "";
        if (!parentPid) continue;
        const projE = planetProjE.get(parentPid) ?? 0;
        if (projE >= 0) {
          // current parent's planet 不缺电 — 找另一个缺电 planet 的 goal 改挂
          const needyPid = [...planetProjE.entries()].filter(([, e]) => e < 0).sort((a, b) => a[1] - b[1])[0]?.[0];
          if (!needyPid) continue; // 没缺电 planet — cleanup-global 接管
          const newParent = allRows.find((r) => {
            if (!["pending","active","blocked"].includes(r.status)) return false;
            const id = r.goal.id;
            if (id.startsWith("opt-") || id.startsWith("exp-") || id.startsWith("expb-")) return false;
            return (r.goal as { planet?: string }).planet === needyPid;
          });
          if (!newParent) continue;
          try {
            const merged = { ...eg, goal: { ...eg.goal, parent_goal_id: newParent.goal.id }, updated_at: Date.now() };
            await pgStore.upsertGoal(uid, merged);
            console.info(`[optimizer/energy-guard/reparent] uid=${uid.slice(0,8)} ${eg.goal.id} parent ${parentId}@${parentPid}(projE=${Math.round(projE)}) → ${newParent.goal.id}@${needyPid}(projE=${Math.round(planetProjE.get(needyPid) ?? 0)})`);
            actioned++;
          } catch (e) {
            console.warn(`[optimizer/energy-guard/reparent] ${eg.goal.id} threw:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
    for (const planet of Object.values(planetsMap)) {
      if ((planet as { type?: string }).type !== "planet") continue;
      const b = (planet as { buildings?: Record<string, number> }).buildings ?? {};
      // post-completion levels: build_q.building 是耗电 mine 时 mineDraw 用 queue level,
      // 是电厂 (solar/fusion) 时 plant 输出也提前算 — 双向都要 predict
      const bq = (planet as { build_q?: { building?: string; level?: number } | null }).build_q;
      const projectedLvl = (name: string): number => {
        const cur = b[name] ?? 0;
        if (bq && bq.building === name && (bq.level ?? 0) > cur) return bq.level!;
        return cur;
      };
      const solar = projectedLvl("solarPlant");
      const fusion = projectedLvl("fusionReactor");
      let mineDraw = 0;
      for (const mk of mineKeys) mineDraw += mineEnergyConsumption(mk, projectedLvl(mk));
      const solarOut = solarProduction(solar);
      const fusionOut = fusionProduction(fusion, energyTech);
      const formulaBudget = solarOut + fusionOut - mineDraw;
      // v0.0.865 — operator 2026-06-06 "老账号星球出现负电, 自动优化是不是自动的".
      // 老 guard 只看 formulaBudget (mines vs solar+fusion), 漏 LF building / crawler /
      // 其他耗电消费者. snapE 显负但 formula 说仍 +2K → guard 永远跳过 → planet
      // 永远负电. 用 snapE 兜底: 跟 formulaBudget 取最小, 让真实负电信号也能 fire.
      // 容差 -50: 避免 snapshot 抖动 / 计算延迟造成小负值反复 emit.
      const snapE = (planet as { resources?: { e?: number } }).resources?.e ?? 0;
      // v0.0.989m → v0.0.993 — owner 2026-06-09 picked B (顶层修复):
      // v0.0.989m 加了 forward-project, 但循环里 `projectedSnapE -= delta` 把同
      // planet 上多个 active mine goal 的 delta **累加**, 实际 mine 串行 build,
      // sum 会 oversize solar → solar 太贵建不起 → mine 也卡在 prereq 不动 → 死锁
      // (eb990432 新账号 3 颗负电星球, opt-solar L19/L22 全 blocked on 24k crystal).
      //
      // 顶层模型: optimizer 只需 size solar to 覆盖**单个最大 mine 的下次 build**
      // 即可. mine 串行完成, 其余 mine 在自己 prereq cascade 里再触发 opt-solar
      // (chain emit). 用 MAX single delta 替代 SUM.
      const planetIdLocal = (planet as { id?: string }).id ?? "";
      let maxMineDelta = 0;
      if (planetIdLocal) {
        for (const r of allRows) {
          // v0.0.1025 — owner 2026-06-09 "电够为什么建电厂" 实证 33674107: e=+6218
          // (够), 但 PG 仍派 opt-solarPlant. 真因循环锁:
          //   buil-deutSynth-L33 → planner hard-gate blocked (projected=-1035)
          //   forward-projection 仍把它算进 delta
          //   → realBudget<0 → emit opt-solar → blocked m short
          //   → deutSynth 永远不动 → e 永远 +6218 → 实际不缺
          //   ↑ 但 forward-projection 还说缺, 死锁
          // 修: forward-projection 只 count 真会落地的 mine (status ∈ active/
          // pending/dispatched). blocked 的 mine 不动, 也就不会消耗 energy,
          // 别把它纳入 projection.
          if (!["active","pending","dispatched"].includes(r.status)) continue;
          if ((r.goal as { planet?: string }).planet !== planetIdLocal) continue;
          const tgt = r.goal.target as { building?: string; level?: number } | undefined;
          const bld = tgt?.building;
          const lvl = tgt?.level;
          if (!bld || typeof lvl !== "number") continue;
          if (bld !== "metalMine" && bld !== "crystalMine" && bld !== "deuteriumSynth") continue;
          const curLvl = (planet.buildings as Record<string, number> | undefined)?.[bld] ?? 0;
          if (lvl <= curLvl) continue;
          const delta = mineEnergyConsumption(bld, lvl) - mineEnergyConsumption(bld, curLvl);
          if (delta > maxMineDelta) maxMineDelta = delta;
        }
      }
      const projectedSnapE = snapE - maxMineDelta;
      const realBudget = projectedSnapE < -50 || snapE < -50
        ? Math.min(formulaBudget, projectedSnapE, snapE)
        : Math.min(formulaBudget, projectedSnapE);
      // v0.0.908 撤回 — owner 2026-06-07 "改你的垃圾方法": PROACTIVE_E_BUFFER
      // 是错颗粒度. 真模型 = planner.ts pickEnergyPrereqBuilding (L229+) 已经在
      // 每个矿建造前 pre-flight 检查 extraConsumption vs structuralBudget,
      // 不够就 cascade 进电厂. energy-guard 只是 post-hoc 兜底.
      if (realBudget >= 0) {
        // v0.0.915 — owner 2026-06-07 "3:279:7 不缺电为什么也补电厂?" — 旧
        // opt-* emit 时 snapE 是负, 后来自然回正 (transport/production) 但
        // opt-* 一直 blocked 卡 panel. 现在 sweep 时若 realBudget >= 0, cancel
        // 该 planet 的 pending/blocked opt-solarPlant + opt-fusionReactor stale
        // goal. active 不动 (in-flight 真的在建). opt-energyTech 是 global
        // research 不绑 planet, 也不动 (单条 goal 服务所有负电星球).
        // v0.0.936 — owner 2026-06-07 "能源恢复了会自动取消?" / "错了" 实证:
        // v0.0.935 撤掉是我之前 Q 描述方向反了的误操作, 立刻恢复 v0.0.915.
        const planetIdForCleanup = (planet as { id?: string }).id ?? "";
        if (planetIdForCleanup) {
          const stales = allRows.filter((r) => {
            const id = r.goal.id;
            const isEnergyOpt = id.startsWith("opt-solarPlant-L") || id.startsWith("opt-fusionReactor-L");
            if (!isEnergyOpt) return false;
            if (!id.endsWith(uid.slice(0, 8))) return false;
            if (r.goal.planet !== planetIdForCleanup) return false;
            if (!["pending", "blocked"].includes(r.status)) return false;
            return true;
          });
          for (const stale of stales) {
            try {
              await pgStore.updateGoalStatus(uid, stale.goal.id, "cancelled", `energy recovered (snapE=${snapE}, realBudget=${Math.round(realBudget)}) — no longer needed`);
              console.info(`[optimizer/energy-guard/cleanup] uid=${uid.slice(0, 8)} planet=${planetIdForCleanup} cancel ${stale.goal.id} (energy recovered)`);
              actioned++;
            } catch (e) {
              console.warn(`[optimizer/energy-guard/cleanup] cancel ${stale.goal.id} threw:`, e instanceof Error ? e.message : e);
            }
          }
        }
        continue;
      }
      const inflightMine = bq && mineKeys.includes(bq.building as typeof mineKeys[number]) ? `${bq.building} L${bq.level} in-flight` : "current levels";
      const deficit = -realBudget;
      // v0.0.914 — owner 2026-06-07 "optimizer/cascade gate/post-hoc tick
      // 不能合并吗" — 4 路 enum 抽到 planner.pickEnergyFixCandidates (shared
      // helper). 这里只剩"嫁接 winner 到 PG row"的 dispatch 逻辑.
      const deutSynth = projectedLvl("deuteriumSynth");
      const fusionPrereqOk = deutSynth >= 5 && energyTech >= 3;
      const candidates = pickEnergyFixCandidates({
        deficit, solar, fusion, energyTech,
        fusionPrereqsMet: fusionPrereqOk,
      });
      const winner = candidates[0];
      if (!winner) continue;
      const planetId = (planet as { id?: string }).id ?? "";
      if (!planetId) continue;
      console.info(`[optimizer/energy-guard/compare] uid=${uid.slice(0,8)} planet=${planetId} deficit=${Math.round(deficit)} picks=[${candidates.map(c => `${c.kind}:${c.cost}`).join(",")}] → pick ${winner.kind}`);
      // sameRoot — find non-opt root goal on planet so cascade nests under it
      const sameRoot = allRows.find((r) => {
        if (r.goal.planet !== planetId) return false;
        if (!["active", "blocked", "pending"].includes(r.status)) return false;
        const id = r.goal.id;
        if (id.startsWith("opt-") || id.startsWith("exp-") || id.startsWith("expb-")) return false;
        return true;
      });
      const parentField = sameRoot ? { parent_goal_id: sameRoot.goal.id } : {};
      // emitOpt — uid/level dedup + upsert single goal row
      const emitOpt = async (kind: "build" | "research", target: Record<string, unknown>, optId: string, levelForDedup: number, optKindKey: string): Promise<void> => {
        const exists = allRows.find((r) => {
          if (!r.goal.id.startsWith(`opt-${optKindKey}-L`)) return false;
          if (!r.goal.id.endsWith(uid.slice(0, 8))) return false;
          if (kind === "build" && r.goal.planet !== planetId) return false;
          if (!["active", "blocked", "pending"].includes(r.status)) return false;
          const lvl = (r.goal.target as { level?: number })?.level ?? 0;
          return lvl >= levelForDedup;
        });
        if (exists) return;
        const row = {
          goal: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            id: optId, type: kind as any,
            target,
            ...(kind === "build" ? { planet: planetId } : {}),
            priority: 9,
            is_main_goal: false,
            status: "pending" as const,
            created_at: Date.now(),
            progress_pct: 0,
            current_step: "queued",
            eta_at: null,
            ...parentField,
          },
          status: "pending" as const,
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        try {
          await pgStore.upsertGoal(uid, row);
          console.log(`[optimizer/energy-guard] uid=${uid.slice(0, 8)} planet=${planetId} realBudget=${Math.round(realBudget)} (${inflightMine}) → emit ${optId}`);
          actioned++;
        } catch (e) {
          console.warn(`[optimizer/energy-guard] upsert ${optId} threw:`, e instanceof Error ? e.message : e);
        }
      };
      // v0.0.1024 — owner 2026-06-09 "发现错误" 实证 33674107: PG 有 opt-solarPlant-L28
      // AND L29 双 stale, 但当前 winner 是 fusion. 根因:
      //   A. emitOpt 只 skip 自己再 emit, 不 cancel 同 planet 老 opt-solar 当 winner 升级
      //   B. 老 cleanup 只在 realBudget>=0 时跑, winner kind 切换时 NEG-E 下没 cleanup
      // 修: emit winner 之前 cancel 同 planet 所有 non-winner opt-energy (planet-bound:
      // solarPlant + fusionReactor). opt-energyTech 是 global 不绑 planet, 由
      // cleanup-global (v0.0.1010) + reparent (v0.0.1011) 处理, 这里不动.
      const winnerOptIds = new Set<string>();
      if (winner.kind === "solar") winnerOptIds.add(`opt-solarPlant-L${winner.level}-${uid.slice(0,8)}`);
      else if (winner.kind === "fusion") winnerOptIds.add(`opt-fusionReactor-L${winner.level}-${uid.slice(0,8)}`);
      else if (winner.kind === "energy") winnerOptIds.add(`opt-energyTech-L${winner.level}-${uid.slice(0,8)}`);
      else if (winner.kind === "combo") {
        winnerOptIds.add(`opt-fusionReactor-L${winner.fL}-${uid.slice(0,8)}`);
        winnerOptIds.add(`opt-energyTech-L${winner.eL}-${uid.slice(0,8)}`);
      }
      const stalePlanetEnergyOpts = allRows.filter((r) => {
        const id = r.goal.id;
        if (!id.endsWith(uid.slice(0,8))) return false;
        // planet-bound energy opt-* only: solar + fusion. opt-energyTech 是 global.
        if (!(id.startsWith("opt-solarPlant-L") || id.startsWith("opt-fusionReactor-L"))) return false;
        if (r.goal.planet !== planetId) return false;
        if (!["pending","blocked","active"].includes(r.status)) return false;
        if (winnerOptIds.has(id)) return false; // winner 留住
        return true;
      });
      for (const stale of stalePlanetEnergyOpts) {
        try {
          await pgStore.updateGoalStatus(uid, stale.goal.id, "cancelled", `superseded by energy-guard winner=${winner.kind}${"level" in winner ? `:L${winner.level}` : ""} on planet=${planetId}`);
          console.info(`[optimizer/energy-guard/supersede] uid=${uid.slice(0,8)} planet=${planetId} cancel ${stale.goal.id} (winner=${winner.kind})`);
          actioned++;
        } catch (e) {
          console.warn(`[optimizer/energy-guard/supersede] cancel ${stale.goal.id} threw:`, e instanceof Error ? e.message : e);
        }
      }
      // dispatch by winning candidate
      if (winner.kind === "solar") {
        const optId = `opt-solarPlant-L${winner.level}-${uid.slice(0, 8)}`;
        await emitOpt("build", { building: "solarPlant", level: winner.level }, optId, winner.level, "solarPlant");
      } else if (winner.kind === "fusion") {
        const optId = `opt-fusionReactor-L${winner.level}-${uid.slice(0, 8)}`;
        await emitOpt("build", { building: "fusionReactor", level: winner.level }, optId, winner.level, "fusionReactor");
      } else if (winner.kind === "energy") {
        const optId = `opt-energyTech-L${winner.level}-${uid.slice(0, 8)}`;
        await emitOpt("research", { tech: "energyTech", level: winner.level }, optId, winner.level, "energyTech");
      } else if (winner.kind === "combo") {
        const fOptId = `opt-fusionReactor-L${winner.fL}-${uid.slice(0, 8)}`;
        const eOptId = `opt-energyTech-L${winner.eL}-${uid.slice(0, 8)}`;
        await emitOpt("build", { building: "fusionReactor", level: winner.fL }, fOptId, winner.fL, "fusionReactor");
        await emitOpt("research", { tech: "energyTech", level: winner.eL }, eOptId, winner.eL, "energyTech");
      }
      // v0.0.1024 (C 撤回) — owner 2026-06-09 "天体物理大于等于9 就不看产能"
      // + "设置成等待资源": 产能判断不归 optimizer 管. planner 已经在资源
      // 不够时返 "waiting for resources" 状态, 那就是权威结果, optimizer 不
      // 再额外 warn/block. astro>=9 (post-expedition phase) 资源跨 planet
      // 流转充裕, 更不该看产能. 见 [[no-fallback-design]] — 不另写 second-guess.
    }
    // v0.0.1010 — owner 2026-06-09 "不缺电 为什么要补电" 实证 4baba0e2 11 颗
    // planet 全正电 (lowest e=193), opt-energyTech-L16 仍在 PG blocked, 老
    // cleanup logic (L714) 只 cancel opt-solarPlant/opt-fusionReactor, 漏 energyTech.
    // 注释里说 "energyTech 是 global, 服务所有负电星球", 但当 0 颗负电时该 sweep
    // 也得清. 这里在外 loop 完后 global sweep: 若 uid 任何 planet 都不缺电
    // (forward-project 后) → cancel opt-energyTech-L*.
    let anyNeedsEnergyFix = false;
    for (const planet of Object.values(planetsMap)) {
      const snapE = (planet as { resources?: { e?: number } }).resources?.e ?? 0;
      if (snapE < 0) { anyNeedsEnergyFix = true; break; }
      // forward-project: 检查该 planet 的 active mine goal 是否会让 e 变负
      // v0.0.1025 — 同前 2 处: blocked mine 不算 (循环锁修复).
      const pid = (planet as { id?: string }).id ?? "";
      let maxDelta = 0;
      for (const r of allRows) {
        if (!["active","pending","dispatched"].includes(r.status)) continue;
        if ((r.goal as { planet?: string }).planet !== pid) continue;
        const tgt = r.goal.target as { building?: string; level?: number } | undefined;
        const bld = tgt?.building;
        const lvl = tgt?.level;
        if (!bld || typeof lvl !== "number") continue;
        if (bld !== "metalMine" && bld !== "crystalMine" && bld !== "deuteriumSynth") continue;
        const curLvl = (planet.buildings as Record<string, number> | undefined)?.[bld] ?? 0;
        if (lvl <= curLvl) continue;
        const delta = mineEnergyConsumption(bld, lvl) - mineEnergyConsumption(bld, curLvl);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (snapE - maxDelta < 0) { anyNeedsEnergyFix = true; break; }
    }
    if (!anyNeedsEnergyFix) {
      const stales = allRows.filter((r) => {
        const id = r.goal.id;
        if (!id.startsWith("opt-energyTech-L")) return false;
        if (!id.endsWith(uid.slice(0, 8))) return false;
        return ["pending","blocked","active"].includes(r.status);
      });
      for (const stale of stales) {
        try {
          await pgStore.updateGoalStatus(uid, stale.goal.id, "cancelled", `no planet needs energy fix (all planets projected positive) — global energyTech opt obsolete`);
          console.info(`[optimizer/energy-guard/cleanup-global] uid=${uid.slice(0,8)} cancel ${stale.goal.id} (no neg-e planet for this uid)`);
          actioned++;
        } catch (e) {
          console.warn(`[optimizer/energy-guard/cleanup-global] cancel ${stale.goal.id} threw:`, e instanceof Error ? e.message : e);
        }
      }
    }
  } catch (e) {
    console.warn(`[optimizer/energy-guard] sweep threw uid=${uid.slice(0, 8)}:`, e instanceof Error ? e.message : e);
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
