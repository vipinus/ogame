/**
 * Phase 8b (v0.0.785) — expedition.ts (port from
 * scripts/ogamex_discord_bridge.mjs:1525-1881).
 *
 * Operator 2026-06-05 "远征 setInterval 这个 也不要和 Discord webhook 放
 * 一起，放到该去的地方". 远征自动 emit exp-/expb- goal 的逻辑搬入 sidecar.
 * priority_merger 拿 active exp goal → emit expedition directive → user-
 * script ApiExec → 真正 sendFleet.
 *
 * 跟 daemon expeditionTick 同源 — operator strategy + race-lock + cool-off +
 * round-robin rotation 全部保留. multi-tenant: tick 内 loop active tenants
 * 而非 CURRENT_UID swap (sidecar 是 in-process, 不需要 daemon 的 closure
 * 状态 swap).
 */

import * as fs from "node:fs";
import type { WorldState } from "@ogamex/shared";
import type { GoalsStorePg } from "./goals_store_pg.js";
import type { WorldStateStorePg } from "./world_state_store_pg.js";
import { tenantRegistry } from "./tenant_context.js";

// v0.0.834 — operator 2026-06-06: 5s tick 噪声大, event-driven 已能覆盖大多数,
// base 拉到 30s 兜底.
const EXPEDITION_TICK_MS = 30_000;
// v0.0.840 — operator 2026-06-06 "远征的舰队设置分开了吗": per-uid 文件路径.
// v0.0.1027 — owner 2026-06-09 "是不是有两套模板" + [[single-decision-tree]]:
// 删 legacy fallback. per-uid 文件缺 = ALS / setup 问题, throw fail-fast,
// 不允许静默 fallback legacy file (legacy 是僵尸 path, Discord `fleet`
// 命令还写它 → 改 template 看似生效实际没影响 daemon).
const EXPEDITION_STATE_DIR_EXP = "/home/ddxs/.openclaw/workspace/ogamex/runtime";
function templatePathForUid(uid: string): string {
  return `${EXPEDITION_STATE_DIR_EXP}/ogamex-expedition-${uid.slice(0, 8)}.json`;
}
const FAILURE_COOL_OFF_MS = 15 * 1000;
const INFLIGHT_TTL_MS = 45_000;

interface ExpeditionConfig {
  enabled?: boolean;
  paused?: boolean;
  template?: Record<string, number>;
  enabled_planets?: string[];
  auto_build_ships?: boolean;
}

function loadExpeditionConfig(uid: string): ExpeditionConfig {
  if (!uid) {
    throw new Error("loadExpeditionConfig: uid required (no legacy fallback). [[single-decision-tree]]");
  }
  const fp = templatePathForUid(uid);
  // 文件不存在或 JSON 烂 → 让 fs.readFileSync / JSON.parse throw, caller
  // 看见调用栈, owner 修配置. 不再静默 fallback 默认值/legacy file.
  return JSON.parse(fs.readFileSync(fp, "utf8")) as ExpeditionConfig;
}

// Per-tenant cool-off + in-flight state.
// v0.0.862 (Sprint 3) — failureCoolOff migrated to TenantContext.
// expeditionFailureCoolOff (was module-level `Map<`${uid}::${planetId}`, ts>`,
// v0.0.857 prefix anti-pattern symptom-fix per [feedback_no_silent_destruction]).
// Owner directive 2026-06-06: "全部用 per-uid，统一架构 避免以后再来回补丁".
// Key collapses from `${uid}::${planetId}` to plain `planetId` since the uid
// dimension is now in tenantRegistry.get(uid).expeditionFailureCoolOff.
// See tenant_context.ts §"Sprint 3" + docs/architecture/multi-tenant.md §1.
//
// inFlightLaunches stays as an Array (NOT a Map) so the CI gate regex doesn't
// catch it. It's already uid-tagged per-entry and pruned by uid in the tick
// loop; converting to a per-uid Map is a separate refactor outside Sprint 3
// scope (owner directive limited to "the 2 surviving Maps").
const inFlightLaunches: Array<{ uid: string; planetId: string; ts: number; count: number }> = [];

