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
import { tenantRegistry } from "./tenant_context.js";
import { getCurrentUserId } from "./user_context.js";

export type PlanResult = Directive | { blocked: string; auto_complete?: boolean };

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
//
// Phase 11 (v0.0.785) — operator 2026-06-05 "LF 建筑有需要电的注意补电策略".
// kaelesh sanctuary / antimatterCondenser / 等 LF major buildings 升级也耗
// 电. catalog cost_at(L).e 当前 verified_against_live=false 故 0, future
// 一次修 catalog 双端生效 (simulate + planner). gate 入口扩 LF building 名:
// 当 catalog 真 e cost > 0 时 gate trigger emit solarPlant cascade.
export const ENERGY_GATED_BUILDINGS: ReadonlySet<string> = new Set([
  "metalMine",
  "crystalMine",
  "deuteriumSynth",
  // LF buildings (kaelesh — known energy-consumer) — sanctuary 是 housing
  // 但其衍生 antimatterCondenser/runeForge/megalith 是真耗电.
  "antimatterCondenser",
  "runeForge",
  "megalith",
  // humans counterpart
  "biosphereFarm",  // 实际 produces food (not electricity); 留作 placeholder
]);

// v0.0.696 — operator 2026-06-03 "保留计算矿产量，分成两部分":
//   pre-expedition phase (no fleet has flown mission=15)
//     → compute production + auto-upgrade STORAGE (crystalStorage/deuteriumTank).
//       metalStorage 永远不自动建 (operator: "金属永远过剩").
//   post-expedition phase (any expedition in flight or slots used > 0)
//     → no production calc, simple "waiting for resources" — state refresh
//       is event-driven via fleet-landing events.
function isPostExpeditionPhase(state: WorldState): boolean {
  // v0.0.697 — operator 2026-06-03 "astro >= 4 这个合理".
  // v0.0.931 — owner 2026-06-07 "改成 9": astro=4 只解锁 1 远征槽, 太早就
  // 不算矿/存储罐的产能 wait, post-phase skip 过激进; astro>=9 = floor(sqrt(9))
  // =3 槽, 远征经济才真正起飞, transport 周期稳定能补给 — 这时 skip 才合理.
  const astro = state.research?.levels?.["astrophysics"] ?? 0;
  return astro >= 9;
}

// Pre-phase storage strategy: when resource bottleneck is crystal or deuterium
// AND current storage is ≥95% full → recommend storage upgrade. metal is
// EXCLUDED per operator policy (metal永远过剩). Returns the storage building
// to upgrade, or null when wait-only path is appropriate.
function pickStorageUpgrade(planet: Planet, short: { m: number; c: number; d: number }, econSpeed: number = 1): "metalStorage" | "crystalStorage" | "deuteriumTank" | null {
  const r = planet.resources ?? { m: 0, c: 0, d: 0 };
  // v0.0.825 / v0.0.848 — operator 2026-06-06 解除 metalStorage 限制.
  // v0.0.849 — operator 2026-06-06 "新账号金属满了 没有触发建存储罐". 0.95 阈值
  // 在 speed-1 服 OK 但 speed-8 服只剩 ~12 分钟窗口 (60% 距 cap, 实际产量 *8 倍
  // 已要溢出). 改成预测式: 把当前 r + 未来 30min 产出加起来比 cap, 命中 0.95
  // 就 fire. 慢服 m_h≈0 等价于纯静态阈值, 快服自然提前.
  const cap = (lvl: number): number => Math.floor(5000 * Math.pow(2.5, lvl));
  const mStorLvl = planet.buildings?.["metalStorage"] ?? 0;
  const cStorLvl = planet.buildings?.["crystalStorage"] ?? 0;
  const dStorLvl = planet.buildings?.["deuteriumTank"] ?? 0;
  const mMax = (planet.storage?.m_max ?? 0) > 0 ? planet.storage!.m_max : cap(mStorLvl);
  const cMax = (planet.storage?.c_max ?? 0) > 0 ? planet.storage!.c_max : cap(cStorLvl);
  const dMax = (planet.storage?.d_max ?? 0) > 0 ? planet.storage!.d_max : cap(dStorLvl);
  const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
  const horizonH = 0.5; // 30 min predictive horizon
  const mProj = r.m + Math.max(0, (prod.m_h ?? 0)) * econSpeed * horizonH;
  const cProj = r.c + Math.max(0, (prod.c_h ?? 0)) * econSpeed * horizonH;
  const dProj = r.d + Math.max(0, (prod.d_h ?? 0)) * econSpeed * horizonH;
  if (short.m > 0 && mProj >= mMax * 0.95) return "metalStorage";
  if (short.c > 0 && cProj >= cMax * 0.95) return "crystalStorage";
  if (short.d > 0 && dProj >= dMax * 0.95) return "deuteriumTank";
  return null;
}

// ogame v12 vanilla energy formulas (per hour, universe-speed cancels in
// deltas). Mirrors the daemon's mineEnergyConsumption / solarProduction
// (ogamex_discord_bridge.mjs L683-700); kept inline to avoid pulling the
// daemon into a sidecar import. metalMine + crystalMine consume base=10,
// deuteriumSynth consume base=20, solarPlant produces 20, fusionReactor
// produces 50*(1+0.02*energyTech).
export function mineEnergyConsumption(building: string, level: number): number {
  if (level <= 0) return 0;
  // Phase 11 — LF building 走 catalog `cost_at(L).e` 而不是 hardcode 公式.
  // catalog 数据 verified_against_live=false 时返回 0 → gate noop. 一次修
  // catalog 即可双端 (planner + simulate) 同步生效.
  const regularBases: Record<string, number> = { deuteriumSynth: 20, metalMine: 10, crystalMine: 10 };
  if (regularBases[building] !== undefined) {
    return regularBases[building]! * level * Math.pow(1.1, level);
  }
  // LF building energy lookup via catalog. species detection 在调用方,
  // 这里跨所有 species 查 — 第一个 hit 就用 (ogame 同名 building 跨 species
  // catalog 一致是合理假设, 否则签名要加 species 参数).
  for (const speciesKey of Object.keys(LIFEFORM_TECH) as Array<keyof typeof LIFEFORM_TECH>) {
    const entry = LIFEFORM_TECH[speciesKey]?.buildings?.[building];
    if (entry?.cost_at) {
      const cost = entry.cost_at(level);
      return Math.max(0, (cost as { e?: number }).e ?? 0);
    }
  }
  return 0;
}

// ogame v12 vanilla — power plant production (per hour, universe speed cancels
// in delta comparisons). Mirrors daemon's solarProduction.
//   solarPlant:    20 * L * 1.1^L                            (ogame wiki v12)
//   fusionReactor: 30 * L * (1.05 + 0.01 * energyTech)^L     (ogame wiki v12)
// v0.0.911 — fusion 公式由 owner 2026-06-07 "公式肯定有问题" 触发审计修复:
// 旧式 `50 * L * 1.1^L * (1 + 0.02*e)` 跟 ogame 真公式不对 (L=15 e=12 时
// 3885 vs 真 4742, 误差 ~20%), 早期实现拍脑袋写的, 没人 check; planner +
// simulate 双端读这函数 → 偏低 → fusion pick / deficit 都会被低估.
export function solarProduction(level: number): number {
  if (level <= 0) return 0;
  return 20 * level * Math.pow(1.1, level);
}
export function fusionProduction(level: number, energyTech: number): number {
  if (level <= 0) return 0;
  return 30 * level * Math.pow(1.05 + 0.01 * energyTech, level);
}

// v0.0.737 — operator 2026-06-04 "补电厂的逻辑是有的, 不要重复写代码, 复用".
// Shared energy-gate decision: returns the recommended power plant + level
// when `building` upgrade would drain energy below 0, or null otherwise.
// Used by BOTH planBuild (recurses into planBuild for the pick) AND
// simulate() prereq-tree builder (adds the pick as a tree child).
// Single source of truth for the solar-vs-fusion choice + needsPowerPlant
// gate — algorithm parity guaranteed between planning and visualization.
//
// v0.0.738 — operator 2026-06-04 "tree 显示的还是不对吧". `level: current+1`
// 只够升一级, deutSynth L32 缺 ~1466 能源, fusion L14→L15 只多产 ~475 — 不
// 够. 改成 minLevel = 把 deficit 全部抹平所需的最小电厂级数. planner 跟
// simulate 都用同一个 minLevel: 前者递归 planBuild 一级一级 dispatch (loop
// 在外层 tick 上), 后者一次性 buildAndSimulate(target=minLevel) 把整段累计
// 进 tree ETA.
// v0.0.764 — operator 2026-06-04 "船运资源到 4:299:8 就会触发升级一次核电站,
// 能量已经足够". Root cause: 4:299:8 fields 已满, fusion L17 dispatch 反复被
// ogame 拒 120012, 24h backoff 锁 PARENT goal 但 planner 每次 trigger 仍
// 递归选 fusion. 修复 — 缓存"该 planet 上该 building 最近 120012 fields_full"
// 24h, planner 看到则跳过 (选另一种 plant or 干脆 return null 让 parent
// blocked with "fields full")。Module-level cache 跨 dispatch tick 持久.
// v0.0.862 (Sprint 3) — fieldsFullCache was module-level `Map<`${planetId}:
// ${building}`, …>` WITHOUT uid prefix. Planet IDs aren't globally unique
// across tenants (different universes can share numerics; even within one
// universe our state model holds multiple tenants' planets in one process),
// and the 24h TTL made the cross-tenant suppression durable — real bug.
// Owner directive 2026-06-06: "全部用 per-uid，统一架构 避免以后再来回补丁".
// All entry points now take `uid` and the Map lives inside TenantContext.
// See tenant_context.ts §"Sprint 3" + docs/architecture/multi-tenant.md §1.
function fieldsFullKey(planetId: string, building: string): string {
  return `${planetId}:${building}`;
}
// v0.0.958 — owner 2026-06-08 "fields_full 也 60s 一次": flat retry, owner
// 自己/ogame 自愈, planner 别假设 24h 不可恢复.
const FIELDS_FULL_TTL_MS = 60 * 1000;
export function markFieldsFull(uid: string, planetId: string, building: string): void {
  tenantRegistry.get(uid).fieldsFullCache.set(
    fieldsFullKey(planetId, building),
    { until: Date.now() + FIELDS_FULL_TTL_MS },
  );
}
export function isFieldsFull(uid: string, planetId: string, building: string): boolean {
  const cache = tenantRegistry.get(uid).fieldsFullCache;
  const entry = cache.get(fieldsFullKey(planetId, building));
  if (!entry) return false;
  if (entry.until < Date.now()) {
    cache.delete(fieldsFullKey(planetId, building));
    return false;
  }
  return true;
}
export function clearFieldsFull(uid: string, planetId: string, building: string): void {
  tenantRegistry.get(uid).fieldsFullCache.delete(fieldsFullKey(planetId, building));
}
/** Owner endpoint helpers — list all entries, optionally clear by (planet, building). */
export interface FieldsFullEntry { planet_id: string; building: string; until_ms: number; remaining_ms: number; }
export function listFieldsFull(uid: string): FieldsFullEntry[] {
  const cache = tenantRegistry.get(uid).fieldsFullCache;
  const out: FieldsFullEntry[] = [];
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (v.until < now) { cache.delete(k); continue; }
    const [planet_id, building] = k.split(":");
    if (planet_id && building) out.push({ planet_id, building, until_ms: v.until, remaining_ms: v.until - now });
  }
  return out;
}
export function clearAllFieldsFull(uid: string): number {
  const cache = tenantRegistry.get(uid).fieldsFullCache;
  const n = cache.size;
  cache.clear();
  return n;
}
/** Clear by planet only (all buildings) — common after operator builds terraformer. */
export function clearFieldsFullByPlanet(uid: string, planetId: string): number {
  const cache = tenantRegistry.get(uid).fieldsFullCache;
  let n = 0;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(planetId + ":")) { cache.delete(k); n++; }
  }
  return n;
}

