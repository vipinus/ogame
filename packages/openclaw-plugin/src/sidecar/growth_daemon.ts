/**
 * Per-planet growth daemon (v0.0.989).
 *
 * owner 2026-06-08: "新账号任务的优化为什么不建矿和存储罐" + "为什么也不是每个
 * 星球一棵树" + "我要优化出最优解" + "新账号的优化就是一坨💩".
 *
 * Optimizer.ts 只为 explicit user-goal emit top-1 加速器 (line 482), 且 storage
 * 完全不在候选名单 (line 361). 殖民地若无 user goal 完全裸奔 — 不建矿, 不建存储,
 * 资源溢出 / 远期产能落后. 不能接受.
 *
 * 本 daemon 每 60s 评估每星球, 跳过已有 main goal 或已有 growth-* active 的星球.
 * 候选 = 3 矿 (metalMine/crystalMine/deuteriumSynth) 升 +1..+3 + 3 存储 +1.
 * 评分公式 (24h 净 resource 价值):
 *   - 矿: gain_per_hour * (24h - buildH) - cumCost - opportunity_cost_during_build
 *   - 存储: overflow_avoided = (curProj - curCap) * (cur fill ratio) when projecting > 95% cap
 *
 * Emit 1 个 ROI 最高的 growth-{planet}-{building}-L{level} goal, status pending.
 * 跟 priority_merger / planner 走同 build dispatch 路径.
 *
 * 跟 optimizer 解耦: optimizer 继续 emit opt-* 加速 explicit user goal (能源链 etc),
 * growth-daemon 解决"无 main goal 殖民地长期成长"问题.
 */

import type { GoalsStorePg } from "./goals_store_pg.js";
import type { WorldStateStorePg } from "./world_state_store_pg.js";
import type { WorldState } from "@ogamex/shared";
import { mineProdRatio, cumulativeMineCost, buildSecondsForRange } from "./optimizer.js";

/** Closure deps injected by sidecar/index.ts boot — REUSES the existing
 *  createGoal + setMainGoal pipelines (with dedup + triggerDispatch + uid
 *  scoping). v0.0.989d — owner 2026-06-08 "不要每次都重做 昨天做好的不能复用吗".
 *  Old direct upsertGoal path produced custom growth-* prefix that bypassed
 *  panel tree rendering + planner buil-* cascade conventions. */
export interface GrowthCreateBuildMainGoal {
  (uid: string, planet: string, building: string, level: number): Promise<string | null>;
}

interface PlanetSnapshot {
  id: string;
  type?: string;
  buildings?: Record<string, number>;
  resources?: { m?: number; c?: number; d?: number; e?: number };
  production?: { m_h?: number; c_h?: number; d_h?: number };
  storage?: { m_max?: number; c_max?: number; d_max?: number };
}

const TICK_MS = 60_000;
const ROI_HORIZON_HOURS = 24;
const STORAGE_TRIGGER_RATIO = 0.95;
const STORAGE_HORIZON_HOURS = 0.5;
const MIN_ROI_VALUE = 1; // skip if not even +1 value gain

function computeStorageCap(lvl: number): number {
  return Math.floor(5000 * Math.pow(2.5, lvl));
}

function valueOfResources(r: { m: number; c: number; d: number }): number {
  // owner: m:c:d ≈ 1:2:3 weighting (ogame trade ratios); cost-aware sum.
  return r.m * 1 + r.c * 2 + r.d * 3;
}

interface GrowthCandidate {
  building: string;
  level: number;
  roi: number;
  note: string;
}