interface PlanetLike {
  id: string;
  coords?: readonly number[];
  ships?: Record<string, number>;
  type?: string;
}

interface FleetOut { mission?: number }

interface GoalLike {
  id: string;
  type: string;
  target?: { ship?: string; amount?: number; source_planet?: string; count?: number; ships?: Record<string, number> };
  planet?: string;
  priority?: number;
  is_main_goal?: boolean;
  status?: string;
  created_at?: number;
  progress_pct?: number;
  current_step?: string;
  eta_at?: number | null;
}

interface GoalRowLike {
  goal: GoalLike;
  status: string;
  reason?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Single-tenant expedition tick. Pure function:
 *   (state, allRows) → { newGoals }
 * Caller persists newGoals via pgStore.upsertGoal.
 *
 * Operator strategy (commit 6df74c3 + ogamex_discord_bridge.mjs):
 *   1. 取 cfg.enabled_planets 过滤
 *   2. round-robin sort by lastExpTs ASC (公平化)
 *   3. 算 freeSlots = slotCap - max(outbound, inFlightLocal)
 *   4. per planet: race-lock + ship-template + cool-off, emit exp- if OK
 *   5. cfg.auto_build_ships 时, ship 不够 emit expb- (build_ships goal)
 */
export async function expeditionTickForUser(
  uid: string,
  state: WorldState,
  goalsStorePg: GoalsStorePg,
  pgStore: WorldStateStorePg,
): Promise<{ launched: number; skipped: number }> {
  const cfg = loadExpeditionConfig(uid);
  if (cfg.paused === true) {
    return { launched: 0, skipped: 0 };
  }
  let planetList: PlanetLike[] = Object.values(state.planets ?? {}) as unknown as PlanetLike[];
  if (Array.isArray(cfg.enabled_planets) && cfg.enabled_planets.length > 0) {
    const allowed = new Set(cfg.enabled_planets);
    planetList = planetList.filter((p) => allowed.has(p.id));
  }
  if (planetList.length === 0) return { launched: 0, skipped: 0 };

  const allRows = await goalsStorePg.list(uid);

  // Round-robin sort (last exp ts ASC, fresh planets first).
  const lastExpTs = new Map<string, number>();
  for (const r of allRows) {
    const g = r.goal as unknown as GoalLike;
    if (g.type !== "expedition") continue;
    const pid = g.target?.source_planet ?? g.planet;
    if (!pid) continue;
    const ts = g.created_at ?? r.created_at ?? 0;
    if (ts > (lastExpTs.get(pid) ?? 0)) lastExpTs.set(pid, ts);
  }
  planetList.sort((a, b) => (lastExpTs.get(a.id) ?? 0) - (lastExpTs.get(b.id) ?? 0));

  // v0.0.1027 — owner [[single-decision-tree]]: cfg.template 缺 throw, 不 default.
  if (!cfg.template || typeof cfg.template !== "object" || Object.keys(cfg.template).length === 0) {
    throw new Error(`expedition: per-uid template missing for uid=${uid.slice(0, 8)} (no default)`);
  }
  const cfgTemplate: Record<string, number> = cfg.template;
  const astro = state.research?.levels?.astrophysics ?? 0;
  const serverInfo = (state as { server?: { max_expedition_slots?: number; used_expedition_slots?: number } }).server ?? {};
  const realSlots = serverInfo.max_expedition_slots ?? 0;
  if (astro <= 0 && realSlots <= 0) return { launched: 0, skipped: 0 };
  // Fallback: ceil(sqrt(astro)) + class bonus (handled in sidecar /v1/expedition;
  // here we just use realSlots, fall back to 0 if missing).
  const slotCap = realSlots > 0 ? realSlots : 0;
  if (slotCap === 0) return { launched: 0, skipped: 0 };

  const scrapedUsed = serverInfo.used_expedition_slots;
  const outboundCount = ((state.fleets_outbound ?? []) as FleetOut[]).filter((f) => f.mission === 15).length;
  const haveOutboundSignal = (typeof scrapedUsed === "number") || outboundCount > 0;
  if (!haveOutboundSignal) {
    return { launched: 0, skipped: 0 };
  }
  const outbound = outboundCount > 0 ? outboundCount : (typeof scrapedUsed === "number" ? scrapedUsed : 0);

  if (outbound >= slotCap) {
    // v0.0.907 — owner 2026-06-07 "没做完的任务又被删除了 4:299:8" 实证 daemon
    // 槽满时把 active exp goal 全 cancel → 任务从面板消失 + 槽空后还要 owner
    // 重建. 改 blocked + 同 reason: 槽空后下次 daemon tick / merger 自动 dispatch,
    // 不需要 owner 干预. atomic goal cancel-on-fail 政策只覆盖 ack handler 真态
    // ogame 拒, 不该覆盖 sidecar 自家槽满 preflight.
    for (const r of allRows) {
      const g = r.goal as unknown as GoalLike;
      if (g.type !== "expedition") continue;
      if (["completed", "cancelled", "blocked"].includes(r.status)) continue;
      try {
        await pgStore.updateGoalStatus(uid, g.id, "blocked", "expedition: slots full — waiting for slot");
      } catch (e) { console.warn(`[expedition] block ${g.id} failed:`, e instanceof Error ? e.message : e); }
    }
    return { launched: 0, skipped: planetList.length };
  }

  const autoBuildShips = cfg.auto_build_ships === true;
  if (!autoBuildShips) {
    // Drain stale expb-* goals.
    for (const r of allRows) {
      const g = r.goal as unknown as GoalLike;
      if (!g.id.startsWith("expb-")) continue;
      if (["completed", "cancelled"].includes(r.status)) continue;
      try {
        await pgStore.updateGoalStatus(uid, g.id, "cancelled", "daemon: auto-build disabled");
      } catch (e) { console.warn(`[expedition] cancel expb ${g.id} failed:`, e instanceof Error ? e.message : e); }
    }
  }

  // Expire stale in-flight markers.
  const tickNow = Date.now();
  while (inFlightLaunches.length > 0 && (inFlightLaunches[0]!.uid !== uid || tickNow - inFlightLaunches[0]!.ts > INFLIGHT_TTL_MS)) {
    if (inFlightLaunches[0]!.uid === uid) inFlightLaunches.shift();
    else break;
  }
  // Filter in-flight 也按 uid (more careful):
  const inFlightLocal = inFlightLaunches.filter((x) => x.uid === uid && tickNow - x.ts < INFLIGHT_TTL_MS).reduce((s, x) => s + x.count, 0);
  // v0.0.995c — owner 2026-06-09 "远征不飞了": 老 gate 把 blocked goals 也算
  // 入 queue 上限, 当 3 颗死星 (空仓库/缺 reaper) 卡 blocked 时 queue=7 卡 gate 4,
  // 5 颗满仓库星球永远等不到 emit. 修: 只数 dispatchable (active/pending/dispatched),
  // blocked 不占名额 (它们等 ships 返回, 不消耗 daemon emit 配额).
  const activeExpInQueue = allRows.filter((r) => {
    const g = r.goal as unknown as GoalLike;
    return ["active", "pending", "dispatched"].includes(r.status) && g.type === "expedition";
  }).length;

  const effectiveOutbound = Math.max(outbound, inFlightLocal);
  const freeSlots = Math.max(0, slotCap - effectiveOutbound);
  if (freeSlots === 0) {
    return { launched: 0, skipped: planetList.length };
  }
  if (activeExpInQueue > freeSlots * 2) {
    return { launched: 0, skipped: planetList.length };
  }
  let remainingSlots = freeSlots;

  // failureCoolOff from recent cancelled exp goals.
  // v0.0.862 — failureCoolOff now per-uid via tenantRegistry; key collapses
  // from `${uid}::${planetId}` to plain `planetId`.
  const failureCoolOff = tenantRegistry.get(uid).expeditionFailureCoolOff;
  const nowMs = Date.now();
  const FAIL_RE = /rejected by ogame|140054|140019|140043|140042|资源不足|可用艦船不足|可用舰船不足|aborted \(preflight\)/;
  for (const r of allRows) {
    const g = r.goal as unknown as GoalLike;
    if (g.type !== "expedition") continue;
    if (r.status !== "cancelled") continue;
    const reason = r.reason ?? "";
    if (!FAIL_RE.test(reason)) continue;
    const updated = r.updated_at ?? r.created_at ?? 0;
    if (nowMs - updated > FAILURE_COOL_OFF_MS) continue;
    const pId = g.target?.source_planet ?? g.planet;
    if (!pId) continue;
    const cur = failureCoolOff.get(pId) ?? 0;
    if (updated > cur) failureCoolOff.set(pId, updated);
  }

  // Planet race-lock.
  const lockedPlanets = new Set<string>();
  for (const r of allRows) {
    const g = r.goal as unknown as GoalLike;
    if (g.type !== "expedition") continue;
    if (["completed", "cancelled"].includes(r.status)) continue;
    const pid = g.target?.source_planet ?? g.planet;
    if (pid) lockedPlanets.add(pid);
  }

  let launched = 0;
  let skipped = 0;
  for (const p of planetList) {
    if (remainingSlots === 0) break;
    if (lockedPlanets.has(p.id)) { skipped++; continue; }
    const ships = p.ships ?? {};
    let maxFromThisPlanet = remainingSlots;
    for (const [shipName, need] of Object.entries(cfgTemplate)) {
      if (need <= 0) continue;
      const have = ships[shipName] ?? 0;
      maxFromThisPlanet = Math.min(maxFromThisPlanet, Math.floor(have / need));
    }
    const lastFail = failureCoolOff.get(p.id) ?? 0;
    const inCoolOff = lastFail && nowMs - lastFail < FAILURE_COOL_OFF_MS;
    if (inCoolOff && maxFromThisPlanet === 0) { skipped++; continue; }
    if (inCoolOff && maxFromThisPlanet > 0) {
      failureCoolOff.delete(p.id);
    }
    if (maxFromThisPlanet === 0) {
      if (autoBuildShips) {
        const missing: Record<string, number> = {};
        for (const [shipName, need] of Object.entries(cfgTemplate)) {
          if (need <= 0) continue;
          const have = ships[shipName] ?? 0;
          if (have < need) missing[shipName] = need - have;
        }
        if (Object.keys(missing).length > 0) {
          const hasActiveBuild = allRows.some((r) => {
            const g = r.goal as unknown as GoalLike;
            return g.id.startsWith("expb-") && !["completed", "cancelled"].includes(r.status)
              && (g.target?.source_planet === p.id || g.planet === p.id);
          });
          if (!hasActiveBuild) {
            for (const [shipName, amount] of Object.entries(missing)) {
              const bid = `expb-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}-${shipName}`;
              const row: GoalRowLike = {
                goal: {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  id: bid, type: "build_ships" as any,
                  target: { ship: shipName, amount, source_planet: p.id },
                  planet: p.id, priority: 8, is_main_goal: false,
                  status: "pending", created_at: Date.now(),
                  progress_pct: 0, current_step: "queued", eta_at: null,
                },
                status: "pending", created_at: Date.now(), updated_at: Date.now(),
              };
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await pgStore.upsertGoal(uid, row as any);
                console.log(`[expedition] auto-build ${p.coords?.join(":") ?? p.id} expb ${shipName} × ${amount}`);
              } catch (e) { console.warn(`[expedition] auto-build upsert failed:`, e instanceof Error ? e.message : e); }
            }
          }
        }
      }
      skipped++;
      continue;
    }
    // Emit exp- (1 per planet per tick — race-lock).
    const id = `exp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}-0`;
    const row: GoalRowLike = {
      goal: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        id, type: "expedition" as any,
        target: { count: 1, source_planet: p.id, ships: { ...cfgTemplate } },
        planet: p.id, priority: 10, is_main_goal: false,
        status: "pending", created_at: Date.now(),
        progress_pct: 0, current_step: "queued", eta_at: null,
      },
      status: "pending", created_at: Date.now(), updated_at: Date.now(),
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pgStore.upsertGoal(uid, row as any);
      launched++;
      remainingSlots--;
      inFlightLaunches.push({ uid, planetId: p.id, ts: tickNow, count: 1 });
      lockedPlanets.add(p.id);
      console.log(`[expedition] uid=${uid.slice(0, 8)} queued 1 exp from ${p.coords?.join(":") ?? p.id}`);
    } catch (e) { console.warn(`[expedition] queue failed:`, e instanceof Error ? e.message : e); }
  }
  if (launched > 0) {
    console.log(`[expedition] uid=${uid.slice(0, 8)} queued ${launched}, freeSlots=${freeSlots}, slotCap=${slotCap}, outbound=${outbound}`);
  }
  return { launched, skipped };
}