// v0.0.* — operator 2026-06-05 final spec: "如果新建的建筑需要的电量大于库存
// 电量 就启动补电厂的任务". Trigger condition is the per-upgrade energy delta
// vs the current energy surplus. If the building's L→L+1 step consumes more
// energy than the planet currently has in surplus, queue a plant. Otherwise
// leave it; the operator's transports/manual queue can deal.
// Earlier iterations: v0.0.675/737 used projectedEnergy<0 (mathematically the
// same as below); a -BUFFER tolerance was tried and rejected. Bootstrap branch
// (no plant at all) stays — there's no operator decision to preserve.
export type EnergyPrereqPick =
  | { kind: "build"; building: "fusionReactor" | "solarPlant"; level: number; targetLevel: number }
  | { kind: "research"; tech: "energyTech"; level: number; targetLevel: number };

// v0.0.914 — shared 4-way decision helper. Single source of truth for the
// energy-fix candidate enumeration. Used by planner.ts pickEnergyPrereqBuilding
// (synchronous cascade gate) AND optimizer.ts energy-guard (60s post-hoc
// tick). Both callers only differ in how they DISPATCH the winning candidate
// (planner returns PlanResult, optimizer emits PG rows); the DECISION is
// identical, owner 2026-06-07 "optimizer/cascade gate/post-hoc tick 不能合并吗"
// 拉通点.
export type EnergyFixCandidate =
  | { kind: "solar"; level: number; cost: number }
  | { kind: "fusion"; level: number; cost: number }
  | { kind: "energy"; level: number; cost: number }
  | { kind: "combo"; fL: number; eL: number; cost: number };

// v0.0.931 — owner 2026-06-07 "维护三套代码 改个参数会很容易出错". per-build
// helper 把 input prep (extraConsumption, deficit, snapE, fusionPrereqsMet)
// 全封在内部, 3 caller 不再各算各的 → 不再 drift. simulate v0.0.929/930
// 翻车命中的就是 input 算口径不一致(单步 vs 全程), 这层 entry 杜绝.
export function pickEnergyFixForBuildLevel(input: {
  planet: Planet;
  building: string;
  currentLevel: number;
  nextLevel: number;
  energyTech: number;
  solarBlocked?: boolean;
  fusionBlocked?: boolean;
}): EnergyFixCandidate[] {
  const { planet, building, currentLevel, nextLevel, energyTech } = input;
  const solar = planet.buildings?.["solarPlant"] ?? 0;
  const fusion = planet.buildings?.["fusionReactor"] ?? 0;
  const dSynth = planet.buildings?.["deuteriumSynth"] ?? 0;
  const fusionPrereqsMet = dSynth >= 5 && energyTech >= 3;
  const snapE = (planet.resources as { e?: number } | undefined)?.e ?? 0;
  const extraConsumption = mineEnergyConsumption(building, nextLevel) - mineEnergyConsumption(building, currentLevel);
  const deficit = Math.max(0, extraConsumption - snapE, -snapE);
  return pickEnergyFixCandidates({
    deficit, solar, fusion, energyTech, fusionPrereqsMet,
    solarBlocked: !!input.solarBlocked,
    fusionBlocked: !!input.fusionBlocked,
  });
}

export function pickEnergyFixCandidates(input: {
  deficit: number;
  solar: number;
  fusion: number;
  energyTech: number;
  fusionPrereqsMet: boolean;
  solarBlocked?: boolean;   // e.g. fields_full
  fusionBlocked?: boolean;
}): EnergyFixCandidate[] {
  const { deficit, solar, fusion, energyTech, fusionPrereqsMet } = input;
  const solarBlocked = !!input.solarBlocked;
  const fusionBlocked = !!input.fusionBlocked;
  const solarCostFn = TECH_TREE.solarPlant?.cost_at as ((l: number) => { m: number; c: number; d?: number }) | undefined;
  const fusionCostFn = TECH_TREE.fusionReactor?.cost_at as ((l: number) => { m: number; c: number; d?: number }) | undefined;
  const energyCostFn = TECH_TREE.energyTech?.cost_at as ((l: number) => { m: number; c: number; d?: number }) | undefined;
  const cumCost = (costFn: ((l: number) => { m: number; c: number; d?: number }) | undefined, fromL: number, toL: number): number => {
    if (!costFn) return Number.POSITIVE_INFINITY;
    let total = 0;
    for (let l = fromL + 1; l <= toL; l++) {
      const c = costFn(l);
      total += c.m + c.c + (c.d ?? 0);
    }
    return Math.round(total);
  };
  const candidates: EnergyFixCandidate[] = [];
  // solar single-axis
  if (!solarBlocked) {
    let lvl: number | null = null;
    for (let l = solar + 1; l <= solar + 30; l++) {
      if (solarProduction(l) - solarProduction(solar) >= deficit) { lvl = l; break; }
      lvl = l;
    }
    if (lvl !== null) candidates.push({ kind: "solar", level: lvl, cost: cumCost(solarCostFn, solar, lvl) });
  }
  // fusion single-axis
  if (fusionPrereqsMet && !fusionBlocked) {
    const baseFusionOut = fusionProduction(fusion, energyTech);
    let lvl: number | null = null;
    for (let l = fusion + 1; l <= fusion + 30; l++) {
      if (fusionProduction(l, energyTech) - baseFusionOut >= deficit) { lvl = l; break; }
      lvl = l;
    }
    if (lvl !== null) candidates.push({ kind: "fusion", level: lvl, cost: cumCost(fusionCostFn, fusion, lvl) });
  }
  // energyTech-alone (research) — needs existing fusion reactor
  if (fusionPrereqsMet && fusion > 0) {
    const baseFusionOut = fusionProduction(fusion, energyTech);
    let lvl: number | null = null;
    for (let l = energyTech + 1; l <= energyTech + 10; l++) {
      if (fusionProduction(fusion, l) - baseFusionOut >= deficit) { lvl = l; break; }
      lvl = l;
    }
    if (lvl !== null) candidates.push({ kind: "energy", level: lvl, cost: cumCost(energyCostFn, energyTech, lvl) });
  }
  // fusion + energyTech combo
  if (fusionPrereqsMet && fusion > 0 && !fusionBlocked) {
    const baseFusionOut = fusionProduction(fusion, energyTech);
    let best: { fL: number; eL: number; cost: number } | null = null;
    for (let fL = fusion + 1; fL <= fusion + 5; fL++) {
      for (let eL = energyTech + 1; eL <= energyTech + 5; eL++) {
        if (fusionProduction(fL, eL) - baseFusionOut < deficit) continue;
        const total = cumCost(fusionCostFn, fusion, fL) + cumCost(energyCostFn, energyTech, eL);
        if (!best || total < best.cost) best = { fL, eL, cost: total };
      }
    }
    if (best) candidates.push({ kind: "combo", fL: best.fL, eL: best.eL, cost: best.cost });
  }
  candidates.sort((a, b) => a.cost - b.cost);
  return candidates;
}

export function pickEnergyPrereqBuilding(
  building: string,
  current: number,
  nextLevel: number,
  planet: Planet,
  energyTech: number,
  /** v0.0.938 — owner 2026-06-07 "不要维护三个决策引擎". 若提供 activeRows,
   *  直接读 optimizer 已派的 opt-* 作为决策真理, 完全跳过本地 4 路 enum.
   *  drift 架构性消除. 不提供时仍走旧 helper 路径 (back-compat). */
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
  uidForOptLookup?: string,
): EnergyPrereqPick | null {
  if (!ENERGY_GATED_BUILDINGS.has(building)) return null;
  if (building === "solarPlant" || building === "fusionReactor") return null;
  // v0.0.985 — owner 2026-06-08 "建完就负电了, 部署预测模式": planner 老逻辑
  // 用 snapE (当前) + extra (本次升级 delta) 检查, 漏看 build_q 已 queued 的
  // 同 building 升级 — 那个 build 完成后 snapE 实际已下降. 改用 predict mode:
  //   projectedSnapE = snapE - 已 queued 升级的耗电 delta (从 current 到 q.level)
  //   实际本次 dispatch 后 energy = projectedSnapE - extra (nextLevel - q.level)
  // 若 q.level >= nextLevel 说明已在排队中 (planner 跨 tick 重复 pick), 不动作
  const planetBuildQ = (planet as { build_q?: { building?: string; level?: number } | null }).build_q;
  const qLvl = (planetBuildQ && planetBuildQ.building === building && typeof planetBuildQ.level === "number")
    ? planetBuildQ.level : current;
  const projectedCurrent = Math.max(current, qLvl);
  const queuedConsumeDelta = mineEnergyConsumption(building, projectedCurrent) - mineEnergyConsumption(building, current);
  // v0.0.938 — sole-decider path: 读 opt-* 真理, 跳过本地 picker.
  if (activeRows && uidForOptLookup) {
    const snapE0Raw = (planet.resources as { e?: number } | undefined)?.e ?? 0;
    const snapE0 = snapE0Raw - queuedConsumeDelta;  // 预测 post-queue balance
    const extra0 = mineEnergyConsumption(building, nextLevel) - mineEnergyConsumption(building, projectedCurrent);
    if (extra0 <= snapE0 && !((planet.buildings?.["solarPlant"] ?? 0) === 0 && (planet.buildings?.["fusionReactor"] ?? 0) === 0)) {
      return null; // 能源够用 (post-queue projected), 不需要补
    }
    const opt = findActiveEnergyOpt(activeRows, uidForOptLookup, planet.id);
    if (!opt) return null; // optimizer 还没派 → planner 这一拍不动手, 等 60s 后下次 tick
    // v0.0.985 — owner 2026-06-08 "查清原因" 真态: opt-* goal 落后于 PG 真态,
    // 仍要求 solarPlant Lxxx 但 planet 实际已 Lxxx. 老代码递归 planBuild 命中
    // "already at target" → 字面冒泡到 ALREADY_AT_TARGET_RE → 30s consensus →
    // 误删 ORIGINAL deuteriumSynth L33 goal (33674107 实证 18:05-18:06).
    // 修: 源头不返已达 level 的 prereq, 返 null 让 planner 继续主路径.
    if (opt.kind === "build" && opt.building) {
      const curOpt = planet.buildings?.[opt.building] ?? 0;
      if (curOpt >= opt.level) return null;
      return { kind: "build", building: opt.building, level: opt.level, targetLevel: opt.level };
    }
    if (opt.kind === "research") {
      const curTech = energyTech;
      if (curTech >= opt.level) return null;
    }
    return { kind: "research", tech: "energyTech", level: opt.level, targetLevel: opt.level };
  }
  // v0.0.931 — owner 2026-06-07 "维护三套代码 改个参数会很容易出错". input
  // prep (snapE / extraConsumption / deficit / fusionPrereqsMet) 搬进 helper,
  // planner caller 收缩到几行。
  const solar = planet.buildings?.["solarPlant"] ?? 0;
  const fusion = planet.buildings?.["fusionReactor"] ?? 0;
  // v0.0.985 — 预测模式: snapE 减 queue 已计划的 mine 升级耗电, extra 从
  // projectedCurrent (queue level) 算起, 不是 PG 当下 current.
  const snapE = ((planet.resources as { e?: number } | undefined)?.e ?? 0) - queuedConsumeDelta;
  const extraConsumption = mineEnergyConsumption(building, nextLevel) - mineEnergyConsumption(building, projectedCurrent);
  const needsPowerPlant = (solar === 0 && fusion === 0) || extraConsumption > snapE;
  if (!needsPowerPlant) return null;
  if (solar === 0 && fusion === 0) {
    return { kind: "build", building: "solarPlant", level: 1, targetLevel: 1 };
  }
  const uidForCache = getCurrentUserId() ?? "";
  const candidates = pickEnergyFixForBuildLevel({
    planet, building, currentLevel: current, nextLevel, energyTech,
    solarBlocked: isFieldsFull(uidForCache, planet.id, "solarPlant"),
    fusionBlocked: isFieldsFull(uidForCache, planet.id, "fusionReactor"),
  });
  console.info(
    `[ogamex/planner/energy-gate] planet=${planet.id} building=${building} ${current}->${nextLevel} ` +
    `snapE=${snapE} extra=${Math.round(extraConsumption)} ` +
    `picks=[${candidates.map(c => `${c.kind}:${c.cost}`).join(",")}]`,
  );
  const winner = candidates[0];
  if (!winner) return null;
  // v0.0.985 — 同 v0.0.985 路径 1 修法: 若 picker 推荐已达 level, 不要返
  // (会被递归 planBuild 误判 already at → 冒泡到 ALREADY_AT_TARGET_RE → 误删 goal)
  if (winner.kind === "solar") {
    if (solar >= winner.level) return null;
    return { kind: "build", building: "solarPlant", level: winner.level, targetLevel: winner.level };
  }
  if (winner.kind === "fusion") {
    if (fusion >= winner.level) return null;
    return { kind: "build", building: "fusionReactor", level: winner.level, targetLevel: winner.level };
  }
  if (winner.kind === "energy") {
    if (energyTech >= winner.level) return null;
    return { kind: "research", tech: "energyTech", level: winner.level, targetLevel: winner.level };
  }
  // combo: greedy first step — emit the cheaper kick-off (energyTech research
  // is typically cheaper than first fusion bump at mid-game). next-tick re-eval
  // dispatches the remaining half once state advances.
  {
    const fusionCostFn = TECH_TREE.fusionReactor?.cost_at as ((l: number) => { m: number; c: number; d?: number }) | undefined;
    const energyCostFn = TECH_TREE.energyTech?.cost_at as ((l: number) => { m: number; c: number; d?: number }) | undefined;
    const fFirst = fusionCostFn ? (() => { const c = fusionCostFn(fusion + 1); return c.m + c.c + (c.d ?? 0); })() : Number.POSITIVE_INFINITY;
    const eFirst = energyCostFn ? (() => { const c = energyCostFn(energyTech + 1); return c.m + c.c + (c.d ?? 0); })() : Number.POSITIVE_INFINITY;
    if (eFirst <= fFirst) return { kind: "research", tech: "energyTech", level: winner.eL, targetLevel: winner.eL };
    return { kind: "build", building: "fusionReactor", level: winner.fL, targetLevel: winner.fL };
  }
}

