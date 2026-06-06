/**
 * M4.5 + M5/M6 — Sidecar boot.
 *
 * Wires together the M4.2 WsServer, M4.3 HttpServer, M4.4 Reporter, the M5
 * goals/planner/priority-merger stack, and the M6 strategy/memory/failure
 * pipeline into a single lifecycle handle. The OpenClaw plugin entry
 * (`src/index.ts`) imports `startSidecar` and fires it on module load when
 * configured via env.
 *
 * Both transports carry the same protocol envelope (UpstreamMsg /
 * DownstreamMsg). A message arriving on either transport must reach
 * subscribers that registered against the *other* transport, because the
 * userscript may bridge over WS *or* HTTP long-poll depending on the host
 * environment. We achieve this by overriding the returned handle's `on`
 * methods so that each registration is mirrored into a shared per-type
 * registry; both servers' raw `on` is wired once to broadcast into that
 * registry. Consumers get transport-agnostic delivery.
 *
 * Upstream message routing (registered after wiring is complete):
 *   - `state.snapshot`     → stateRef mirror + MemoryWriter push + PriorityMerger dispatch
 *   - `event.daily_failure`→ FailureAggregator.record (LLM-driven strategy patching)
 *   - `event.emergency`    → Reporter.pushEmergency (Discord)
 *   - `hello`              → server replies with current Strategy via ws.send (strategy.full)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { WsServer } from "./ws_server.js";
import { HttpServer } from "./http_server.js";
import { SaveCoordinator } from "./save_coordinator.js";
import { SaveCoordinatorManager, FailureAggregatorManager, ReporterManager } from "./multitenant_managers.js";
import { Reporter } from "./reporter.js";
import { StrategyManager } from "./strategy_manager.js";
import type { GoalRow } from "./goals_types.js";
import { needsFoodCascade } from "./lifeform_balance.js";
import { GoalsStorePg } from "./goals_store_pg.js";
// Phase 7a — DualReadGoalsStore + db_mode (sqlite|dual|pg) removed. PG is now
// the sole reader path. Rollback = revert this commit.
// resolveDbMode removed in Phase 7a — no more mode switch.
// Phase 7d — WorldStateStore SQLite class deleted (PG primary).
import { WorldStateStorePg } from "./world_state_store_pg.js";
import { getCurrentUserId } from "./user_context.js";
import { GeminiClient } from "./gemini_client.js";
import { parseGoalFromNL } from "../tools/add_goal.js";
import { PriorityMerger } from "./priority_merger.js";
import { planGoal, pickEnergyPrereqBuilding, solarProduction, fusionProduction, mineEnergyConsumption, ENERGY_GATED_BUILDINGS, markFieldsFull } from "./planner.js";
import { buildHealthReport } from "./health.js";
import { DebugBuffer } from "./debug_buffer.js";
import {
  createFailureAggregator,
  type FailureAggregator,
} from "./failure_aggregator.js";
import {
  startMemoryWriter,
  type MemoryWriterHandle,
} from "./memory_writer.js";
import {
  startDigestScheduler,
  type DigestSchedulerHandle,
} from "./digest_scheduler.js";
import type {
  AnalyzeInput,
  AnalyzeResult,
} from "../llm/strategy_analyzer.js";
import type {
  DownstreamMsg,
  Strategy,
  UpstreamMsg,
  WorldState,
} from "@ogamex/shared";
import { TECH_TREE, LIFEFORM_TECH, techSec } from "@ogamex/shared";

interface PrereqTreeNode {
  tech: string;
  targetLevel: number;
  currentLevel: number;
  kind: "research" | "building";
  met: boolean;
  children: PrereqTreeNode[];
  eta_seconds?: number | null;
  subtree_eta_seconds?: number;
  // v0.0.791 — operator "建造和研究看不出先后顺序". queue_label = ogame 真实
  // 执行序: R1/R2 (global research_q serial), B1@<planet> (per-planet build_q),
  // S1@<planet> (shipyard_q). DFS post-order = ogame "prereq 先, root 后" 真序.
  queue_label?: string;
}

export interface SidecarConfig {
  wsPort: number;
  httpPort: number;
  bridgeToken: string;
  discordChannelId?: string;
  /** Where to store strategy.json + git audit repo. Default ~/.openclaw/workspace/ogamex-strategy. */
  strategyRepoDir?: string;
  /** Path to goals SQLite file. Default ~/.openclaw/workspace/ogamex-goals.db. ":memory:" for tests. */
  goalsDbPath?: string;
  /** Path to world-state SQLite file. Default ~/.openclaw/workspace/ogamex-world.db.
   *  ":memory:" for tests. Persists every state.snapshot so sidecar restart
   *  recovers the WorldState mirror without waiting for the next userscript
   *  poll. Operator 2026-06-01 "要持久化 ogame 里面的所有数据". */
  worldStateDbPath?: string;
  /** OpenClaw memory dir. Default ~/.openclaw/workspace/memory. */
  memoryDir?: string;
  /** Gemini API key. Default process.env.GEMINI_API_KEY. */
  geminiApiKey?: string;
  /** Test-only override forwarded to FailureAggregator — bypasses Gemini. */
  analyzer?: (input: AnalyzeInput, llm: GeminiClient) => Promise<AnalyzeResult>;
}

export interface SidecarHandle {
  ws: WsServer;
  http: HttpServer;
  reporter: Reporter | null;
  strategyManager: StrategyManager;
  // Phase 7d — goalsStore + worldStateStore (SQLite) removed from handle.
  priorityMerger: PriorityMerger;
  failureAggregator: FailureAggregator;
  memoryWriter: MemoryWriterHandle;
  /** M8.2 daily digest publisher — exposes publishNow() for manual triggers. */
  digestScheduler: DigestSchedulerHandle;
  /** Current world-state mirror, populated by the state.snapshot handler. */
  stateRef: { current: WorldState | null };
  /**
   * Report current expedition slot usage. When no state.snapshot has arrived
   * yet, `state_ready` is false and used/max are -1 sentinels — operators can
   * use that to distinguish "no expeditions launched" from "haven't heard
   * from the userscript yet".
   */
  listExpedition(): {
    state_ready: boolean;
    used: number;
    max: number;
    paused: boolean;
  };
  /** Stop everything. */
  stop(): Promise<void>;
}

export interface StartSidecarOptions {
  /** Override the Discord transport. Tests inject a vi.fn; prod uses defaultDiscordSend. */
  sendDiscord?: (channelId: string, content: string) => Promise<void>;
  /**
   * Seed Strategy when the strategy repo is empty. When omitted, a minimal
   * stub Strategy is bootstrapped so the sidecar can still come up — useful
   * for the M4.5 transport-only smoke tests; production callers SHOULD pass
   * a real Strategy so the LLM and audit trail start from a sensible state.
   */
  defaultStrategy?: Strategy;
}

/** Conservative defaults — every required Strategy field present, every flag off. */
function bootstrapStrategy(): Strategy {
  return {
    version: 0,
    updated_at: Date.now(),
    updated_by: "userscript-bootstrap",
    reason: "bootstrap",
    daily: {
      expedition: {
        enabled: false,
        auto_fill_slots: false,
        source_planet: null,
        target_position: 16,
        fleet_templates: {},
        galaxy_strategy: {
          mode: "fixed",
          home_galaxy_first: true,
          switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
          cross_galaxy_deut_budget: 0,
        },
        cargo_load: { smallCargo_capacity_pct: 100, largeCargo_capacity_pct: 100 },
      },
      resource_balance: { enabled: false, trigger_overflow_pct: 90 },
      defense_replenish: { enabled: false, keep_minimum: {} },
      default_build: { enabled: false, strategy: "balanced", ratio: {} },
      heartbeat: { enabled: false, schedule: [] },
    },
    emergency: {
      attack: {
        save_window_minutes: 15,
        prefer_moon: true,
        alliance_safe_planets: [],
        safety_margin_minutes: 2,
      },
      spy: { push_immediate: true, counter_spy: false, log_attacker: true },
      anomaly: { push_immediate: true, pause_planet_automation: false },
      resource_critical: { threshold_pct: 95, try_redistribute_first: true },
    },
    audit_rules_thresholds: {},
  };
}

// All UpstreamMsg variants we relay between transports. Keep in sync with
// `UpstreamMsg["type"]` in @ogamex/shared. We can't enumerate a TS union at
// runtime, so this list is the source of truth for the relay.
const UPSTREAM_TYPES: ReadonlyArray<UpstreamMsg["type"]> = [
  "hello",
  "state.snapshot",
  "event.emergency",
  "event.daily_failure",
  "event.directive_completed",
  "event.extractor_failure",
  "audit.condition_unmet",
  "pong",
];

/**
 * Default workspace root. Under vitest we land in a *fresh per-boot* tmp
 * directory so multiple `startSidecar` calls in the same suite never step on
 * each other's git repo or sqlite file. Production resolves to the canonical
 * `~/.openclaw/workspace`.
 */
function defaultWorkspaceDir(): string {
  if (process.env["VITEST"] === "true" || process.env["VITEST"] === "1") {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ogamex-sidecar-"));
  }
  return path.join(os.homedir(), ".openclaw", "workspace");
}

/**
 * Stand-in WorldState used when the failure-aggregator triggers an LLM
 * analysis before the userscript has sent its first `state.snapshot`. Real
 * traffic almost certainly arrives in the opposite order, but the contract
 * still has to be honored — `getState` must never return null.
 */
function emptyWorldState(): WorldState {
  return {
    server: { universe: "", speed: 1 },
    player: { id: "", name: "", alliance: null },
    planets: {},
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: 0,
    page_snapshots: {},
  };
}

/**
 * Walk every planet in the new snapshot and compare ship counts against the
 * previous snapshot. For each ship type whose count INCREASED on a planet,
 * find an active build_ships goal targeting that ship on that planet and
 * decrement its `amount` by the delta. When the remaining amount drops to
 * <= 0, mark the goal completed.
 */
// Phase 7c.5.f — async PG primary. SQLite store retired; reader supplies
// active goals per uid. Caller (state.snapshot handler) fires-and-forgets
// because ship-progress is a non-critical optimization tracker.
async function updateBuildShipsProgress(
  prev: WorldState,
  next: WorldState,
  reader: { listActiveByUser: (uid: string) => Promise<GoalRow[]> } | null,
  uid: string | null,
  pgStore?: WorldStateStorePg | null,
): Promise<void> {
  if (!reader || !uid || !pgStore) return;
  const activeRows = await reader.listActiveByUser(uid);
  // Index active build_ships goals by (planet_id || "", ship) for O(1) lookup.
  const goalByKey = new Map<string, { goalId: string; remaining: number }>();
  for (const row of activeRows) {
    if (row.goal.type !== "build_ships") continue;
    const t = row.goal.target as { ship?: unknown; amount?: unknown; planet?: unknown };
    const ship = typeof t.ship === "string" ? t.ship : "";
    if (!ship) continue;
    const planetRef =
      (typeof t.planet === "string" && t.planet) || row.goal.planet || "";
    const amount = typeof t.amount === "number" ? t.amount : 0;
    const key = `${planetRef}::${ship}`;
    goalByKey.set(key, { goalId: row.goal.id, remaining: amount });
  }
  if (goalByKey.size === 0) return;

  for (const [planetId, planet] of Object.entries(next.planets ?? {})) {
    const prevPlanet = prev.planets?.[planetId];
    if (!prevPlanet) continue;
    const prevShips = prevPlanet.ships ?? {};
    const newShips = planet.ships ?? {};
    for (const [ship, newCountRaw] of Object.entries(newShips)) {
      const newCount = typeof newCountRaw === "number" ? newCountRaw : 0;
      const prevCount = (prevShips as Record<string, number | undefined>)[ship] ?? 0;
      const delta = newCount - prevCount;
      if (delta <= 0) continue;
      // Try planet-id key first, then coord key, then unscoped (no planet).
      const coordKey = planet.coords.join(":");
      const candidates = [
        `${planetId}::${ship}`,
        `${coordKey}::${ship}`,
        `::${ship}`,
      ];
      let match: { goalId: string; remaining: number } | undefined;
      let matchKey: string | undefined;
      for (const k of candidates) {
        const found = goalByKey.get(k);
        if (found) { match = found; matchKey = k; break; }
      }
      if (!match || !matchKey) continue;
      const newRemaining = match.remaining - delta;
      const matchedId = match.goalId;
      try {
        const newAmountTarget = { amount: Math.max(0, newRemaining) };
        await pgStore.updateGoalTarget(uid, matchedId, newAmountTarget);
        if (newRemaining <= 0) {
          await pgStore.updateGoalStatus(uid, matchedId, "completed", null);
          goalByKey.delete(matchKey);
        } else {
          // Refresh map so subsequent deltas this tick stay accurate.
          goalByKey.set(matchKey, { goalId: matchedId, remaining: newRemaining });
        }
      } catch (e) {
        console.error("[ogamex/sidecar] ship-progress update failed", matchedId, e);
      }
    }
  }
}

/**
 * Spin up all sidecar servers, M5/M6 components, and (optionally) the
 * Reporter. Resolves only after both servers are listening.
 */