function evalMineCandidate(
  planet: PlanetSnapshot,
  mineKey: "metalMine" | "crystalMine" | "deuteriumSynth",
  dL: number,
  econSpeed: number,
): GrowthCandidate | null {
  const cur = planet.buildings?.[mineKey] ?? 0;
  const L_new = cur + dL;
  const robo = planet.buildings?.["roboticsFactory"] ?? 0;
  const nano = planet.buildings?.["naniteFactory"] ?? 0;
  const buildSec = buildSecondsForRange(mineKey, cur, L_new, robo, nano, econSpeed);
  if (buildSec === null) return null;
  const cost = cumulativeMineCost(mineKey, cur, L_new);
  if (!cost) return null;
  const rk = mineKey === "metalMine" ? "m_h" : mineKey === "crystalMine" ? "c_h" : "d_h";
  const prodCurH = planet.production?.[rk] ?? 0;
  const ratio = mineProdRatio(cur, L_new);
  if (ratio <= 1) return null;
  const prodNewH = prodCurH * ratio;
  const gainPerHourBase = prodNewH - prodCurH;
  const gainPerHour = Math.max(0, gainPerHourBase) * econSpeed;
  const buildH = buildSec / 3600;
  const horizonAfterBuild = Math.max(0, ROI_HORIZON_HOURS - buildH);
  // gross production gain
  const grossGain = gainPerHour * horizonAfterBuild;
  // opportunity cost: during build, we forgo NEW resources we'd produce IF we
  // had spent same time at higher level. proxy = prodCurH * buildH (already
  // accruing at curLvl). cost.value subtracted separately.
  const resGain = mineKey === "metalMine" ? grossGain
                : mineKey === "crystalMine" ? grossGain * 2
                : grossGain * 3;
  const costVal = valueOfResources(cost);
  const roi = resGain - costVal;
  return {
    building: mineKey,
    level: L_new,
    roi,
    note: `mine dL=${dL} buildH=${buildH.toFixed(1)} gain/h=${gainPerHour.toFixed(0)} grossH=${horizonAfterBuild.toFixed(1)} cost=${costVal.toFixed(0)} ROI=${roi.toFixed(0)}`,
  };
}

function evalStorageCandidate(
  planet: PlanetSnapshot,
  kind: "metalStorage" | "crystalStorage" | "deuteriumTank",
  econSpeed: number,
): GrowthCandidate | null {
  const r = planet.resources ?? {};
  const rk = kind === "metalStorage" ? "m" : kind === "crystalStorage" ? "c" : "d";
  const ph = (rk + "_h") as "m_h" | "c_h" | "d_h";
  const curLvl = planet.buildings?.[kind] ?? 0;
  const curRes = (r as Record<string, number>)[rk] ?? 0;
  const prodH = planet.production?.[ph] ?? 0;
  const storageMaxKey = (rk + "_max") as "m_max" | "c_max" | "d_max";
  const liveMax = (planet.storage as Record<string, number> | undefined)?.[storageMaxKey] ?? 0;
  const cap = liveMax > 0 ? liveMax : computeStorageCap(curLvl);
  const proj = curRes + Math.max(0, prodH) * econSpeed * STORAGE_HORIZON_HOURS;
  if (proj < cap * STORAGE_TRIGGER_RATIO) return null;
  // overflow soon — emergency, high ROI proxy = the resources we WOULD lose
  // over horizon (avoided overflow value).
  const newCap = computeStorageCap(curLvl + 1);
  const capacityGain = newCap - cap;
  const overflowRiskPerHour = Math.max(0, prodH) * econSpeed;
  const avoidedLossH = Math.min(ROI_HORIZON_HOURS, capacityGain / Math.max(1, overflowRiskPerHour));
  const avoidedLossValue = overflowRiskPerHour * avoidedLossH * (rk === "m" ? 1 : rk === "c" ? 2 : 3);
  // Storage cost (~exponential). Use rough formula matching ogame v12.
  // metalStorage: 1000 * 2^L, etc. Stay simple.
  const costM = kind === "metalStorage" ? 1000 * Math.pow(2, curLvl + 1)
              : kind === "crystalStorage" ? 1000 * Math.pow(2, curLvl + 1)
              : 1000 * Math.pow(2, curLvl + 1);
  const costC = kind === "crystalStorage" ? 500 * Math.pow(2, curLvl + 1)
              : kind === "deuteriumTank" ? 1000 * Math.pow(2, curLvl + 1)
              : 0;
  const costVal = costM + costC * 2;
  const roi = avoidedLossValue - costVal;
  return {
    building: kind,
    level: curLvl + 1,
    roi,
    note: `storage proj=${proj.toFixed(0)} cap=${cap} avoidedH=${avoidedLossH.toFixed(1)} avoided=${avoidedLossValue.toFixed(0)} cost=${costVal.toFixed(0)} ROI=${roi.toFixed(0)}`,
  };
}