// Ogame v12 — list of buildings that can physically exist on a moon. Anything
// not in this set is planet-only (naniteFactory, terraformer, spaceDock, mines,
// solar/fusion, research lab, allianceDepot, etc.) and must be rejected when a
// goal targets a moon body, before any chain/fields work runs.
const MOON_ALLOWED_BUILDINGS: ReadonlySet<string> = new Set([
  "metalStorage",
  "crystalStorage",
  "deuteriumTank",
  "roboticsFactory",
  "shipyard",
  "lunarBase",
  "sensorPhalanx",
  "jumpgate",
  "missileSilo",
]);

// Reverse of MOON_ALLOWED: buildings that physically CANNOT exist on a planet,
// only on moons. Operator 2026-05-29 evidence: GoalRunner dispatched
// `lunarBase L1 planet_id=33637366` (a planet, not the matching moon) → ogame
// returned error 100001 "未知的錯誤". planner should reject before dispatch.
const MOON_ONLY_BUILDINGS: ReadonlySet<string> = new Set([
  "lunarBase",
  "sensorPhalanx",
  "jumpgate",
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
  /** v0.0.938 — owner 2026-06-07 "不要维护三个决策引擎, 改架构". 把 active
   *  goals 透传进 planner, pickEnergyPrereqBuilding 不再自跑 helper, 改读
   *  optimizer 已 emit 的 opt-* 作为唯一决策权威. drift 架构性消除. */
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[] | undefined;
}

/** v0.0.938 — 读 optimizer 已派的 opt-{fusionReactor,solarPlant,energyTech}
 *  作为该 planet 的"能源决策"。optimizer 60s tick 是 sole decider, planner
 *  + simulate 都 follow 这条 emit, drift 不可能。
 *  返回 null = optimizer 当前没派, 调用方应 fallback 到 block "waiting upstream". */
export function findActiveEnergyOpt(
  rows: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
  uid: string,
  planetId: string,
): { kind: "build" | "research"; building?: "fusionReactor" | "solarPlant"; tech?: "energyTech"; level: number; goalId: string } | null {
  const tail = uid.slice(0, 8);
  for (const r of rows) {
    if (!["pending", "active", "blocked"].includes(r.status)) continue;
    const id = r.goal.id;
    if (!id.endsWith(tail)) continue;
    const tgt = r.goal.target as { building?: string; tech?: string; level?: number };
    const lvl = tgt?.level ?? 0;
    if (id.startsWith("opt-fusionReactor-L")) {
      if (r.goal.planet !== planetId) continue;
      return { kind: "build", building: "fusionReactor", level: lvl, goalId: id };
    }
    if (id.startsWith("opt-solarPlant-L")) {
      if (r.goal.planet !== planetId) continue;
      return { kind: "build", building: "solarPlant", level: lvl, goalId: id };
    }
    if (id.startsWith("opt-energyTech-L")) {
      // research 是 global, 不绑 planet
      return { kind: "research", tech: "energyTech", level: lvl, goalId: id };
    }
  }
  return null;
}

export function planGoal(
  goal: Goal,
  state: WorldState,
  /** v0.0.938 — owner 直传 active goals 进 planner, picker 路径读 opt-* */
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
): PlanResult {
  switch (goal.type) {
    case "research":
      return planResearchGoal(goal, state, activeRows);
    case "build":
      return planBuildGoal(goal, state, activeRows);
    case "build_ships":
      return planBuildShipsGoal(goal, state, activeRows);
    case "expedition":
      return planExpeditionGoal(goal, state);
    case "colonize":
      return planColonizeGoal(goal, state, activeRows);
    case "deploy":
    case "transport":
      return planFleetSendGoal(goal, state);
    case "lifeform_building":
      return planLifeformBuildingGoal(goal, state, activeRows);
    case "lifeform_research":
      return planLifeformResearchGoal(goal, state);
    case "species_discovery":
      return planSpeciesDiscoveryGoal(goal, state);
    case "jumpgate":
      return planJumpgateGoal(goal, state);
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

  // Operator 2026-05-28: "sidecar planner 加 expedition > discover 优先级".
  // Sort-priority alone (compareRows: expedition=10 > discover=5) only
  // orders dispatch within a tick; slot competition happens at ApiExec
  // POST time which is async. To truly let expedition win the fleet-slot
  // race, the discover gate must RESERVE enough fleet slots for every
  // expedition slot ogame still has room for, plus 1 for emergency FS.
  //
  // Reserve = freeExpSlots + 1
  //   - freeExpSlots: how many expedition fleets ogame would still accept
  //   - +1: emergency FS save (FSM bypass still works regardless, but
  //         leaving headroom avoids 140043 on FS save burst)
  const server = (state.server ?? {}) as {
    used_fleet_slots?: number; max_fleet_slots?: number;
    used_expedition_slots?: number; max_expedition_slots?: number;
  };
  const used = server.used_fleet_slots ?? 0;
  const max = server.max_fleet_slots ?? 0;
  const usedExp = server.used_expedition_slots ?? 0;
  const maxExp = server.max_expedition_slots ?? 0;
  const freeExpSlots = Math.max(0, maxExp - usedExp);
  const reserveForExp = freeExpSlots + 1; // +1 emergency FS
  if (max > 0 && used >= max - reserveForExp) {
    return { blocked: `species_discovery: reserve ${reserveForExp} fleet slot(s) for expedition+emergency (used=${used} max=${max} freeExp=${freeExpSlots})` };
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
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: "discover",
    // goal_id MUST be at top level (per Directive type + sidecar handlers
    // that read d.goal_id directly). Earlier version placed it in params
    // which is silently ignored by directiveToGoal mapping + optimistic
    // completed[] update → planner kept selecting same coord 50+ times.
    goal_id: goal.id,
    params: {
      planet_id: planetId,
      galaxy,
      system: nextSystem,
      position: nextPosition,
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
// Phase 10 (v0.0.785) — POPULATION_FOOD_BY_SPECIES + needsFoodCascade 抽到
// shared helper. planner 跟 simulate 同源 (operator memory SOP).
import { needsFoodCascade } from "./lifeform_balance.js";

function planLifeformBuildingGoal(
  goal: Goal,
  state: WorldState,
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
): PlanResult {
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

  // Phase 11+ (v0.0.785) — fields_full hard-block 路径之前只 cover regular
  // building (index.ts markFieldsFull on 120012 ack); planner
  // 这侧 planBuildGoal 有 isFieldsFull check 防 retry spam, 但
  // planLifeformBuildingGoal 漏了 → antimatterCondenser L49 120012 一直
  // retry (operator 33653036 evidence 21:01-21:07 三次 dispatch). 修对齐.
  // v0.0.862 — uid threaded via ALS (priorityMerger.dispatch's runWithUser).
  if (isFieldsFull(getCurrentUserId() ?? "", planet.id, building)) {
    return { blocked: `fields_full hard-block on ${planet.id}:${building} (24h backoff)` };
  }

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
  if (lfBuildQ && lfBuildQ.building === building && (lfBuildQ.ends_at ?? 0) > Date.now()) {
    return { blocked: `${building} already in lf_build_q (ends ${new Date(lfBuildQ.ends_at!).toISOString()})` };
  }
  // v0.0.978 — owner 2026-06-08 "LF 还没动静": planner 老代码也 block 任何
  // regular build_q 占用 → LF dispatch 被卡. 但 memory feedback_one_build_goal_per_planet
  // 真态: ogame 有 4 独立槽位 (常规 build / LF build / shipyard / global research),
  // LF 不应被 regular build_q 阻挡. 删 regular build_q gate, 仅保留 LF queue gate.
  // v0.0.979 robotics/nanite gate → v0.0.980 owner 2026-06-08 "取消约束".
  // 因为长任务 (e.g. naniteFactory L7) 会全程锁死 LF dispatch — 接受不了.
  // 现 LF 不 care regular build_q, 完全 parallel 跑.

  // Population/Food balance — auto-build food when housing grows (sanctuary
  // → antimatterCondenser for kaelesh; residentialSector etc → biosphereFarm
  // for humans). 抽 needsFoodCascade helper (Phase 10), 跟 simulate 同源.
  const lfr2 = (planet as { lifeform_resources?: { living_space?: number | null; well_fed?: number | null } }).lifeform_resources;
  const foodCheck = needsFoodCascade(building, species, lfBldg, lfr2, current, level);
  if (foodCheck) {
    const subGoal: Goal = { ...goal, target: { building: foodCheck.rule.food, level: foodCheck.currentFoodLevel + 1, planet: planet.id } } as Goal;
    return planLifeformBuildingGoal(subGoal, state);
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
      const sM = Math.max(0, lfCost.m - r.m), sC = Math.max(0, lfCost.c - r.c), sD = Math.max(0, lfCost.d - r.d);
      if (isPostExpeditionPhase(state)) {
        return { blocked: `waiting for resources (m=${sM} c=${sC} d=${sD} short)` };
      }
      // Pre-phase: try storage upgrade first
      const storUp = pickStorageUpgrade(planet, { m: sM, c: sC, d: sD }, state.server?.speed ?? 1);
      if (storUp) {
        const curLvl = planet.buildings?.[storUp] ?? 0;
        const elevatedRoot = { ...goal, priority: Math.min(10, (typeof goal.priority === "number" ? goal.priority : 5) + 3) } as Goal;
        const ctx: PlanCtx = { state, rootGoal: elevatedRoot, depth: 0, sourcePlanetId: planet.id, activeRows };
        return planBuild(storUp, curLvl + 1, planet.id, ctx);
      }
      // Else: production-rate wait ETA in reason
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      // v0.0.726 — operator 2026-06-03 "建造 重氫合成器 32 时间评估错误 实际
      // 时间是27分钟" (panel showed 11h12m ≈ 24× over). Root cause: 服务器
      // 经济倍率没乘进 wait formula. ogame's prod field is base per-second
      // before universe economy speed (server.speed, typically 1-10). Real
      // hourly rate = prod * 3600 * server.speed. Skipping server.speed
      // makes wait ETA scale with reciprocal of speed (speed=8 → wait 8×
      // too high; combined with bonus drift → operator's observed 24×).
      const econSpeed = state.server?.speed ?? 1;
      const tM = (prod.m_h ?? 0) > 0 ? sM / ((prod.m_h ?? 1) * econSpeed) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / ((prod.c_h ?? 1) * econSpeed) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / ((prod.d_h ?? 1) * econSpeed) * 3600 : (sD > 0 ? 999999 : 0);
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
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: "build",
    params: { building, technology_id: techId, target_level: current + 1, planet_id: planet.id },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `lifeform build ${building} L${current + 1} on ${planet.coords?.join(":") ?? planet.id}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// lifeform_research (v0.0.602 — operator 2026-06-01)
// ────────────────────────────────────────────────────────────────────────────

function planLifeformResearchGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as { tech?: string; level?: number; planet?: string };
  const tech = typeof target.tech === "string" ? target.tech : "";
  const level = typeof target.level === "number" ? target.level : 0;
  if (!tech) return { blocked: "lifeform_research goal missing target.tech" };
  if (level <= 0) return { blocked: "lifeform_research goal needs target.level > 0" };
  const planet = resolvePlanet(target.planet ?? goal.planet, state) ?? Object.values(state.planets ?? {})[0];
  if (!planet) return { blocked: "lifeform_research: no planet" };
  const species = ((planet.lifeform as { species?: string } | null)?.species ?? "humans") as keyof typeof LIFEFORM_TECH;
  const catalog = LIFEFORM_TECH[species];
  if (!catalog) return { blocked: `lifeform_research: unknown species ${species}` };
  const entry = catalog.research[tech];
  if (!entry) return { blocked: `lifeform_research: ${tech} not in ${species} catalog` };
  // Current level lookup — ogame stores lifeform research per-planet too,
  // but our extractor doesn't surface it yet (TODO: add lifeform_research
  // field to planet state). For now compare against 0 → always allow up to
  // target. ApiExec will dispatch via lfresearch component endpoint; if
  // already at target ogame returns no-op + ack.
  const lfResearch = (planet as { lifeform_research?: Record<string, number> }).lifeform_research ?? {};
  const current = lfResearch[tech] ?? 0;
  if (current >= level) {
    return { blocked: `lifeform_research: already at or above target — ${tech} L${current} ≥ ${level}` };
  }
  // Output directive — ApiExec dispatch handles via lfresearch component.
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: "lifeform_research",
    params: {
      planet_id: planet.id,
      tech,
      level: current + 1,
      species,
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `lifeform research ${tech} L${current + 1} on ${planet.coords?.join(":") ?? planet.id} (${species})`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// research
// ────────────────────────────────────────────────────────────────────────────

function planResearchGoal(
  goal: Goal,
  state: WorldState,
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
): PlanResult {
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

  // v0.0.896 — owner 2026-06-07 "research:energyTech rejected 100001" 实证:
  // ogame 研究队列是 GLOBAL 1 个, 我方 combustion 在跑 cascade 还 emit
  // energyTech → ogame 全局拒. state.research.queue 实际有数 (PG 验过),
  // 之前 planResearch 只 gate researchLab building 升级, 漏 research queue
  // 本身 — 11 轮一直在 spam 100001.
  const rq = ctx.state.research?.queue;
  if (rq && (rq.ends_at ?? 0) > Date.now()) {
    const etaS = Math.max(0, Math.round(((rq.ends_at ?? 0) - Date.now()) / 1000));
    if (rq.tech === tech) {
      return { blocked: `${tech} already in ogame research queue (~${etaS}s) — wait for completion` };
    }
    return { blocked: `research queue busy: ${rq.tech} ~${etaS}s — global queue, ogame allows 1 research at a time` };
  }

  // v0.0.789 — owner directive "研究的时候可以继续建筑除了研究所" 反向: 任何
  // 星球 researchLab 正在升级时, research 不能 dispatch (ogame 拒 120024
  // "研究正在開展中" 的对称). 扫所有 planets 看 build_q.building==researchLab.
  for (const p of Object.values(ctx.state.planets ?? {})) {
    const bq = (p as { build_q?: { building?: string; ends_at?: number } | null }).build_q;
    if (bq && bq.building === "researchLab" && (bq.ends_at ?? 0) > Date.now()) {
      const etaS = Math.max(0, Math.round(((bq.ends_at ?? 0) - Date.now()) / 1000));
      return { blocked: `research blocked — researchLab upgrading on ${p.id} (~${etaS}s)` };
    }
  }

  const nextLevel = current + 1;

  for (const [reqTech, reqLevel] of Object.entries(entry.requires)) {
    const reqEntry = TECH_TREE[reqTech];
    if (!reqEntry) {
      return { blocked: `unknown prereq tech: ${reqTech} (required by ${tech})` };
    }
    if (reqEntry.kind === "building") {
      // v0.0.456: research's building prereqs (researchLab, etc.) are
      // network-wide — operator rule "星球上的研究所有效，月球不需要建研究所".
      // Scan all planets, pick the highest level. If sourcePlanetId is a moon
      // and the building is planet-only, the moon lookup would be 0 → planner
      // tries to build planet-only on moon → blocked by planet-only gate.
      // Fix: use highest-level planet for both the level check and the upgrade
      // target. Buildings allowed on moons (rare for research prereqs) still
      // fall through to the global scan since planet-network is the canonical
      // truth for research requirements.
      let bestPlanetId = ctx.sourcePlanetId;
      let actual = 0;
      for (const p of Object.values(ctx.state.planets ?? {})) {
        if (p.type !== "planet") continue;
        const lvl = p.buildings?.[reqTech] ?? 0;
        if (lvl > actual) { actual = lvl; bestPlanetId = p.id; }
      }
      if (actual < reqLevel) {
        return planBuild(reqTech, reqLevel, bestPlanetId, { ...ctx, depth: ctx.depth + 1, sourcePlanetId: bestPlanetId });
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

  // v0.0.824 — operator 2026-06-06 "殖民任务执行过程中存储罐满了, 有没有处理".
  // 真因: colo → astro cascade → espionageTech L4, planResearch 直接 emit 不查
  // 资源. crystalStorage L1 cap ~12K, mine 满了停产, sidecar 缓存的 resources
  // 比 ogame 真实多 → affordable=true 但 ogame 拒 120017 "Insufficient Crystal"
  // 反复 60s 重派.
  // 跟 planBuild 1040 / planBuildShips 1156 / planLifeformBuild 588 对称兜底,
  // 并加一道 proactive storage gate: research lab 所在星球任意一种资源 ≥ 95% cap
  // → 优先升 storage (即便看似 affordable, sidecar resources 可能 stale).
  // lab 用 sourcePlanetId 上的 resources (research 在主科研星算).
  const labPlanet = Object.values(ctx.state.planets ?? {}).find((p) => p.id === ctx.sourcePlanetId);
  if (labPlanet) {
    const proactive = pickStorageUpgrade(labPlanet, { m: 1, c: 1, d: 1 }, ctx.state.server?.speed ?? 1);
    if (proactive) {
      const curLvl = labPlanet.buildings?.[proactive] ?? 0;
      const elevatedRoot = { ...ctx.rootGoal, priority: Math.min(10, (typeof ctx.rootGoal.priority === "number" ? ctx.rootGoal.priority : 5) + 3) } as Goal;
      return planBuild(proactive, curLvl + 1, labPlanet.id, { ...ctx, rootGoal: elevatedRoot, depth: ctx.depth + 1 });
    }
  }
  const costFnR = entry.cost_at as ((l: number) => { m: number; c: number; d?: number; e?: number }) | undefined;
  if (labPlanet && costFnR) {
    const rawCost = costFnR(nextLevel);
    const rCost = { m: rawCost.m, c: rawCost.c, d: rawCost.d ?? 0 };
    const r = labPlanet.resources ?? { m: 0, c: 0, d: 0 };
    const affordable = r.m >= rCost.m && r.c >= rCost.c && r.d >= rCost.d;
    if (!affordable) {
      const sM = Math.max(0, rCost.m - r.m), sC = Math.max(0, rCost.c - r.c), sD = Math.max(0, rCost.d - r.d);
      if (isPostExpeditionPhase(ctx.state)) {
        return { blocked: `waiting for resources (m=${sM} c=${sC} d=${sD} short)` };
      }
      const storUp = pickStorageUpgrade(labPlanet, { m: sM, c: sC, d: sD }, ctx.state.server?.speed ?? 1);
      if (storUp) {
        const curLvl = labPlanet.buildings?.[storUp] ?? 0;
        const elevatedRoot = { ...ctx.rootGoal, priority: Math.min(10, (typeof ctx.rootGoal.priority === "number" ? ctx.rootGoal.priority : 5) + 3) } as Goal;
        return planBuild(storUp, curLvl + 1, labPlanet.id, { ...ctx, rootGoal: elevatedRoot, depth: ctx.depth + 1 });
      }
      const prod = labPlanet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      const econSpeed = ctx.state.server?.speed ?? 1;
      const tM = (prod.m_h ?? 0) > 0 ? sM / ((prod.m_h ?? 1) * econSpeed) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / ((prod.c_h ?? 1) * econSpeed) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / ((prod.d_h ?? 1) * econSpeed) * 3600 : (sD > 0 ? 999999 : 0);
      const wait = Math.round(Math.max(tM, tC, tD));
      return { blocked: `waiting ${wait}s for resources (m=${sM} c=${sC} d=${sD} short)` };
    }
  }

  return makeResearchDirective(tech, nextLevel, ctx);
}

function makeResearchDirective(tech: string, nextLevel: number, ctx: PlanCtx): Directive {
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: typeof ctx.rootGoal.priority === "number" ? ctx.rootGoal.priority : 5,
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

function planBuildGoal(
  goal: Goal,
  state: WorldState,
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
): PlanResult {
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

  let planet = resolvePlanet(planetRef, state);
  if (!planet) return { blocked: `planet not found: ${planetRef}` };
  // v0.0.470: moon-only building disambiguation (operator 2026-05-30
  // "build jumpgate 2 ↳ moon-only building jumpgate cannot be built on
  // planet"). When the goal targets a moon-only building (lunarBase,
  // sensorPhalanx, jumpgate) but resolvePlanet picked the same-coord
  // planet (due to ambiguous coord ref), auto-switch to the moon. Without
  // this, the planet-only gate downstream would block forever even though
  // the same coord has a perfectly valid moon for the build.
  if (MOON_ONLY_BUILDINGS.has(building) && planet.type !== "moon") {
    const coord = planet.coords?.join(":");
    if (coord) {
      const moonAtCoord = Object.values(state.planets ?? {})
        .find((p) => p.type === "moon" && p.coords?.join(":") === coord);
      if (moonAtCoord) planet = moonAtCoord;
    }
  }

  const ctx: PlanCtx = {
    state,
    rootGoal: goal,
    depth: 0,
    sourcePlanetId: planet.id,
    activeRows,
  };

  return planBuild(building, level, planet.id, ctx);
}

function planBuild(building: string, targetLevel: number, planetId: string, ctx: PlanCtx): PlanResult {
  if (ctx.depth > MAX_RECURSION_DEPTH) {
    return { blocked: `recursion depth exceeded while planning build ${building}` };
  }
  // v0.0.453: alias map — operator types common alternative names.
  // moonBase → lunarBase, moon_base → lunarBase, lunar_base → lunarBase.
  const BUILDING_ALIASES: Record<string, string> = {
    moonBase: "lunarBase",
    moon_base: "lunarBase",
    lunar_base: "lunarBase",
    sensor_phalanx: "sensorPhalanx",
    sensorphalanx: "sensorPhalanx",
    jump_gate: "jumpgate",
  };
  const canonical = BUILDING_ALIASES[building] ?? BUILDING_ALIASES[building.toLowerCase()] ?? building;
  const entry = TECH_TREE[canonical];
  if (!entry) return { blocked: `unknown tech: ${building}` };
  building = canonical;
  if (entry.kind !== "building") {
    return { blocked: `tech ${building} is not a building (kind=${entry.kind})` };
  }

  const planet = Object.values(ctx.state.planets ?? {}).find((p) => p.id === planetId);
  if (!planet) return { blocked: `planet not found: ${planetId}` };

  // v0.0.1009 → v0.0.1013 → v0.0.1014 — owner 2026-06-09 "current e 这个没用了
  // 就删掉吧": delta >= 0 时 projected = current - delta ≤ current, 所以
  // current<0 必然 projected<0, `current<0` 是 `projected<0` 的子集. 删冗余.
  // 顶层逻辑: 只看预测 E (forward-projected post-build). 任何 building 类 (mine
  // 有 delta, 非 mine delta=0) 都走同一公式.
  const isEnergyFixPath = building === "solarPlant" || building === "fusionReactor";
  const isMineForEnergy = building === "metalMine" || building === "crystalMine" || building === "deuteriumSynth";
  const curLvlForE = (planet.buildings as Record<string, number> | undefined)?.[building] ?? 0;
  const deltaE = isMineForEnergy ? mineEnergyConsumption(building, targetLevel) - mineEnergyConsumption(building, curLvlForE) : 0;
  const projectedE = ((planet.resources as { e?: number } | undefined)?.e ?? 0) - deltaE;
  if (!isEnergyFixPath && projectedE < 0) {
    return { blocked: `energy gate (projected=${Math.round(projectedE)}, delta=${Math.round(deltaE)}) — ${building} L${targetLevel} blocked, energy fix has priority (build solar/fusion first)` };
  }

  // v0.0.455: planet-only gate — reject up-front if the goal asks for a
  // building that physically can't exist on a moon. Catches optimizer
  // mistakes like naniteFactory L7 on a moon (operator hit this 2026-05-29,
  // goal stuck active forever). Whitelist is MOON_ALLOWED_BUILDINGS.
  if (planet.type === "moon" && !MOON_ALLOWED_BUILDINGS.has(building)) {
    return {
      blocked: `planet-only building ${building} cannot be built on moon (${planet.id}); allowed on moon: ${Array.from(MOON_ALLOWED_BUILDINGS).join(", ")}`,
    };
  }

  // v0.0.456: moon-only gate (reverse direction) — reject up-front if the goal
  // asks for a moon-only building (lunarBase / sensorPhalanx / jumpgate) on a
  // planet body. Operator 2026-05-29 evidence: `lunarBase L1 planet_id=33637366
  // → error 100001 "未知的錯誤"`. Suggest the matching moon's id in the
  // blocked reason so the optimizer or operator can re-target cleanly.
  if (planet.type === "planet" && MOON_ONLY_BUILDINGS.has(building)) {
    const coord = planet.coords?.join(":") ?? "?";
    const matchingMoon = Object.values(ctx.state.planets ?? {})
      .find((p) => p.type === "moon" && p.coords?.join(":") === coord);
    const moonHint = matchingMoon
      ? ` — re-target to moon at same coord (id=${matchingMoon.id})`
      : ` — no moon found at ${coord}, build a moon first`;
    return {
      blocked: `moon-only building ${building} cannot be built on planet (${planet.id} @ ${coord})${moonHint}`,
    };
  }

  // v0.0.694 — operator 2026-06-03 "主任务已经做完成，怎么还有后续任务".
  // FIRST check whether goal target is already met. moon jumpgate L2 already
  // achieved → goal terminal → NO moon-fields recursion needed.
  const current = planet.buildings?.[building] ?? 0;
  if (current >= targetLevel) {
    return {
      blocked: `already at or above target level (${current} >= ${targetLevel}) for ${building} on ${planetId}`,
    };
  }

  // v0.0.452: moon-fields gate. Operator 2026-05-29 rule "月球只剩一个
  // 空间的时候必须先造月球基地,再建其他建筑". When the target body is
  // a moon and the requested building is NOT lunarBase, check whether
  // remaining fields ≤ 1; if so, AUTO-RECURSE into lunarBase upgrade as
  // a prereq (operator 2026-05-29 "按照最优解走就好了，最终目标只有一
  // 个"). v0.0.468: instead of returning blocked, emit a planBuild
  // directive for lunarBase L+1 so the single user goal drives its own
  // fields-expansion prereqs across multiple dispatch ticks — no need for
  // operator to manually create separate lunarBase goals.
  // v0.0.694 — moved BELOW the "already at target" gate so completed
  // moon goals don't trigger spurious lunarBase recursion.
  if (planet.type === "moon" && building !== "lunarBase") {
    const b = (planet.buildings as Record<string, number | undefined>) ?? {};
    let usedFields = 0;
    for (const name of MOON_ALLOWED_BUILDINGS) usedFields += (b[name] ?? 0);
    const lunarBaseLevel = b["lunarBase"] ?? 0;
    const maxFields = 1 + 3 * lunarBaseLevel;
    const free = maxFields - usedFields;
    if (free <= 1) {
      return planBuild("lunarBase", lunarBaseLevel + 1, planetId, { ...ctx, depth: ctx.depth + 1 });
    }
  }

  // v0.0.789 — owner directive 2026-06-05 "建筑串行建设, 研究的时候可以
  // 继续建筑除了研究所". ogame planet 同一时刻只跑 1 个 build queue, 任何
  // active build (无论同建筑/不同建筑) 都要 block 第二个 dispatch. Research
  // queue 独立, 不受影响 (planBuild → 不 gate research_q except researchLab).
  // 历史 v0.0.* line 923 用 `buildQ.item` 是死字段 (实际数据用 `building`,
  // shared/types.ts 同步修过), gate 永远 false → 100001 反复事故.
  // v0.0.1008 — owner 2026-06-09 "为啥又在造机器人工厂": state.snapshot lag
  // 让 planner 在同一 (planet,building) 60s 内 cascade re-dispatch 多次. 加
  // recent-dispatch gate: 如果同 (planet,building) 30s 内派过, 强制 blocked
  // 等 state 同步. 60s 后自动放行 (build ack/snapshot 应已到位).
  const uidForRecent = getCurrentUserId() ?? "";
  const recentKey = `${planetId}:${building}`;
  const recentTs = tenantRegistry.get(uidForRecent).recentBuildDispatchAt.get(recentKey) ?? 0;
  if (recentTs > 0 && Date.now() - recentTs < 30_000) {
    const ageSec = Math.round((Date.now() - recentTs) / 1000);
    return { blocked: `${building} dispatched ${ageSec}s ago on ${planetId} — waiting for state.snapshot to reflect (30s cooldown)` };
  }

  const buildQ = planet.build_q;
  if (buildQ && (buildQ.ends_at ?? 0) > Date.now()) {
    const etaS = Math.max(0, Math.round(((buildQ.ends_at ?? 0) - Date.now()) / 1000));
    if (buildQ.building === building) {
      // v0.0.933 — owner 2026-06-07 "纳米7 任务也被删掉了". 旧 emit "already
      // upgrading" 文案匹配 priority_merger ALREADY_AT_TARGET_RE → 错误
      // mark completed, **不区分 buildQ.level 是否 ≥ targetLevel**. 例:
      // 33674107 nano target=7, current=3, buildQ=building L4 → 旧逻辑当
      // 完成 mark goal completed, 而真态只到 L4 还差 3 级.
      // 修: 只有当 buildQ.level >= targetLevel 时才用 "already upgrading"
      // (会自动 complete 是 by-design), 否则用 "queue busy" 文案不匹配 regex
      // → 单纯 blocked 等本 level 完成, 下次 tick 真 dispatch 下个 level.
      const bqLvl = buildQ.level ?? 0;
      if (bqLvl >= targetLevel) {
        return { blocked: `${building} already upgrading in ogame queue on ${planetId} (~${etaS}s)` };
      }
      return { blocked: `${building} L${bqLvl} in ogame queue on ${planetId} (~${etaS}s) — wait then dispatch next level (target L${targetLevel})` };
    }
    return { blocked: `planet ${planetId} build queue busy: ${buildQ.building} (~${etaS}s) — building serial` };
  }

  // researchLab is a facility that affects research speed network-wide.
  // ogame rejects researchLab upgrade with error 120024 ("目前研究正在開展中"
  // / "research in progress") when ANY research is currently running on
  // any planet — the queue is global, not per-planet. Gate the dispatch
  // until the active research finishes, otherwise we burn a directive
  // round-trip and a goal gets parked "blocked" until manual resume.
  // Operator incident 2026-06-02: build researchLab 15 vs intergalactic L9
  // research → endless retry until intergalactic finished.
  if (building === "researchLab") {
    const rq = ctx.state.research?.queue;
    if (rq && (rq.ends_at ?? 0) > Date.now()) {
      const etaS = Math.max(0, Math.round((rq.ends_at - Date.now()) / 1000));
      return { blocked: `researchLab needs idle research — ${rq.tech} L${rq.level} still running (~${etaS}s)` };
    }
  }

  const nextLevel = current + 1;

  // Energy gate: mines need positive net energy. v0.0.675 — operator
  // 2026-06-03 拍板两条：
  //   (1) 预判: 当前 energy - 升级后多消耗的 energy < 0 → 先建电厂
  //   (2) 太阳能 vs 核融合二选一: 算法在 pickEnergyPrereqBuilding 共享
  //       helper, planner 跟 simulate() prereq-tree builder 都复用。
  // v0.0.737 — operator 2026-06-04 "不要重复写代码, 复用". Algorithm
  // body lives in pickEnergyPrereqBuilding (above). Affordability check
  // stays here because planBuild's recursion decision depends on it.
  const energyPick = pickEnergyPrereqBuilding(
    building,
    current,
    nextLevel,
    planet,
    ctx.state.research?.levels?.["energyTech"] ?? 0,
    ctx.activeRows,
    getCurrentUserId() ?? "",
  );
  if (energyPick) {
    // v0.0.913 — energyPick is now discriminated union (build | research).
    // research path: dispatch via planResearch; afford handled inside it
    // (research costs c+d only, no m). build path: existing afford logic.
    const pickTechKey = energyPick.kind === "build" ? energyPick.building : energyPick.tech;
    const pickCostFn = TECH_TREE[pickTechKey]?.cost_at as
      | ((l: number) => { m: number; c: number; d?: number })
      | undefined;
    const pickCost = pickCostFn ? pickCostFn(energyPick.level) : { m: 0, c: 0, d: 0 };
    const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
    const pickAffordable =
      r.m >= pickCost.m &&
      r.c >= pickCost.c &&
      r.d >= (pickCost.d ?? 0);
    if (pickAffordable) {
      const bumped = Math.min(10, (typeof ctx.rootGoal.priority === "number" ? ctx.rootGoal.priority : 5) + 5);
      const elevCtx: PlanCtx = {
        ...ctx,
        depth: ctx.depth + 1,
        rootGoal: { ...ctx.rootGoal, priority: bumped },
      };
      if (energyPick.kind === "build") {
        return planBuild(energyPick.building, energyPick.level, planetId, elevCtx);
      }
      return planResearch(energyPick.tech, energyPick.level, elevCtx);
    }
    // v0.0.826 — solarPlant 不 afford 时, mine 也禁止 dispatch. block 带 deficit
    // 让 owner 看见, 等 resources 自然回流后 plant afford 再走.
    const sM = Math.max(0, pickCost.m - r.m);
    const sC = Math.max(0, pickCost.c - r.c);
    const sD = Math.max(0, (pickCost.d ?? 0) - r.d);
    // v0.0.849 — afford 不上 m 可能是 cap 满了, 优先 storage upgrade.
    if (!isPostExpeditionPhase(ctx.state)) {
      const storUp = pickStorageUpgrade(planet, { m: sM, c: sC, d: sD }, ctx.state.server?.speed ?? 1);
      if (storUp) {
        const curLvl = planet.buildings?.[storUp] ?? 0;
        return planBuild(storUp, curLvl + 1, planetId, { ...ctx, depth: ctx.depth + 1 });
      }
    }
    const pickLabel = energyPick.kind === "build" ? energyPick.building : energyPick.tech;
    return { blocked: `energy negative — need ${pickLabel} L${energyPick.level} first (short m=${sM} c=${sC} d=${sD})` };
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

  // v0.0.695 — operator 2026-06-03 "等待资源的 先检查资源是否够了，再发api请求，
  // 不够就不用发". Affordability check now applies to ALL buildings (including
  // mines). Previously mines skipped the check entirely → planner emitted
  // directive when short → ogame returned "資源不足" → goal hit backoff_60s.
  const costFn = entry.cost_at as ((l: number) => { m: number; c: number; d?: number; e?: number }) | undefined;
  if (costFn) {
    const rawCost = costFn(nextLevel);
    const buildCost = { m: rawCost.m, c: rawCost.c, d: rawCost.d ?? 0, e: rawCost.e ?? 0 };
    const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
    const affordable = r.m >= buildCost.m && r.c >= buildCost.c && r.d >= buildCost.d;
    if (!affordable) {
      const sM = Math.max(0, buildCost.m - r.m), sC = Math.max(0, buildCost.c - r.c), sD = Math.max(0, buildCost.d - r.d);
      if (isPostExpeditionPhase(ctx.state)) {
        return { blocked: `waiting for resources (m=${sM} c=${sC} d=${sD} short)` };
      }
      // Pre-phase: storage strategy first, then production wait ETA
      const storUp = pickStorageUpgrade(planet, { m: sM, c: sC, d: sD }, ctx.state.server?.speed ?? 1);
      if (storUp) {
        const curLvl = planet.buildings?.[storUp] ?? 0;
        return planBuild(storUp, curLvl + 1, planetId, { ...ctx, depth: ctx.depth + 1 });
      }
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      // v0.0.726 — operator 2026-06-03 "建造 重氫合成器 32 时间评估错误 实际
      // 时间是27分钟" (panel showed 11h12m ≈ 24× over). Root cause: 服务器
      // 经济倍率没乘进 wait formula. ogame's prod field is base per-second
      // before universe economy speed (server.speed, typically 1-10). Real
      // hourly rate = prod * 3600 * server.speed. Skipping server.speed
      // makes wait ETA scale with reciprocal of speed (speed=8 → wait 8×
      // too high; combined with bonus drift → operator's observed 24×).
      const econSpeed = ctx.state.server?.speed ?? 1;
      const tM = (prod.m_h ?? 0) > 0 ? sM / ((prod.m_h ?? 1) * econSpeed) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / ((prod.c_h ?? 1) * econSpeed) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / ((prod.d_h ?? 1) * econSpeed) * 3600 : (sD > 0 ? 999999 : 0);
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
    priority: typeof ctx.rootGoal.priority === "number" ? ctx.rootGoal.priority : 5,
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

function planBuildShipsGoal(
  goal: Goal,
  state: WorldState,
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
): PlanResult {
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

  // v0.0.782 — prereq cascade. Operator 2026-06-05 (daigang 新服 colonyShip
  // 死循环 ogame 100001/"shipyard page missing tech 208"): planColonizeGoal
  // 短路直接 emit build_ships 没人查 shipyard L4 + impulseDrive L3, ogame 必拒.
  // 复用 planBuild/planResearch cascade, 缺啥递归补啥.
  const shipEntry = TECH_TREE[ship];
  if (shipEntry?.requires) {
    const ctx: PlanCtx = {
      state,
      rootGoal: goal,
      depth: 0,
      sourcePlanetId: planet.id,
      activeRows,
    };
    for (const [reqTech, reqLevel] of Object.entries(shipEntry.requires)) {
      const reqEntry = TECH_TREE[reqTech];
      if (!reqEntry) {
        return { blocked: `unknown prereq tech: ${reqTech} (required by ${ship})` };
      }
      if (reqEntry.kind === "building") {
        const actual = planet.buildings?.[reqTech] ?? 0;
        if (actual < reqLevel) {
          return planBuild(reqTech, reqLevel, planet.id, { ...ctx, depth: ctx.depth + 1 });
        }
      } else if (reqEntry.kind === "research") {
        const actual = state.research.levels[reqTech] ?? 0;
        if (actual < reqLevel) {
          return planResearch(reqTech, reqLevel, { ...ctx, depth: ctx.depth + 1 });
        }
      } else {
        return { blocked: `unsupported prereq kind ${reqEntry.kind} for ${reqTech} (required by ${ship})` };
      }
    }
  }

  // v0.0.897 — owner 2026-06-07 "10个大运可以一个一个造不要一起造，资源够
  // 一个就造一个". 旧逻辑 totalCost = cost × amount 一次性算全量, 不够就
  // block. 改: 算单艘 cost, 算 max_affordable = min(amount, floor(资源/cost)),
  // ≥1 就 dispatch amount=max_affordable, 不够 1 才 block. 造船+造防御同
  // 颗粒度. Owner: "资源够一个就造一个", 不再等齐全。
  const cost = shipEntry?.cost_at ? shipEntry.cost_at(1) : null;
  let dispatchAmount = amount;
  if (cost) {
    const r = planet.resources ?? { m: 0, c: 0, d: 0, e: 0 };
    // 单艘 affordable check
    const oneShipOk = r.m >= cost.m && r.c >= cost.c && r.d >= cost.d;
    if (!oneShipOk) {
      const sM = Math.max(0, cost.m - r.m), sC = Math.max(0, cost.c - r.c), sD = Math.max(0, cost.d - r.d);
      if (isPostExpeditionPhase(state)) {
        return { blocked: `waiting for resources (m=${sM} c=${sC} d=${sD} short for 1 ${ship})` };
      }
      const storUp = pickStorageUpgrade(planet, { m: sM, c: sC, d: sD }, state.server?.speed ?? 1);
      if (storUp) {
        const curLvl = (planet.buildings as Record<string, number>)[storUp] ?? 0;
        const elevatedRoot = { ...goal, priority: Math.min(10, (typeof goal.priority === "number" ? goal.priority : 5) + 3) } as Goal;
        const ctx: PlanCtx = { state, rootGoal: elevatedRoot, depth: 0, sourcePlanetId: planet.id, activeRows };
        return planBuild(storUp, curLvl + 1, planet.id, ctx);
      }
      const prod = planet.production ?? { m_h: 0, c_h: 0, d_h: 0 };
      const econSpeed = state.server?.speed ?? 1;
      const tM = (prod.m_h ?? 0) > 0 ? sM / ((prod.m_h ?? 1) * econSpeed) * 3600 : (sM > 0 ? 999999 : 0);
      const tC = (prod.c_h ?? 0) > 0 ? sC / ((prod.c_h ?? 1) * econSpeed) * 3600 : (sC > 0 ? 999999 : 0);
      const tD = (prod.d_h ?? 0) > 0 ? sD / ((prod.d_h ?? 1) * econSpeed) * 3600 : (sD > 0 ? 999999 : 0);
      const wait = Math.round(Math.max(tM, tC, tD));
      return { blocked: `waiting ${wait}s for resources (m=${sM} c=${sC} d=${sD} short for 1 ${ship})` };
    }
    // 单艘够 → 看资源最多能造几艘, 上限 = goal.target.amount
    const affordM = cost.m > 0 ? Math.floor(r.m / cost.m) : amount;
    const affordC = cost.c > 0 ? Math.floor(r.c / cost.c) : amount;
    const affordD = cost.d > 0 ? Math.floor(r.d / cost.d) : amount;
    const maxAffordable = Math.min(affordM, affordC, affordD);
    dispatchAmount = Math.max(1, Math.min(amount, maxAffordable));
  }

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: "build_ships",
    params: {
      ship,
      amount: dispatchAmount,
      planet_id: planet.id,
      technology_id: nameToId(ship),
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `build ${dispatchAmount}/${amount}× ${ship} on ${planet.id}`,
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
  };
  const sourcePlanetRaw = typeof target.source_planet === "string" ? target.source_planet : undefined;
  const planet =
    resolvePlanet(sourcePlanetRaw, state) ??
    resolvePlanet(goal.planet, state) ??
    Object.values(state.planets ?? {})[0];
  if (!planet) return { blocked: "expedition goal: no planets available" };

  const ships = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  const targetPosition = typeof target.target_position === "number" ? target.target_position : 16;

  const sourceCoordsKey = planet.coords.join(":");
  // No "1 expedition per planet" block — owner runs multiple parallel
  // expeditions up to ogame's slot cap (max=4 for explorer). Slot
  // capacity check happens at the daemon level (bridge expeditionTick).
  // Each exp- goal here = one launch attempt regardless of how many
  // fleets are already outbound. ogame will reject 140019 if cap full.

  // v0.0.1006 — owner 2026-06-09 "远征没有足够的船也派出去了": planner
  // 老代码 expedition 路径**完全没有 ship-availability 检查**, deploy/transport
  // (planner.ts:1823) 早就有同款 `have < want → blocked`. 一份代码两套标准,
  // daemon snapshot 跟实际 ogame 状态有 lag 时漏拦. 拉通: planner 在 expedition
  // dispatch 前也做 ship 检查, 不够就 blocked, 让 daemon 下 tick 重 emit / 等
  // ships 回港.
  const planetShipsMap = (planet.ships as Record<string, number | undefined>) ?? {};
  for (const [shipKey, want] of Object.entries(ships)) {
    if (typeof want !== "number" || want <= 0) continue;
    const have = planetShipsMap[shipKey] ?? 0;
    if (have < want) {
      return {
        blocked: `expedition blocked: ${planet.id} has ${have}× ${shipKey}, need ${want} (preflight on dispatch)`,
      };
    }
  }

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: "expedition",
    params: {
      planet_id: planet.id,
      source_planet: planet.id,
      source_coords: sourceCoordsKey,
      ships,
      target_position: targetPosition,
      mission: MISSION_EXPEDITION,
    },
    preconds: [],
    // Operator 2026-05-27: "也不要有 ttl". Expedition directive must never
    // expire — fleet returns asynchronously and may sit cross-boundary;
    // expiring leads to silent miss + slot underuse.
    expires_at: Number.MAX_SAFE_INTEGER,
    reason: `expedition from ${sourceCoordsKey} → pos ${targetPosition}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// colonize
// ────────────────────────────────────────────────────────────────────────────

function planColonizeGoal(
  goal: Goal,
  state: WorldState,
  activeRows?: readonly { goal: { id: string; planet?: string; target: unknown; type: string }; status: string }[],
): PlanResult {
  const target = goal.target as {
    target_coords?: unknown;
    source_planet?: unknown;
    // v0.0.689 — range-scan shape (operator 2026-06-03 "舰船任务改成殖民任务"):
    galaxy_min?: unknown; galaxy_max?: unknown;
    system_min?: unknown; system_max?: unknown;
    position_min?: unknown; position_max?: unknown;
  };
  const targetCoords = typeof target.target_coords === "string" ? target.target_coords : "";
  const hasRange =
    typeof target.galaxy_min === "number" && typeof target.galaxy_max === "number" &&
    typeof target.system_min === "number" && typeof target.system_max === "number" &&
    typeof target.position_min === "number" && typeof target.position_max === "number";
  if (!targetCoords && !hasRange) {
    return { blocked: "colonize goal missing target.target_coords or range" };
  }

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

  // v0.0.786 → v0.0.793 — astrophysics gate. ogame v12 真公式 (operator
  // 2026-06-05 paste table 实证):
  //   max_total_planets = floor((astro_level + 1) / 2) + 1
  // L=0 → 1, L=1 → 2, L=2 → 2, L=3 → 3, L=4 → 3, L=5 → 4, ...
  // 之前 v0.0.786 用 `floor(astro/2)+1` 差 1 级; target 用 `owned*2` overkill
  // 2 倍 (owned=1 应 L=1, 实际开 L=2). 修: target = 2*owned-1 让
  // maxPlanetsAt(target) 严格 > owned. moon 不算殖民地槽.
  const ownedPlanets = Object.values(state.planets ?? {})
    .filter((p) => p.type === "planet").length;
  const astroLevel = state.research?.levels?.["astrophysics"] ?? 0;
  const maxPlanetsAt = (lvl: number): number => Math.floor((lvl + 1) / 2) + 1;
  const maxPlanets = maxPlanetsAt(astroLevel);
  if (ownedPlanets >= maxPlanets) {
    const targetAstro = Math.max(1, 2 * ownedPlanets - 1);
    const virtualGoal: Goal = {
      ...goal,
      type: "research",
      target: { tech: "astrophysics", level: targetAstro },
    } as Goal;
    return planResearchGoal(virtualGoal, state);
  }

  // v0.0.689 — auto-build colonyShip when missing. Operator's flow step 1
  // ("在出发星球建造殖民船") becomes implicit: planner emits build_ships when
  // hangar is empty; next tick re-enters this fn and finds it ready.
  // v0.0.782 — route through planBuildShipsGoal so shipyard/impulseDrive
  // prereq cascade runs (daigang 新服 shipyard=0 死循环修复).
  const colonyShips = sourcePlanet.ships?.colonyShip ?? 0;
  if (colonyShips < 1) {
    const virtualGoal: Goal = {
      ...goal,
      type: "build_ships",
      target: { ship: "colonyShip", amount: 1, planet: sourcePlanet.id },
    } as Goal;
    return planBuildShipsGoal(virtualGoal, state);
  }

  // ColonyShip ready. Emit colonize directive — legacy single-coord or
  // new range-scan (api_executor handles galaxy scan at dispatch time).
  const params: Record<string, unknown> = {
    planet_id: sourcePlanet.id,
    source_planet: sourcePlanet.id,
    mission: MISSION_COLONIZE,
    ships: { colonyShip: 1 } satisfies ShipCount,
  };
  let reason: string;
  if (hasRange) {
    params["range"] = {
      galaxy_min: target.galaxy_min, galaxy_max: target.galaxy_max,
      system_min: target.system_min, system_max: target.system_max,
      position_min: target.position_min, position_max: target.position_max,
    };
    reason = `colonize scan g[${String(target.galaxy_min)}-${String(target.galaxy_max)}] s[${String(target.system_min)}-${String(target.system_max)}] p[${String(target.position_min)}-${String(target.position_max)}] from ${sourcePlanet.id}`;
  } else {
    params["target_coords"] = targetCoords;
    reason = `colonize ${targetCoords} from ${sourcePlanet.id}`;
  }

  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: "colonize",
    params,
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// deploy / transport (mission 4 / 3)
// ────────────────────────────────────────────────────────────────────────────

function planFleetSendGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as {
    target_coords?: unknown;
    target_type?: unknown;     // v0.0.428: "planet" | "moon" | "debris"
    ships?: unknown;
    take_all?: unknown;        // v0.0.* — chain unload leg: sweep source body
    resources?: unknown;
    cargo?: unknown;           // v0.0.428: panel writes `cargo`, accept both
    source_planet?: unknown;
  };
  const targetCoords = typeof target.target_coords === "string" ? target.target_coords : "";
  if (!targetCoords) return { blocked: `${goal.type} goal missing target.target_coords` };
  const targetType = typeof target.target_type === "string" ? target.target_type : "planet";

  // v0.0.* — operator 2026-06-05 "按照参数 空船走JG 带回JG上的其他船". Chain
  // unload leg (source moon → source planet after JG sweep) should ferry
  // whatever is currently on the source body, not just the originally-
  // allocated cargo ships. take_all on a deploy goal substitutes the static
  // ships map with the body's full ship inventory at dispatch time (mirrors
  // the JG take_all helper above). Static ships path stays for fine-grained
  // chains and legacy callers.
  const takeAll = (target as { take_all?: unknown }).take_all === true;
  const staticShips = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  let ships: ShipCount = staticShips;
  // shipsList finalized below after take_all substitution.
  if (!takeAll) {
    const initialList = Object.entries(staticShips).filter(([, n]) => typeof n === "number" && (n as number) > 0);
    if (initialList.length === 0) {
      return { blocked: `${goal.type} goal: ships map is empty` };
    }
  }

  // v0.0.428: panel writes `cargo` (m/c/d); legacy callers use `resources`.
  // Accept either; cargo wins if both present.
  const resources =
    typeof target.cargo === "object" && target.cargo !== null
      ? (target.cargo as { m?: number; c?: number; d?: number })
      : typeof target.resources === "object" && target.resources !== null
        ? (target.resources as { m?: number; c?: number; d?: number })
        : undefined;

  const sourceRaw = typeof target.source_planet === "string" ? target.source_planet : undefined;
  const sourcePlanet =
    resolvePlanet(sourceRaw, state) ??
    resolvePlanet(goal.planet, state) ??
    Object.values(state.planets ?? {})[0];
  if (!sourcePlanet) return { blocked: `${goal.type} goal: no source planet available` };

  // v0.0.* — take_all substitution: pull the body's full live ship inventory
  // at dispatch time. Filter zero counts so the directive payload stays lean.
  // v0.0.926 — owner 2026-06-07 "月球上的舰队小于派出的舰队 等待 不一定是LG
  // 有可能派 SC". 加 per-ship-type 期望比对 — target.ships 是 chain 上游
  // 承诺送来的量 (任意 type), source 上 <expected 任一类 → block 等 upstream.
  if (takeAll) {
    const onBody = (sourcePlanet.ships ?? {}) as Record<string, number | undefined>;
    const expectedShips = (target.ships && typeof target.ships === "object" && !Array.isArray(target.ships))
      ? target.ships as Record<string, number>
      : {};
    for (const [name, expectedN] of Object.entries(expectedShips)) {
      const exp = expectedN as number;
      if (!Number.isFinite(exp) || exp <= 0) continue;
      const have = onBody[name] ?? 0;
      if ((have as number) < exp) {
        return { blocked: `${goal.type} (take_all) waiting upstream: source ${sourcePlanet.id} has ${have}× ${name}, chain expects ≥${exp}` };
      }
    }
    const swept: ShipCount = {} as ShipCount;
    for (const [name, n] of Object.entries(onBody)) {
      if ((n ?? 0) > 0) (swept as Record<string, number>)[name] = n as number;
    }
    if (Object.keys(swept).length === 0) {
      return { blocked: `${goal.type} (take_all) source body ${sourcePlanet.id} has no ships available yet (waiting for upstream ferry)` };
    }
    ships = swept;
  }
  const shipsList = Object.entries(ships).filter(([, n]) => typeof n === "number" && (n as number) > 0);
  if (shipsList.length === 0) {
    return { blocked: `${goal.type} goal: ships map is empty` };
  }

  // v0.0.485 — same-body no-op guard. Operator 2026-05-30: chain Seg 3
  // "to_stop_load" with fromP=moon emitted deploy with source=moon AND
  // target_coords=that moon's coord (moon→self). userscript sendFleet
  // fallback-rewrote source to a planet at OTHER coord, dispatching a
  // duplicate of Seg 2's cargo fleet. Backend backstop: when source body's
  // coord matches target coord AND types align → refuse to dispatch.
  const sourceCoordStr = (sourcePlanet.coords ?? []).join(":");
  const sourceType = (sourcePlanet as { type?: string }).type ?? "planet";
  if (sourceCoordStr && sourceCoordStr === targetCoords && sourceType === targetType) {
    return { blocked: `${goal.type} no-op: source body ${sourcePlanet.id} (${sourceType}) is already at ${targetCoords} — same body, nothing to deploy` };
  }

  const mission = goal.type === "deploy" ? MISSION_DEPLOY : MISSION_TRANSPORT;

  // v0.0.547 — operator 2026-05-31 "这次根本就没飞 你看一下最后一个运输任务"
  // chain leg 1 (ferry_to_res_load planet→moon at 4:299:8) was auto-completed
  // 71ms after creation because this check returned `blocked: already at or
  // above target — ... fleet in flight ...` and ALREADY_AT_TARGET_RE matched
  // "in flight" → priority_merger flipped to "completed" (terminal).
  // But the in-flight fleet was UNRELATED (different chain, same coord pair).
  // For chain legs, "fleet in flight" means WAIT (transient), NOT done.
  // Drop the "already at or above target" prefix so the regex doesn't match
  // and the goal stays blocked (will retry when fleet clears outbound).
  //
  // v0.0.941 — 2026-06-07 owner chain txc-mq4apypy-li2b leg 4 (moon@3:279:7
  // → planet@3:279:7) false-blocked by a planet→planet recall phantom at the
  // same coord. Pre-emption check was coord+mission only; add origin_type /
  // dest_type match so moon-source legs aren't blocked by planet-source
  // phantoms at the same coord (and vice versa). Normalize both sides to
  // "planet"|"moon"|"debris" because schema is divergent: extractFleetMovements
  // writes number codes (1/2/3) while recordFleetLaunch syn-XXX writes strings.
  const srcKey = sourcePlanet.coords.join(":");
  const normType = (t: unknown): string => {
    if (typeof t === "string") return t;
    if (t === 1) return "planet";
    if (t === 2) return "debris";
    if (t === 3) return "moon";
    return "";
  };
  for (const f of state.fleets_outbound ?? []) {
    if (
      f.mission === mission &&
      f.origin.join(":") === srcKey &&
      f.dest.join(":") === targetCoords &&
      normType((f as { origin_type?: unknown }).origin_type) === sourceType &&
      normType((f as { dest_type?: unknown }).dest_type) === targetType
    ) {
      return { blocked: `${goal.type} pre-empted by existing fleet (mission ${mission} ${srcKey} ${sourceType}→${targetCoords} ${targetType}); waiting for clear outbound` };
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
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: goal.type, // "deploy" | "transport"
    params: {
      target_coords: targetCoords,
      target_type: targetType,
      ships,
      ...(resources ? { resources } : {}),
      planet_id: sourcePlanet.id,
      source_planet: sourcePlanet.id,
      mission,
      // v0.0.431: forward chain_id so goal_runner slot-gate + api_executor
      // slot-gate can detect chain-bound deploy and bypass keep-1-empty.
      ...(typeof (target as { chain_id?: unknown }).chain_id === "string" && (target as { chain_id?: string }).chain_id
        ? { chain_id: (target as { chain_id: string }).chain_id } : {}),
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `${goal.type} from ${srcKey} → ${targetCoords}`,
    goal_id: goal.id,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// jumpgate (Phase 2b — sibling-moon hop via ogame /component=jumpgate)
// ────────────────────────────────────────────────────────────────────────────

function planJumpgateGoal(goal: Goal, state: WorldState): PlanResult {
  const target = goal.target as {
    source_moon?: string;          // moon planet_id where the JG fires
    target_moon?: string;          // sibling moon planet_id to land on
    ships?: unknown;               // ShipCount of what to send
    chain_id?: string;             // forwarded to bridge for debug
  };
  const sourceMoonId = typeof target.source_moon === "string" ? target.source_moon : undefined;
  const targetMoonId = typeof target.target_moon === "string" ? target.target_moon : undefined;
  if (!sourceMoonId) return { blocked: "jumpgate: missing source_moon" };
  if (!targetMoonId) return { blocked: "jumpgate: missing target_moon" };
  const srcMoon = state.planets?.[sourceMoonId];
  const tgtMoon = state.planets?.[targetMoonId];
  if (!srcMoon) return { blocked: `jumpgate: source_moon ${sourceMoonId} not in state` };
  if (tgtMoon === undefined) return { blocked: `jumpgate: target_moon ${targetMoonId} not in state` };
  // v0.0.805 — operator 2026-06-05 "跳跃成功了 还卡在这里, 任务不知道":
  // owner 手动 click ogame UI 跳 JG, sidecar 没经过 directive ack 路径, JG
  // goal status 一直 active/blocked. ogame cooldown 启动 → planner 看 cd > 0
  // → blocked, chain leg 2 跟着卡. self-detect: target_moon 已 collect expected
  // ships → JG 真跳过 (whoever dispatched), auto_complete 给 priorityMerger
  // mark goal completed, chain unblock. take_all 模式 ships 是 dynamic, 此路径
  // 只 cover 静态 ships count.
  // v0.0.829 — operator 2026-06-06 "月球没有 cd 根本没跳" — 老 self-detect 只
  // 看 target_moon ships sufficient, chain context 下 target 上已经有历史 ships
  // 残留(上一次 chain LC 还未 deploy 出去 / 多 chain 重叠使用同 moon), 误判
  // auto_complete 跳过 JG 不真跳. 真因 fix: src moon cooldown active 才能证明
  // "JG 刚跳过 (whoever dispatched)". src cd=0 + target ships sufficient =
  // 历史残留, 必须 dispatch.
  const srcCdSec = (srcMoon as { jumpgate_cooldown_sec?: number | null }).jumpgate_cooldown_sec;
  const srcHarvestedAt = (srcMoon as { jumpgate_harvested_at?: number | null }).jumpgate_harvested_at;
  const srcCdActive = typeof srcCdSec === "number" && srcCdSec > 0 && typeof srcHarvestedAt === "number"
    && (srcCdSec - Math.floor((Date.now() - srcHarvestedAt) / 1000)) > 0;
  const expectedShips = target.ships;
  if (srcCdActive && expectedShips && typeof expectedShips === "object" && !Array.isArray(expectedShips)) {
    const tgtShips = (tgtMoon as { ships?: Record<string, number> }).ships ?? {};
    const entries = Object.entries(expectedShips as Record<string, unknown>)
      .filter(([, v]) => typeof v === "number" && (v as number) > 0) as Array<[string, number]>;
    if (entries.length > 0 && entries.every(([k, v]) => (tgtShips[k] ?? 0) >= v)) {
      return {
        blocked: `jumpgate already executed (src cd active + target ${targetMoonId} ships ≥ expected)`,
        auto_complete: true,
      };
    }
  }
  // Cooldown check — frontend captures jumpgate_cooldown_sec on each click;
  // we treat absence as "ready" (operator's overlay GET will refresh).
  // v0.0.720 — operator 2026-06-03 "JG 没有跳" 真因: ogame v12 JG lock 是
  // bilateral — A→B 完成后 A 跟 B 都进 cd, 期间任何方向 JG 都拒。Planner
  // 之前只查 source moon cd, target 还在 cd 时 dispatch → ogame 空 error 拒。
  // Evidence: 3:279:7 月球 cd=1596 (paired with 2:279:8 19:38 UTC JG), 1:486:7
  // → 3:279:7 dispatch 5 次, ogame 全 reject 空 error。Fix: 同样 cd 检查 also
  // 跑 target moon。Block reason 区分 src vs tgt 便于 operator 看 panel。
  const cdSec = (srcMoon as { jumpgate_cooldown_sec?: number | null }).jumpgate_cooldown_sec;
  const harvestedAt = (srcMoon as { jumpgate_harvested_at?: number | null }).jumpgate_harvested_at;
  if (typeof cdSec === "number" && cdSec > 0 && typeof harvestedAt === "number") {
    const elapsedSec = Math.floor((Date.now() - harvestedAt) / 1000);
    const remaining = cdSec - elapsedSec;
    if (remaining > 0) {
      return { blocked: `jumpgate: source_moon ${sourceMoonId} cooldown ${remaining}s remaining` };
    }
  }
  const tgtCdSec = (tgtMoon as { jumpgate_cooldown_sec?: number | null } | undefined)?.jumpgate_cooldown_sec;
  const tgtHarvestedAt = (tgtMoon as { jumpgate_harvested_at?: number | null } | undefined)?.jumpgate_harvested_at;
  if (typeof tgtCdSec === "number" && tgtCdSec > 0 && typeof tgtHarvestedAt === "number") {
    const tgtElapsedSec = Math.floor((Date.now() - tgtHarvestedAt) / 1000);
    const tgtRemaining = tgtCdSec - tgtElapsedSec;
    if (tgtRemaining > 0) {
      return { blocked: `jumpgate: target_moon ${targetMoonId} cooldown ${tgtRemaining}s remaining (ogame v12 bilateral lock — both moons must be ready)` };
    }
  }
  // v0.0.469: take-all-ships mode (operator 2026-05-30 "用跳跃门往回走的
  // 时候带走月球上所有的船"). When target.take_all is true OR ships ==="all",
  // SUBSTITUTE the static ships count with whatever is currently on the
  // source moon at dispatch time. JG ferry leg sweeps up everything, not
  // just what operator originally configured. Static ship count still
  // supported for fine-grained chains.
  const takeAll = (target as { take_all?: unknown }).take_all === true || target.ships === "all";
  let ships: ShipCount;
  if (takeAll) {
    const onMoonAll = srcMoon.ships ?? {};
    // v0.0.926 — owner 2026-06-07 "月球上的舰队小于派出的舰队 等待 不一定是
    // LG 有可能派 SC". 每种 ship type 的 chain 期望必须先到齐再 sweep, 防止
    // 上游 JG/ferry 还没到货时 take_all 抢走 stale 残料.
    const expectedJgShips = (target.ships && typeof target.ships === "object" && !Array.isArray(target.ships))
      ? target.ships as Record<string, number>
      : {};
    for (const [name, expectedN] of Object.entries(expectedJgShips)) {
      const exp = expectedN as number;
      if (!Number.isFinite(exp) || exp <= 0) continue;
      const have = (onMoonAll as Record<string, number | undefined>)[name] ?? 0;
      if ((have as number) < exp) {
        return { blocked: `jumpgate (take_all) waiting upstream: source_moon ${sourceMoonId} has ${have}× ${name}, chain expects ≥${exp}` };
      }
    }
    ships = {} as ShipCount;
    for (const [name, n] of Object.entries(onMoonAll)) {
      if ((n ?? 0) > 0) (ships as Record<string, number>)[name] = n as number;
    }
  } else {
    ships = (typeof target.ships === "object" && target.ships !== null ? target.ships : {}) as ShipCount;
  }
  // v0.0.547 — operator 2026-05-31 "JG 没有跳" → take_all JG with 0 ships on
  // source moon → dispatched ships={} → userscript throws "empty ships payload"
  // → ack failure → WS-flap loses ack → goal stuck active → stuck-recovery
  // re-dispatches in a loop. Fix: refuse to dispatch JG with empty ships.
  // Wait for upstream ferry to actually deliver ships before generating the
  // JG directive.
  if (Object.values(ships).every((n) => !(n as number) || (n as number) <= 0)) {
    return { blocked: `jumpgate: source_moon ${sourceMoonId} has no ships available yet (waiting for upstream ferry)` };
  }
  // Ship availability gate — sum of requested ships vs source-moon current.
  const onMoon = srcMoon.ships ?? {};
  for (const [name, n] of Object.entries(ships)) {
    if ((n ?? 0) <= 0) continue;
    if ((onMoon[name as keyof ShipCount] ?? 0) < (n ?? 0)) {
      return { blocked: `jumpgate: source_moon ${sourceMoonId} only has ${onMoon[name as keyof ShipCount] ?? 0}× ${name}, needs ${n}` };
    }
  }
  return {
    id: `dir-${randomUUID()}`,
    source: "goal",
    method: "ui",
    priority: typeof goal.priority === "number" ? goal.priority : 5,
    action: "jumpgate",
    params: {
      planet_id: sourceMoonId,            // session-cp source for the POST
      source_moon_id: sourceMoonId,
      target_moon_id: targetMoonId,
      ships,
      chain_id: target.chain_id ?? "",
    },
    preconds: [],
    expires_at: Date.now() + DIRECTIVE_TTL_MS,
    reason: `jumpgate ${sourceMoonId} → ${targetMoonId}`,
    goal_id: goal.id,
  };
}

// Re-export GoalType for callers who want to switch on it; keeps the module
// self-contained as the canonical planner entry point.
export type { GoalType };
