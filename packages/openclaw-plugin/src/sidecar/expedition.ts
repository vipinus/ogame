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

const EXPEDITION_TICK_MS = 5_000;
const EXPEDITION_TEMPLATE_PATH = "/home/ddxs/.openclaw/workspace/ogamex/runtime/ogamex-expedition.json";
const DEFAULT_EXPEDITION_TEMPLATE: Record<string, number> = { smallCargo: 1, espionageProbe: 1 };
const FAILURE_COOL_OFF_MS = 15 * 1000;
const INFLIGHT_TTL_MS = 45_000;

interface ExpeditionConfig {
  enabled?: boolean;
  paused?: boolean;
  template?: Record<string, number>;
  enabled_planets?: string[];
  auto_build_ships?: boolean;
}

function loadExpeditionConfig(): ExpeditionConfig {
  try { return JSON.parse(fs.readFileSync(EXPEDITION_TEMPLATE_PATH, "utf8")) as ExpeditionConfig; }
  catch { return { enabled: true, template: DEFAULT_EXPEDITION_TEMPLATE }; }
}

// Per-tenant cool-off + in-flight state. Keyed by `${uid}::${planetId}`.
const inFlightLaunches: Array<{ uid: string; planetId: string; ts: number; count: number }> = [];
const failureCoolOff = new Map<string, number>(); // `${uid}::${planetId}` → ts

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
  const cfg = loadExpeditionConfig();
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

  const cfgTemplate: Record<string, number> = cfg.template ?? DEFAULT_EXPEDITION_TEMPLATE;
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
    // Cancel any active expedition goal (slots full).
    for (const r of allRows) {
      const g = r.goal as unknown as GoalLike;
      if (g.type !== "expedition") continue;
      if (["completed", "cancelled"].includes(r.status)) continue;
      try {
        await pgStore.updateGoalStatus(uid, g.id, "cancelled", "expedition: slots full (scraped)");
      } catch (e) { console.warn(`[expedition] cancel ${g.id} failed:`, e instanceof Error ? e.message : e); }
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
  const activeExpInQueue = allRows.filter((r) => {
    const g = r.goal as unknown as GoalLike;
    return !["completed", "cancelled"].includes(r.status) && g.type === "expedition";
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
    const key = `${uid}::${pId}`;
    const cur = failureCoolOff.get(key) ?? 0;
    if (updated > cur) failureCoolOff.set(key, updated);
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
    const key = `${uid}::${p.id}`;
    const lastFail = failureCoolOff.get(key) ?? 0;
    const inCoolOff = lastFail && nowMs - lastFail < FAILURE_COOL_OFF_MS;
    if (inCoolOff && maxFromThisPlanet === 0) { skipped++; continue; }
    if (inCoolOff && maxFromThisPlanet > 0) {
      failureCoolOff.delete(key);
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
  const triggerForUid = (uid: string): void => {
    const st = deps.getStateForUid(uid);
    if (!st) return;
    // Fire-and-forget — don't block snapshot handler.
    void expeditionTickForUser(uid, st, deps.goalsStorePg, deps.pgStore)
      .catch((e) => console.warn(`[expedition] trigger uid=${uid.slice(0, 8)} threw:`, e instanceof Error ? e.message : e));
  };
  console.info(`[expedition] sidecar tick started (${EXPEDITION_TICK_MS / 1000}s base + state.snapshot event-driven)`);
  return { stop: () => { stopped = true; clearInterval(t); }, triggerForUid };
}