export function pickBestGrowthAction(
  planet: PlanetSnapshot,
  econSpeed: number,
): GrowthCandidate | null {
  // skip moon: moon doesn't grow mines
  if (planet.type === "moon") return null;
  const candidates: GrowthCandidate[] = [];
  for (const mine of ["metalMine", "crystalMine", "deuteriumSynth"] as const) {
    for (let dL = 1; dL <= 3; dL++) {
      const c = evalMineCandidate(planet, mine, dL, econSpeed);
      if (c) candidates.push(c);
    }
  }
  for (const storage of ["metalStorage", "crystalStorage", "deuteriumTank"] as const) {
    const c = evalStorageCandidate(planet, storage, econSpeed);
    if (c) candidates.push(c);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.roi - a.roi);
  return candidates[0]!;
}

export async function runGrowthDaemonOnce(
  uid: string,
  getStateForUid: (uid: string) => WorldState | null,
  goalsStorePg: GoalsStorePg,
  worldStateStorePg: WorldStateStorePg,
  createBuildMainGoal: GrowthCreateBuildMainGoal,
): Promise<{ emitted: number; skipped: number }> {
  // v0.0.989a — owner 2026-06-08: in-memory tenantRegistry only hydrates on
  // active WS session; eb990432 silent-skipped first round despite having 3
  // planets in PG. Fallback to PG read so daemon doesn't depend on WS state.
  let state = getStateForUid(uid);
  if (!state) {
    try {
      const hydrated = await worldStateStorePg.hydrate(uid);
      if (hydrated) state = hydrated.state;
    } catch (e) {
      console.warn(`[growth-daemon] PG hydrate ${uid.slice(0,8)} failed:`, e instanceof Error ? e.message : e);
    }
  }
  if (!state) return { emitted: 0, skipped: 0 };
  // v0.0.989b — owner 2026-06-08 "改错了 你又吧约束忘了 天体物理9 以上,
  // 不考虑 矿和存储罐". planner.ts:isPostExpeditionPhase + optimizer.ts:329
  // postPhaseSkipMine 都已用 astrophysics>=9 阈值跳过矿/存储 (post-expedition
  // 经济阶段 transport 接管补给). growth_daemon 必须对齐, 否则同账号 3 处约束
  // 不拉通.
  const astro = (state as { research?: { levels?: Record<string, number> } }).research?.levels?.["astrophysics"] ?? 0;
  if (astro >= 9) {
    console.info(`[growth-daemon] uid=${uid.slice(0,8)} SKIP-ALL astrophysics=${astro} >=9 (post-expedition phase)`);
    return { emitted: 0, skipped: 0 };
  }
  const allRows = await goalsStorePg.list(uid);
  const econSpeed = (state as { server?: { speed?: number } }).server?.speed ?? 1;
  let emitted = 0;
  let skipped = 0;
  const planets = Object.entries((state as { planets?: Record<string, unknown> }).planets ?? {});
  for (const [planetId, planetRaw] of planets) {
    const planet = planetRaw as PlanetSnapshot;
    planet.id = planetId;
    // Skip planets that have an explicit main goal (owner manually steering).
    // v0.0.989e — owner 2026-06-08: 同 planet 已有 user-emitted build/research
    // goal (买家自己加的或 panel 加的) 也算"一棵树",不准再 emit 第二棵. 不能只
    // check is_main_goal flag — naniteFactory user goal is_main_goal=false 漏判.
    // 排除 opt-* (accel cascade child) + exp-* (expedition) + expb-* (ship build).
    const planetHasAnyTree = allRows.some((r) => {
      if ((r.goal as { planet?: string }).planet !== planetId) return false;
      if (!["active", "blocked", "pending"].includes(r.status)) return false;
      const id = r.goal.id;
      if (id.startsWith("opt-")) return false;
      if (id.startsWith("exp-")) return false;
      if (id.startsWith("expb-")) return false;
      const t = r.goal.type;
      return t === "build" || t === "research" || t === "lifeform_building" || t === "lifeform_research";
    });
    if (planetHasAnyTree) { skipped++; continue; }
    const pick = pickBestGrowthAction(planet, econSpeed);
    if (!pick || pick.roi < MIN_ROI_VALUE) { skipped++; continue; }
    // v0.0.989c — owner 2026-06-08 "没做到 一个星球一颗树": 单 build 节点不是 tree.
    // 升级到长视野 (curLvl+5) + is_main_goal=true → planner cascade L+1..L+5 出树,
    // panel 显主 tree, gate dedup 后该 planet 一棵长 tree 跑完才能再 emit.
    const TREE_HORIZON_LEVELS = 5;
    const buildings = (planet as { buildings?: Record<string, number> }).buildings ?? {};
    const curLvl = buildings[pick.building] ?? 0;
    const treeTargetLvl = curLvl + TREE_HORIZON_LEVELS;
    // v0.0.989d — owner 2026-06-08 "不要每次都重做 昨天做好的不能复用吗".
    // REUSE createGoal callback (dedup + buil-* id + triggerDispatch) +
    // setMainGoal (is_main_goal=true + tree render). 不再 upsertGoal 直写.
    try {
      const goalId = await createBuildMainGoal(uid, planetId, pick.building, treeTargetLvl);
      if (goalId) {
        console.info(`[growth-daemon] uid=${uid.slice(0, 8)} planet=${planetId} EMIT ${pick.building} L${treeTargetLvl} (curL=${curLvl} +${TREE_HORIZON_LEVELS}) id=${goalId} ${pick.note}`);
        emitted += 1;
      } else {
        console.info(`[growth-daemon] uid=${uid.slice(0, 8)} planet=${planetId} createBuildMainGoal returned null (dedup or unavailable)`);
        skipped += 1;
      }
    } catch (e) {
      console.warn(`[growth-daemon] createBuildMainGoal failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { emitted, skipped };
}

export function startGrowthDaemon(deps: {
  goalsStorePg: GoalsStorePg;
  worldStateStorePg: WorldStateStorePg;
  getStateForUid: (uid: string) => WorldState | null;
  loadActiveTenantUids: () => Promise<string[]>;
  createBuildMainGoal: GrowthCreateBuildMainGoal;
}): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const uids = await deps.loadActiveTenantUids();
      let tot = { emitted: 0, skipped: 0 };
      for (const uid of uids) {
        try {
          const r = await runGrowthDaemonOnce(uid, deps.getStateForUid, deps.goalsStorePg, deps.worldStateStorePg, deps.createBuildMainGoal);
          tot.emitted += r.emitted;
          tot.skipped += r.skipped;
        } catch (e) {
          console.warn(`[growth-daemon] tick uid=${uid.slice(0, 8)} threw:`, e instanceof Error ? e.message : e);
        }
      }
      if (tot.emitted > 0 || tot.skipped > 0) {
        console.info(`[growth-daemon] tick complete emitted=${tot.emitted} skipped=${tot.skipped}`);
      }
    } catch (e) {
      console.warn("[growth-daemon] outer tick threw:", e instanceof Error ? e.message : e);
    }
  };
  const t = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
    (t as unknown as { unref: () => void }).unref();
  }
  console.info(`[growth-daemon] started (${TICK_MS / 1000}s tick, ROI horizon=${ROI_HORIZON_HOURS}h)`);
  return { stop: () => clearInterval(t) };
}