export async function startSidecar(
  config: SidecarConfig,
  opts?: StartSidecarOptions,
): Promise<SidecarHandle> {
  const effectiveOpts: StartSidecarOptions = opts ?? {};
  // -------------------------------------------------------------------------
  // Bootstrap order: persistent stores first (so the rest of the pipeline can
  // assume strategy.json + goals.db exist), then transports, then live
  // wiring. Anything that needs a clock or async I/O happens via injection
  // so this whole function stays synchronous up to the `await` on .start().
  // -------------------------------------------------------------------------

  const workspaceDir = defaultWorkspaceDir();

  const strategyRepoDir = config.strategyRepoDir ?? path.join(workspaceDir, "ogamex-strategy");
  const goalsDbPath = config.goalsDbPath ?? path.join(workspaceDir, "ogamex-goals.db");
  const worldStateDbPath = config.worldStateDbPath ?? path.join(workspaceDir, "ogamex-world.db");
  const memoryDir = config.memoryDir ?? path.join(workspaceDir, "memory");

  const strategyManager = new StrategyManager({
    repoDir: strategyRepoDir,
    defaultStrategy: effectiveOpts.defaultStrategy ?? bootstrapStrategy(),
  });
  // init() is idempotent — safe to call even when the repo already exists.
  strategyManager.init();

  // Phase 7d (v0.0.784) — SQLite GoalsStore + WorldStateStore 删完. legacyUid 仍用作
  // PG hydrate uid (operator's tenant). dbPath options ignored (无 SQLite file).
  const legacyUid = process.env.OGAMEX_LEGACY_USER_ID ?? "";
  void goalsDbPath;
  void worldStateDbPath;

  // Phase 8a — Postgres shadow writer (multi-tenant). When
  // OGAMEX_OPERATOR_USER_ID is set + DATABASE_URL is reachable, every
  // SQLite mutation also fires async into ogame_* tables under that user
  // id. Lets ogame-next /dashboard read live state via Drizzle without
  // coupling to this process. Failure paths are best-effort: a Postgres
  // outage never blocks the SQLite primary write.
  const pgUserId = process.env.OGAMEX_OPERATOR_USER_ID ?? "";
  const pgUrl = process.env.DATABASE_URL ?? "";
  let pgStore: WorldStateStorePg | null = null;
  // Phase 9b — DATABASE_URL alone is sufficient to enable Postgres routing.
  // OGAMEX_OPERATOR_USER_ID is now opt-in fallback for env-driven legacy
  // setups; multi-tenant push (per-user Bearer) routes via ALS regardless.
  if (pgUrl) {
    try {
      pgStore = new WorldStateStorePg({ databaseUrl: pgUrl });
      const mode = pgUserId
        ? `legacy single-tenant fallback uid=${pgUserId.slice(0, 8)}…`
        : "pure multi-tenant (per-Bearer ALS routing)";
      console.info(`[ogamex/sidecar] Postgres writer enabled — ${mode}`);
    } catch (e) {
      console.warn("[ogamex/sidecar] Postgres init failed (sqlite primary continues):", e);
    }
  } else {
    console.info("[ogamex/sidecar] Postgres writer DISABLED (set DATABASE_URL to enable)");
  }
  // Phase 7a — PG is the sole goal reader. Dual-read drift observer / mode
  // switch (OGAMEX_DB_MODE) retired; PriorityMerger gets GoalsStorePg directly.
  let goalsStorePg: GoalsStorePg | null = null;
  if (pgStore) {
    try {
      // Share the WorldStateStorePg pool — avoids double-connecting.
      const sharedSql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
      goalsStorePg = new GoalsStorePg({ sql: sharedSql });
      console.info("[ogamex/sidecar] GoalsStorePg constructed (sharing pgStore pool)");
    } catch (e) {
      console.warn("[ogamex/sidecar] GoalsStorePg init failed:", e);
    }
  } else {
    console.info("[ogamex/sidecar] GoalsStorePg DISABLED (no pgStore — SQLite-only fallback)");
  }
  /** Best-effort shadow fire — never throws, never blocks. Phase 9b:
   *  per-request AsyncLocalStorage user_id (from HttpServer resolving
   *  Bearer token to PG user) is the PRIMARY routing key. env default
   *  is fallback ONLY for non-HTTP-triggered paths (boot hydrate,
   *  background timers) — every authenticated push hits the ALS path.
   *  Silently skip when no user_id resolvable: that's the right behavior
   *  for "global token" / "unauthenticated" paths which shouldn't write
   *  to any user partition. */
  const shadowFire = (label: string, fn: (uid: string) => Promise<unknown>): void => {
    if (!pgStore) return;
    const ctxUid = getCurrentUserId();
    const uid = ctxUid || pgUserId;
    if (!uid) {
      // No per-request user context AND no env default → write goes to
      // SQLite only. Phase 9b makes this an EXPECTED case (operator using
      // global token = legacy debug channel), not a warn-worthy gap.
      return;
    }
    fn(uid).catch((e) => {
      console.warn(`[ogamex/sidecar/pg] ${label} failed (uid=${uid.slice(0,8)}…):`, e instanceof Error ? e.message : e);
    });
  };
  // Phase 7b — events trim + WAL checkpoint were SQLite-specific maintenance.
  // PG has its own retention story; PG event trim still happens via
  // pgStore.trimEvents called from the appendEvent paths where shadowFire
  // fires after each insert. The SQLite trim / WAL checkpoint hooks are
  // removed here as dead code (Proxy already noop'd them under SQLITE_WRITE
  // = off, but keeping the call sites was just noise).

  // Phase 7c.5.a (2026-06-05) — daemon-side reconciler retired.
  // ogamex_discord_bridge.mjs no longer opens goals.db (Phase 7c.4); the
  // 30s SQLite↔PG drift sweep this hack was paid to absorb has nothing
  // left to reconcile. Sidecar writes PG primary (7c.2/7c.3.*), daemon
  // writes PG primary (7c.4) — single source of truth, no double-write.

  const apiKey = config.geminiApiKey ?? process.env["GEMINI_API_KEY"] ?? "";
  // We construct the Gemini client unconditionally — even an empty key — so
  // downstream callers can still hold the reference. Real calls would fail
  // with a 4xx from the API, but tests inject `analyzer` and never hit it.
  const geminiClient = new GeminiClient({ apiKey });

  // --- WorldState mirror + userscript liveness -----------------------------
  // Declared up here (before the transports) so the M8.1 healthReporter can
  // close over them at HttpServer construction time. Both are populated by
  // the `state.snapshot` handler registered further below.
  const stateRef: { current: WorldState | null } = { current: null };
  const lastSeen: { at: number | null } = { at: null };
  const sidecarStartedAt = Date.now();

  // Phase 9c.1 — per-user WorldState mirror. state.snapshot handler routes
  // by ALS user_id when present; PriorityMerger / SaveCoord / FailureAgg
  // still operate on the legacy single-tenant stateRef (9c.2/3 will lift
  // those). Read paths (/v1/state with Bearer, /api/me/state in Next.js
  // via Drizzle) already prefer the per-user partition.
  const userStates = new Map<string, WorldState>();
  const userLastSeen = new Map<string, number>();
  /** Lookup a user's latest snapshot, falling back to operator legacy. */
  const getUserState = (userId: string | undefined): WorldState | null => {
    if (userId && userStates.has(userId)) return userStates.get(userId) ?? null;
    return stateRef.current;
  };
  void getUserState; // re-export later as we wire read paths

  // Hydrate stateRef from persisted blob BEFORE transports start. Lets
  // priorityMerger / health / debug endpoints have a real WorldState even
  // before the userscript's first state.snapshot. Corrupt blob → null +
  // warn so boot still completes (next snapshot will overwrite).
  // v0.0.724 — operator 2026-06-03 "sqlite 马上要放弃了 用PG". Hydrate
  // PRIMARILY from PG (ogame_world_state table) for the legacy operator
  // uid. SQLite still tried as fallback only if PG returns null or fails.
  try {
    let persisted: { state: WorldState; updated_at: number } | null = null;
    let source = "sqlite";
    if (pgStore && legacyUid) {
      try {
        const pgPersisted = await pgStore.hydrate(legacyUid);
        if (pgPersisted !== null) {
          persisted = pgPersisted;
          source = "pg";
        }
      } catch (e) {
        console.warn("[ogamex/sidecar] PG hydrate failed, will try SQLite fallback:", e);
      }
    }
    if (persisted === null) {
      const sqlitePersisted = null; // Phase 7d — SQLite hydrate retired (PG primary)
      if (sqlitePersisted !== null) {
        persisted = sqlitePersisted;
        source = "sqlite-fallback";
      }
    }
    if (persisted !== null) {
      stateRef.current = persisted.state;
      const ageMin = Math.round((Date.now() - persisted.updated_at) / 60_000);
      console.info(`[ogamex/sidecar] hydrated WorldState from ${source} (age ${ageMin}min, last_update=${persisted.state.last_update})`);
    } else {
      console.info("[ogamex/sidecar] no persisted WorldState (neither PG nor SQLite) — waiting for first state.snapshot");
    }
  } catch (e) {
    console.warn("[ogamex/sidecar] WorldState hydrate failed (corrupt blob?), continuing with null:", e);
  }

  // Debounced upsert to ride atop the high-frequency state.snapshot stream.
  // 1s window matches MemoryWriter's debounce — every snapshot triggers one
  // pending write, repeated snapshots inside the window collapse to one.
  // Operator 2026-06-01 "事件驱动也要更新后台数据" — the snapshot handler
  // already covers full-state replacement; event-driven deltas land via
  // state_store.setPartial → next snapshot includes them.
  const WORLD_STATE_DEBOUNCE_MS = 1000;
  // v0.0.858 — operator 2026-06-06 "新号第二颗星优化有问题没建造重氢工厂".
  // 真因: stateRef.current 是 module-level global, 任何 user push snapshot 都覆写.
  // 老 scheduleWorldStatePersist 1s debounce 期间, 别 user 的 snapshot 把 global
  // 改了 → timer fire 时读 stateRef.current 已不是 schedule 时 user 的 snap → 写
  // user A 的 PG row 写成 user B 的 snap (cross-tenant 污染). 顶层修法: per-uid
  // debounce 状态, schedule 时 capture uid + snapshot, fire 时读 captured value
  // 不再读 global.
  const perUidWriteTimer = new Map<string, NodeJS.Timeout>();
  const perUidPendingSnap = new Map<string, WorldState>();
  const scheduleWorldStatePersist = (snap: WorldState, uid: string): void => {
    if (!uid) return; // legacy / no-uid: skip persist (matches pre-857 silent path)
    perUidPendingSnap.set(uid, snap);
    if (perUidWriteTimer.has(uid)) return;
    const t = setTimeout(() => {
      perUidWriteTimer.delete(uid);
      const pending = perUidPendingSnap.get(uid);
      perUidPendingSnap.delete(uid);
      if (!pending) return;
      // v0.0.725 — Phase 6b (task #163, operator 2026-06-03 "sqlite 马上要
      // 放弃了 用PG"): PG-only primary write for world_state. SQLite write
      // dropped — fallback hydrate path (worldStateStore.hydrate) still kept
      // for crash safety until Phase 7 deletes SQLite entirely.
      if (!pgStore) return;
      void pgStore.upsertWorldState(uid, pending).catch((e) => {
        console.warn(`[ogamex/sidecar/pg] upsertWorldState failed (uid=${uid.slice(0,8)}…):`, e instanceof Error ? e.message : e);
      });
    }, WORLD_STATE_DEBOUNCE_MS);
    perUidWriteTimer.set(uid, t);
  };
  const flushWorldStatePersist = (): void => {
    // Shutdown / explicit flush — drain every per-uid pending snap immediately.
    for (const [uid, t] of perUidWriteTimer) clearTimeout(t);
    const drains = Array.from(perUidPendingSnap.entries());
    perUidWriteTimer.clear();
    perUidPendingSnap.clear();
    if (!pgStore) return;
    for (const [uid, snap] of drains) {
      void pgStore.upsertWorldState(uid, snap).catch((e) => {
        console.warn(`[ogamex/sidecar/pg] flushWorldState failed (uid=${uid.slice(0,8)}…):`, e instanceof Error ? e.message : e);
      });
    }
  };

  // --- DebugBuffer (M8.5) --------------------------------------------------
  // Rings the last 100 dispatched directives + 100 upstream events. Wired
  // into both the PriorityMerger send path and the cross-transport relay
  // further below. Constructed up here so the HttpServer constructor can
  // close over `debug.snapshot` for the /v1/debug HTML page.
  const debug = new DebugBuffer();

  // --- Transports ----------------------------------------------------------
  // v0.0.549 — operator 2026-05-31 "没用过 ws 就删了吧". WS path was never
  // actually used in production (operator's localStorage OGAMEX_BRIDGE_URL
  // defaults to https:// → HttpBridgeClient long-poll). WsServer kept causing
  // false "connected=false" health reports and WS-specific debugging cycles.
  // Replace with a no-op stub that satisfies the type but doesn't bind any
  // port or accept connections. All `ws.send(...)` writes are paired with
  // `http.queueDownstream(...)` already — HTTP path is the single source of
  // delivery. `ws.on = wrapOn` mutation below still works (assigns to stub
  // method, harmless).
  // Operator 2026-06-04 — un-stub WsServer; CF tunnel will route /ws via
  // same-port Upgrade (attachToHttpServer below after http.start()). The
  // original stub from v0.0.638 was because WsServer self-spawned a port
  // and caused false-positive "connected=false" health reports; new attach
  // mode reuses HttpServer's port + ping sweep keeps liveness honest.
  // resolveUserToken: per-user Bearer support so non-global tokens
  // (operator's PG bridge_token) can connect WS and be uid-tagged for
  // per-user broadcast routing.
  const ws = new WsServer({
    port: config.wsPort,
    token: config.bridgeToken,
    ...(pgStore ? {
      resolveUserToken: async (bearer: string): Promise<string | null> => {
        if (!bearer) return null;
        try {
          const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
          const rows = await sql`SELECT user_id FROM user_settings WHERE bridge_token = ${bearer} LIMIT 1`;
          const row = rows[0] as { user_id?: string } | undefined;
          return row?.user_id ?? null;
        } catch (e) {
          console.warn("[ws] resolveUserToken threw", e);
          return null;
        }
      },
    } : {}),
  });
  // v0.0.459 forward-decl: priorityMerger is constructed later (after planner
  // + saveCoordinator wiring) but HttpServer's CRUD endpoints (cancelGoal,
  // resumeGoal, etc.) close over it for event-triggered dispatch. Holds the
  // ref so closures stay typesafe; assigned at line ~1055 just after
  // `new PriorityMerger(...)`.
  let priorityMergerRef: PriorityMerger | null = null;
  // v0.0.500 — track fleet IDs we've already fired debris-check for, so each
  // expedition triggers at most one explorer dispatch even if /movement
  // scrape flaps (fleet appears, disappears, reappears across snapshots).
  // v0.0.677 — operator 2026-06-03 实测: sidecar 8.5h 0 FIRED. Root cause:
  // v0.0.674 single-Signal-B design required `return_at !== null` but ogame
  // v12 on this server frequently leaves return_at NULL for expeditions even
  // when fleet is truly returning. Result: Signal B never crossed the gate.
  // Restored Signal C (arrival_at past→future phase jump) as fallback so the
  // path no longer depends solely on return_at populating. Per-signal dedup
  // (was per-fleet) so B and C each fire once independently — avoids the
  // v0.0.574 holding-entry false-fire dedup-then-block scenario.
  const firedDebrisCheckFor = new Map<string, Set<"B" | "C">>();
  // v0.0.501 — fallback signal: track last-seen origin/dest per expedition
  // fleet so we can fire debris-check when fleet disappears from outbound.
  // v0.0.502 — also track last arrival_at so we can detect phase transition
  // (arrival_at jumps from past to future = fleet entered next phase, which
  // for expedition mission means exploration ended → returning home).
  // v0.0.574 — also track return_at so Signal B can distinguish:
  //   - fleet disappear with return_at === null → entered HOLDING (skip)
  //   - fleet disappear with return_at !== null → truly RETURNED HOME (fire)
  // operator 2026-06-01 实证: fleet 2353595 1:486 entered holding at 15:19,
  // disappeared from /movement, Signal B mis-fired (太早, no debris yet),
  // dedup then blocked the real "returned home" disappear @ 15:40 → no harvest.
  const expLastSeen = new Map<string, { origin: readonly number[]; dest: readonly number[]; arrival_at: number | null; return_at: number | null }>();
  // v0.0.818 — operator 2026-06-05 "2:260:9 远征回来了没有触发自动回收".
  // sidecar restart 期间 expedition return → in-memory expLastSeen 丢 →
  // Signal B miss. 文件持久化, restart 重 load. firedDebrisCheckFor 也持久
  // 防 重 fire (fleet id 全宇宙单调递增, 重启后看到旧 id 已 fired).
  const EXP_PERSIST_PATH = `${process.env.HOME ?? "/tmp"}/.openclaw/workspace/ogamex/exp_state.json`;
  try {
    const raw = fs.readFileSync(EXP_PERSIST_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      expLastSeen?: Array<[string, { origin: number[]; dest: number[]; arrival_at: number | null; return_at: number | null }]>;
      firedDebrisCheckFor?: Array<[string, Array<"B" | "C">]>;
    };
    if (Array.isArray(parsed.expLastSeen)) {
      for (const [k, v] of parsed.expLastSeen) expLastSeen.set(k, v);
    }
    if (Array.isArray(parsed.firedDebrisCheckFor)) {
      for (const [k, arr] of parsed.firedDebrisCheckFor) firedDebrisCheckFor.set(k, new Set(arr));
    }
    console.info(`[exp-persist] loaded ${expLastSeen.size} expLastSeen + ${firedDebrisCheckFor.size} firedDebrisCheckFor entries from ${EXP_PERSIST_PATH}`);
  } catch (e) {
    if ((e as { code?: string })?.code !== "ENOENT") console.warn("[exp-persist] load threw", e);
  }
  const persistExpState = (): void => {
    try {
      const data = {
        expLastSeen: Array.from(expLastSeen.entries()),
        firedDebrisCheckFor: Array.from(firedDebrisCheckFor.entries()).map(([k, s]) => [k, Array.from(s)]),
      };
      fs.writeFileSync(EXP_PERSIST_PATH, JSON.stringify(data));
    } catch (e) { console.warn("[exp-persist] save threw", e); }
  };
  const persistTimer = setInterval(persistExpState, 30_000);
  if (typeof (persistTimer as unknown as { unref?: () => void }).unref === "function") {
    (persistTimer as unknown as { unref: () => void }).unref();
  }
  const triggerDispatch = (): void => {
    if (!priorityMergerRef) return;
    // Phase 9c.7 hotfix — read ALS uid. When this runs inside a Bearer-
    // wrapped request frame (createGoal, cancelGoal etc.) the merger MUST
    // restrict dispatch to that caller's goals. Without this, operator's
    // expedition goals would dispatch under the foreign caller's ALS, and
    // queueDownstream would route operator's directives into the foreign
    // user's poll bucket → operator's userscript never receives them.
    // Real incident 2026-06-02: daigang's createGoal trigger ran the
    // merger → operator's 5 active expeditions queued into daigang's
    // bucket → operator's "没自动发远征".
    const uid = getCurrentUserId();
    const userState = uid ? userStates.get(uid) : undefined;
    const state = userState ?? stateRef.current ?? emptyWorldState();
    // v0.0.669 — merger.dispatch is async (Phase 5b). Fire-and-forget
    // with .catch to keep this trigger sync (called from event handlers
    // that don't await).
    priorityMergerRef.dispatch(state, uid).catch((e) =>
      console.error("[merger] triggerDispatch threw", e),
    );
  };
  // Operator 2026-06-04 "全做" — section_settings push forwarder. Sidecar's
  // sectionSettingsWrite callback (defined inside this httpServerCtor opts
  // block) needs to broadcast to userscript so in-game panel reflects
  // without F5. http itself is constructed AFTER this block, so we hold a
  // mutable forwarder; reassigned at line ~1801 after `const http = ...`.
  let broadcastSectionUpdate: (uid: string, settings: Record<string, string | boolean>) => void
    = () => { /* no-op until http is wired */ };
  // The HttpServer's /v1/health route delegates to buildHealthReport via a
  // thunk closure — needs `stateRef`, `lastSeen`, and the `ws.clients` set,
  // all of which exist before this point. The thunk is invoked per-request.
  const httpServerCtor = (): HttpServer => new HttpServer({
    port: config.httpPort,
    token: config.bridgeToken,
    healthReporter: () => buildHealthReport({
      startedAt: sidecarStartedAt,
      lastUserscriptSeenAt: lastSeen.at,
      // WsServer.clients is private; we read it via a structural cast. This
      // matches the comment in the M8.1 spec — we don't want to break the
      // WsServer encapsulation by adding a public method just for health.
      // v0.0.549 — HTTP-only mode: "bridge open" means we saw an upstream
       // message from the userscript within the last 60s. last_seen is
       // bumped whenever any upstream msg (state.snapshot / event.* / hello)
       // arrives via /ogamex/v1/push. Replaces the prior ws.clients.size>0
       // check which was always false in HTTP-only mode.
      bridgeOpen: () => lastSeen.at !== null && Date.now() - lastSeen.at < 60_000,
      llmPing: () => pingGemini(geminiClient),
      stateRef,
      strategyVersion: () => strategyManager.load().version,
      // Phase 9c.1 — multi-tenant snapshot observability.
      multiTenantSnapshot: () => {
        const tracked = userStates.size;
        let maxAge: number | null = null;
        if (userLastSeen.size > 0) {
          const oldest = Math.min(...Array.from(userLastSeen.values()));
          maxAge = Math.round((Date.now() - oldest) / 1000);
        }
        return {
          users_tracked: tracked,
          last_seen_max_age_seconds: maxAge,
          save_coord_instances: saveCoordManager.size(),
          failure_agg_instances: failureAggManager.size(),
          reporter_instances: reporterManager?.size() ?? 0,
          poll_buckets: http.pollBucketSizes(),
        };
      },
      // v0.0.638 — surface persistence-tier stats so operators can confirm
      // the SQLite store is non-empty / not silently truncated. Wrapped in
      // try/catch inside buildHealthReport already.
      persistenceStats: () => {
        let dbSize = 0;
        let walSize = 0;
        try { dbSize = fs.statSync(worldStateDbPath).size; } catch { /* fresh install */ }
        try { walSize = fs.statSync(`${worldStateDbPath}-wal`).size; } catch { /* WAL may be 0 */ }
        return {
          db_path: worldStateDbPath,
          db_size_bytes: dbSize,
          wal_size_bytes: walSize,
          row_counts: { events: 0, save_records: 0, failure_cooldowns: 0, world_state_present: stateRef.current !== null },
        };
      },
    }),
    debugSnapshot: () => debug.snapshot(),
    // Phase 9a — per-user Bearer → user_id resolver via Postgres
    // (user_settings.bridge_token UNIQUE index → O(1) lookup per push).
    // Wraps handlePush in AsyncLocalStorage so shadow writes pick up
    // the right multi-tenant user_id.
    ...(pgStore
      ? {
          resolveUserToken: async (bearer: string): Promise<string | null> => {
            if (!bearer) return null;
            try {
              const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
              const rows = await sql`SELECT user_id FROM user_settings WHERE bridge_token = ${bearer} LIMIT 1`;
              const row = rows[0] as { user_id?: string } | undefined;
              return row?.user_id ?? null;
            } catch (e) {
              console.warn("[ogamex/sidecar] resolveUserToken threw", e);
              return null;
            }
          },
          // S4 — operator "全做" bidir section_settings.
          sectionSettingsRead: async (uid: string): Promise<Record<string, unknown>> => {
            try {
              const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
              const rows = await sql`SELECT section_settings FROM user_settings WHERE user_id = ${uid} LIMIT 1`;
              const row = rows[0] as { section_settings?: Record<string, unknown> } | undefined;
              return row?.section_settings ?? {};
            } catch (e) {
              console.warn("[ogamex/sidecar] sectionSettingsRead threw", e);
              return {};
            }
          },
          sectionSettingsWrite: async (uid: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> => {
            const ALLOWED = new Set(["ogamex.emergency.paused", "OGAMEX_SPY_TRIGGERS_SAVE", "ogamex.expedition.paused", "OGAMEX_EMERGENCY_SOUND_ALARM", "ogamex.global.paused"]);
            const filtered: Record<string, string | boolean> = {};
            for (const [k, v] of Object.entries(patch)) {
              if (!ALLOWED.has(k)) continue;
              if (typeof v === "string" || typeof v === "boolean") filtered[k] = v;
            }
            const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
            const existing = await sql`SELECT section_settings FROM user_settings WHERE user_id = ${uid} LIMIT 1`;
            const cur = (existing[0] as { section_settings?: Record<string, unknown> } | undefined)?.section_settings ?? {};
            const merged = { ...cur, ...filtered };
            const mergedJson = sql.json(merged as unknown as import("postgres").JSONValue);
            await sql`
              INSERT INTO user_settings (user_id, section_settings, updated_at)
              VALUES (${uid}, ${mergedJson}, NOW())
              ON CONFLICT (user_id) DO UPDATE SET section_settings = ${mergedJson}, updated_at = NOW()
            `;
            // Operator 2026-06-04 "全做" — push to userscript so in-game panel
            // 即时 reflect, not "next F5". Forwarder set after http construction.
            try { broadcastSectionUpdate(uid, merged as Record<string, string | boolean>); } catch (e) { console.warn("[ogamex] broadcastSectionUpdate threw", e); }
            return merged;
          },
        }
      : {}),
    // Operator 2026-06-04 "flagship 信号灯" — surface ws-connected-by-uid to
    // HTTP layer so /v1/me/bridge-status can answer per-user.
    wsHasUidConnected: (uid: string): boolean => ws.hasUidConnected(uid),
    // Operator 2026-06-04 "红灯 = TM 离线" — derive last_push_ago from PG
    // ogame_world_state.updated_at. sidecar upserts that column on every
    // state.snapshot push (any transport). null when row missing.
    userLastSeenAgoSec: async (uid: string): Promise<number | null> => {
      if (!pgStore) return null;
      try {
        const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
        const rows = await sql`SELECT updated_at FROM ogame_world_state WHERE user_id = ${uid} LIMIT 1`;
        const row = rows[0] as { updated_at?: Date | string } | undefined;
        if (!row?.updated_at) return null;
        const ms = row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime();
        return Math.max(0, Math.floor((Date.now() - ms) / 1000));
      } catch (e) {
        console.warn("[ogamex] userLastSeenAgoSec threw", e);
        return null;
      }
    },
    // v0.0.766 — S14b 切服 stash 模式: 不是销毁 goal, 而是 stash 等切回来 restore.
    // reason 格式: 'server-switch-stash:<oldUniverse>'. status='cancelled' 但
    // reason 含 universe 标识, 切回该 universe 时自动 restore. operator:
    // "切回来的时候可以把持久化的数据拿回来复原现场吧?".
    serverSwitchCancelGoals: async (uid: string, reason: string): Promise<number> => {
      if (!pgStore) return 0;
      try {
        const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
        // reason 实际是 "server switched: oldUniverse → newUniverse" 我们解析 oldUniverse
        const m = reason.match(/server switched:\s*([^→\s]+)/);
        const oldUniverse = m?.[1] ?? "?";
        const stashReason = `server-switch-stash:${oldUniverse}`;
        const rows = await sql`UPDATE ogame_goals SET status = 'cancelled', reason = ${stashReason}, updated_at = NOW()
          WHERE user_id = ${uid} AND status NOT IN ('cancelled', 'completed') AND (reason IS NULL OR reason NOT LIKE 'server-switch-stash:%')
          RETURNING id`;
        return rows.length;
      } catch (e) {
        console.warn("[server-switch] stash goals SQL threw", e);
        return 0;
      }
    },
    // v0.0.766b — 切到新 universe 时, 查 cancelled goals 中 reason 匹配
    // 该 universe 的 stash, 全部 status='pending' reason=NULL 复原.
    serverSwitchRestoreGoals: async (uid: string, newUniverse: string): Promise<number> => {
      if (!pgStore) return 0;
      try {
        const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
        const stashReason = `server-switch-stash:${newUniverse}`;
        const rows = await sql`UPDATE ogame_goals SET status = 'pending', reason = NULL, updated_at = NOW()
          WHERE user_id = ${uid} AND status = 'cancelled' AND reason = ${stashReason}
          RETURNING id`;
        return rows.length;
      } catch (e) {
        console.warn("[server-switch] restore goals SQL threw", e);
        return 0;
      }
    },
    // v0.0.766 — S14 audit log: 写 ogame_events.type='event.server_switch'
    // 让 flagship ThreatListCard 旁边的 chip 显示历史.
    serverSwitchAppendEvent: async (uid: string, payload: Record<string, unknown>): Promise<void> => {
      if (!pgStore) return;
      try {
        await pgStore.appendEvent(uid, "event.server_switch", payload);
      } catch (e) {
        console.warn("[server-switch] appendEvent threw", e);
      }
    },
    // Operator API providers — surface state/goals/expedition over HTTP.
    stateProvider: (uid?: string) => {
      // 2026-06-05 — per-user routing for daemon optimizer + flagship.
      // Without uid → legacy global mirror. With uid → user-tenant mirror.
      // Null fallback (instead of cross-tenant) when uid given but no state
      // seeded, mirroring listGoals' fix to avoid "operator data appears
      // on daigang's first render" race.
      if (uid) {
        const us = userStates.get(uid);
        return us ?? { ok: false, reason: "no snapshot yet for user" };
      }
      return stateRef.current ?? { ok: false, reason: "no snapshot yet" };
    },
    listGoals: async (explicitUid?: string) => {
      // Phase 9c.7 — when explicitUid is supplied (foreign Bearer
      // resolved at the http layer), filter rows by user_id. Operator's
      // legacy panel passes nothing → goalsStore.list() returns ALL rows
      // including the historic NULL-user_id rows that pre-date 9c.4.
      // Phase 7b — read from PG when available (web /api/me/goals POSTs
      // write straight to PG and never touch sidecar SQLite, so SQLite
      // was missing the goal entirely → TM panel saw zero goals from
      // web-created chains). Fall back to SQLite only when pgStore boot
      // failed (single-process degraded mode).
      const pgRows = goalsStorePg && explicitUid
        ? await goalsStorePg.list(explicitUid)
        : null;
      // 2026-06-05 — per-user state for simulate(). Without this the panel's
      // prereq tree was rendering against whichever user most recently pushed
      // state.snapshot (typically the legacy operator on s274), so daigang's
      // s275 colonize tree showed shipyard L12 / robotics L15 — operator's
      // levels, not daigang's. userStates is the per-tenant mirror populated
      // by the ws.on("state.snapshot") handler. currentState mirrors the
      // same per-user routing for every state surface (research levels,
      // research queue) read inside listGoals.
      const userState = explicitUid ? userStates.get(explicitUid) : undefined;
      // 2026-06-05 — operator "每次第一次点开是错的, 再点就对了": when an
      // explicit uid is supplied but state mirror hasn't seeded yet (TM
      // boot race — first /v1/goals fetch beats first state.snapshot push),
      // fall back to NULL rather than stateRef.current. The global mirror
      // is whichever user pushed last (typically operator) — using it
      // contaminates the new user's first prereq tree with the legacy
      // operator's planet/research levels. NULL gives planets={} and
      // research={}; simulate emits a benign empty tree instead.
      const currentState = explicitUid ? (userState ?? null) : (userState ?? stateRef.current);
      const planets = (currentState?.planets ?? {});
      const idToCoords = (ref: string | undefined): string | undefined => {
        if (!ref) return undefined;
        if (/^\d+:\d+:\d+$/.test(ref)) return ref;
        const p = planets[ref];
        return Array.isArray(p?.coords) ? p.coords.join(":") : ref;
      };
      // Unified execution simulator — walks subtree in serial order
      // (children before self), maintains running resource bank with
      // accumulation during wait+build, applies storage cap. Returns total
      // seconds and per-node contribution. Replaces the old per-node
      // sum-with-no-carryover which over-estimated wait time when prior
      // levels' waits already accumulated future needs.
      // v0.0.809 — operator 2026-06-05 "L7 deuteriumSynth 720m ETA 服务器
      // 因子? TM 已经采集服务器时间了". multi-tenant bug: 之前用 global
      // stateRef (last-push tenant), 跨 tenant 串号. 新账号无 server.speed
      // 拿到 daigang 的 speed=8 — OR worse 反过来 拿 default 1 → simulate
      // build sec 膨胀 8×. 改 per-tenant currentState (跟 v0.0.788 astroLevel
      // fix 同款).
      const universeSpeed = currentState?.server?.speed ?? 1;
      const researchSpeed = currentState?.server?.research_speed ?? universeSpeed;
      // v0.0.773 — operator 2026-06-04 "昨天说好的 天体物理大于4以后就不
      // 考虑矿了 直接等待资源". Daemon v0.0.739 已加同款 gate (skip 优化器);
      // sidecar simulate 也同步: post-expedition phase (astro >= 4) 时 wait
      // 视为 0, 只计 build_sec — 不再按 production rate 推 21d/346d 等离谱
      // 数字, owner 用 transport 自己掌控资源 supply.
      // v0.0.810 — per-tenant fix同 v0.0.809: postExpeditionPhase 之前用
      // global stateRef → 决定 wait_sec 是否 skip 错串号. astro 18 (daigang)
      // 拿到 astro 0 (新账号 fallback) → wait_sec 不该 skip → simulate ETA
      // 膨胀 (operator L32 11h40m 怀疑案). 改 currentState 拿真正 tenant.
      const postExpeditionPhase = (currentState?.research?.levels?.astrophysics ?? 0) >= 4;
      function simulate(rootTechName: string, rootTargetLevel: number, rootKind: "research" | "building", planetId: string | undefined, useTreeBuilder: "regular" | "lifeform"): { tree: PrereqTreeNode | null; total: number; totalCost: { m: number; c: number; d: number }; bankAtStart: { m: number; c: number; d: number }; currentStep: { tech: string; kind: "research" | "building"; level: number; cost: { m: number; c: number; d: number } } | null } {
        const planet = planetId ? planets[planetId] ?? Object.values(planets)[0] : Object.values(planets)[0];
        // Initial bank — REAL planet resources at this moment.
        const bank: { m: number; c: number; d: number } = {
          m: planet?.resources?.m ?? 0,
          c: planet?.resources?.c ?? 0,
          d: planet?.resources?.d ?? 0,
        };
        // v0.0.730 — operator 2026-06-03 "按照服务器倍速计算就好了". Base
        // production.m_h is the UN-SPEED-ADJUSTED hourly rate (ogame's API
        // returns base rate; universe speed multiplier applies separately).
        // Without this, sM/(prod/3600) overestimates wait by `universeSpeed`x —
        // on Scorpius (speed=8), planner showed 8311d for a 1037-day reality
        // (and a properly-mined planet, ~130 days). v0.0.726 fixed
        // planner.ts wait formulas but missed this *primary* simulate loop.
        const prodPerSec = {
          m: (planet?.production?.m_h ?? 0) * universeSpeed / 3600,
          c: (planet?.production?.c_h ?? 0) * universeSpeed / 3600,
          d: (planet?.production?.d_h ?? 0) * universeSpeed / 3600,
        };
        // Storage caps (ogame v12 approximate; conservative — caps growth)
        const caps = {
          m: 5000 * Math.pow(2.5, planet?.buildings?.["metalStorage"] ?? 0),
          c: 5000 * Math.pow(2.5, planet?.buildings?.["crystalStorage"] ?? 0),
          d: 5000 * Math.pow(2.5, planet?.buildings?.["deuteriumTank"] ?? 0),
        };
        // Operator 2026-05-29: track ACCELERATOR levels as a mutable
        // baseline so subsequent build-self iterations and dependent
        // subtrees see freshly upgraded robotics/nanite/researchLab.
        // The old code captured these once at simulate-init and used the
        // stale value for every level of every node — so 7 levels of
        // naniteFactory all paid the L0 build-time (no 2× per-level
        // speedup), turning each level into ~6.8h * 2^L instead of the
        // ~6.8h-flat the real game gives once the previous level lands.
        const levels = {
          robotics: planet?.buildings?.["roboticsFactory"] ?? 0,
          nanite:   planet?.buildings?.["naniteFactory"]   ?? 0,
          lab:      planet?.buildings?.["researchLab"]     ?? 0,
        };
        // v0.0.756 — operator "为什么有两套算法 统一一下". Unified ogame build
        // time formula extracted to @ogamex/shared/build_time. Daemon
        // (discord_bridge.mjs buildSecondsForRange) imports compiled JS from
        // the same module — single source of truth.
        const buildSec = (cost: { m: number; c: number }, nodeKind: string): number =>
          techSec(cost, nodeKind, levels, universeSpeed, researchSpeed);
        const accumulate = (sec: number) => {
          // Operator 2026-05-29: pre-existing stockpile MAY exceed storage
          // cap (transport from other planets, expedition haul, lifeform
          // perks). Old code truncated `bank.m → cap` on every accumulate,
          // which made a fresh colony with 60M m + metalStorage L0
          // (cap=5000) appear to have only 5000 m available for the entire
          // simulation. Correct ogame semantics: production only accrues
          // while bank < cap; once over cap, production stops but the
          // stockpile stays. Existing over-cap reserves are not clobbered.
          if (bank.m < caps.m) bank.m = Math.min(bank.m + prodPerSec.m * sec, caps.m);
          if (bank.c < caps.c) bank.c = Math.min(bank.c + prodPerSec.c * sec, caps.c);
          if (bank.d < caps.d) bank.d = Math.min(bank.d + prodPerSec.d * sec, caps.d);
        };
        const timeToAfford = (cost: { m: number; c: number; d?: number }): number => {
          const sM = Math.max(0, cost.m - bank.m);
          const sC = Math.max(0, cost.c - bank.c);
          const sD = Math.max(0, (cost.d ?? 0) - bank.d);
          const tM = sM > 0 ? (prodPerSec.m > 0 ? sM / prodPerSec.m : Infinity) : 0;
          const tC = sC > 0 ? (prodPerSec.c > 0 ? sC / prodPerSec.c : Infinity) : 0;
          const tD = sD > 0 ? (prodPerSec.d > 0 ? sD / prodPerSec.d : Infinity) : 0;
          return Math.max(tM, tC, tD, 0);
        };
        let total = 0;
        // Operator 2026-05-29: track total resource cost across the entire
        // chain (self + all prereq levels). Panel subtracts current planet
        // bank to render a "缺 m/c/d" badge so operator knows exactly how
        // much to transport in.
        const totalCost = { m: 0, c: 0, d: 0 };
        const bankAtStart = { m: bank.m, c: bank.c, d: bank.d };
        // v0.0.461: capture FIRST-to-execute (deepest unmet leaf) step cost.
        // Operator 2026-05-29 "同时显示当前要做的任务缺多少资源" — total
        // shortage tells "how much to ship for full chain", current step
        // tells "what's blocking the very next dispatch". Filled by the
        // post-order visit in buildAndSimulate; only set ONCE (first hit).
        let currentStep: { tech: string; kind: "research" | "building"; level: number; cost: { m: number; c: number; d: number } } | null = null;
        // Walk and build the tree node objects. Each node gets eta_seconds
        // = its contribution (wait + build for its own levels), and
        // subtree_eta_seconds = total time from start through this node.
        function buildAndSimulate(techName: string, targetLevel: number, kind: "research" | "building", currentOverride?: number): PrereqTreeNode | null {
          let tech: { kind?: string; requires?: Record<string, number>; cost_at?: (l: number) => { m: number; c: number; d?: number; e?: number } } | undefined;
          let current = 0;
          let costFn: ((l: number) => { m: number; c: number; d?: number; e?: number }) | undefined;
          if (useTreeBuilder === "lifeform") {
            const species = ((planet as { lifeform?: { species?: string } } | null)?.lifeform?.species) ?? "humans";
            const catalog = LIFEFORM_TECH[species as keyof typeof LIFEFORM_TECH];
            if (!catalog) return null;
            const entry = catalog.buildings[techName];
            if (!entry) return null;
            const lfb = (planet as { lifeform_buildings?: Record<string, number> } | null)?.lifeform_buildings ?? {};
            current = lfb[techName] ?? 0;
            costFn = entry.cost_at as typeof costFn;
            tech = { requires: entry.requires };
          } else {
            tech = (TECH_TREE as unknown as Record<string, { kind?: string; requires?: Record<string, number>; cost_at?: (l: number) => { m: number; c: number; d?: number; e?: number } }>)[techName];
            if (!tech) return null;
            const techKind = tech.kind ?? "";
            const research = currentState?.research?.levels ?? {};
            // v0.0.456: when goal target body is a moon and the prereq is a
            // PLANET-ONLY building (researchLab, naniteFactory, terraformer,
            // mines, ...), fall back to highest level across all planets —
            // operator rule "星球上的研究所有效". Moon-allowed buildings
            // (roboticsFactory, shipyard, sensorPhalanx, jumpgate, lunarBase,
            // storage, missileSilo) MUST keep body-local lookup or robo L12
            // climb goal reads operator main planet's R12 as the moon's R →
            // shows 0h ETA (regression v0.0.456 first cut).
            const MOON_ALLOWED = new Set([
              "metalStorage", "crystalStorage", "deuteriumTank",
              "roboticsFactory", "shipyard", "lunarBase",
              "sensorPhalanx", "jumpgate", "missileSilo",
            ]);
            const lookupBuildingLevel = (bld: string): number => {
              const direct = planet?.buildings?.[bld] ?? 0;
              // v0.0.456 (refined): TWO independent network-wide cases:
              //   1) body=moon + building is planet-only → moon can't host, scan network
              //   2) building is researchLab → research-network-wide regardless of
              //      body type (operator 2026-05-29 issue: planet 4:299:8 has lab=0
              //      but operator's main planet has lab=15, computerTech research
              //      validated against that lab globally, panel showed phantom 0/1)
              const moonNeedsNetwork = planet?.type === "moon" && !MOON_ALLOWED.has(bld);
              const labAlwaysNetwork = bld === "researchLab";
              if (!moonNeedsNetwork && !labAlwaysNetwork) return direct;
              let best = direct;
              for (const p of Object.values(planets)) {
                if (p?.type !== "planet") continue;
                const lvl = p.buildings?.[bld] ?? 0;
                if (lvl > best) best = lvl;
              }
              return best;
            };
            current = currentOverride !== undefined ? currentOverride
                    : kind === "research" ? (research[techName] ?? 0)
                    : techKind === "ship" || techKind === "defense" ? ((planet?.ships as Record<string, number> | undefined)?.[techName] ?? 0)
                    : lookupBuildingLevel(techName);
            costFn = tech.cost_at as typeof costFn;
          }
          const children: PrereqTreeNode[] = [];
          // v0.0.739 — local flag, set by energy-gate per-level loop when
          // it emits interleaved children + does its own self-level work.
          // Skips the regular self loop below to avoid double-counting.
          let energyGateHandled = false;
          for (const [req, lvl] of Object.entries(tech?.requires ?? {})) {
            const subKind = useTreeBuilder === "lifeform"
              ? "building"
              : ((TECH_TREE as Record<string, { kind?: string }>)[req]?.kind === "research" ? "research" : "building");
            const node = buildAndSimulate(req, lvl, subKind);
            if (node) children.push(node);
          }
          // v0.0.785 — operator 2026-06-05 "酒足饭饱 小于 生活空间的时候 建
          // 农场反物质冷凝器" + "以前写好了，测试都通过了的". planner.ts:549
          // commit 6198be4 加了 kaelesh sanctuary→antimatterCondenser food
          // gate, simulate 漏同步 → panel prereq_tree 看不到 food 前置 cascade.
          // 镜像 planner 逻辑: 当 housing (living_space) > food (well_fed)
          // 时, emit food building cascade as child.
          // Phase 10 — needsFoodCascade 抽 shared helper (lifeform_balance.ts),
          // 跟 planner.ts:535 同源. operator memory planner/simulate 共享 SOP.
          if (useTreeBuilder === "lifeform" && kind === "building" && planet) {
            const species = ((planet as { lifeform?: { species?: string } } | null)?.lifeform?.species) ?? "humans";
            const lfBldg2 = (planet as { lifeform_buildings?: Record<string, number> } | null)?.lifeform_buildings ?? {};
            const lfr = (planet as { lifeform_resources?: { living_space?: number | null; well_fed?: number | null } } | null)?.lifeform_resources ?? null;
            const foodCheck = needsFoodCascade(techName, species, lfBldg2, lfr, current, targetLevel);
            if (foodCheck) {
              const foodChild = buildAndSimulate(foodCheck.rule.food, foodCheck.currentFoodLevel + 1, "building");
              if (foodChild) children.push(foodChild);
            }
          }
          // v0.0.737 — operator 2026-06-04 "补电厂的逻辑是有的, 已经自动建
          // 电厂了, 不要重复写代码, 复用". Mirror planner.ts's decision by
          // calling the SAME helper. Single source of truth: planner picks
          // the power plant for actual dispatch, simulate() shows it as a
          // tree child for panel visualization — both call the same fn so
          // the algorithms can never diverge.
          // v0.0.738 — operator 2026-06-04 "应该 fusion 17 完了 应该是 重氢
          // 工厂 31 然后 再建 fusion 18 最后才是 重氢32 树状展开". per-level
          // energy gate: iterate parent's self levels, for EACH level check
          // if energy goes negative; if so, add a plant child sized to cover
          // THIS level's incremental energy. Multiple plant children = the
          // full sequence visible in tree (fusion 17, fusion 18, ...).
          // Phase 11 — energy gate 扩到 lifeform path. ENERGY_GATED_BUILDINGS
          // 已包含 LF major buildings (antimatterCondenser 等), catalog cost_at(L).e
          // 真实有值时 cascade emit solarPlant 跟 regular path 同源.
          //
          // operator 2026-06-05 audit antimatterCondenser L48→L49: catalog
          // e=0 → cascade nest 退化为单 self-level node → 跟 parent duplicate.
          // 修: 入口检查 building 真实 energy delta, 0 时 skip gate (走普通 self
          // loop, 无 duplicate). 当 catalog e cost 修正后立刻自动 trigger.
          const energyDelta = (current < targetLevel)
            ? mineEnergyConsumption(techName, targetLevel) - mineEnergyConsumption(techName, current)
            : 0;
          if (kind === "building" && planet &&
              ENERGY_GATED_BUILDINGS.has(techName) &&
              techName !== "solarPlant" && techName !== "fusionReactor" &&
              energyDelta > 0) {
            const energyTechL = currentState?.research?.levels?.["energyTech"] ?? 0;
            const fusionStart = planet.buildings?.["fusionReactor"] ?? 0;
            const solarStart = planet.buildings?.["solarPlant"] ?? 0;
            const dSynth = planet.buildings?.["deuteriumSynth"] ?? 0;
            const planetD = (planet.resources as { d?: number } | undefined)?.d ?? 0;
            // Pick fusion vs solar ONCE (same algorithm as helper): based on
            // start-state cost compare + fusion viability. Then use that
            // type for all per-level bumps.
            const fusionPickCostFn = (TECH_TREE as Record<string, { cost_at?: (l: number) => { m: number; c: number; d?: number } }>)["fusionReactor"]?.cost_at;
            const solarPickCostFn = (TECH_TREE as Record<string, { cost_at?: (l: number) => { m: number; c: number; d?: number } }>)["solarPlant"]?.cost_at;
            const fusionCost0 = fusionPickCostFn ? fusionPickCostFn(fusionStart + 1) : { m: 0, c: 0, d: 0 };
            const solarCost0 = solarPickCostFn ? solarPickCostFn(solarStart + 1) : { m: 0, c: 0, d: 0 };
            const fusionPrereqsMet = dSynth >= 5 && energyTechL >= 3;
            const fusionAffordable = planetD >= (fusionCost0.d ?? 0);
            const fusionViable = fusionPrereqsMet && fusionAffordable;
            const fusionTotal = fusionCost0.m + fusionCost0.c + (fusionCost0.d ?? 0);
            const solarTotal = solarCost0.m + solarCost0.c + (solarCost0.d ?? 0);
            const pickFusion = fusionViable && fusionTotal < solarTotal;
            const plantBuilding: "fusionReactor" | "solarPlant" = pickFusion ? "fusionReactor" : "solarPlant";
            const prodFn = (lvl: number): number => pickFusion ? fusionProduction(lvl, energyTechL) : solarProduction(lvl);
            // Per-level iteration: virtual energy + virtual plant level
            // start from real planet state.
            let virtualEnergy = (planet.resources as { e?: number } | undefined)?.e ?? 0;
            let virtualPlantLvl = pickFusion ? fusionStart : solarStart;
            if (current < targetLevel && typeof costFn === "function") {
              // v0.0.740 — operator 2026-06-04 "排个序很难吗？后造的在上面,
              // 有缩进, 能看出依赖关系". Collect steps in chronological order
              // first, then assemble as CASCADE nest (latest-built = topmost
              // child of root, earlier-built = nested deeper). Result: depth
              // shows dependency direction, top child = goal-final-step,
              // deepest = first action needed.
              type Step = { tech: string; current: number; target: number; kind: "building"; eta: number };
              const steps: Step[] = [];
              let cumulativeEta = 0;
              for (let l = current + 1; l <= targetLevel; l++) {
                const delta = mineEnergyConsumption(techName, l) - mineEnergyConsumption(techName, l - 1);
                let projected = virtualEnergy - delta;
                let firstBumpForced = fusionStart === 0 && solarStart === 0 && l === current + 1 && virtualPlantLvl === 0;
                let safetyCap = 25;
                while ((projected < 0 || firstBumpForced) && safetyCap-- > 0) {
                  const nextPlantLvl = virtualPlantLvl + 1;
                  const baseProd = prodFn(virtualPlantLvl);
                  const newProd = prodFn(nextPlantLvl);
                  // Inline plant cost simulation (same primitives as parent
                  // self loop) so virtual bank stays consistent.
                  const plantCostFn = (TECH_TREE as Record<string, { cost_at?: (l: number) => { m: number; c: number; d?: number } }>)[plantBuilding]?.cost_at;
                  if (typeof plantCostFn === "function") {
                    const pCost = plantCostFn(nextPlantLvl);
                    const pCost3 = { m: pCost.m, c: pCost.c, d: pCost.d ?? 0 };
                    totalCost.m += pCost3.m;
                    totalCost.c += pCost3.c;
                    totalCost.d += pCost3.d;
                    // v0.0.773 — astro >= 4 跳 production-wait (同上面 self-loop)
                    const pWait = postExpeditionPhase ? 0 : timeToAfford(pCost3);
                    if (isFinite(pWait)) {
                      if (!postExpeditionPhase) accumulate(pWait);
                      const pBuild = buildSec(pCost3, "building");
                      accumulate(pBuild);
                      bank.m = Math.max(0, bank.m - pCost3.m);
                      bank.c = Math.max(0, bank.c - pCost3.c);
                      bank.d = Math.max(0, bank.d - pCost3.d);
                      const pStep = Math.round(pWait + pBuild);
                      cumulativeEta += pStep;
                      total += pStep;
                      steps.push({ tech: plantBuilding, current: virtualPlantLvl, target: nextPlantLvl, kind: "building", eta: pStep });
                    }
                  }
                  virtualEnergy += newProd - baseProd;
                  virtualPlantLvl = nextPlantLvl;
                  projected = virtualEnergy - delta;
                  firstBumpForced = false;
                }
                virtualEnergy -= delta;
                // Parent self-level
                const cost = costFn(l);
                if (currentStep === null) {
                  currentStep = { tech: techName, kind, level: l, cost: { m: cost.m, c: cost.c, d: cost.d ?? 0 } };
                }
                totalCost.m += cost.m;
                totalCost.c += cost.c;
                totalCost.d += cost.d ?? 0;
                // v0.0.773 — astro >= 4 跳 wait (同 outer loop)
                const wait = postExpeditionPhase ? 0 : timeToAfford(cost);
                if (!isFinite(wait)) { total = Infinity; break; }
                if (!postExpeditionPhase) accumulate(wait);
                const build = buildSec(cost, kind);
                accumulate(build);
                bank.m = Math.max(0, bank.m - cost.m);
                bank.c = Math.max(0, bank.c - cost.c);
                bank.d = Math.max(0, bank.d - (cost.d ?? 0));
                const step = Math.round(wait + build);
                cumulativeEta += step;
                total += step;
                steps.push({ tech: techName, current: l - 1, target: l, kind: "building", eta: step });
              }
              // Now assemble cascade: latest step at top, each earlier step
              // nested as a child of the later one. subtree_eta = cumulative
              // from THIS step backwards through deeper nesting → sums correctly.
              let cascade: PrereqTreeNode | null = null;
              let runningSubEta = 0;
              for (const s of steps) {  // chronological order = bottom-up for cascade
                runningSubEta += s.eta;
                const node: PrereqTreeNode = {
                  tech: s.tech,
                  targetLevel: s.target,
                  currentLevel: s.current,
                  kind: s.kind,
                  met: false,
                  children: cascade ? [cascade] : [],
                  eta_seconds: s.eta,
                  subtree_eta_seconds: runningSubEta,
                };
                cascade = node;
              }
              if (cascade) children.push(cascade);
              energyGateHandled = true;
            }
          }
          // Self: simulate levels current+1..target IN ORDER
          let selfEta = 0;
          if (!energyGateHandled && current < targetLevel && typeof costFn === "function") {
            for (let l = current + 1; l <= targetLevel; l++) {
              const cost = costFn(l);
              // v0.0.461: first unmet leaf's first level = "current step" —
              // capture only once (deepest leaf reached first in post-order
              // traversal). This is the cost ogame will charge for the very
              // next dispatched directive on this goal.
              if (currentStep === null) {
                currentStep = {
                  tech: techName,
                  kind,
                  level: l,
                  cost: { m: cost.m, c: cost.c, d: cost.d ?? 0 },
                };
              }
              // Operator 2026-05-29: accumulate the level cost into the
              // chain-wide total BEFORE bank subtraction so the panel can
              // show "缺 X 资源" regardless of what production trickled in.
              totalCost.m += cost.m;
              totalCost.c += cost.c;
              totalCost.d += cost.d ?? 0;
              // v0.0.773 — operator 2026-06-04 "糊涂了吧 已经运资源开始建设
              // 了 你还关注矿干嘛": 这一级如果正在 ogame build_q 里 (已扣
              // 资源, ogame countdown 是 ground truth), 用 endsAt 短路;
              // 不再叠 sidecar 悲观 wait (基于 production 算出来的 346d
              // 跟实际无关, 因为 operator 通过 transport 调资源).
              let stepOverride: number | null = null;
              if (kind === "building" && planet) {
                const bq = (planet as { build_q?: { building?: string; level?: number; ends_at?: number } | null }).build_q;
                if (bq && bq.building === techName && bq.level === l && typeof bq.ends_at === "number") {
                  const remaining = Math.max(0, Math.floor((bq.ends_at - Date.now()) / 1000));
                  stepOverride = remaining;
                }
              } else if (kind === "research" && currentState?.research) {
                const rq = (currentState.research as { queue?: { tech?: string; level?: number; ends_at?: number } | null }).queue;
                if (rq && rq.tech === techName && rq.level === l && typeof rq.ends_at === "number") {
                  stepOverride = Math.max(0, Math.floor((rq.ends_at - Date.now()) / 1000));
                }
              }
              let wait: number; let build: number;
              if (stepOverride !== null) {
                wait = 0;
                build = stepOverride;
                // 资源已扣过, 不动 bank
              } else if (postExpeditionPhase) {
                // astro >= 4: 只算 build_sec, wait 由 owner transport 调
                wait = 0;
                build = buildSec(cost, kind);
                accumulate(build);
                bank.m = Math.max(0, bank.m - cost.m);
                bank.c = Math.max(0, bank.c - cost.c);
                bank.d = Math.max(0, bank.d - (cost.d ?? 0));
              } else {
                wait = timeToAfford(cost);
                if (!isFinite(wait)) { total = Infinity; break; }
                accumulate(wait);
                build = buildSec(cost, kind);
                accumulate(build);
                bank.m = Math.max(0, bank.m - cost.m);
                bank.c = Math.max(0, bank.c - cost.c);
                bank.d = Math.max(0, bank.d - (cost.d ?? 0));
              }
              const step = wait + build;
              selfEta += step;
              total += step;
              // Operator 2026-05-29: each completed level of an accelerator
              // speeds up every subsequent buildSec call (its own next
              // levels AND any sibling/parent that recurses through these
              // mutables). robotics +1 → divisor (1+robotics) grows;
              // naniteFactory +1 → divisor 2^nanite doubles; researchLab
              // +1 → research divisor (1+lab) grows.
              if (techName === "roboticsFactory") levels.robotics = l;
              else if (techName === "naniteFactory") levels.nanite = l;
              else if (techName === "researchLab")  levels.lab = l;
            }
          }
          return {
            tech: techName, targetLevel, currentLevel: current, kind,
            met: current >= targetLevel,
            children,
            eta_seconds: Math.round(selfEta),
            subtree_eta_seconds: Math.round(total),
          };
        }
        const tree = buildAndSimulate(rootTechName, rootTargetLevel, rootKind);
        // v0.0.465: moon-fields-aware lunarBase prereq surface (operator
        // 2026-05-29 "free 1 的时候就必须是月球基地"). When goal targets a
        // moon body and current free fields <= 1, the next build MUST be
        // lunarBase to expand the slot pool (each LB level grants 3 fields).
        // Surface this dynamic prereq in the tree by promoting the lunarBase
        // child node's targetLevel to LB_now + 1 (the next-level expansion).
        // Without this, panel just shows lunarBase L?/1 ✓ and operator can't
        // see WHY the moon build is wedged.
        const MOON_BUILDINGS_FOR_FIELDS = [
          "lunarBase", "roboticsFactory", "shipyard", "sensorPhalanx",
          "jumpgate", "missileSilo", "metalStorage", "crystalStorage",
          "deuteriumTank",
        ];
        if (tree && planet?.type === "moon" && rootTechName !== "lunarBase") {
          const b = (planet?.buildings as Record<string, number | undefined>) ?? {};
          const lbCurrent = b["lunarBase"] ?? 0;
          const usedFields = MOON_BUILDINGS_FOR_FIELDS.reduce((s, n) => s + (b[n] ?? 0), 0);
          const maxFields = 1 + 3 * lbCurrent;
          const free = maxFields - usedFields;
          if (free <= 1) {
            const lbNeeded = lbCurrent + 1;
            const existingLb = tree.children.find((c) => c.tech === "lunarBase");
            if (existingLb) {
              existingLb.targetLevel = lbNeeded;
              existingLb.met = lbCurrent >= lbNeeded;
            } else {
              tree.children.unshift({
                tech: "lunarBase",
                kind: "building",
                currentLevel: lbCurrent,
                targetLevel: lbNeeded,
                met: false,
                children: [],
                eta_seconds: 0,
                subtree_eta_seconds: 0,
              });
            }
            // v0.0.466: synthetic lunarBase becomes the new "current step".
            // Without this, panel still shows old current_step (the original
            // root next-level cost) — operator can't see how much resource
            // to ship in for the actual blocking lunarBase upgrade. Override
            // currentStep with lunarBase L_needed's cost from TECH_TREE.
            const lbEntry = (TECH_TREE as unknown as Record<string, { cost_at?: (l: number) => { m: number; c: number; d?: number } }>)["lunarBase"];
            const lbCostFn = lbEntry?.cost_at;
            if (typeof lbCostFn === "function") {
              const lbCost = lbCostFn(lbNeeded);
              currentStep = {
                tech: "lunarBase",
                kind: "building",
                level: lbNeeded,
                cost: { m: lbCost.m, c: lbCost.c, d: lbCost.d ?? 0 },
              };
            }
          }
        }
        return { tree, total, totalCost, bankAtStart, currentStep };
      }
      // Build prereq tree for a goal. Walks TECH_TREE (regular) or
      // LIFEFORM_TECH.<species>.buildings (lifeform). Each node carries
      // current level (from state) + target + met flag + computed ETAs.
      const _legacy_unused_buildTree = (
        _techName: string,
        _targetLevel: number,
        _kind: "research" | "building",
        _planetId: string | undefined,
      ): PrereqTreeNode | null => {
        // SUPERSEDED by simulate() above. Kept as stub for any stale reference.
        return null;
      };
      const _legacy_unused_buildLifeformTree = (
        _buildingName: string,
        _targetLevel: number,
        _planetId: string | undefined,
      ): PrereqTreeNode | null => null;
      void _legacy_unused_buildTree;
      void _legacy_unused_buildLifeformTree;
      // Compute eta_at from ogame's in-flight queue for this goal's planet.
      // STRICT match: ETA returned only when an in-flight queue item's name
      // matches this goal's target OR a building in this goal's prereq tree
      // (planner may dispatch a prereq directive on any queue). Multiple
      // goals on the same planet now show distinct, accurate ETAs instead of
      // all displaying the same unrelated queue end.
      const computeEta = (
        goal: { type: string; target: unknown; planet?: unknown },
        prereqNames: Set<string>,
      ): number | null => {
        const planetId = (() => {
          const ref = typeof goal.planet === "string" ? goal.planet : undefined;
          if (!ref) return undefined;
          // v0.0.476: same moon-only redirect as listGoals tree resolver
          // (v0.0.471). Without this, computeEta resolved coord/numeric-id
          // to planet for moon-only goals (JG L2 etc.) → moon's build_q
          // invisible → eta_at=null → panel can't show "building" status.
          const tgtBuilding = (goal.target as { building?: unknown })?.building;
          const isMoonOnly = goal.type === "build"
            && typeof tgtBuilding === "string"
            && (tgtBuilding === "lunarBase" || tgtBuilding === "sensorPhalanx" || tgtBuilding === "jumpgate");
          // Case A: coord ref
          if (/^\d+:\d+:\d+$/.test(ref)) {
            const matches: Array<{ id: string; type: string }> = [];
            for (const [id, p] of Object.entries(planets)) {
              const c = (p as { coords?: readonly number[] } | undefined)?.coords;
              if (Array.isArray(c) && c.join(":") === ref) {
                matches.push({ id, type: (p as { type?: string }).type ?? "planet" });
              }
            }
            if (matches.length === 0) return undefined;
            if (isMoonOnly) {
              const moon = matches.find((x) => x.type === "moon");
              if (moon) return moon.id;
            }
            return matches[0]!.id;
          }
          // Case B: numeric id ref → may point to planet but want moon
          if (isMoonOnly) {
            const directBody = planets[ref];
            if (directBody && (directBody as { type?: string }).type !== "moon") {
              const coords = (directBody as { coords?: readonly number[] }).coords;
              if (Array.isArray(coords)) {
                const coordStr = coords.join(":");
                for (const [id, p] of Object.entries(planets)) {
                  const pType = (p as { type?: string }).type;
                  const pCoords = (p as { coords?: readonly number[] }).coords;
                  if (pType === "moon" && Array.isArray(pCoords) && pCoords.join(":") === coordStr) {
                    return id;
                  }
                }
              }
            }
          }
          return ref;
        })();
        const p = planetId ? planets[planetId] as { build_q?: { ends_at?: number; building?: string }; shipyard_q?: { ends_at?: number; ship?: string }; lf_build_q?: { ends_at?: number; building?: string } } | undefined : undefined;
        const tgt = goal.target as { building?: string; ship?: string; tech?: string };
        const now = Date.now();
        if (goal.type === "build" || goal.type === "lifeform_building") {
          if (p?.build_q?.building && (p.build_q.building === tgt.building || prereqNames.has(p.build_q.building)) && p.build_q.ends_at && p.build_q.ends_at > now) {
            return p.build_q.ends_at;
          }
          if (p?.lf_build_q?.building && (p.lf_build_q.building === tgt.building || prereqNames.has(p.lf_build_q.building)) && p.lf_build_q.ends_at && p.lf_build_q.ends_at > now) {
            return p.lf_build_q.ends_at;
          }
        }
        if (goal.type === "build_ships") {
          const sq = p?.shipyard_q;
          if (sq && sq.ship === tgt.ship && sq.ends_at && sq.ends_at > now) {
            return sq.ends_at;
          }
          const bq2 = p?.build_q;
          if (bq2 && bq2.building && prereqNames.has(bq2.building) && bq2.ends_at && bq2.ends_at > now) {
            return bq2.ends_at;
          }
        }
        if (goal.type === "research") {
          const rq = currentState?.research?.queue as { ends_at?: number; tech?: string } | undefined;
          if (rq && rq.tech === tgt.tech && rq.ends_at && rq.ends_at > now) return rq.ends_at;
        }
        return null;
      };
      const collectPrereqNames = (node: PrereqTreeNode | null, out: Set<string>): void => {
        if (!node) return;
        if (!node.met) out.add(node.tech);
        for (const c of node.children) collectPrereqNames(c, out);
      };
      // Phase 7c.5.c — SQLite fallback removed. goalsStorePg.list(uid) always
      // available since 7c.2; if pgRows null we treat as empty result rather
      // than fall through to cross-tenant SQLite.
      const sourceRows = pgRows ?? [];
      return sourceRows.map((r) => {
        const target = r.goal.target as { tech?: string; building?: string; level?: number; target_level?: number };
        const lvl = target.target_level ?? target.level ?? 1;
        let prereq_tree: PrereqTreeNode | null = null;
        let totalCost: { m: number; c: number; d: number } = { m: 0, c: 0, d: 0 };
        let bankAtStart: { m: number; c: number; d: number } = { m: 0, c: 0, d: 0 };
        // v0.0.461: per-goal "current step" — operator 2026-05-29 "同时显示
        // 当前要做的任务缺多少资源". Pulled from simulate's leftmost-leaf
        // capture so panel can render "下一步: lunarBase L4 缺 m=80k".
        let currentStepCapture: { tech: string; kind: "research" | "building"; level: number; cost: { m: number; c: number; d: number } } | null = null;
        const planetRef = typeof r.goal.planet === "string" ? r.goal.planet : undefined;
        // Resolve planet ref (id-or-coord) to id for tree lookup.
        // v0.0.471: moon-only building disambiguation (operator 2026-05-30
        // "不跑 build jumpgate 2 ↳ lunarBase (0/1)"). When the goal target
        // is a moon-only building (jumpgate/lunarBase/sensorPhalanx) and
        // the planet ref is an ambiguous coord, PREFER moon at that coord.
        // Without this, simulate() resolved to planet (first match by
        // iteration order) → tree showed lunarBase=0 (planet has none) →
        // current_step locked at lunarBase L1 → goal never gets dispatched
        // because planner (which DOES prefer moon, v0.0.470) sees different
        // state than tree. Mirror the same preference here.
        const MOON_ONLY_BUILDINGS_SET = new Set(["lunarBase", "sensorPhalanx", "jumpgate"]);
        const goalTargetBuilding = (r.goal.target as { building?: unknown })?.building;
        const wantMoon = r.goal.type === "build"
          && typeof goalTargetBuilding === "string"
          && MOON_ONLY_BUILDINGS_SET.has(goalTargetBuilding);
        let resolvedPlanetId = planetRef;
        // Case A: planetRef is a coord like "4:299:8" — resolve to id by
        // iterating, preferring moon for moon-only buildings.
        if (planetRef && /^\d+:\d+:\d+$/.test(planetRef)) {
          const matches: Array<{ id: string; type: string }> = [];
          for (const [id, p] of Object.entries(planets)) {
            if (Array.isArray(p?.coords) && p.coords.join(":") === planetRef) {
              matches.push({ id, type: (p as { type?: string }).type ?? "planet" });
            }
          }
          if (matches.length > 0) {
            const chosen = wantMoon
              ? (matches.find((x) => x.type === "moon") ?? matches[0])
              : matches[0];
            resolvedPlanetId = chosen!.id;
          }
        }
        // Case B: planetRef is a numeric id (e.g., "33666823") that points
        // to a PLANET but target is moon-only — switch to the moon at the
        // same coord. Mirror of planner v0.0.470 behavior. Without this,
        // tree builder shows planet's empty lunarBase (0/1) while planner
        // dispatches to moon — operator sees inconsistent UI.
        else if (planetRef && wantMoon && planets[planetRef]) {
          const resolvedBody = planets[planetRef]!;
          const bodyType = (resolvedBody as { type?: string }).type;
          if (bodyType !== "moon") {
            const coord = (resolvedBody as { coords?: readonly number[] }).coords;
            if (Array.isArray(coord)) {
              const coordStr = coord.join(":");
              for (const [id, p] of Object.entries(planets)) {
                const pType = (p as { type?: string }).type;
                const pCoords = (p as { coords?: readonly number[] }).coords;
                if (pType === "moon" && Array.isArray(pCoords) && pCoords.join(":") === coordStr) {
                  resolvedPlanetId = id;
                  break;
                }
              }
            }
          }
        }
        const captureSim = (sim: { tree: PrereqTreeNode | null; totalCost: { m: number; c: number; d: number }; bankAtStart: { m: number; c: number; d: number }; currentStep?: { tech: string; kind: "research" | "building"; level: number; cost: { m: number; c: number; d: number } } | null }): void => {
          prereq_tree = sim.tree;
          totalCost = sim.totalCost;
          bankAtStart = sim.bankAtStart;
          currentStepCapture = sim.currentStep ?? null;
        };
        if (r.goal.type === "research" && target.tech) {
          captureSim(simulate(target.tech, lvl, "research", resolvedPlanetId, "regular"));
        } else if (r.goal.type === "build" && target.building) {
          captureSim(simulate(target.building, lvl, "building", resolvedPlanetId, "regular"));
        } else if (r.goal.type === "lifeform_building" && target.building) {
          captureSim(simulate(target.building, lvl, "building", resolvedPlanetId, "lifeform"));
        } else if (r.goal.type === "build_ships") {
          const shipTarget = r.goal.target as { ship?: string; amount?: number };
          if (shipTarget.ship) {
            captureSim(simulate(shipTarget.ship, shipTarget.amount ?? 1, "building", resolvedPlanetId, "regular"));
          }
        } else if (r.goal.type === "colonize") {
          // 2026-06-05 v0.0.788 — operator "我发的命令是去殖民 只有一个任务,
          // 你为什么搞两个". 一个 colonize 一棵 tree, 单根. astro 是 owner
          // 视角的 prereq (max_planet gate), 但 ogame TECH_TREE 没把它列在
          // colonyShip.requires 里 — 它是 mission-level 约束. 不挂 ghost
          // root; 直接把 astrophysics 子树 push 进 colonyShip 的 children,
          // 跟 shipyard/impulseDrive 平级. operator 看一棵 cascade 就完事.
          const cTarget = r.goal.target as { source_planet?: string };
          const colSourceId = cTarget.source_planet ?? resolvedPlanetId;
          if (colSourceId) {
            const ownedPlanets = Object.values(planets)
              .filter((p) => (p as { type?: string }).type === "planet").length;
            // v0.0.788 — 必须 per-tenant currentState, 不能 stateRef.current.
            // 后者会读到上一个 push 的 tenant (daigang astro=18) 让 colonize
            // 误判 "astro 已够" 不挂 astrophysics 子树.
            const astroLevel = (currentState?.research?.levels?.["astrophysics"] ?? 0);
            // v0.0.793 — ogame v12 真公式: max_total = floor((L+1)/2)+1.
            // target = 2*owned-1 让 maxAt(target) > owned. owned=1 时 target=1.
            const astroTarget = Math.max(1, 2 * ownedPlanets - 1);
            const colSim = simulate("colonyShip", 1, "building", colSourceId, "regular");
            let mergedTotalCost = colSim.totalCost;
            if (astroLevel < astroTarget && colSim.tree) {
              const astroSim = simulate("astrophysics", astroTarget, "research", colSourceId, "regular");
              if (astroSim.tree) {
                const existing = (colSim.tree as unknown as { children?: PrereqTreeNode[] }).children ?? [];
                (colSim.tree as unknown as { children: PrereqTreeNode[] }).children = [astroSim.tree, ...existing];
                const baseEta = (colSim.tree as unknown as { subtree_eta_seconds?: number }).subtree_eta_seconds ?? 0;
                const astroEta = (astroSim.tree as unknown as { subtree_eta_seconds?: number }).subtree_eta_seconds ?? 0;
                (colSim.tree as unknown as { subtree_eta_seconds?: number }).subtree_eta_seconds = baseEta + astroEta;
                mergedTotalCost = {
                  m: colSim.totalCost.m + astroSim.totalCost.m,
                  c: colSim.totalCost.c + astroSim.totalCost.c,
                  d: colSim.totalCost.d + astroSim.totalCost.d,
                };
              }
            }
            captureSim({ tree: colSim.tree, totalCost: mergedTotalCost, bankAtStart: colSim.bankAtStart, currentStep: colSim.currentStep });
          }
        }
        // v0.0.790 — operator 2026-06-05 "为什么 9 10 没在树里面" + "补的电厂
        // 没有在里面". Optimizer 派的 opt-* sub-goals (parent_goal_id=this
        // row.id) 各有自己的 prereq_tree (含 solarPlant energy cascade). 把它
        // 们 push 进当前 tree 的 root.children — owner 看一棵全貌, 不再 N 张
        // 独立卡片. opt-* 自身 panel 仍展示但加 "🔧 child of X" link.
        if (prereq_tree && r.goal.id) {
          const myId = r.goal.id;
          for (const childRow of sourceRows) {
            if (childRow.goal.parent_goal_id !== myId) continue;
            // v0.0.792 — operator: cancelled/completed 不该 enrich 进 tree
            // (3 个 crystalMine 重复事故). 只 walk 在飞的 sub-goal.
            if (!["active", "blocked", "pending"].includes(childRow.status)) continue;
            const cTarget = childRow.goal.target as { building?: string; tech?: string; level?: number };
            const cLvl = cTarget.level ?? 1;
            let childSim: { tree: PrereqTreeNode | null } | null = null;
            if (cTarget.building) {
              childSim = simulate(cTarget.building, cLvl, "building", resolvedPlanetId, "regular");
            } else if (cTarget.tech) {
              childSim = simulate(cTarget.tech, cLvl, "research", resolvedPlanetId, "regular");
            }
            if (childSim?.tree) {
              const root = prereq_tree as unknown as { children?: PrereqTreeNode[] };
              root.children = [...(root.children ?? []), childSim.tree];
            }
          }
        }
        // v0.0.790 — operator "显示的对吗" → ETA double-count 修. impulseDrive
        // 在 cascade tree 出现 2 次 (astrophysics 真前置 + colonyShip 真前置),
        // ogame research_q 串行只升一次 → 同 tech 同 (current,target) 多次出现
        // 只算第一次 eta, 之后置 0. dedup 走 BFS keep-first. 也设 dedup_skip
        // flag 让 queue_label walk 跳过, 不分配序号.
        if (prereq_tree) {
          const seenDedup = new Set<string>();
          const dedupWalk = (n: PrereqTreeNode): number => {
            const obj = n as unknown as { tech: string; currentLevel: number; targetLevel: number; eta_seconds?: number; subtree_eta_seconds?: number; children?: PrereqTreeNode[]; _dedup_skip?: boolean };
            const key = `${obj.tech}@${obj.currentLevel}→${obj.targetLevel}`;
            if (seenDedup.has(key)) {
              obj.eta_seconds = 0;
              obj._dedup_skip = true;
              let cEta = 0;
              for (const c of obj.children ?? []) cEta += dedupWalk(c);
              obj.subtree_eta_seconds = cEta;
              return cEta;
            }
            seenDedup.add(key);
            let cEta = 0;
            for (const c of obj.children ?? []) cEta += dedupWalk(c);
            const selfEta = obj.eta_seconds ?? 0;
            obj.subtree_eta_seconds = selfEta + cEta;
            return selfEta + cEta;
          };
          dedupWalk(prereq_tree);
        }
        // v0.0.791 — operator "建造和研究看不出先后顺序". queue label DFS
        // post-order = ogame 真序 (prereq 先, root 后). met / dedup_skip 节点
        // 不算 queue. operator 2026-06-05 终拍板 "一棵树能看出先后顺序":
        // 一棵 tree 内 R/B chip 标 ogame queue 执行序就够, 不需 two-column.
        if (prereq_tree) {
          let rSeq = 0;
          let bSeq = 0;
          const labelWalk = (n: PrereqTreeNode): void => {
            for (const c of n.children ?? []) labelWalk(c);
            const obj = n as unknown as { kind: string; met?: boolean; _dedup_skip?: boolean; queue_label?: string };
            if (obj.met || obj._dedup_skip) return;
            if (obj.kind === "research") {
              rSeq++;
              obj.queue_label = `R${rSeq}`;
            } else if (obj.kind === "building" || obj.kind === "ship") {
              bSeq++;
              obj.queue_label = `B${bSeq}`;
            }
          };
          labelWalk(prereq_tree);
        }
        // Operator 2026-05-29: panel renders "缺 X m / Y c / Z d" chip.
        // shortage = max(0, totalCost - planetBank) — only what operator
        // still needs to ship in (or accrue) on top of current stockpile.
        const resourceShortage = {
          m: Math.max(0, totalCost.m - bankAtStart.m),
          c: Math.max(0, totalCost.c - bankAtStart.c),
          d: Math.max(0, totalCost.d - bankAtStart.d),
        };
        return {
          id: r.goal.id,
          type: r.goal.type,
          target: r.goal.target,
          planet: idToCoords(r.goal.planet),
          priority: r.goal.priority,
          status: r.status,
          reason: r.reason,
          is_main_goal: r.goal.is_main_goal === true,
          parent_goal_id: r.goal.parent_goal_id,
          // v0.0.483 — body-wide active queue snapshot (any building/research
          // happening on this goal's body, regardless of whether it serves
          // THIS goal's tech). Operator 2026-05-30: 月球上 lunarBase L7 在
          // 造 → jumpgate L2 goal panel 应该显示 "building lunarBase L7" 优先
          // 于 "waiting resources / awaiting transport". 反映真实 ground truth.
          body_build_q: (() => {
            const ref = typeof r.goal.planet === "string" ? r.goal.planet : undefined;
            if (!ref) return null;
            const planetsMap = stateRef.current?.planets ?? {};
            const tgtBuilding = (r.goal.target as { building?: unknown })?.building;
            const isMoonOnly = r.goal.type === "build" && typeof tgtBuilding === "string"
              && (tgtBuilding === "lunarBase" || tgtBuilding === "sensorPhalanx" || tgtBuilding === "jumpgate");
            let bodyId: string | undefined = undefined;
            if (/^\d+:\d+:\d+$/.test(ref)) {
              const matches: Array<{ id: string; type: string }> = [];
              for (const [id, p] of Object.entries(planetsMap)) {
                const c = (p as { coords?: readonly number[] } | undefined)?.coords;
                if (Array.isArray(c) && c.join(":") === ref) matches.push({ id, type: (p as { type?: string }).type ?? "planet" });
              }
              if (isMoonOnly) bodyId = matches.find((x) => x.type === "moon")?.id ?? matches[0]?.id;
              else bodyId = matches[0]?.id;
            } else {
              bodyId = ref;
              if (isMoonOnly) {
                const direct = planetsMap[ref] as { type?: string; coords?: readonly number[] } | undefined;
                if (direct && direct.type !== "moon" && Array.isArray(direct.coords)) {
                  const coordStr = direct.coords.join(":");
                  for (const [id, p] of Object.entries(planetsMap)) {
                    const pt = (p as { type?: string }).type;
                    const pc = (p as { coords?: readonly number[] }).coords;
                    if (pt === "moon" && Array.isArray(pc) && pc.join(":") === coordStr) { bodyId = id; break; }
                  }
                }
              }
            }
            const body = bodyId ? (planetsMap[bodyId] as { build_q?: { ends_at?: number; building?: string; level?: number }; lf_build_q?: { ends_at?: number; building?: string; level?: number }; shipyard_q?: { ends_at?: number; ship?: string } } | undefined) : undefined;
            if (!body) return null;
            const now = Date.now();
            const bq = body.build_q;
            if (bq?.ends_at && bq.ends_at > now && bq.building) {
              return { queue: "build", tech: bq.building, level: bq.level ?? null, ends_at: bq.ends_at };
            }
            const lq = body.lf_build_q;
            if (lq?.ends_at && lq.ends_at > now && lq.building) {
              return { queue: "lf_build", tech: lq.building, level: lq.level ?? null, ends_at: lq.ends_at };
            }
            const sq = body.shipyard_q;
            if (sq?.ends_at && sq.ends_at > now && sq.ship) {
              return { queue: "shipyard", tech: sq.ship, level: null, ends_at: sq.ends_at };
            }
            return null;
          })(),
          created_at: r.created_at,
          updated_at: r.updated_at,
          eta_at: (() => {
            const names = new Set<string>();
            collectPrereqNames(prereq_tree, names);
            return computeEta(r.goal as { type: string; target: unknown; planet?: unknown }, names);
          })(),
          prereq_tree,
          total_cost: totalCost,
          resource_shortage: resourceShortage,
          // v0.0.461: current-step shortage. The deepest unmet leaf's NEXT
          // level cost minus current planet bank — exactly what's blocking
          // the next dispatch attempt. Panel renders "↳ 当前: lunarBase L4
          // 缺 m=80k" so operator can see what to transport in for the
          // immediate work, not just the full chain.
          current_step: currentStepCapture ? {
            tech: (currentStepCapture as { tech: string }).tech,
            kind: (currentStepCapture as { kind: string }).kind,
            level: (currentStepCapture as { level: number }).level,
            cost: (currentStepCapture as { cost: { m: number; c: number; d: number } }).cost,
            shortage: {
              m: Math.max(0, (currentStepCapture as { cost: { m: number } }).cost.m - bankAtStart.m),
              c: Math.max(0, (currentStepCapture as { cost: { c: number } }).cost.c - bankAtStart.c),
              d: Math.max(0, (currentStepCapture as { cost: { d: number } }).cost.d - bankAtStart.d),
            },
          } : null,
          // v0.0.459: event-triggered awaiting set — empty/missing means
          // "ready to dispatch on next event". Non-empty means goal is
          // waiting for one of these event types before merger will try.
          awaiting_events: priorityMergerRef
            ? Array.from(priorityMergerRef.getAwaiting(r.goal.id))
            : [],
        };
      });
    },
    // v0.0.804 — operator "过期还可以用 弹强制更新类似窗口 点击跳充值页面".
    subscriptionProvider: async (uid: string): Promise<{ active: boolean; expires_at: number | null }> => {
      if (!pgStore) return { active: true, expires_at: null };
      try {
        const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
        const rows = await sql`SELECT current_period_end FROM subscriptions WHERE user_id = ${uid} AND status IN ('active','trialing') AND current_period_end > NOW() ORDER BY current_period_end DESC LIMIT 1`;
        const r = rows[0] as { current_period_end?: Date } | undefined;
        if (r?.current_period_end) {
          return { active: true, expires_at: r.current_period_end.getTime() };
        }
        return { active: false, expires_at: null };
      } catch (e) {
        console.warn("[subscriptionProvider] threw", e);
        return { active: true, expires_at: null }; // safe-default: 不锁
      }
    },
    expeditionProvider: (uid?: string) => {
      // v0.0.840 — operator 2026-06-06 "新账号 TM 远征显示老账号内容": 老逻辑
      // 用 stateRef.current (主号全局), 改取 per-uid state, 没 uid 时 fallback.
      const stateForUid: WorldState | null = uid ? (userStates.get(uid) ?? null) : (stateRef.current ?? null);
      const ready = stateForUid !== null;
      let paused = false;
      try {
        // operator 2026-06-04 "远征设置里面的舰队配置不生效了" — must match
        // http_server.ts EXPEDITION_STATE_FILE (workspace, not /tmp).
        const fp = process.env.OGAMEX_EXPEDITION_STATE_FILE
          ?? path.join(os.homedir(), ".openclaw/workspace/ogamex/runtime/ogamex-expedition.json");
        const raw = fs.readFileSync(fp, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        paused = parsed["paused"] === true;
      } catch { /* missing or malformed — treat as not paused */ }
      if (!ready) return { state_ready: false, used: -1, max: -1, paused, active: [] };
      // v0.0.720 (rev v0.0.724) — operator 2026-06-03 "重启才会变成0，前台
      // 传回的数据都要持久化". Pure-fleets15 broke the post-restart case:
      // hydrate loads persisted server.used_expedition_slots = 6 但 fleets_
      // outbound 可能空 (synthetic prune 后没 fresh push), 直接 fleets15=0
      // → 显示 0/6. Fix: use max(fleets15, srv.used_exp) for the both-aware
      // value, then CAP to max_expedition_slots so a stale srv=525 collapses
      // to 6/6 instead of 525/6 (the 525 bug that v0.0.720 was solving).
      const srv = (stateForUid?.server ?? {}) as {
        used_expedition_slots?: number; max_expedition_slots?: number; player_class?: string;
      };
      const astro = stateForUid?.research?.levels?.["astrophysics"] ?? 0;
      const fleets15 = (stateForUid?.fleets_outbound ?? []).filter((f) => f.mission === 15).length;
      const classBonus = (srv.player_class ?? process.env["OGAMEX_DEFAULT_CLASS"] ?? "") === "discoverer" ? 2 : 0;
      const computedMax = Math.floor(Math.sqrt(astro)) + classBonus;
      const maxSlots = srv.max_expedition_slots && srv.max_expedition_slots > 0 ? srv.max_expedition_slots : computedMax;
      const rawUsed = Math.max(fleets15, srv.used_expedition_slots ?? 0);
      const slots = {
        used: Math.min(rawUsed, maxSlots),  // cap defangs stale-srv amplification
        max: maxSlots,
      };
      const fleets = stateForUid?.fleets_outbound ?? [];
      const now = Date.now();
      const active = fleets.filter((f) => f.mission === 15).map((f, i) => ({
        fleet_id: f.id ?? `mvt-${i}`,
        arrival_at: f.arrival_at ?? 0,
        return_at: f.return_at ?? null,
        eta_in_seconds: Math.max(0, Math.floor(((f.arrival_at ?? 0) - now) / 1000)),
        origin: Array.isArray(f.origin) ? f.origin.join(":") : null,
        dest: Array.isArray(f.dest) ? f.dest.join(":") : null,
        ships: f.ships ?? {},
      }));
      return {
        active,
        used: slots.used,
        max: slots.max,
        astrophysics_level: astro,
        paused,
        state_ready: true,
      };
    },
    emergencyProvider: (uid?: string) => {
      // v0.0.840 — per-uid: 跟 expeditionProvider 对称, 不再 stateRef.current 主号.
      const stateForUid: WorldState | null = uid ? (userStates.get(uid) ?? null) : (stateRef.current ?? null);
      // Minimal emergency stub — surfaces hostile incoming events from
      // state.events_incoming as the panel expects. Full attack-save
      // orchestration lives userscript-side; this endpoint is just a read.
      const ev = stateForUid?.events_incoming ?? [];
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      const hostile = ev.filter((e) => e.hostile === true).map((e) => ({
        id: e.id ?? "",
        type: e.type ?? "attack",
        arrives_at: e.arrives_at ?? 0,
        // arrives_at is in UNIX SECONDS (from eventContent observer + reporter).
        // Previously computed eta as (arrives_at - now_MS)/1000 which mixed
        // units → huge negative → Math.max(0,...) → always 0.
        eta_in_seconds: Math.max(0, (e.arrives_at ?? 0) - nowSec),
        from: Array.isArray(e.from) ? e.from.join(":") : null,
        to: Array.isArray(e.to) ? e.to.join(":") : null,
        // operator 2026-06-04 "紧急任务区分是星球还是月球" — propagate to_type
        // from IncomingEvent so panel + flagship can render 🌑 vs 🪐. Falls
        // back to "planet" when probe didn't carry the field (treats as
        // planet target; same default the eventbox_hook uses).
        to_type: (e as { to_type?: "planet" | "moon" }).to_type === "moon" ? "moon" : "planet",
        ships_count: typeof e.ships_count === "number" ? e.ships_count : "?",
      }));
      return {
        hostile,
        count: hostile.length,
        snapshot_age_ms: stateForUid?.last_update ? (now - stateForUid.last_update) : null,
      };
    },
    listEvents: async (limit, type, userId) => {
      // v0.0.813 — operator 2026-06-05 "稽核日誌 0 rows". 旧版 stub return [].
      // 改 PG per-user 真查 (cover stripe-event/userscript event audit view).
      // 无 userId fallback 返 [] (legacy operator 用 global token, 跨 tenant
      // 不让看).
      if (!pgStore || !userId) return [];
      try {
        const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
        const rows = type
          ? await sql`SELECT id, type, payload, EXTRACT(EPOCH FROM created_at)*1000 AS ts FROM ogame_events WHERE user_id=${userId} AND type=${type} ORDER BY id DESC LIMIT ${limit}`
          : await sql`SELECT id, type, payload, EXTRACT(EPOCH FROM created_at)*1000 AS ts FROM ogame_events WHERE user_id=${userId} ORDER BY id DESC LIMIT ${limit}`;
        return rows.map((r) => ({
          id: (r as { id: number }).id,
          type: (r as { type: string }).type,
          ts: Number((r as { ts: string | number }).ts),
          payload: (r as { payload: unknown }).payload,
        }));
      } catch (e) {
        console.error("[ogamex/sidecar] listEvents PG query failed", e);
        return [];
      }
    },
    // Phase 7c.3.a (2026-06-05) — Group B CRUD handlers all on PG primary.
    // Uid resolution mirrors shadowFire: ALS-resolved caller (web user) or
    // env operator pgUserId fallback. When neither resolves, the handler
    // refuses with a clear reason instead of silently dropping the write.
    cancelGoal: async (id) => {
      const callerUid = getCurrentUserId();
      const uid = callerUid || pgUserId;
      if (!pgStore || !goalsStorePg || !uid) {
        return { ok: false, reason: "pg unavailable or no user context" };
      }
      const owner = await goalsStorePg.ownerOf(uid, id);
      if (!owner) return { ok: false, reason: "goal not found" };
      if (callerUid && owner !== callerUid) return { ok: false, reason: "goal not found" };
      // Cascade cancel: BFS through parent_goal_id chain. Operator semantics
      // preserved verbatim from the SQLite path.
      const cascadeIds: string[] = [];
      const queue = [id];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const pid = queue.shift()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        const children = await goalsStorePg.listChildren(uid, pid);
        for (const child of children) {
          if (child.status === "completed" || child.status === "cancelled") continue;
          cascadeIds.push(child.goal.id);
          queue.push(child.goal.id);
        }
      }
      await pgStore.updateGoalStatus(uid, id, "cancelled", "via /v1/goals/{id}/cancel");
      priorityMergerRef?.clearAwaiting(id);
      priorityMergerRef?.clearDispatched(id);
      for (const cid of cascadeIds) {
        const cReason = `cascade: parent ${id.slice(0, 12)} cancelled`;
        await pgStore.updateGoalStatus(uid, cid, "cancelled", cReason);
        priorityMergerRef?.clearAwaiting(cid);
        priorityMergerRef?.clearDispatched(cid);
      }
      triggerDispatch();
      return { ok: true, cascaded: cascadeIds.length };
    },
    pauseGoal: async (id) => {
      const callerUid = getCurrentUserId();
      const uid = callerUid || pgUserId;
      if (!pgStore || !goalsStorePg || !uid) return { ok: false, reason: "pg unavailable or no user context" };
      const owner = await goalsStorePg.ownerOf(uid, id);
      if (!owner) return { ok: false, reason: "goal not found" };
      if (callerUid && owner !== callerUid) return { ok: false, reason: "goal not found" };
      await pgStore.updateGoalStatus(uid, id, "blocked", "paused by operator");
      priorityMergerRef?.clearDispatched(id);
      triggerDispatch();
      return { ok: true };
    },
    resumeGoal: async (id) => {
      const callerUid = getCurrentUserId();
      const uid = callerUid || pgUserId;
      if (!pgStore || !goalsStorePg || !uid) return { ok: false, reason: "pg unavailable or no user context" };
      const owner = await goalsStorePg.ownerOf(uid, id);
      if (!owner) return { ok: false, reason: "goal not found" };
      if (callerUid && owner !== callerUid) return { ok: false, reason: "goal not found" };
      await pgStore.updateGoalStatus(uid, id, "pending", "resumed by operator");
      // Operator-triggered retry — clear awaiting so this goal is eligible
      // for dispatch on the immediate triggerDispatch below.
      priorityMergerRef?.clearAwaiting(id);
      priorityMergerRef?.clearDispatched(id);
      triggerDispatch();
      return { ok: true };
    },
    setMainGoal: async (id) => {
      const callerUid = getCurrentUserId();
      const uid = callerUid || pgUserId;
      if (!pgStore || !goalsStorePg || !uid) return { ok: false, reason: "pg unavailable or no user context" };
      const owner = await goalsStorePg.ownerOf(uid, id);
      if (!owner) return { ok: false, reason: "goal not found" };
      if (callerUid && owner !== callerUid) return { ok: false, reason: "goal not found" };
      await pgStore.setMainGoal(uid, id);
      triggerDispatch();
      return { ok: true };
    },
    unsetMainGoal: async (id) => {
      const callerUid = getCurrentUserId();
      const uid = callerUid || pgUserId;
      if (!pgStore || !goalsStorePg || !uid) return { ok: false, reason: "pg unavailable or no user context" };
      const owner = await goalsStorePg.ownerOf(uid, id);
      if (!owner) return { ok: false, reason: "goal not found" };
      if (callerUid && owner !== callerUid) return { ok: false, reason: "goal not found" };
      await pgStore.setMainGoal(uid, null);
      triggerDispatch();
      return { ok: true };
    },
    parseGoalNL: async (description) => {
      if (!apiKey) return { ok: false, reason: "GEMINI_API_KEY not configured" };
      const planets = Object.values(stateRef.current?.planets ?? {})
        .filter((p) => p && p.coords && p.coords.length === 3)
        .map((p) => ({ id: p.id, name: p.name ?? "", coords: p.coords as readonly [number, number, number], type: p.type ?? "planet" }));
      const result = await parseGoalFromNL(description, { gemini: geminiClient, listPlanets: () => planets });
      if ("error" in result) return { ok: false, reason: result.error };
      return { ok: true, parsed: result };
    },
    // Phase 7c.3.b (2026-06-05) — Group C create handlers: PG primary.
    // Both createGoal and createDiscoveryGoal write directly to pgStore.
    // upsertGoal; SQLite addForUser/add removed. Dedup in discovery walks
    // goalsStorePg.list(uid) — multi-tenant scoped, no SQLite cross-tenant
    // leak. Legacy operator path resolves uid via pgUserId env so the
    // operator-bootstrap flow still creates goals without ALS context.
    createGoal: async (body) => {
      const SUPPORTED = new Set([
        "research", "build", "build_universal", "colonize",
        "build_ships", "build_defense", "terraformer_to", "expedition",
        "deploy", "transport", "pick_lifeform", "lifeform_level_to",
        "lifeform_research", "lifeform_building",
        "species_discovery", "jumpgate",
      ]);
      if (!SUPPORTED.has(body.type)) return { ok: false, reason: `unsupported goal type: ${body.type}` };
      const createUid = getCurrentUserId() ?? (getLegacyOperatorUid() || pgUserId || undefined);
      if (!pgStore || !createUid) {
        return { ok: false, reason: "pg unavailable or no user context" };
      }
      // v0.0.782 — colonize/jumpgate idempotent: 同 type+planet 已有未结束
      // goal 直接 return existing. operator 2026-06-05 "只不停的重复加殖民
      // 任务" 实证根因 = 操作员看 panel goal 消失就再加 + 旧 goal cascade
      // 误标 completed (上一 commit 7f2f72d 已修) 同时 2 个 colo goal 同
      // planet 并发 cascade 互相 race shipyard build → ogame 100001 spam.
      if ((body.type === "colonize" || body.type === "jumpgate") && goalsStorePg) {
        const allRows = await goalsStorePg.list(createUid);
        const targetPlanet = body.planet ?? "";
        const existing = allRows.find((r) =>
          r.goal.type === body.type &&
          !["completed", "cancelled"].includes(r.status) &&
          ((r.goal.planet ?? "") === targetPlanet),
        );
        if (existing) {
          console.log(`[goal/create] dedup ${body.type} planet=${targetPlanet} → return existing ${existing.goal.id}`);
          return { ok: true, goal_id: existing.goal.id, reason: `${body.type} already active on planet ${targetPlanet}` };
        }
      }
      const id = `${body.type.slice(0, 4)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const nowTs = Date.now();
      const addedRow: GoalRow = {
        goal: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          id, type: body.type as any,
          target: body.target,
          ...(body.planet ? { planet: body.planet } : { planet: "" }),
          priority: typeof body.priority === "number" ? body.priority : 5,
          is_main_goal: false,
          status: "pending", created_at: nowTs,
          progress_pct: 0, current_step: "queued", eta_at: null,
        },
        status: "pending", created_at: nowTs, updated_at: nowTs,
      };
      await pgStore.upsertGoal(createUid, addedRow);
      console.log(`[goal/create] ${id} type=${body.type} planet=${body.planet ?? "(none)"} priority=${body.priority ?? 5} user=${createUid.slice(0,8)}`);
      triggerDispatch();
      return { ok: true, goal_id: id };
    },
    createDiscoveryGoal: async (body) => {
      const planet = stateRef.current?.planets?.[body.source_planet];
      if (!planet) return { ok: false, reason: `unknown planet ${body.source_planet}` };
      const createUid = getCurrentUserId() ?? (getLegacyOperatorUid() || pgUserId || undefined);
      if (!pgStore || !goalsStorePg || !createUid) {
        return { ok: false, reason: "pg unavailable or no user context" };
      }
      // Block second active discovery for same planet (operator panel UX).
      const allRows = await goalsStorePg.list(createUid);
      const existing = allRows.find((r) =>
        r.goal.type === "species_discovery" &&
        !["completed", "cancelled"].includes(r.status) &&
        (r.goal.target as { source_planet?: string }).source_planet === body.source_planet,
      );
      if (existing) return { ok: false, reason: `discovery already active on ${body.source_planet} (goal ${existing.goal.id})` };
      const id = `disc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const dNow = Date.now();
      const discRow: GoalRow = {
        goal: {
          id, type: "species_discovery",
          target: {
            source_planet: body.source_planet,
            galaxy: body.galaxy,
            base_system: body.base_system,
            range: body.range ?? 10,
            completed: [],
          },
          planet: body.source_planet, priority: 5, is_main_goal: false,
          status: "pending", created_at: dNow,
          progress_pct: 0, current_step: "queued", eta_at: null,
        },
        status: "pending", created_at: dNow, updated_at: dNow,
      };
      await pgStore.upsertGoal(createUid, discRow);
      console.log(`[discovery] created goal ${id} from planet ${body.source_planet} galaxy=${body.galaxy} base=${body.base_system} range=${body.range ?? 10}`);
      return { ok: true, goal_id: id };
    },
    recordSaveLaunched: (body) => {
      // Phase 9c.3: route by ALS uid (set by dispatchPush from Bearer).
      const u = getCurrentUserId();
      const c = isLegacyUid(u) ? saveCoordinator : saveCoordManager.get(u!);
      c.recordLaunch(body);
      return { ok: true };
    },
    recordSaveRecallConfirmed: (fleet_id) => {
      const u = getCurrentUserId();
      const c = isLegacyUid(u) ? saveCoordinator : saveCoordManager.get(u!);
      c.recordRecallConfirmed(fleet_id);
      return { ok: true };
    },
    listActiveSaves: (explicitUid?: string) => {
      // Phase 9c.6 — explicit uid from dispatchSaveActive Bearer resolution
      // takes precedence; otherwise fall back to ALS (in case caller is
      // inside a push frame); otherwise legacy.
      const u = explicitUid ?? getCurrentUserId();
      const c = isLegacyUid(u) ? saveCoordinator : saveCoordManager.get(u!);
      return c.list();
    },
  });
  const http = httpServerCtor();
  // Operator 2026-06-04 — start ONLY http; attach ws to its raw server.
  // Reusing same port avoids cf-router routing + extra-port bookkeeping.
  await http.start();
  const rawHttp = http.getRawServer();
  if (rawHttp) {
    ws.attachToHttpServer(rawHttp);
  } else {
    console.warn("[ogamex] http server raw handle null after start — falling back to ws.start()");
    await ws.start();
  }

  // Operator 2026-06-04 "全做" — wire the section_settings push forwarder
  // now that http exists. Per [v0.0.638] ws.send is stub; http.queueDownstream
  // is the real delivery (long-poll). Passing uid lets HTTP downstream queue
  // route per-user when multi-tenant queues are active; broadcast otherwise.
  broadcastSectionUpdate = (uid, settings): void => {
    const msg = { type: "section_settings.update" as const, settings, reason: "user_write" };
    try { ws.send(msg); } catch (e) { console.warn("[ogamex] ws.send section_settings.update threw", e); }
    try {
      const hh = http as unknown as { queueDownstream: (m: typeof msg, u?: string) => void };
      hh.queueDownstream(msg, uid);
    } catch (e) {
      console.warn("[ogamex] http.queueDownstream section_settings.update threw", e);
    }
  };

  // --- Cross-transport relay ------------------------------------------------
  // Shared registry of consumer-supplied handlers per UpstreamMsg type. The
  // raw WsServer / HttpServer each get exactly ONE relay listener per type
  // that fans out into this registry. Consumers register via the wrapped
  // handle.ws.on / handle.http.on (below) which adds to the shared set, so
  // it doesn't matter which transport delivered the message.
  type AnyHandler = (m: UpstreamMsg) => void;
  const registry = new Map<UpstreamMsg["type"], Set<AnyHandler>>();
  for (const t of UPSTREAM_TYPES) {
    const set = new Set<AnyHandler>();
    registry.set(t, set);
    // Phase 7c.3.c — fan async to allow PG lookups (goalsStorePg.get) in
    // directive_completed handler. Outer transports treat handlers as
    // fire-and-forget; making fan async is safe (returned Promise unawaited).
    const fan = async (m: UpstreamMsg): Promise<void> => {
      // M8.5: every upstream message lands in the DebugBuffer once, before
      // consumer handlers run. directive_completed is doubly-recorded — once
      // as a generic event row, once as a state mutation on the matching
      // dispatched directive. Errors here would only happen if the buffer
      // itself throws (it doesn't), so no try/catch.
      debug.recordEvent(m);
      if (m.type === "event.directive_completed") {
        // v0.0.789 — operator 2026-06-05 "改" — PG events 看到同 directive_id
        // 200ms 内 2 条 directive.completed reject. 真因: userscript
        // goal_runner.ts:105-106 dual-path ack (WS instant + HTTP retry ×3
        // 兜底 zombie WS); sidecar fan 被 ws + http 两个 transport 各调一次.
        // dedup gate: directiveToGoal 是 source of truth (line 2438 set on
        // dispatch, line 2061 delete on first ack). 第二次 ack 进来 has=false
        // 就 skip 整个 directive_completed branch + 不 fan to consumer
        // handlers (避免重复 trigger goal status update / Discord notify).
        if (!directiveToGoal.has(m.directive_id)) {
          return;
        }
        debug.recordComplete(m.directive_id, m.result);
        // v0.0.636 — audit ack into events table. Truncate error string to
        // keep payloads bounded (matches debug-buffer convention).
        try {
          const r = m.result as {
            success?: boolean;
            error?: string;
            result?: { action?: string; colonize_result?: { success?: boolean; coord?: string; reason?: string } };
          } | undefined;
          const errStr = typeof r?.error === "string" ? r.error.slice(0, 400) : undefined;
          const payload = {
            directive_id: m.directive_id,
            success: r?.success === true,
            error: errStr,
          };
          shadowFire("appendEvent.completed", (uid) => pgStore!.appendEvent(uid, "directive.completed", payload));
          // v0.0.* — operator: re-evaluate ETA on task completion. Building
          // levels just bumped (R/N/etc), all downstream goals' ETAs may
          // shrink. Force harvest + push fresh state.
          emitPostDirectiveRefresh("post-completed-eta");
          // v0.0.689 — colonize result side-channel: write a dedicated
          // "colonize_done" event so the panel can render last-status
          // without parsing directive payloads.
          const inner = r?.result;
          if (r?.success === true && inner?.action === "colonize" && inner.colonize_result) {
            const cr = inner.colonize_result;
            const clPayload = {
              ts: Date.now(),
              success: cr.success === true,
              coord: typeof cr.coord === "string" ? cr.coord : undefined,
              reason: typeof cr.reason === "string" ? cr.reason : undefined,
            };
            shadowFire("appendEvent.colonize_done", (uid) => pgStore!.appendEvent(uid, "colonize_done", clPayload));
          }
        } catch (e) { console.error("[ogamex/sidecar] appendEvent completed threw", e); }
        const goalId = directiveToGoal.get(m.directive_id);
        if (goalId) {
          directiveToGoal.delete(m.directive_id);
          const result = m.result as { success?: boolean; error?: string } | undefined;
          if (result?.success === false) {
            const reason = String(result?.error ?? "ApiExec failed (no reason)").slice(0, 400);
            // ATOMIC failure → CANCEL (not blocked). Atomic actions (expedition/
            // colonize/deploy/transport) are one-shot: ApiExec rejection means
            // the fleet didn't launch — no retry path. Daemon will create a
            // fresh goal when conditions allow (ships available, slots free).
            // Without cancel, merger flips goal blocked→active each cooldown
            // and re-dispatches → ogame anti-bot trip ("服务器无响应").
            // For BUILD/RESEARCH: blocked is fine (resource shortage recovers).
            //
            // Operator 2026-05-29: TRANSIENT 140043 "請稍後再試" is an ogame
            // dispatch-race / rate-limit (mirrors fleet_api.ts TRANSIENT_RACE_RE)
            // — retrying on next planner tick is correct, NOT a one-shot fail.
            // Cancelling on transient permanently kills a transport chain when
            // its first leg (planet→own moon ferry) races a sibling fleet POST.
            // Operator 2026-05-29: extend to cover goal_runner.ts slot-gate
            // ack messages "fleet slots full N/M keep-1-empty (early skip, not
            // queued)". Slot gates are transient by design — they wait for
            // an expedition return; merger retries fine on next tick. Without
            // this, a chain's first leg dies the moment expeditions saturate.
            // v0.0.429: + 140028 / 倉存容量不足 (target storage cap full) —
            // operator 2026-05-29 "可以hold 等有槽了再飞" applies symmetrically
            // to storage hold; blocked retries on each planner tick and
            // dispatches once destination storage clears.
            // v0.0.432: + 已達艦隊數上限 / 已达舰队数上限 / fleet count limit /
            // 140019 (server-side fleet-slot saturation; ogame returns this
            // when the slot opens between our usedF check and the POST).
            // 2026-06-05 — operator daigang s275 colonize cascade hit
            // 100001 "previously unknown error" 10× in a row, sidecar
            // cancelled the goal. userscript api/fleet_api.ts already
            // classifies 100001 as TRANSIENT_RACE_RE (v0.0.469 — operator
            // 2026-05-30 "build naniteFactory 7 ↳ 100001 未知錯誤"); sidecar
            // side was inconsistent and kept cancelling fresh-server build
            // attempts. Align with userscript: 100001 + 未知錯誤 are transient.
            // v0.0.834 — operator 2026-06-06 retry 审计: 加 ogame HTML 503/
            // overload 典型 ack message. Titania OGame 服器过载 / non-success
            // HTTP 200 (response 不是 JSON 是 HTML 错误页) 是 transient, 跟
            // 100001 同等待遇, 进 exponential backoff 队列.
            const TRANSIENT_RE = /140043|140028|140019|100001|120017|未知錯誤|未知错误|未知的錯誤|未知的错误|請稍後再試|请稍后再试|稍後再試|try again later|cannot dispatch fleet|slots full|early skip, not queued|倉存容量不足|仓存容量不足|storage.*insufficient|insufficient.*storage|insufficient resources|已達艦隊數上限|已达舰队数上限|fleet count limit|maximum.*fleets|already.*maximum|previously unknown error|non-success response HTTP|HTTP 503|Service Temporarily Unavailable|Service Unavailable|Titania OGame|rejected: non-JSON response/i;
            const isTransient = TRANSIENT_RE.test(reason);
            // v0.0.738 — operator 2026-06-04 "supplies:fusionReactor rejected
            // 該行星已沒空間了 120012 这个报错". Permanent error: planet's
            // building fields are exhausted; only operator can demolish or
            // build terraformer to free space. ogame state won't self-resolve.
            // Use long backoff (24h) instead of 60s so auto-retry doesn't
            // burn token / spam logs every minute.
            const HARD_BLOCK_RE = /120012|該行星已沒空間了|该行星已没空间|no space left|fields full|no field/i;
            const isHardBlock = HARD_BLOCK_RE.test(reason);
            // Phase 7c.3.c (2026-06-05) — PG-first lookup, SQLite fallback.
            // webtx-* (web POST → PG only) absent from goalsStore.list();
            // without this lookup the handler sees row=undefined → type=
            // undefined → falls into the blocked branch silently with no
            // atomic-cancel semantics. Sync helper: await PG when uid known.
            const lookupUid = getCurrentUserId() || pgUserId;
            let row: GoalRow | undefined = undefined;
            if (goalsStorePg && lookupUid) {
              const pgRow = await goalsStorePg.get(lookupUid, goalId);
              if (pgRow) row = pgRow;
            }
            // Phase 7c.5.c — SQLite fallback removed; PG goalsStorePg.get is authoritative.
            const type = row?.goal.type;
            // v0.0.784 — failure cancel 必须 action 匹配 root goal.type, 跟
            // success-mark (7f2f72d) 对称. cascade prereq directive (例如
            // colonize goal emit action=research impulseDrive) 失败时不应
            // cancel 整个 root goal — 仅当 atomic action (action=colonize
            // 真派殖民 fleet 失败) 才 cancel. operator 2026-06-05 "殖民任务
            // 又消失了" 实证: cascade 的 research:impulseDrive 因 120017
            // crystal 不够 → 整 colonize goal cancelled.
            const failedAction = directiveToParams.get(m.directive_id)?.action;
            const atomicCancelOk =
              (type === "expedition" && failedAction === "expedition") ||
              (type === "colonize"   && failedAction === "colonize") ||
              (type === "deploy"     && failedAction === "deploy") ||
              (type === "transport"  && failedAction === "transport");
            // Phase 7c.5.b — PG primary writes; SQLite paired-write retired.
            // webtx-* (PG-only) used to throw "unknown goal id" on the SQLite
            // side (operator hit it on leg 1 first dispatch 13:39:08).
            if (!isTransient && atomicCancelOk) {
              if (pgStore && lookupUid) {
                await pgStore.updateGoalStatus(lookupUid, goalId, "cancelled", reason);
              }
              priorityMergerRef?.clearAwaiting(goalId);
              priorityMergerRef?.clearDispatched(goalId);
            } else {
              if (pgStore && lookupUid) {
                await pgStore.updateGoalStatus(lookupUid, goalId, "blocked", reason);
              }
              // v0.0.459: event-triggered gate — goal stays blocked until
              // awaiting events clear.
              // v0.0.542: split policy by goal type (operator 2026-05-31
              // "运输到了 但 100001 还卡在 awaiting operator_retry"). Build /
              // research / build_ships / lifeform_building / species_discovery
              // failures are usually transient (resource shortage at POST
              // time, slot race, mystery 100001) — when underlying ogame
              // state changes (transport arrives, slot frees), the next
              // empire_poll snapshot should auto-retry. Add 60s backoff so
              // persistent errors don't tight-loop. Fleet POSTs (expedition/
              // colonize/deploy/transport/jumpgate FLEET goal) keep the
              // strict operator_retry gate — they're slot-bound, race-prone,
              // and operator wants explicit control before re-firing.
              const failedType = row?.goal.type;
              const isFleetPost = failedType === "expedition" || failedType === "colonize"
                || failedType === "deploy" || failedType === "transport" || failedType === "jumpgate";
              // v0.0.577 — operator 2026-06-01 "不要手动 resume": all goal
               // types auto-backoff (no more operator_retry gate for fleet POST).
               // Fleet POST failures historically waited for explicit operator
               // pause+resume to avoid race-prone re-fire. With dispatch dedup
               // (wire harvest 10min + sendFleet payload 60s + sidecar firedDebrisCheckFor)
               // + stuck-recovery 60s, race risk is acceptable for auto-recovery.
              // v0.0.738 — hard-block errors (120012 fields full) use 24h
              // backoff: needs operator demolish/terraformer, won't self-resolve.
              // v0.0.834 — exponential backoff. failureCount 累计, 每次失败
              // backoff = min(60s * 2^(N-1), 3600s). hardblock 走 24h 单独路径.
              let backoffMs: number;
              let backoffLabel: string;
              if (isHardBlock) {
                backoffMs = 24 * 3600 * 1000;
                backoffLabel = "backoff_24h_hardblock";
              } else {
                const n = (goalFailureCount.get(goalId) ?? 0) + 1;
                goalFailureCount.set(goalId, n);
                const seconds = Math.min(60 * Math.pow(2, n - 1), 3600);
                backoffMs = seconds * 1000;
                backoffLabel = `backoff_${seconds}s`;
                console.info(`[backoff] goal=${goalId.slice(0,12)} failureCount=${n} → ${seconds}s`);
                // v0.0.835 + v0.0.842 节流: 任何失败 emit data.refresh, 但 per-goal
                // 60s cooldown — 失败 storm 不再每秒触发 userscript 全 page poll
                // (browser CPU 卡死).
                try {
                  const nowMs = Date.now();
                  const lastEmit = lastRefreshEmitAt.get(goalId) ?? 0;
                  if (nowMs - lastEmit >= REFRESH_EMIT_COOLDOWN_MS) {
                    emitPostDirectiveRefresh(`fail-recover goal=${goalId.slice(0,12)} n=${n}`);
                    lastRefreshEmitAt.set(goalId, nowMs);
                    console.info(`[stale-recover] goal=${goalId.slice(0,12)} fail#${n} → data.refresh emitted`);
                  }
                } catch (e) { console.warn(`[stale-recover] emit threw:`, e); }
              }
              priorityMergerRef?.markAwaiting(goalId, ["empire_poll", backoffLabel]);
              setTimeout(() => {
                priorityMergerRef?.clearAwaiting(goalId, backoffLabel);
              }, backoffMs).unref();
              if (isHardBlock) {
                console.log(`[hard-block] goal ${goalId.slice(0, 12)} ${reason.slice(0, 80)} — 24h backoff, operator action required`);
                // v0.0.764 — operator 2026-06-04 "船运资源到 4:299:8 就会触
                // 发升级一次核电站, 能量已经足够". 120012 fields_full hits
                // 锁 PARENT goal 24h 但 planner 每次 trigger 仍递归选 fusion
                // → 派 directive → 120012 → loop. 修: 同时 mark planet×
                // building 24h, planner.pickEnergyPrereqBuilding 看到则跳过.
                const params = directiveToParams.get(m.directive_id);
                if (params?.planet_id && params?.building) {
                  markFieldsFull(params.planet_id, params.building);
                  console.log(`[hard-block] markFieldsFull ${params.planet_id}:${params.building} for 24h`);
                }
              }
              directiveToParams.delete(m.directive_id);
              void isFleetPost; // kept for log/diag; treatment unified now
              // v0.0.478: also clear dispatch stamp — directive completed
              // (with failure), so stuck-recovery's "in-flight" gate releases.
              priorityMergerRef?.clearDispatched(goalId);
            }
          } else if (result?.success === true) {
            // Success → clear any awaiting set so next dispatch can fire.
            priorityMergerRef?.clearAwaiting(goalId);
            // v0.0.478: clear dispatch stamp so next leg/level can dispatch.
            priorityMergerRef?.clearDispatched(goalId);
            // v0.0.834 — success ack 清零失败计数, 下次失败从 60s 起重新算.
            goalFailureCount.delete(goalId);
            lastRefreshEmitAt.delete(goalId);
            // ATOMIC actions (expedition / colonize / deploy / transport):
            // ApiExec's success means the fleet launched. Goal is terminal —
            // mark completed immediately. Without this, expedition goals
            // accumulate in store ("active" forever), daemon's activeExpInQueue
            // counter inflates, freeSlots drops to 0, no new exp launches.
            //
            // Building/research/build_ships are NOT atomic — ApiExec success
            // means ogame accepted the POST for ONE level; planner re-runs
            // next tick and either dispatches the next level or detects
            // terminal via state ("already at or above target"). Don't auto-
            // complete those — would lose the higher target.
            // Phase 7c.3.c — PG-first lookup; SQLite fallback. Without this,
            // webtx-* atomic deploy/jumpgate never marked completed → goal
            // stays active → stuck-recovery re-dispatch every ~30s.
            const lookupUid2 = getCurrentUserId() || pgUserId;
            let row: GoalRow | undefined = undefined;
            if (goalsStorePg && lookupUid2) {
              const pgRow = await goalsStorePg.get(lookupUid2, goalId);
              if (pgRow) row = pgRow;
            }
            // Phase 7c.5.c — SQLite fallback removed; PG goalsStorePg.get is authoritative.
            const type = row?.goal.type;
            // v0.0.782 — action must match goal.type. Cascade prereq directives
            // (e.g. colonize-goal emitting `action=build building=shipyard`) share
            // goal_id with the root colonize goal but are NOT terminal — their
            // success means "shipyard L1 built", not "colonize done". Operator
            // 2026-06-05 "还没造殖民船怎么可能完成" 实证 colonize 被 cascade
            // build/shipyard success 误判 completed (没有新 planet 没有 colonyShip).
            const actionDone = directiveToParams.get(m.directive_id)?.action;
            const atomicTypeOk =
              (type === "expedition" && actionDone === "expedition") ||
              (type === "colonize"   && actionDone === "colonize") ||
              (type === "deploy"     && actionDone === "deploy") ||
              (type === "transport"  && actionDone === "transport") ||
              (type === "jumpgate"   && actionDone === "jumpgate");
            if (atomicTypeOk) {
              // Phase 7c.5.b — PG primary. webtx-* leg 1 SQLite throw crashed
              // the whole fan handler (operator 2026-06-05 13:39:08 evidence),
              // making it look like "ack never arrived" to leg 2/3 downstream.
              if (pgStore && lookupUid2) {
                await pgStore.updateGoalStatus(lookupUid2, goalId, "completed", null);
              }
            }
            // v0.0.796 — operator 2026-06-05 "跳跃成功了 但是卡住了". JG ack
            // 完成后 source moon ship -= ships, target moon += ships, 本地
            // mirror; chain leg 2 source ship gate (priority_merger.ts:471-481)
            // 立刻通过, 不等 pollFetchResources 5s+ cross-planet snapshot lag.
            // 失败 (r?.success === false) 不动 inventory, 让 ogame 真态主导.
            const innerResult = (m.result as { success?: boolean })?.success === true;
            if (innerResult && type === "jumpgate" && actionDone === "jumpgate" && row && lookupUid2) {
              const tgt = row.goal.target as { source_moon?: string; target_moon?: string; ships?: Record<string, number> };
              const ships = tgt.ships ?? {};
              const srcId = tgt.source_moon;
              const dstId = tgt.target_moon;
              const us = userStates.get(lookupUid2);
              if (us && Object.keys(ships).length > 0) {
                const planetsMap = us.planets ?? {};
                if (srcId && planetsMap[srcId]) {
                  const src = planetsMap[srcId] as { ships?: Record<string, number> };
                  const srcShips: Record<string, number> = { ...(src.ships ?? {}) };
                  for (const [k, v] of Object.entries(ships)) srcShips[k] = Math.max(0, (srcShips[k] ?? 0) - v);
                  (planetsMap[srcId] as { ships?: Record<string, number> }).ships = srcShips;
                }
                if (dstId && planetsMap[dstId]) {
                  const dst = planetsMap[dstId] as { ships?: Record<string, number> };
                  const dstShips: Record<string, number> = { ...(dst.ships ?? {}) };
                  for (const [k, v] of Object.entries(ships)) dstShips[k] = (dstShips[k] ?? 0) + v;
                  (planetsMap[dstId] as { ships?: Record<string, number> }).ships = dstShips;
                }
                console.info(`[jg/local-mirror] uid=${lookupUid2.slice(0,8)} src=${srcId} dst=${dstId} ships=${JSON.stringify(ships)} — chain leg 2 unblocked`);
              }
            }
            // species_discovery: ApiExec success = ONE coord done. Append to
            // target.completed[] so planner picks next coord on next tick.
            // Goal stays "active" until all coords attempted (planner emits
            // "all coords attempted — goal complete" blocked → consumer can
            // mark cancelled, or we auto-complete here once range filled).
            if (type === "species_discovery" && row) {
              const tgt = row.goal.target as { galaxy?: number; system?: number; position?: number; completed?: string[]; range?: number };
              const completed = Array.isArray(tgt.completed) ? [...tgt.completed] : [];
              const lastDispatched = directiveToDiscoverCoord.get(m.directive_id);
              directiveToDiscoverCoord.delete(m.directive_id);

              // Operator 2026-05-27 "pending it dont drop": frontend ack
              // skipped:"slot_full" means ApiExec hit slot gate AFTER
              // planner's snapshot was stale (planner saw 15/17, ApiExec
              // fetched fresh 17/17). Revert the optimistic completed[]
              // add (line ~919) so planner picks this coord again next
              // tick when fleet returns. Without revert = silent drop.
              const resultMaybeSkip = (m as { result?: { result?: { skipped?: string } } }).result?.result;
              if (resultMaybeSkip?.skipped === "slot_full" && lastDispatched) {
                const idx = completed.indexOf(lastDispatched);
                if (idx >= 0) {
                  completed.splice(idx, 1);
                  const revertedTarget = { ...tgt, completed } as Record<string, unknown>;
                  if (pgStore && lookupUid2) {
                    await pgStore.updateGoalTarget(lookupUid2, goalId, revertedTarget);
                  }
                  const totalCoords = ((tgt.range ?? 10) * 2 + 1) * 15;
                  console.log(`[discovery] goal ${goalId} HOLD ${lastDispatched} (slot_full, reverted optimistic add) progress: ${completed.length}/${totalCoords}`);
                }
              } else {
                if (lastDispatched && !completed.includes(lastDispatched)) {
                  completed.push(lastDispatched);
                }
                // Operator 2026-05-27: frontend ack may include `system_states`
                // map (galaxy fetch revealed all 15 positions' cooldown state).
                // Batch-add all cooled/unavailable coords to completed[] so
                // planner skips ahead instead of dispatching the other 14.
                const resultMaybe = (m as { result?: { result?: { system_states?: Record<string, string> } } }).result?.result;
                const systemStates = resultMaybe?.system_states;
                let batchAdded = 0;
                if (systemStates && typeof systemStates === "object") {
                  for (const k of Object.keys(systemStates)) {
                    if (!completed.includes(k)) {
                      completed.push(k);
                      batchAdded++;
                    }
                  }
                }
                if (lastDispatched || batchAdded > 0) {
                  const progressTarget = { ...tgt, completed } as Record<string, unknown>;
                  if (pgStore && lookupUid2) {
                    await pgStore.updateGoalTarget(lookupUid2, goalId, progressTarget);
                  }
                  const totalCoords = ((tgt.range ?? 10) * 2 + 1) * 15;
                  console.log(`[discovery] goal ${goalId} progress: ${completed.length}/${totalCoords} (added ${lastDispatched ?? "?"}${batchAdded > 0 ? ` + batch ${batchAdded} from system_states` : ""})`);
                }
                // v0.0.575 — operator 2026-06-01 "发现任务派的很慢": species_
                // discovery left status="active" after each success, forcing
                // priority_merger to wait for the 90s atomic stuck-recovery
                // timeout (v0.0.573 added it to atomic list) before re-dispatch.
                // Multi-coord scan thus took ~90s/coord = 8h for 315 coords.
                // Reset status to "pending" so next tick re-plans IMMEDIATELY,
                // bypassing the active-block stuck-recovery wait.
                if (pgStore && lookupUid2) {
                  await pgStore.updateGoalStatus(lookupUid2, goalId, "pending", null);
                }
              }
            }
            // build / research / build_ships / lifeform_building → no-op,
            // planner detects terminal next tick.
          }
        }
        // v0.0.459: directive ack is a planner-eligible event — re-dispatch
        // so any unblocked / next-chain-leg goal fires immediately. Without
        // this, the 500ms tick (removed) used to absorb the gap; now must be
        // explicit.
        triggerDispatch();
      }
      for (const h of set) {
        try { h(m); } catch { /* handler errors must not crash the relay */ }
      }
    };
    // Each server's typed `on` requires the literal type parameter — but
    // because we're iterating, we erase the type and cast at the boundary.
    // The handler itself is variant-safe (set only stores callbacks that
    // were registered against the same `t`).
    (ws as unknown as { on: (type: string, h: AnyHandler) => void }).on(t, fan);
    (http as unknown as { on: (type: string, h: AnyHandler) => void }).on(t, fan);
  }

  // Wrap ws.on / http.on so consumer registrations land in the shared
  // registry. We MUTATE the instances (not the prototype) so other instances
  // are unaffected. Original methods are intentionally hidden — direct
  // access would bypass the relay, which is exactly what we want to prevent.
  const wrapOn = <K extends UpstreamMsg["type"]>(
    type: K,
    handler: (msg: Extract<UpstreamMsg, { type: K }>) => void,
  ): void => {
    const set = registry.get(type);
    if (!set) {
      // Should never happen if UPSTREAM_TYPES is exhaustive, but guard anyway.
      throw new Error(`startSidecar: unknown UpstreamMsg type "${type}"`);
    }
    set.add(handler as unknown as AnyHandler);
  };
  ws.on = wrapOn as typeof ws.on;
  http.on = wrapOn as typeof http.on;

  // --- Reporter (optional) -------------------------------------------------
  let reporter: Reporter | null = null;
  if (config.discordChannelId !== undefined && config.discordChannelId !== "") {
    const send = effectiveOpts.sendDiscord ?? defaultDiscordSend;
    reporter = new Reporter({ channelId: config.discordChannelId, send });
  }
  // Phase 9c.8 — per-user Discord webhook routing. New users push their own
  // webhook URL via /settings → PG user_settings.discord_webhook_url. The
  // manager mints a Reporter per uid backed by that URL (direct POST, no
  // OpenClaw SDK). Legacy operator's notifications stay on `reporter` above
  // (OpenClaw channel); only foreign users hit this manager.
  const reporterManager = pgStore !== null
    ? new ReporterManager({
        loadWebhookUrl: (uid: string) => pgStore!.getDiscordWebhookUrl(uid),
      })
    : null;

  // --- MemoryWriter --------------------------------------------------------
  const memoryWriter = startMemoryWriter({
    memoryDir,
    debounceMs: 5000,
    forceRefreshMs: 60_000,
  });

  // v0.0.* — operator 2026-06-05 "每次任务开始和完成的时候自动重新评估".
  // After dispatch / completion, push data.refresh so userscript re-harvests
  // empire (buildings/research/resources), pushes fresh state.snapshot, and
  // sidecar's next /v1/goals serves simulate() output with the up-to-date
  // accel (R/N/lab levels). Without this, ETA stays stale until panel's
  // natural 3s poll cycle and operator sees outdated estimates.
  // v0.0.* — operator 2026-06-05 — after sidecar restart, TM may not push
  // state.snapshot until the operator navigates a fresh ogame page. The
  // state-staleness gate (5 min) then blocks every fleet POST goal until
  // a snapshot arrives, leaving web-created transport chains stuck pending.
  // Solve by periodically broadcasting data.refresh while stateRef is stale
  // and there's a TM connected. Stops once a fresh snapshot lands.
  const STATE_REFRESH_INTERVAL_MS = 30_000;
  const stateRefreshTimer: NodeJS.Timeout = setInterval(() => {
    const last = stateRef.current?.last_update ?? 0;
    const ageMs = Date.now() - last;
    if (last > 0 && ageMs < 60_000) return;  // fresh enough
    const msg = { type: "data.refresh" as const, scope: "all" as const, reason: "stale-state-poll" };
    try { ws.send(msg); } catch (e) { console.warn("[ogamex/sidecar] stale-poll ws.send threw", e); }
    try { http.queueDownstream(msg); } catch (e) { console.warn("[ogamex/sidecar] stale-poll http.queue threw", e); }
  }, STATE_REFRESH_INTERVAL_MS);
  stateRefreshTimer.unref();

  const emitPostDirectiveRefresh = (reason: string): void => {
    const msg: DownstreamMsg = { type: "data.refresh", scope: "all", reason };
    try { ws.send(msg); } catch (e) { console.warn("[ogamex/sidecar] emitPostDirectiveRefresh ws.send threw", e); }
    try { http.queueDownstream(msg); } catch (e) { console.warn("[ogamex/sidecar] emitPostDirectiveRefresh http.queue threw", e); }
  };

  // --- PriorityMerger ------------------------------------------------------
  const priorityMerger: PriorityMerger = new PriorityMerger({
    planGoal,
    send: (msg: DownstreamMsg) => {
      // M8.5: record every dispatched directive in the DebugBuffer so the
      // /v1/debug page can show what was sent + (later) whether it completed.
      // Other DownstreamMsg variants (strategy.full, ping…) are skipped — the
      // debug page is directive-centric, not bridge-traffic-centric.
      if (msg.type === "directive.dispatch") {
        debug.recordDispatch(msg.directive);
        // v0.0.636 — operator audit: persist directive dispatch into events
        // table so /v1/events shows the full sidecar action history across
        // restarts. Payload kept lean (id/goal/action/priority/expires);
        // full directive lives in directiveToGoal map + ack handler.
        try {
          const d = msg.directive as { id?: string; goal_id?: string; action?: string; priority?: number; expires_at?: number; params?: Record<string, unknown> };
          const payload = {
            directive_id: d.id,
            goal_id: d.goal_id,
            action: d.action,
            priority: d.priority,
            expires_at: d.expires_at,
            params: d.params,
          };
          shadowFire("appendEvent.dispatch", (uid) => pgStore!.appendEvent(uid, "directive.dispatch", payload));
        } catch (e) { console.error("[ogamex/sidecar] appendEvent dispatch threw", e); }
        // v0.0.* — operator: re-evaluate ETA on task start (accel may have
        // changed since last snapshot). Async harvest + push fresh state.
        emitPostDirectiveRefresh("post-dispatch-eta");
        // Remember directive_id → goal_id so we can mark the goal blocked
        // when the ack returns with success:false. Without this, ApiExec
        // failures (e.g., expedition 140054) leave the goal "active"
        // forever and merger keeps re-dispatching every cooldown cycle.
        const d = msg.directive as { id: string; goal_id?: string; action?: string; params?: { galaxy?: number; system?: number; position?: number; building?: string; planet_id?: string } };
        if (d.id && d.goal_id) directiveToGoal.set(d.id, d.goal_id);
        // v0.0.764 — also stash params for 120012 fields_full retro-mark.
        // v0.0.782 — additionally stash action so directive_completed handler
        // can verify it matches goal.type before mark-completed (cascade prereq
        // bug: colonize goal's emitted build/build_ships directive误标整个 goal
        // completed; operator 2026-06-05 "还没造殖民船怎么可能完成").
        if (d.id) {
          const entry: { action?: string; building?: string; planet_id?: string } = {};
          if (d.action !== undefined) entry.action = d.action;
          if (d.params?.building !== undefined) entry.building = d.params.building;
          if (d.params?.planet_id !== undefined) entry.planet_id = d.params.planet_id;
          directiveToParams.set(d.id, entry);
        }
        // species_discovery: stash dispatched coord by directive_id (NOT on
        // the goal row — goalsStore.list returns SQL copies, mutations
        // wouldn't persist). directive_completed handler reads from this map.
        // ALSO append coord to target.completed[] OPTIMISTICALLY at dispatch
        // — planner's next tick must see this coord as "attempted" so it
        // picks the NEXT coord. Without this, merger fires planner every
        // 500ms while ack hasn't returned → same coord queued 50+ times
        // (operator observed in log dump). If ApiExec fails, coord still
        // counts as attempted (cooldown reset is 7d anyway).
        if (d.action === "discover" && d.goal_id && d.params) {
          const coord = `${d.params.galaxy}:${d.params.system}:${d.params.position}`;
          directiveToDiscoverCoord.set(d.id, coord);
          // Phase 7c.5.c — PG primary discovery optimistic update. send() is
          // sync but lookup + write is fire-and-forget; the next planner
          // tick reads completed[] regardless of when it commits.
          const dGoalId = d.goal_id;
          void (async () => {
            const uid = getCurrentUserId() || pgUserId;
            if (!uid || !pgStore || !goalsStorePg) return;
            const pgRow = await goalsStorePg.get(uid, dGoalId);
            if (!pgRow || pgRow.goal.type !== "species_discovery") return;
            const tgt = pgRow.goal.target as { completed?: string[] };
            const completed = Array.isArray(tgt.completed) ? [...tgt.completed] : [];
            if (completed.includes(coord)) return;
            completed.push(coord);
            const optimisticTarget = { ...pgRow.goal.target, completed } as Record<string, unknown>;
            await pgStore.updateGoalTarget(uid, dGoalId, optimisticTarget);
          })().catch((e) => console.warn("[discover/optimistic] threw:", e instanceof Error ? e.message : e));
        }
      }
      ws.send(msg);
      // HTTP-side consumers (long-poll) also need the directive — queue it
      // so a polling userscript receives the dispatch.
      http.queueDownstream(msg);
    },
    // v0.0.670 — Phase 5c: mirror every merger-driven status mutation to
    // the PG shadow writer. The 11 in-loop updateStatus call sites were
    // SQLite-only before this hook (Phase 5b drift evidence: sqlite=13
    // pg=9). Use upsertGoal (INSERT-or-UPDATE) so the mirror converges
    // even when the goal was created via a pre-Phase-0 path that didn't
    // shadow-write its INSERT — the first merger status mutation hydrates
    // the PG row from the merger's now-up-to-date GoalRow snapshot.
    onStatusChange: (row, mergerUid) => {
      if (!pgStore) return;
      shadowFire("goal.merger.upsertGoal", async (resolvedUid) => {
        // Prefer the merger's per-dispatch uid (already ALS-routed by
        // the dispatch caller). Fallback to shadowFire's resolution if
        // the merger ran outside an ALS frame.
        const uid = mergerUid || resolvedUid;
        await pgStore!.upsertGoal(uid, row);
      });
      // v0.0.806 — operator 2026-06-05 "出发月球的 cd 没有 目的也应该没有
      // 数据库里的是我刷的". JG goal mark completed (无论 ack-driven 还是
      // v0.0.805 self-detect auto_complete) 时, 同步本地 mirror 双月球
      // jumpgate_cooldown_sec + jumpgate_harvested_at, 不靠 userscript
      // overlay 手动 fetch. ogame v12 JG cd ≈ 60min base (受 hyperspaceTech
      // 影响), 兜底用 3600s; userscript pollEmpire 拿到真值后会 overwrite.
      if (row.status === "completed" && row.goal.type === "jumpgate") {
        const tgt = row.goal.target as { source_moon?: string; target_moon?: string; ships?: unknown };
        const uid = mergerUid;
        if (uid && (tgt.source_moon || tgt.target_moon)) {
          const us = userStates.get(uid);
          if (us) {
            const planetsMap = us.planets ?? {};
            const nowMs = Date.now();
            const fallbackCd = 3600;
            const markCd = (moonId: string | undefined): void => {
              if (!moonId) return;
              const p = planetsMap[moonId] as { jumpgate_cooldown_sec?: number; jumpgate_harvested_at?: number } | undefined;
              if (!p) return;
              p.jumpgate_cooldown_sec = fallbackCd;
              p.jumpgate_harvested_at = nowMs;
            };
            markCd(tgt.source_moon);
            markCd(tgt.target_moon);
            console.info(`[jg/cd-mirror] uid=${uid.slice(0,8)} mirrored cd=${fallbackCd}s on src=${tgt.source_moon} tgt=${tgt.target_moon} after auto-complete`);
          }
        }
      }
    },
    // Phase 7a — PG primary reader. SQLite reads survived in dist purely as
    // a fallback when DATABASE_URL is unset; if pgStore boots OK, the merger
    // never touches SQLite for reads.
    ...(goalsStorePg ? { reader: goalsStorePg } : {}),
    // Phase 7c.2 (2026-06-05) — PG primary writer. The merger's
    // updateStatusAndMirror writes status transitions directly via
    // pgStore.updateGoalStatus, bypassing SQLite. PG-only goals (created
    // via web POST → PG) no longer cause "unknown goal id" throws; the
    // cross-tenant SQLite fallback remains for legacy single-tenant.
    ...(pgStore ? { writer: pgStore } : {}),
  });
  // v0.0.459 forward-ref assignment — CRUD endpoints + directive_completed
  // handler use priorityMergerRef + triggerDispatch via closure (declared
  // above ws/http setup). Without this assignment, those closures see null
  // and noop on every CRUD call → no dispatch → goal stuck pending forever.
  priorityMergerRef = priorityMerger;
  // v0.0.765 — operator 2026-06-04 "暂停所有 TM 动作". Inject isGlobalPaused
  // 让 merger.dispatch 看到 PG ogamex.global.paused=true 时直接 return 空.
  // Cache 5s 避免每 tick SQL: 切换状态后最多 5s 起效.
  let globalPauseCache: { value: boolean; ts: number } = { value: false, ts: 0 };
  priorityMerger.isGlobalPausedFn = (uid?: string): boolean => {
    if (!pgStore || !uid) return false;
    const now = Date.now();
    if (now - globalPauseCache.ts < 5_000) return globalPauseCache.value;
    try {
      // sync no go — schedule refresh, return last value
      void (async () => {
        try {
          const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
          const rows = await sql`SELECT section_settings->>'ogamex.global.paused' AS v FROM user_settings WHERE user_id = ${uid} LIMIT 1`;
          const r = rows[0] as { v?: string } | undefined;
          globalPauseCache = { value: r?.v === "true", ts: Date.now() };
        } catch (e) { console.warn("[global-pause] read threw", e); }
      })();
    } catch { /* */ }
    return globalPauseCache.value;
  };
  // v0.0.794 — subscription gate. operator 2026-06-05 "可以安装 但是要暂停".
  // freemium throttle: 没 active sub 时 priorityMerger 跳过整 tick. cache
  // per uid 60s (订阅状态变化频率低, 不需 5s). status IN (active, trialing) +
  // current_period_end > NOW() 是 active 判定 (cover stripe/paypal/free_code).
  const subPauseCache = new Map<string, { paused: boolean; ts: number }>();
  priorityMerger.isSubscriptionPausedFn = (uid?: string): boolean => {
    if (!pgStore || !uid) return false;
    const now = Date.now();
    const hit = subPauseCache.get(uid);
    if (hit && now - hit.ts < 60_000) return hit.paused;
    try {
      void (async () => {
        try {
          const sql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
          const rows = await sql`SELECT 1 FROM subscriptions WHERE user_id = ${uid} AND status IN ('active','trialing') AND current_period_end > NOW() LIMIT 1`;
          const hasSub = rows.length > 0;
          subPauseCache.set(uid, { paused: !hasSub, ts: Date.now() });
        } catch (e) { console.warn("[sub-pause] read threw", e); }
      })();
    } catch { /* */ }
    // cold cache → default paused=false 安全侧 (避免初次启动 lag 误锁所有)
    return hit?.paused ?? false;
  };
  // Directive → goal mapping (in-memory). Trimmed when ack arrives.
  const directiveToGoal = new Map<string, string>();
  // v0.0.764 — directive → params snapshot so 120012 hard-block can call
  // markFieldsFull(planet_id, building) when the ack lands. operator
  // 2026-06-04 "船运资源到 4:299:8 就会触发升级一次核电站" loop fix.
  const directiveToParams = new Map<string, { action?: string; building?: string; planet_id?: string }>();
  // v0.0.834 — operator 2026-06-06 retry 审计 exponential backoff: 累计失败
  // 次数, backoff = min(60s * 2^(N-1), 3600s). 60→120→240→480→960→1920→3600
  // 7 次后封顶 1h. 成功 ack 清零.
  const goalFailureCount = new Map<string, number>();
  // v0.0.842 — operator 2026-06-06 "这个版本变得非常卡": v0.0.835 每次 fail 立即
  // emit data.refresh storm (userscript 全 page poll) 把 browser CPU 拉满. 节流
  // per-goal cooldown 60s, fail#1 emit 后下次 emit 至少等 60s. 失败爆发时去掉
  // 重复 push, browser tab 不再卡.
  const lastRefreshEmitAt = new Map<string, number>();
  const REFRESH_EMIT_COOLDOWN_MS = 60_000;
  // species_discovery: stamp dispatched coord per directive_id (NOT on row,
  // because goalsStore.list() returns SQL copies — mutating one is discarded).
  const directiveToDiscoverCoord = new Map<string, string>();

  // --- SaveCoordinator (operator 2026-05-24 "fsm 可以放后台") ------------
  // Owns per-planet IN_FLIGHT → RECALL_READY → RECALLING bookkeeping.
  // Userscript reports launches via POST /v1/save/launched (wired into
  // http opts above) and receives `save.recall_now` downstream when
  // sidecar decides recall margin elapsed. Detection + sendFleet + recall
  // POST stay in userscript — sidecar owns only the coordination state.
  const saveCoordinator = new SaveCoordinator({
    // safetyMarginSeconds removed 2026-05-26 — recall is event-driven (instant on hostile clear)
    stateRef,
    send: (msg) => {
      ws.send(msg);
      http.queueDownstream(msg);
    },
    // v0.0.637 — mirror FSM mutations to disk so a sidecar restart during an
    // active hostile window resumes the IN_FLIGHT → RECALLING transition
    // instead of forgetting the pending event set.
    persistence: {
      upsert: (rec) => {
        shadowFire("upsertSaveRecord", (uid) => pgStore!.upsertSaveRecord(uid, rec));
      },
      delete: (planet_id) => {
        shadowFire("deleteSaveRecord", (uid) => pgStore!.deleteSaveRecord(uid, planet_id));
      },
    },
  });
  // Rehydrate persisted FSM rows before any state.snapshot or HTTP call
  // touches the coordinator. Without this, the disk rows would still be
  // there but the in-memory map would say "no active save" and a new
  // launch on the same planet would silently overwrite the prior record.
  try {
    // Phase 7d — SQLite retired; PG-backed SaveCoord rehydrate via shadowFire
    // path (boot-time PG fetch is a future enhancement). Empty here = SaveCoord
    // starts cold, ops 重新创建 save records when next fleet launches.
    // No-op block — placeholder for future PG-backed rehydrate.
    void saveCoordinator;
  } catch (e) {
    console.warn("[ogamex/sidecar] save_records hydrate failed (continuing empty):", e);
  }
  saveCoordinator.start();

  // --- FailureAggregator ---------------------------------------------------
  const failureAggregator = createFailureAggregator({
    strategyManager,
    gemini: geminiClient,
    getState: () => stateRef.current ?? emptyWorldState(),
    send: (msg: DownstreamMsg) => {
      ws.send(msg);
      http.queueDownstream(msg);
    },
    ...(config.analyzer !== undefined ? { analyzer: config.analyzer } : {}),
    // v0.0.638 — mirror per-task LLM cooldown to disk so a restart mid-
    // cooldown doesn't immediately re-fire the analyzer on the next
    // matching failure burst.
    persistence: {
      upsertCooldown: (task, last_analysis_at) => {
        shadowFire("upsertCooldown", (uid) => pgStore!.upsertFailureCooldown(uid, task, last_analysis_at));
      },
      listCooldowns: () => [], // Phase 7d — PG cooldowns via shadowFire; boot starts fresh
    },
  });

  // --- Phase 9c.3 — per-user managers (coexistence with legacy globals) ---
  // The legacy `saveCoordinator` + `failureAggregator` above remain the
  // operator's instances (uid = OGAMEX_LEGACY_USER_ID). For any OTHER user
  // resolved via Bearer→ALS, the managers below lazily mint a fresh
  // per-user instance whose state machine + LLM cooldowns are isolated.
  // Why coexist instead of swap: operator has 1+ year of FSM state already
  // hydrated into the global instance via rehydrate(persisted) above. A
  // hot swap would lose that. Coexistence preserves operator bit-for-bit
  // and gates the new code path purely on a non-legacy uid showing up.
  // Phase 9c.8 hotfix — lazy-read env, NOT module/startSidecar-init read.
  // run_sidecar.mjs sets process.env.OGAMEX_LEGACY_USER_ID AFTER its
  // `import { startSidecar }`. ESM hoists imports, so any read at
  // startSidecar callsite that runs synchronously during evaluation
  // sees an empty env var. createGoal lambda fires LATER (HTTP request
  // time) so by then the env IS set — but only if we read it lazily.
  // 2026-06-02 incident: createGoal tagged 5 expedition goals with
  // user_id=NULL because this const captured "" at boot, and merger's
  // listActiveByUser("4baba0e2…") skipped them → 远征又卡住.
  const getLegacyOperatorUid = (): string => (process.env.OGAMEX_LEGACY_USER_ID ?? "").trim();
  const isLegacyUid = (uid: string | undefined): boolean => {
    const op = getLegacyOperatorUid();
    return !uid || (op !== "" && uid === op);
  };
  // Per-user state mirror — userStates is populated by state.snapshot
  // handler; the manager's stateRef factory reads from it.
  const saveCoordManager = new SaveCoordinatorManager({
    buildOptionsFor: (uid) => ({
      stateRef: {
        get current() { return userStates.get(uid) ?? null; },
        set current(_v) { /* writes flow through state.snapshot handler */ },
      },
      send: (msg) => {
        // Phase 9c.5 — explicit uid routes the message into THIS user's
        // poll bucket. Their userscript polling under their Bearer reads
        // only this bucket; operator's poll under global token reads only
        // LEGACY_BUCKET. The leak between users is sealed.
        ws.send(msg);
        http.queueDownstream(msg, uid);
      },
      persistence: {
        upsert: (rec) => {
          // SQLite primary write skipped for non-legacy users — SQLite
          // save_records table is keyed by planet_id only and would
          // collide between users on same planet id. PG mirror IS
          // user-partitioned by composite PK (user_id, planet_id), so
          // direct PG write here, no shadowFire ALS dance needed.
          if (pgStore) {
            void pgStore.upsertSaveRecord(uid, rec).catch((e) => {
              console.warn(`[multi/save] upsertSaveRecord user=${uid.slice(0,8)} failed:`, e);
            });
          }
        },
        delete: (planet_id) => {
          if (pgStore) {
            void pgStore.deleteSaveRecord(uid, planet_id).catch((e) => {
              console.warn(`[multi/save] deleteSaveRecord user=${uid.slice(0,8)} failed:`, e);
            });
          }
        },
      },
    }),
  });
  const failureAggManager = new FailureAggregatorManager({
    buildDepsFor: (uid) => ({
      strategyManager,
      gemini: geminiClient,
      getState: () => userStates.get(uid) ?? emptyWorldState(),
      send: (msg: DownstreamMsg) => {
        // Phase 9c.5 — uid bound in closure; explicit so any setTimeout-
        // delivered analyzer message lands in the user's bucket even
        // after the originating ALS frame is gone.
        ws.send(msg);
        http.queueDownstream(msg, uid);
      },
      ...(config.analyzer !== undefined ? { analyzer: config.analyzer } : {}),
      persistence: {
        upsertCooldown: (task, last_analysis_at) => {
          if (pgStore) {
            void pgStore.upsertFailureCooldown(uid, task, last_analysis_at).catch((e) => {
              console.warn(`[multi/fail] upsertCooldown user=${uid.slice(0,8)} failed:`, e);
            });
          }
        },
        // Phase 9c.6 — synchronous loader stays empty (createFailureAggregator
        // calls it before our async hydrate can resolve). Real hydrate fires
        // via the manager's loadCooldowns hook below, which calls
        // hydrateCooldowns() once PG returns.
        listCooldowns: () => [],
      },
    }),
    // Phase 9c.6 — async PG fetch on first mint per uid. Empty array if
    // pgStore not wired (test smoke) — manager skips the hydrate cleanly.
    ...(pgStore !== null
      ? { loadCooldowns: (uid: string) => pgStore!.listFailureCooldowns(uid) }
      : {}),
  });

  // --- DigestScheduler (M8.2) ----------------------------------------------
  // Publishes a markdown summary of Strategy/Goals/Snapshot to Discord once
  // per local day at 06:00 UTC by default. Skips silently if no reporter is
  // configured. The poll interval is intentionally coarse — minute granularity
  // is plenty for a daily digest, and avoids wakeups during normal operation.
  // Phase 7c.5.e — digest 切 PG. operatorUid 来自 env (OGAMEX_OPERATOR_USER_ID),
  // 如果未配置 digest 仍能跑但 list 返回空 → 0 active / 0 blocked.
  const digestOperatorUid = getLegacyOperatorUid() || pgUserId || "";
  const digestScheduler = startDigestScheduler({
    reporter,
    goalsStorePg: goalsStorePg!,
    operatorUid: digestOperatorUid,
    strategyManager,
    stateRef,
  });

  // Phase 8a (v0.0.785) — operator 2026-06-05 "方案 A" — optimizer 从 daemon
  // 搬到 sidecar. 60s tick, per-tenant accelerator math, emit opt-* goal
  // when net savings > 60s. daemon ogamex_discord_bridge.mjs 那侧 setInterval
  // 同步 disable. cf. /home/ddxs/Sync/Works/ogamex/packages/openclaw-plugin/src/sidecar/optimizer.ts
  let optimizerHandle: { stop: () => void } | null = null;
  if (goalsStorePg && pgStore) {
    const { startOptimizer } = await import("./optimizer.js");
    optimizerHandle = startOptimizer({
      goalsStorePg,
      pgStore,
      getStateForUid: (uid: string) => userStates.get(uid) ?? null,
      loadActiveTenantUids: async (): Promise<string[]> => {
        if (!pgStore) return [];
        try {
          const sharedSql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
          const rows = await sharedSql`SELECT DISTINCT user_id FROM ogame_goals WHERE status IN ('active','blocked','pending')`;
          return (rows as Array<{ user_id?: string }>).map((r) => r.user_id ?? "").filter(Boolean);
        } catch (e) {
          console.warn("[optimizer] loadActiveTenantUids failed:", e instanceof Error ? e.message : e);
          return [];
        }
      },
    });
  }
  void optimizerHandle;

  // Phase 8b (v0.0.785) — expedition 从 daemon 搬到 sidecar. 5s base tick +
  // state.snapshot event-driven trigger (fleet 回家时立刻 fire 而不必等 5s).
  // daemon ogamex_discord_bridge.mjs 那侧 expedition setInterval 同步 disable.
  let expeditionHandle: { stop: () => void; triggerForUid: (uid: string) => void } | null = null;
  if (goalsStorePg && pgStore) {
    const { startExpedition } = await import("./expedition.js");
    expeditionHandle = startExpedition({
      goalsStorePg,
      pgStore,
      getStateForUid: (uid: string) => userStates.get(uid) ?? null,
      loadActiveTenantUids: async (): Promise<string[]> => {
        if (!pgStore) return [];
        try {
          const sharedSql = (pgStore as unknown as { sql: import("postgres").Sql }).sql;
          const rows = await sharedSql`SELECT DISTINCT user_id FROM ogame_goals WHERE status IN ('active','blocked','pending')`;
          return (rows as Array<{ user_id?: string }>).map((r) => r.user_id ?? "").filter(Boolean);
        } catch (e) {
          console.warn("[expedition] loadActiveTenantUids failed:", e instanceof Error ? e.message : e);
          return [];
        }
      },
    });
  }
  void expeditionHandle;

  // -------------------------------------------------------------------------
  // Upstream handlers — registered ONCE against the wrapped on, which the
  // cross-transport relay fans both ws and http arrivals into.
  // -------------------------------------------------------------------------

  ws.on("state.snapshot", async (msg) => {
    // Phase 9c.1 — route by ALS user_id when set. Per-user store always
    // updated; legacy stateRef ALSO updated (so PriorityMerger /
    // SaveCoord / FailureAgg still see the latest snapshot from whichever
    // user is most active — this matches pre-9c semantics).
    const ctxUid = getCurrentUserId();
    if (ctxUid) {
      userStates.set(ctxUid, msg.snapshot);
      userLastSeen.set(ctxUid, Date.now());
    }
    const prev = stateRef.current;
    stateRef.current = msg.snapshot;
    lastSeen.at = Date.now();

    // Persist (debounced) — every snapshot schedules at most one write per
    // uid inside the 1s window. Coalesces bursts when the userscript pushes
    // 3-5 snapshots per page change. v0.0.858 — uid + snap captured here
    // so cross-tenant push during debounce window doesn't corrupt PG row.
    {
      const persistUid = ctxUid || pgUserId;
      if (persistUid) scheduleWorldStatePersist(msg.snapshot, persistUid);
    }

    // SaveCoordinator: diff hostile events between snapshots so per-planet
    // FSM can advance IN_FLIGHT → RECALL_READY when all that planet's
    // pending hostiles drop from events_incoming.
    // Phase 9c.3: route by ALS uid — legacy operator (or no uid) uses
    // global instance, foreign users use manager-minted per-user instance.
    try {
      const coord = isLegacyUid(ctxUid) ? saveCoordinator : saveCoordManager.get(ctxUid!);
      coord.onSnapshot(msg.snapshot);
    } catch (e) { console.error("[save-coord] onSnapshot threw", e); }

    // Event-driven expedition trigger: when fleet count drops between two
    // snapshots (fleet returned), bump trigger ts so discord-bridge daemon
    // fires expeditionTick immediately instead of waiting next 10s tick.
    // Operator directive: "ogame 的改成事件触发".
    if (prev !== null) {
      const prevCount = Array.isArray(prev.fleets_outbound) ? prev.fleets_outbound.length : 0;
      const newCount = Array.isArray(msg.snapshot.fleets_outbound) ? msg.snapshot.fleets_outbound.length : 0;
      if (newCount < prevCount) {
        try {
          (http as unknown as { bumpExpeditionTrigger?: () => void }).bumpExpeditionTrigger?.();
        } catch { /* */ }
      }
      // v0.0.501 — expedition debris collection, dual-signal:
      //   Signal A (primary, 早): mission=15 fleet first observed with
      //     return_at != null → fire (fleet started returning)
      //   Signal B (fallback, 晚): mission=15 fleet was in prev snapshot,
      //     gone in new snapshot → fire (fleet returned home)
      // Both signals dedupped per fleet ID via firedDebrisCheckFor Set.
      // Operator 2026-05-30 实证: harvest may not capture return_at reliably;
      // fallback ensures debris-check fires at worst case (fleet home).
      try {
        // operator 2026-06-01: harvest dispatch ALWAYS uses the PLANET at the
        // expedition's origin coords (not the moon, even when the expedition
        // launched from a moon). Explorer ships live on the planet; harvest
        // fleet flies planet → debris-field-at-:16. Hardcode type==="planet".
        const findOriginPlanet = (origCoord: string): { id: string } | undefined => {
          return Object.values(msg.snapshot.planets ?? {})
            .find((p) => Array.isArray(p.coords) && p.coords.join(":") === origCoord && p.type === "planet");
        };
        // v0.0.857 — operator 2026-06-06 "是隔离问题?". 是. expLastSeen /
        // firedDebrisCheckFor 是 module-level global 不分 uid → 跨账户 fleet 条目
        // 互相覆写 + 误删. 顶层修法: key 全部加 uid 前缀 isolated. ctxUid 是当前
        // 推 state.snapshot 的 user (ALS), 没 uid 时退到空字符串 (legacy
        // single-tenant 跟原行为兼容).
        const keyFor = (fid: string): string => ctxUid ? `${ctxUid}::${fid}` : fid;
        const fireFor = (fleetId: string, origin: readonly number[], dest: readonly number[], reason: string, signal: "B" | "C"): "fired" | "skip-origin" | "noop" => {
          const dedupKey = keyFor(fleetId);
          const firedSignals = firedDebrisCheckFor.get(dedupKey) ?? new Set<"B" | "C">();
          if (firedSignals.has(signal)) return "noop";
          if (!Array.isArray(origin) || origin.length !== 3 || !Array.isArray(dest)) return "noop";
          const originPlanet = findOriginPlanet(origin.join(":"));
          if (!originPlanet) {
            console.log(`[debris-check] SKIP fleet ${fleetId} uid=${(ctxUid ?? "_").slice(0,8)}: origin ${origin.join(":")} not in this user's planets`);
            return "skip-origin";
          }
          const g = dest[0], s = dest[1];
          if (typeof g !== "number" || typeof s !== "number") return "noop";
          firedSignals.add(signal);
          firedDebrisCheckFor.set(dedupKey, firedSignals);
          const dbgMsg = { type: "expedition.debris_check" as const, galaxy: g, system: s, origin_planet_id: originPlanet.id, reason };
          ws.send(dbgMsg);
          http.queueDownstream(dbgMsg);
          console.log(`[debris-check] FIRED fleet ${fleetId} uid=${(ctxUid ?? "_").slice(0,8)} signal=${signal} ${reason}: G:S=${g}:${s} origin=${originPlanet.id}`);
          return "fired";
        };
        // v0.0.783 — Signal C 删除. Operator 2026-06-05 "不要搞 b c 能否一次
        // 成功" — 接受偶发 Signal B miss (return_at 偶发 null) 换"远征回家恰好
        // 一次 dispatch"的简洁语义. wire.ts 那侧的 6min dedup 仍兜底防多 fleet
        // 同 origin 短时间叠加. 单一信号源 = Signal B (fleet 真离开 outbound +
        // return_at !== null), 30s settle delay 给 ogame galaxy view 时间结算
        // debris row.
        const currentExpIds = new Set<string>();
        for (const f of msg.snapshot.fleets_outbound ?? []) {
          if (typeof f.id !== "string") continue;
          if (f.mission !== 15) continue;
          currentExpIds.add(keyFor(f.id));
          expLastSeen.set(keyFor(f.id), { origin: f.origin, dest: f.dest, arrival_at: f.arrival_at ?? null, return_at: f.return_at ?? null });
        }
        // Signal B: fleet disappeared from outbound. ogame removes mission=15
        // fleet from /movement when it's HOLDING at :16 (60min) — same
        // disappearance event as truly returning home. Distinguish:
        //   - last-seen return_at === null → fleet entered HOLDING, skip
        //     (debris not yet generated, fleet will reappear as RETURNING)
        //   - last-seen return_at !== null → fleet was returning, now home
        //     (fire harvest)
        // v0.0.574 — operator 2026-06-01 实证: 1:486 fleet 2353595 false-fired
        // at holding-entry, dedup then blocked real return → no harvest.
        // v0.0.857 — 只扫当前 uid 的条目 (key 以 `${uid}::` 开头). 别的 user 的
        // 留给他们自己的 snapshot 处理. legacy uid="" 时扫无前缀条目.
        const myKeyPrefix = ctxUid ? `${ctxUid}::` : "";
        for (const [fid, info] of Array.from(expLastSeen.entries())) {
          if (myKeyPrefix && !fid.startsWith(myKeyPrefix)) continue;
          if (!myKeyPrefix && fid.includes("::")) continue;
          if (currentExpIds.has(fid)) continue;
          if (info.return_at === null) {
            // Holding entry — keep expLastSeen so the next reappearance
            // (returning phase) can update return_at and Signal A/B will
            // fire correctly.
            continue;
          }
          // v0.0.783 — operator 2026-06-05 "回家就派一次不用等30s, 如果失败就
          // 30s以后重新派一次". 删 +30s settle delay, Signal B 立即 fire. 失败
          // 重试在 wire.ts handler 里做 (fetch 失败 30s 后 retry same signal),
          // 不靠 sidecar 多 fire 兜底.
          // v0.0.857 — fid 已带 uid 前缀, 还原 raw fleet id 给 fireFor (其内再加).
          const rawFid = myKeyPrefix ? fid.slice(myKeyPrefix.length) : fid;
          const result = fireFor(rawFid, info.origin, info.dest, "fleet returned home", "B");
          if (result === "fired") expLastSeen.delete(fid);
        }
        // v0.0.567 — GC removed. Operator 2026-06-01 observed 3 mission=8
        // fleets dispatched for the SAME expedition return. Root cause: the
        // old GC deleted fid from firedDebrisCheckFor as soon as the fleet
        // left current outbound. But ogame /movement scrape returns the
        // returning-phase fleet INTERMITTENTLY (flap in/out across snapshots),
        // and on each re-appearance Signal A's `return_at` check fired with
        // an empty dedup Set → re-dispatch. fleet IDs are monotonic per
        // ogame universe; retaining the Set has negligible memory cost
        // (~few hundred entries/day, sidecar restart clears it).
      } catch (e) {
        console.error("[ogamex/sidecar] debris-check threw", e);
      }
    }

    // Ship-build progress watcher — when a planet's ship count rises between
    // snapshots, decrement the matching build_ships goal's `amount` by the
    // delta. When amount drops to <= 0, the goal is completed.
    if (prev !== null) {
      try {
        void updateBuildShipsProgress(prev, msg.snapshot, goalsStorePg, getCurrentUserId() ?? null, pgStore);
      } catch (e) {
        console.error("[ogamex/sidecar] ship-progress watcher threw", e);
      }
    }

    // Phase 7c.5.c — memoryWriter goals fed from PG. snapshot handler is
    // already async; await the per-user PG list when uid known. Cross-tenant
    // listActive over SQLite retired (no longer authoritative).
    const memUid = getCurrentUserId() || pgUserId;
    const memGoals = goalsStorePg && memUid
      ? await goalsStorePg.listActiveByUser(memUid)
      : [];
    memoryWriter.push({
      state: msg.snapshot,
      goals: memGoals,
      strategy: strategyManager.load(),
    });
    // v0.0.459: clear empire_poll awaiting for ALL goals — empire snapshot
    // arrived means underlying ogame state may have changed; previously-failed
    // goals get one more chance. Operator-retry awaiting NOT cleared (that
    // requires explicit operator action via /goals/{id}/resume).
    try { priorityMerger.clearAwaiting("*", "empire_poll"); }
    catch (e) { console.error("[ogamex/sidecar] clearAwaiting threw", e); }
    // Dispatch active goals (idempotent — already-active rows still get a
    // freshly-planned next step). Wrap in try/catch so a single goal's
    // planning failure does NOT swallow subsequent state.snapshots.
    try {
      // Phase 9c.2 — route by ALS user_id when present.
      // v0.0.669 — dispatch is async (Phase 5b); await within this snapshot
      // handler so the log line still reflects this tick's result.
      const dispUid = getCurrentUserId();
      // Phase 8b — fleet 数变化时 trigger expedition (取代 daemon 的 1s poll).
      // 不卡 hot path: fire-and-forget triggerForUid (内部 fire-and-forget).
      if (dispUid && expeditionHandle) {
        try { expeditionHandle.triggerForUid(dispUid); }
        catch (e) { console.warn("[expedition] trigger threw:", e instanceof Error ? e.message : e); }
      }
      const result = await priorityMerger.dispatch(msg.snapshot, dispUid);
      const actions = result.dispatched.map((d) => {
        const params = d.params as { building?: string; tech?: string; ship?: string };
        const label = params.building ?? params.tech ?? params.ship ?? d.action;
        return `${d.action}/${label}`;
      }).join(",");
      const uidTag = dispUid ? ` user=${dispUid.slice(0, 8)}…` : "";
      console.log(`[merger] dispatched=${result.dispatched.length} blocked=${result.blocked.length} done=0 actions=${actions}${uidTag}`);
      // operator 2026-06-05 — dump blocked reasons so we can see why a new
      // web-created transport chain stays pending. Keep entries short.
      if (result.blocked.length > 0 && result.dispatched.length === 0) {
        for (const b of result.blocked) {
          console.info(`[merger/blocked] ${b.goal_id} reason="${(b.reason ?? "").slice(0, 200)}"`);
        }
      }
    } catch (e) {
      console.error("[ogamex/sidecar] priorityMerger.dispatch threw", e);
    }
  });

  // v0.0.459: removed 500ms merger tick (operator 2026-05-29 "基本原则就是
  // 只用事件触发"). Dispatch is now triggered exclusively by:
  //   - ws.on("state.snapshot")        ← empire poll arrived
  //   - event.directive_completed      ← directive ack from userscript
  //   - createGoal/cancelGoal/...      ← operator goal mutation
  //   - resumeGoal                     ← operator manual retry
  // Goals that failed are held via priorityMerger.markAwaiting until one of
  // {empire_poll, operator_retry} clears their awaiting set.

  ws.on("event.daily_failure", (msg) => {
    // Operator 2026-06-01 "事件驱动也要更新后台数据" — persist event row
    // BEFORE async record() so it survives even if analyzer crashes.
    try {
      const payload = {
        task: msg.task, attempts: msg.attempts, last_error: msg.last_error,
      };
      // worldStateStore.appendEvent removed in Phase 7b — shadowFire only.
      shadowFire("appendEvent.daily_failure", (uid) => pgStore!.appendEvent(uid, "event.daily_failure", payload));
    } catch (e) { console.error("[ogamex/sidecar] appendEvent daily_failure threw", e); }
    // record() is async; fire-and-forget. We attach a catch so a stuck
    // analyzer never produces an unhandled rejection (which would crash
    // Node in --unhandled-rejections=strict mode).
    // Phase 9c.3: route by ALS uid — same legacy/manager split as snapshot.
    const failUid = getCurrentUserId();
    const agg = isLegacyUid(failUid) ? failureAggregator : failureAggManager.get(failUid!);
    void agg.record({
      task: msg.task,
      attempts: msg.attempts,
      last_error: msg.last_error,
      context: msg.context,
    }).catch((err: unknown) => {
      console.error("[ogamex/sidecar] failureAggregator.record failed", err);
    });
  });

  ws.on("event.emergency", (msg) => {
    // Operator 2026-06-01 "事件驱动也要更新后台数据" — persist event row
    // BEFORE downstream side-effects so audit log is durable even on crash.
    try {
      const payload = { subtype: msg.subtype, data: msg.data };
      // worldStateStore.appendEvent removed in Phase 7b — shadowFire only.
      shadowFire("appendEvent.emergency", (uid) => pgStore!.appendEvent(uid, "event.emergency", payload));
    } catch (e) { console.error("[ogamex/sidecar] appendEvent emergency threw", e); }
    // Always log on receipt — journalctl is the audit trail for natural
    // attack/spy events (success path was previously silent, making it
    // impossible to grep history). Failure log already exists below.
    const data = (msg.data ?? {}) as {
      event_id?: string;
      from?: unknown;
      to?: unknown;
      arrives_at?: number;
    };
    const fromStr = Array.isArray(data.from) ? data.from.join(":") : "?";
    const toStr = Array.isArray(data.to) ? data.to.join(":") : "?";
    const arr = data.arrives_at ? new Date(data.arrives_at * 1000).toISOString() : "?";
    console.info(
      `[sidecar/emergency] subtype=${msg.subtype} event_id=${data.event_id ?? "?"} from=${fromStr} to=${toStr} arrives_at=${arr}`,
    );
    // Phase 9c.8 — route emergency by ALS uid:
    //   显式 operator uid → 全局 Reporter (OpenClaw SDK → operator's Discord)
    //   foreign uid → reporterManager.get(uid) → user's webhook URL
    //   uid 缺失 (untagged WS / 异常) → 安全 SKIP, 绝不 fall back 到 operator
    //
    // v0.0.850 — operator 2026-06-06 "新账号的信息发到了老账号的Discord频道里了":
    // 老逻辑 isLegacyUid(undefined)=true 导致 untagged WS 的 emergency 全漏到
    // operator. 新账号 daigang@yahoo 装的 userscript 若没注入 per-user
    // bridge_token, WS auth 落 global token 路径 → socketUid 不 set →
    // event.emergency 不带 ALS uid → 误判 legacy → operator's Discord 收到.
    // 修复: 改成正向匹配 operator uid, undefined 不再 fall back.
    const emergencyUid = getCurrentUserId();
    const operatorUid = getLegacyOperatorUid();
    const isOperator = emergencyUid && operatorUid !== "" && emergencyUid === operatorUid;
    if (isOperator) {
      if (reporter === null) return;
      void reporter.pushEmergency(msg.markdown_report).catch((err: unknown) => {
        console.error("[ogamex/sidecar] reporter.pushEmergency (operator) failed", err);
      });
    } else if (reporterManager !== null && emergencyUid) {
      void reporterManager.get(emergencyUid)
        .then((r) => r?.pushEmergency(msg.markdown_report))
        .catch((err: unknown) => {
          console.error(`[ogamex/sidecar] reporter.pushEmergency user=${emergencyUid.slice(0,8)} failed`, err);
        });
    } else {
      console.warn(`[ogamex/sidecar] emergency skipped — uid missing or untagged (subtype=${msg.subtype}); refusing fallback to operator channel`);
    }
  });

  ws.on("hello", () => {
    // v0.0.551 — operator 2026-05-31: HTTP-only mode means EVERY ogame page
    // navigation re-runs the userscript (@run-at=document-end) → new hello.
    // The old flushQueue-on-hello call (designed for WS reconnect to drop
    // stale directives from the disconnect window) becomes destructive here:
    // chain leg 2 directives queued for the next long-poll were being nuked
    // by the operator clicking Overview / Fleet / Galaxy. Operator hit chain
    // txc-mpucf2xr-84vt leg 2 "deploying" stuck because 11 page navs in 5
    // min flushed the directive each time before the long-poll picked it up.
    // For HTTP long-poll the queue should PERSIST across page navigations —
    // it's a session-level resource, not a WS-connection resource.
    // (If needed later we can detect "real reconnect" vs "page nav" by
    //  checking time-since-last-hello, but for now: don't flush.)
    // Also reset merger's per-goal cooldown — fresh client deserves fresh
    // dispatch cycle, not silence because lastDispatchTs is from before
    // disconnect.
    if (typeof (priorityMerger as unknown as { resetCooldown?: () => void }).resetCooldown === "function") {
      (priorityMerger as unknown as { resetCooldown: () => void }).resetCooldown();
    }
    // The userscript has just connected and announced its strategy_version.
    // Reply with the canonical Strategy so it can reconcile any drift.
    // v0.0.638 — operator's userscript runs HTTP long-poll only (ws is
    // stubbed since v0.0.549). ws.send is a no-op; we MUST also enqueue
    // on the HTTP downstream queue so the next /poll delivers strategy.full.
    const full = { type: "strategy.full" as const, strategy: strategyManager.load() };
    ws.send(full);
    http.queueDownstream(full);
  });

  // --- Online banner -------------------------------------------------------
  if (reporter !== null) {
    const httpPort = http.port();
    const banner =
      `OgameX online — sidecar listening on http://127.0.0.1:${httpPort}`;
    // Failure to send the banner must not abort sidecar boot — the bridge
    // itself is healthy; the operator just won't see the online ping.
    try {
      await reporter.pushEmergency(banner);
    } catch (err) {
      console.error("[ogamex/sidecar] failed to send online banner", err);
    }
  } else {
    console.info("[ogamex/sidecar] OgameX online (no discord channel configured)");
  }

  // -------------------------------------------------------------------------
  // Shutdown — clear memory-writer timers (no implicit flush; callers that
  // want a final snapshot on disk must `await handle.memoryWriter.flush()`
  // BEFORE `stop()`), close transports, release SQLite handle.
  // -------------------------------------------------------------------------
  const stop = async (): Promise<void> => {
    digestScheduler.stop();
    memoryWriter.stop();
    // Flush any pending debounced WorldState write BEFORE closing the store
    // handle — otherwise the most recent snapshot may not land on disk.
    try { flushWorldStatePersist(); }
    catch (err) { console.error("[ogamex/sidecar] WorldState flush threw", err); }
    // Phase 7b — final WAL checkpoint dropped (was SQLite-specific and the
    // periodic interval is gone). worldStateStore.close() below still runs
    // better-sqlite3's implicit checkpoint on the way out.
    await Promise.all([ws.stop(), http.stop()]);
    // Phase 7d — SQLite stores retired. Only PG client needs close.
    if (pgStore) {
      try { await pgStore.close(); }
      catch (err) { console.error("[ogamex/sidecar] pgStore.close failed", err); }
    }
  };

  const listExpedition: SidecarHandle["listExpedition"] = () => {
    const ready = stateRef.current !== null;
    const paused = readExpeditionPaused();
    if (!ready) {
      return { state_ready: false, used: -1, max: -1, paused };
    }
    const slots = stateRef.current?.discovery_slots ?? { used: 0, max: 0 };
    return {
      state_ready: true,
      used: slots.used,
      max: slots.max,
      paused,
    };
  };

  return {
    ws,
    http,
    reporter,
    strategyManager,
    priorityMerger,
    failureAggregator,
    memoryWriter,
    digestScheduler,
    stateRef,
    listExpedition,
    stop,
  };
}

/**
 * Read the operator-controlled `paused` flag from the shared expedition
 * state file written by `/v1/expedition/{pause,resume}`. Missing or malformed
 * file ⇒ not paused.
 */
function readExpeditionPaused(): boolean {
  try {
    const expeditionStateFile = process.env.OGAMEX_EXPEDITION_STATE_FILE
      ?? path.join(os.homedir(), ".openclaw/workspace/ogamex/runtime/ogamex-expedition.json");
    const raw = fs.readFileSync(expeditionStateFile, "utf8");
    const parsed = JSON.parse(raw);
    return !!(parsed && typeof parsed === "object" && (parsed as { paused?: unknown }).paused === true);
  } catch {
    return false;
  }
}

/**
 * M8.1 — measure round-trip to the LLM with a 5s ceiling. Returns the rtt in
 * ms on success; otherwise an error string suitable for surfacing in the
 * /v1/health JSON body. We deliberately use a trivial prompt + temperature 0
 * so we're not racking up tokens just to answer health checks.
 */
async function pingGemini(client: GeminiClient): Promise<{ ok: boolean; rttMs: number | null; error?: string }> {
  const TIMEOUT_MS = 5000;
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
  try {
    await Promise.race([
      client.generate("ping", { temperature: 0 }),
      timeout,
    ]);
    return { ok: true, rttMs: Date.now() - start };
  } catch (e) {
    return { ok: false, rttMs: null, error: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Production default — shells out to the OpenClaw CLI to deliver to Discord.
 * Tests do NOT exercise this path (they inject a vi.fn). Uses `spawn` with an
 * arg array — NOT `exec` — so message contents cannot inject shell commands.
 */
export function defaultDiscordSend(channelId: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "openclaw",
      ["message", "send", "--channel", "discord", "--target", channelId, "--message", content],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (err) => reject(err));
    child.once("exit", (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(
        `openclaw message send exited with code ${code ?? "null"}` +
        (stderr.length > 0 ? `: ${stderr.trim()}` : ""),
      ));
    });
  });
}