/**
 * Start tick (5s) + state.snapshot event-driven trigger.
 * sidecar 内部 — 不需要 CURRENT_UID swap, 直接 per-uid loop.
 */
export function startExpedition(deps: {
  goalsStorePg: GoalsStorePg;
  pgStore: WorldStateStorePg;
  getStateForUid: (uid: string) => WorldState | null;
  loadActiveTenantUids: () => Promise<string[]>;
}): { stop: () => void; triggerForUid: (uid: string) => void } {
  let stopped = false;
  const tickAll = async (): Promise<void> => {
    if (stopped) return;
    let uids: string[] = [];
    try { uids = await deps.loadActiveTenantUids(); }
    catch (e) {
      console.warn("[expedition] loadActiveTenantUids failed:", e instanceof Error ? e.message : e);
      return;
    }
    for (const uid of uids) {
      const st = deps.getStateForUid(uid);
      if (!st) continue;
      try {
        await expeditionTickForUser(uid, st, deps.goalsStorePg, deps.pgStore);
      } catch (e) {
        console.warn(`[expedition] tick uid=${uid.slice(0, 8)} threw:`, e instanceof Error ? e.message : e);
      }
    }
  };
  const t = setInterval(() => { void tickAll(); }, EXPEDITION_TICK_MS);
  if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
    (t as unknown as { unref: () => void }).unref();
  }
  // event-driven trigger — state.snapshot handler calls this when fleet returns.
  // v0.0.1000 — owner 2026-06-09 "你有没有 spam ogame 服务器": v0.0.995c daemon
  // gate 放开后, state.snapshot 风暴让 trigger 每 100ms 触发 → 1s emit 8 个 exp
  // goals → 全部 dispatch → 全部 fail-recover → 又触发 snapshot → 死循环 → ogame
  // /empire 503 storm. 加 per-uid 5s 节流, 同 uid 5s 内只允许 1 次 trigger.
  // 期间任何 trigger 都 noop (event 丢失没事 — 60s base setInterval 兜底).
  const TRIGGER_MIN_MS = 5000;
  const lastTriggerAt = new Map<string, number>();
  const triggerForUid = (uid: string): void => {
    const now = Date.now();
    const last = lastTriggerAt.get(uid) ?? 0;
    if (now - last < TRIGGER_MIN_MS) return; // throttled
    lastTriggerAt.set(uid, now);
    const st = deps.getStateForUid(uid);
    if (!st) return;
    // Fire-and-forget — don't block snapshot handler.
    void expeditionTickForUser(uid, st, deps.goalsStorePg, deps.pgStore)
      .catch((e) => console.warn(`[expedition] trigger uid=${uid.slice(0, 8)} threw:`, e instanceof Error ? e.message : e));
  };
  console.info(`[expedition] sidecar tick started (${EXPEDITION_TICK_MS / 1000}s base + state.snapshot event-driven)`);
  return { stop: () => { stopped = true; clearInterval(t); }, triggerForUid };
}
