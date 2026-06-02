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
import { SaveCoordinatorManager, FailureAggregatorManager } from "./multitenant_managers.js";
import { Reporter } from "./reporter.js";
import { StrategyManager } from "./strategy_manager.js";
import { GoalsStore } from "./goals_store.js";
import { WorldStateStore } from "./world_state_store.js";
import { WorldStateStorePg } from "./world_state_store_pg.js";
import { getCurrentUserId } from "./user_context.js";
import { GeminiClient } from "./gemini_client.js";
import { parseGoalFromNL } from "../tools/add_goal.js";
import { PriorityMerger } from "./priority_merger.js";
import { planGoal } from "./planner.js";
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
import { TECH_TREE, LIFEFORM_TECH } from "@ogamex/shared";

interface PrereqTreeNode {
  tech: string;
  targetLevel: number;
  currentLevel: number;
  kind: "research" | "building";
  met: boolean;
  children: PrereqTreeNode[];
  eta_seconds?: number | null;
  subtree_eta_seconds?: number;
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
  goalsStore: GoalsStore;
  worldStateStore: WorldStateStore;
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
function updateBuildShipsProgress(
  prev: WorldState,
  next: WorldState,
  store: GoalsStore,
): void {
  const activeRows = store.listActive();
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
      try {
        store.updateTarget(match.goalId, { amount: Math.max(0, newRemaining) });
        if (newRemaining <= 0) {
          store.updateStatus(match.goalId, "completed");
          goalByKey.delete(matchKey);
        } else {
          // Refresh map so subsequent deltas this tick stay accurate.
          goalByKey.set(matchKey, { goalId: match.goalId, remaining: newRemaining });
        }
      } catch (e) {
        console.error("[ogamex/sidecar] ship-progress update failed", match.goalId, e);
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

  const goalsStore = new GoalsStore({ dbPath: goalsDbPath });
  // Phase 9c.2 — one-shot legacy goal backfill. OGAMEX_LEGACY_USER_ID
  // (operator's user_id from ogame-next) tags every row whose user_id
  // is NULL. Idempotent — re-runs just touch 0 rows.
  const legacyUid = process.env.OGAMEX_LEGACY_USER_ID ?? "";
  if (legacyUid) {
    try {
      const n = goalsStore.backfillLegacyUserId(legacyUid);
      if (n > 0) console.info(`[ogamex/sidecar] goals backfill: ${n} row(s) → user_id=${legacyUid.slice(0,8)}…`);
    } catch (e) { console.warn("[ogamex/sidecar] goals backfill failed:", e); }
  }
  const worldStateStore = new WorldStateStore({ dbPath: worldStateDbPath });

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
  // Bound events table at boot — rolling 10K window. Trims older rows so
  // disk doesn't grow unbounded across a long-lived deployment. 10K @ ~200
  // bytes/row ≈ 2MB ceiling.
  try { worldStateStore.trimEvents(10_000); }
  catch (e) { console.warn("[ogamex/sidecar] events trim failed (continuing):", e); }
  // v0.0.637 — periodic WAL checkpoint so long-running sidecar keeps disk
  // bounded. better-sqlite3 auto-checkpoints only at 1000 dirty pages / on
  // close; with state.snapshot (every ~2s) + directive lifecycle events,
  // WAL can balloon to 100s of MB between natural checkpoints. 5-min
  // cadence matches typical sidecar idle window.
  const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  const walCheckpointTimer: NodeJS.Timeout = setInterval(() => {
    try { worldStateStore.checkpoint(); }
    catch (e) { console.error("[ogamex/sidecar] WAL checkpoint threw", e); }
  }, WAL_CHECKPOINT_INTERVAL_MS);
  // unref so the timer doesn't keep the event loop alive — stop() still
  // calls clearInterval explicitly for clean shutdown.
  walCheckpointTimer.unref();

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
  try {
    const persisted = worldStateStore.hydrate();
    if (persisted !== null) {
      stateRef.current = persisted.state;
      const ageMin = Math.round((Date.now() - persisted.updated_at) / 60_000);
      console.info(`[ogamex/sidecar] hydrated WorldState from db (age ${ageMin}min, last_update=${persisted.state.last_update})`);
    } else {
      console.info("[ogamex/sidecar] no persisted WorldState — waiting for first state.snapshot");
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
  let worldStateWriteTimer: NodeJS.Timeout | null = null;
  const scheduleWorldStatePersist = (): void => {
    if (worldStateWriteTimer !== null) return;
    worldStateWriteTimer = setTimeout(() => {
      worldStateWriteTimer = null;
      const snap = stateRef.current;
      if (snap === null) return;
      try { worldStateStore.upsert(snap); }
      catch (e) { console.error("[ogamex/sidecar] WorldState upsert failed:", e); }
      shadowFire("upsertWorldState", (uid) => pgStore!.upsertWorldState(uid, snap));
    }, WORLD_STATE_DEBOUNCE_MS);
  };
  const flushWorldStatePersist = (): void => {
    if (worldStateWriteTimer !== null) {
      clearTimeout(worldStateWriteTimer);
      worldStateWriteTimer = null;
    }
    const snap = stateRef.current;
    if (snap === null) return;
    try { worldStateStore.upsert(snap); }
    catch (e) { console.error("[ogamex/sidecar] WorldState flush failed:", e); }
    shadowFire("flushWorldState", (uid) => pgStore!.upsertWorldState(uid, snap));
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
  const ws = {
    on: () => { /* */ },
    send: () => { /* */ },
    start: async () => { /* */ },
    stop: async () => { /* */ },
    port: () => 0,
    clients: new Set<unknown>(),
  } as unknown as WsServer;
  // v0.0.459 forward-decl: priorityMerger is constructed later (after planner
  // + saveCoordinator wiring) but HttpServer's CRUD endpoints (cancelGoal,
  // resumeGoal, etc.) close over it for event-triggered dispatch. Holds the
  // ref so closures stay typesafe; assigned at line ~1055 just after
  // `new PriorityMerger(...)`.
  let priorityMergerRef: PriorityMerger | null = null;
  // v0.0.500 — track fleet IDs we've already fired debris-check for, so each
  // expedition triggers at most one explorer dispatch even if return_at stays
  // set across many snapshots. GC'd when fleet ID disappears from outbound.
  const firedDebrisCheckFor = new Set<string>();
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
  const triggerDispatch = (): void => {
    if (!priorityMergerRef) return;
    try { priorityMergerRef.dispatch(stateRef.current ?? emptyWorldState()); }
    catch (e) { console.error("[merger] triggerDispatch threw", e); }
  };
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
          row_counts: worldStateStore.rowCounts(),
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
        }
      : {}),
    // Operator API providers — surface state/goals/expedition over HTTP.
    stateProvider: () => stateRef.current ?? { ok: false, reason: "no snapshot yet" },
    listGoals: () => {
      const planets = stateRef.current?.planets ?? {};
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
      const universeSpeed = stateRef.current?.server?.speed ?? 1;
      const researchSpeed = stateRef.current?.server?.research_speed ?? universeSpeed;
      function simulate(rootTechName: string, rootTargetLevel: number, rootKind: "research" | "building", planetId: string | undefined, useTreeBuilder: "regular" | "lifeform"): { tree: PrereqTreeNode | null; total: number; totalCost: { m: number; c: number; d: number }; bankAtStart: { m: number; c: number; d: number }; currentStep: { tech: string; kind: "research" | "building"; level: number; cost: { m: number; c: number; d: number } } | null } {
        const planet = planetId ? planets[planetId] ?? Object.values(planets)[0] : Object.values(planets)[0];
        // Initial bank — REAL planet resources at this moment.
        const bank: { m: number; c: number; d: number } = {
          m: planet?.resources?.m ?? 0,
          c: planet?.resources?.c ?? 0,
          d: planet?.resources?.d ?? 0,
        };
        const prodPerSec = {
          m: (planet?.production?.m_h ?? 0) / 3600,
          c: (planet?.production?.c_h ?? 0) / 3600,
          d: (planet?.production?.d_h ?? 0) / 3600,
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
        const buildSec = (cost: { m: number; c: number }, nodeKind: string): number => {
          if (nodeKind === "research") {
            const denom = 1000 * (1 + levels.lab) * Math.max(1, researchSpeed);
            return denom > 0 ? ((cost.m + cost.c) / denom) * 3600 : 3600;
          }
          const denom = 2500 * (1 + levels.robotics) * Math.pow(2, levels.nanite) * Math.max(1, universeSpeed);
          return denom > 0 ? ((cost.m + cost.c) / denom) * 3600 : 3600;
        };
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
        function buildAndSimulate(techName: string, targetLevel: number, kind: "research" | "building"): PrereqTreeNode | null {
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
            const research = stateRef.current?.research?.levels ?? {};
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
            current = kind === "research" ? (research[techName] ?? 0)
                    : techKind === "ship" || techKind === "defense" ? ((planet?.ships as Record<string, number> | undefined)?.[techName] ?? 0)
                    : lookupBuildingLevel(techName);
            costFn = tech.cost_at as typeof costFn;
          }
          const children: PrereqTreeNode[] = [];
          for (const [req, lvl] of Object.entries(tech?.requires ?? {})) {
            const subKind = useTreeBuilder === "lifeform"
              ? "building"
              : ((TECH_TREE as Record<string, { kind?: string }>)[req]?.kind === "research" ? "research" : "building");
            const node = buildAndSimulate(req, lvl, subKind);
            if (node) children.push(node);
          }
          // Self: simulate levels current+1..target IN ORDER
          let selfEta = 0;
          if (current < targetLevel && typeof costFn === "function") {
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
              const wait = timeToAfford(cost);
              if (!isFinite(wait)) { total = Infinity; break; }
              accumulate(wait);
              const build = buildSec(cost, kind);
              accumulate(build);
              // Pay cost (subtract; cap-clamped on accumulate)
              bank.m = Math.max(0, bank.m - cost.m);
              bank.c = Math.max(0, bank.c - cost.c);
              bank.d = Math.max(0, bank.d - (cost.d ?? 0));
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
          const rq = stateRef.current?.research?.queue as { ends_at?: number; tech?: string } | undefined;
          if (rq && rq.tech === tgt.tech && rq.ends_at && rq.ends_at > now) return rq.ends_at;
        }
        return null;
      };
      const collectPrereqNames = (node: PrereqTreeNode | null, out: Set<string>): void => {
        if (!node) return;
        if (!node.met) out.add(node.tech);
        for (const c of node.children) collectPrereqNames(c, out);
      };
      return goalsStore.list().map((r) => {
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
    expeditionProvider: () => {
      const ready = stateRef.current !== null;
      let paused = false;
      try {
        const fp = path.join(os.tmpdir(), "ogamex-expedition.json");
        const raw = fs.readFileSync(fp, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        paused = parsed["paused"] === true;
      } catch { /* missing or malformed — treat as not paused */ }
      if (!ready) return { state_ready: false, used: -1, max: -1, paused, active: [] };
      // Slot source: max from scraped (if available) else derive from astro
      // level (floor(sqrt(astro)) + class bonus). Used: fleets_outbound m=15
      // count is most accurate (real-time), fall back to scraped server.*.
      const srv = (stateRef.current?.server ?? {}) as { used_expedition_slots?: number; max_expedition_slots?: number; player_class?: string };
      const astro = stateRef.current?.research?.levels?.["astrophysics"] ?? 0;
      const fleets15 = (stateRef.current?.fleets_outbound ?? []).filter((f) => f.mission === 15).length;
      const classBonus = (srv.player_class ?? process.env["OGAMEX_DEFAULT_CLASS"] ?? "") === "discoverer" ? 2 : 0;
      const computedMax = Math.floor(Math.sqrt(astro)) + classBonus;
      const slots = {
        used: Math.max(fleets15, srv.used_expedition_slots ?? 0),
        max: srv.max_expedition_slots && srv.max_expedition_slots > 0 ? srv.max_expedition_slots : computedMax,
      };
      const fleets = stateRef.current?.fleets_outbound ?? [];
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
    emergencyProvider: () => {
      // Minimal emergency stub — surfaces hostile incoming events from
      // state.events_incoming as the panel expects. Full attack-save
      // orchestration lives userscript-side; this endpoint is just a read.
      const ev = stateRef.current?.events_incoming ?? [];
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
        ships_count: typeof e.ships_count === "number" ? e.ships_count : "?",
      }));
      return {
        hostile,
        count: hostile.length,
        snapshot_age_ms: stateRef.current?.last_update ? (now - stateRef.current.last_update) : null,
      };
    },
    listEvents: (limit, type) => {
      // v0.0.636 — operator audit view. Defaults bounded by HttpServer at
      // 100/1000 (limit) — store-level pagination keeps memory tiny since
      // it's a single LIMIT N query on an indexed table.
      try {
        return type !== undefined && type.length > 0
          ? worldStateStore.listEventsByType(type, limit)
          : worldStateStore.listRecentEvents(limit);
      } catch (e) {
        console.error("[ogamex/sidecar] listEvents failed", e);
        return [];
      }
    },
    cancelGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      // v0.0.481: cascade cancel — cancel all live descendants whose
      // parent_goal_id traces back to this id (BFS through parent_goal_id
      // chain). Architecture B: parent-child sub-goal relationship.
      const cascadeIds: string[] = [];
      const queue = [id];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const pid = queue.shift()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        for (const child of goalsStore.listChildren(pid)) {
          if (child.status === "completed" || child.status === "cancelled") continue;
          cascadeIds.push(child.goal.id);
          queue.push(child.goal.id);
        }
      }
      goalsStore.updateStatus(id, "cancelled", "via /v1/goals/{id}/cancel");
      priorityMergerRef?.clearAwaiting(id);
      priorityMergerRef?.clearDispatched(id);
      for (const cid of cascadeIds) {
        goalsStore.updateStatus(cid, "cancelled", `cascade: parent ${id.slice(0, 12)} cancelled`);
        priorityMergerRef?.clearAwaiting(cid);
        priorityMergerRef?.clearDispatched(cid);
      }
      triggerDispatch();
      return { ok: true, cascaded: cascadeIds.length };
    },
    pauseGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.updateStatus(id, "blocked", "paused by operator");
      priorityMergerRef?.clearDispatched(id);
      triggerDispatch();
      return { ok: true };
    },
    resumeGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.updateStatus(id, "pending", "resumed by operator");
      // v0.0.459: operator-triggered retry — clear awaiting so this goal
      // is eligible for dispatch on the immediate triggerDispatch below.
      priorityMergerRef?.clearAwaiting(id);
      priorityMergerRef?.clearDispatched(id);
      triggerDispatch();
      return { ok: true };
    },
    setMainGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.setMainGoal(id);
      triggerDispatch();
      return { ok: true };
    },
    unsetMainGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.setMainGoal(null);
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
    createGoal: (body) => {
      // M4 — generic goal creation from the panel modal. Trust the body's
      // type/target/planet/priority fields and write straight to goals_store.
      // Validation is intentionally minimal (operator-only LAN UI); the
      // planner will surface bad targets via "blocked: …" on first tick.
      // Operator 2026-05-29: mirrors shared/types.ts GoalType union — keep
      // these in sync. "jumpgate" (v0.0.421 Phase 2b), "species_discovery"
      // both added so frontend modals can create them via this endpoint.
      const SUPPORTED = new Set([
        "research", "build", "build_universal", "colonize",
        "build_ships", "build_defense", "terraformer_to", "expedition",
        "deploy", "transport", "pick_lifeform", "lifeform_level_to",
        "lifeform_research", "lifeform_building",
        "species_discovery", "jumpgate",
      ]);
      if (!SUPPORTED.has(body.type)) return { ok: false, reason: `unsupported goal type: ${body.type}` };
      const id = `${body.type.slice(0, 4)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      goalsStore.add({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        id, type: body.type as any,
        target: body.target,
        ...(body.planet ? { planet: body.planet } : { planet: "" }),
        priority: typeof body.priority === "number" ? body.priority : 5,
        is_main_goal: false,
        status: "pending", created_at: Date.now(),
        progress_pct: 0, current_step: "queued", eta_at: null,
      });
      console.log(`[goal/create] ${id} type=${body.type} planet=${body.planet ?? "(none)"} priority=${body.priority ?? 5}`);
      triggerDispatch();
      return { ok: true, goal_id: id };
    },
    createDiscoveryGoal: (body) => {
      const planet = stateRef.current?.planets?.[body.source_planet];
      if (!planet) return { ok: false, reason: `unknown planet ${body.source_planet}` };
      // Block second active discovery for same planet (operator panel UX).
      const existing = goalsStore.list().find((r) =>
        r.goal.type === "species_discovery" &&
        !["completed", "cancelled"].includes(r.status) &&
        (r.goal.target as { source_planet?: string }).source_planet === body.source_planet
      );
      if (existing) return { ok: false, reason: `discovery already active on ${body.source_planet} (goal ${existing.goal.id})` };
      const id = `disc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      goalsStore.add({
        id, type: "species_discovery",
        target: {
          source_planet: body.source_planet,
          galaxy: body.galaxy,
          base_system: body.base_system,
          range: body.range ?? 10,
          completed: [],
        },
        planet: body.source_planet, priority: 5, is_main_goal: false,
        status: "pending", created_at: Date.now(),
        progress_pct: 0, current_step: "queued", eta_at: null,
      });
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
    listActiveSaves: () => {
      // listActiveSaves is read-only for the operator's own debug UI; it
      // returns the legacy instance's FSM rows. Multi-tenant listing would
      // need a PG query keyed by ALS uid — punted to 9c.5.
      const u = getCurrentUserId();
      const c = isLegacyUid(u) ? saveCoordinator : saveCoordManager.get(u!);
      return c.list();
    },
  });
  const http = httpServerCtor();
  await Promise.all([ws.start(), http.start()]);

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
    const fan = (m: UpstreamMsg): void => {
      // M8.5: every upstream message lands in the DebugBuffer once, before
      // consumer handlers run. directive_completed is doubly-recorded — once
      // as a generic event row, once as a state mutation on the matching
      // dispatched directive. Errors here would only happen if the buffer
      // itself throws (it doesn't), so no try/catch.
      debug.recordEvent(m);
      if (m.type === "event.directive_completed") {
        debug.recordComplete(m.directive_id, m.result);
        // v0.0.636 — audit ack into events table. Truncate error string to
        // keep payloads bounded (matches debug-buffer convention).
        try {
          const r = m.result as { success?: boolean; error?: string } | undefined;
          const errStr = typeof r?.error === "string" ? r.error.slice(0, 400) : undefined;
          const payload = {
            directive_id: m.directive_id,
            success: r?.success === true,
            error: errStr,
          };
          worldStateStore.appendEvent("directive.completed", payload);
          shadowFire("appendEvent.completed", (uid) => pgStore!.appendEvent(uid, "directive.completed", payload));
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
            const TRANSIENT_RE = /140043|140028|140019|請稍後再試|请稍后再试|稍後再試|try again later|cannot dispatch fleet|slots full|early skip, not queued|倉存容量不足|仓存容量不足|storage.*insufficient|insufficient.*storage|已達艦隊數上限|已达舰队数上限|fleet count limit|maximum.*fleets|already.*maximum/i;
            const isTransient = TRANSIENT_RE.test(reason);
            const row = goalsStore.list().find((r) => r.goal.id === goalId);
            const type = row?.goal.type;
            if (!isTransient && (type === "expedition" || type === "colonize" || type === "deploy" || type === "transport")) {
              goalsStore.updateStatus(goalId, "cancelled", reason);
              priorityMergerRef?.clearAwaiting(goalId);
              priorityMergerRef?.clearDispatched(goalId);
            } else {
              goalsStore.updateStatus(goalId, "blocked", reason);
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
              priorityMergerRef?.markAwaiting(goalId, ["empire_poll", "backoff_60s"]);
              setTimeout(() => {
                priorityMergerRef?.clearAwaiting(goalId, "backoff_60s");
              }, 60_000);
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
            const row = goalsStore.list().find((r) => r.goal.id === goalId);
            const type = row?.goal.type;
            if (type === "expedition" || type === "colonize" || type === "deploy" || type === "transport" || type === "jumpgate") {
              // v0.0.446: jumpgate added — operator 2026-05-29 verified
              // JG dispatch succeeded but goal stuck active because this
              // list missed it. Now mark completed on ack so chain prereq
              // unblocks next leg (LegC deploy moon→planet).
              goalsStore.updateStatus(goalId, "completed");
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
                  goalsStore.updateTarget(goalId, { ...tgt, completed } as Record<string, unknown>);
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
                  goalsStore.updateTarget(goalId, { ...tgt, completed } as Record<string, unknown>);
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
                goalsStore.updateStatus(goalId, "pending");
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

  // --- MemoryWriter --------------------------------------------------------
  const memoryWriter = startMemoryWriter({
    memoryDir,
    debounceMs: 5000,
    forceRefreshMs: 60_000,
  });

  // --- PriorityMerger ------------------------------------------------------
  const priorityMerger: PriorityMerger = new PriorityMerger({
    store: goalsStore,
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
          worldStateStore.appendEvent("directive.dispatch", payload);
          shadowFire("appendEvent.dispatch", (uid) => pgStore!.appendEvent(uid, "directive.dispatch", payload));
        } catch (e) { console.error("[ogamex/sidecar] appendEvent dispatch threw", e); }
        // Remember directive_id → goal_id so we can mark the goal blocked
        // when the ack returns with success:false. Without this, ApiExec
        // failures (e.g., expedition 140054) leave the goal "active"
        // forever and merger keeps re-dispatching every cooldown cycle.
        const d = msg.directive as { id: string; goal_id?: string; action?: string; params?: { galaxy?: number; system?: number; position?: number } };
        if (d.id && d.goal_id) directiveToGoal.set(d.id, d.goal_id);
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
          const row = goalsStore.list().find((r) => r.goal.id === d.goal_id);
          if (row && row.goal.type === "species_discovery") {
            const tgt = row.goal.target as { completed?: string[] };
            const completed = Array.isArray(tgt.completed) ? [...tgt.completed] : [];
            if (!completed.includes(coord)) {
              completed.push(coord);
              goalsStore.updateTarget(d.goal_id, { ...row.goal.target, completed } as Record<string, unknown>);
            }
          }
        }
      }
      ws.send(msg);
      // HTTP-side consumers (long-poll) also need the directive — queue it
      // so a polling userscript receives the dispatch.
      http.queueDownstream(msg);
    },
  });
  // v0.0.459 forward-ref assignment — CRUD endpoints + directive_completed
  // handler use priorityMergerRef + triggerDispatch via closure (declared
  // above ws/http setup). Without this assignment, those closures see null
  // and noop on every CRUD call → no dispatch → goal stuck pending forever.
  priorityMergerRef = priorityMerger;
  // Directive → goal mapping (in-memory). Trimmed when ack arrives.
  const directiveToGoal = new Map<string, string>();
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
        worldStateStore.upsertSaveRecord(rec);
        shadowFire("upsertSaveRecord", (uid) => pgStore!.upsertSaveRecord(uid, rec));
      },
      delete: (planet_id) => {
        worldStateStore.deleteSaveRecord(planet_id);
        shadowFire("deleteSaveRecord", (uid) => pgStore!.deleteSaveRecord(uid, planet_id));
      },
    },
  });
  // Rehydrate persisted FSM rows before any state.snapshot or HTTP call
  // touches the coordinator. Without this, the disk rows would still be
  // there but the in-memory map would say "no active save" and a new
  // launch on the same planet would silently overwrite the prior record.
  try {
    const persisted = worldStateStore.listSaveRecords();
    if (persisted.length > 0) {
      saveCoordinator.rehydrate(persisted);
      console.info(`[ogamex/sidecar] rehydrated ${persisted.length} save_record(s) — planets=${persisted.map((r) => r.planet_id).join(",")}`);
    }
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
        worldStateStore.upsertFailureCooldown(task, last_analysis_at);
        shadowFire("upsertCooldown", (uid) => pgStore!.upsertFailureCooldown(uid, task, last_analysis_at));
      },
      listCooldowns: () => worldStateStore.listFailureCooldowns(),
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
  const legacyOperatorUid = (process.env.OGAMEX_LEGACY_USER_ID ?? "").trim();
  const isLegacyUid = (uid: string | undefined): boolean =>
    !uid || (legacyOperatorUid !== "" && uid === legacyOperatorUid);
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
        // Per-user cooldown hydrate would need an async listFailureCooldowns(uid)
        // PG call before first record() — punted to 9c.5 when paid user2 lands;
        // empty start is safe (first failure triggers analyzer immediately,
        // which is the conservative default after a restart anyway).
        listCooldowns: () => [],
      },
    }),
  });

  // --- DigestScheduler (M8.2) ----------------------------------------------
  // Publishes a markdown summary of Strategy/Goals/Snapshot to Discord once
  // per local day at 06:00 UTC by default. Skips silently if no reporter is
  // configured. The poll interval is intentionally coarse — minute granularity
  // is plenty for a daily digest, and avoids wakeups during normal operation.
  const digestScheduler = startDigestScheduler({
    reporter,
    goalsStore,
    strategyManager,
    stateRef,
  });

  // -------------------------------------------------------------------------
  // Upstream handlers — registered ONCE against the wrapped on, which the
  // cross-transport relay fans both ws and http arrivals into.
  // -------------------------------------------------------------------------

  ws.on("state.snapshot", (msg) => {
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

    // Persist (debounced) — every snapshot schedules at most one write inside
    // the 1s window. Coalesces bursts when the userscript pushes 3-5
    // snapshots per page change.
    scheduleWorldStatePersist();

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
        const fireFor = (fleetId: string, origin: readonly number[], dest: readonly number[], reason: string): void => {
          if (firedDebrisCheckFor.has(fleetId)) return;
          if (!Array.isArray(origin) || origin.length !== 3 || !Array.isArray(dest)) return;
          const originPlanet = findOriginPlanet(origin.join(":"));
          if (!originPlanet) {
            console.log(`[debris-check] SKIP fleet ${fleetId}: origin ${origin.join(":")} not in planets`);
            return;
          }
          const g = dest[0], s = dest[1];
          if (typeof g !== "number" || typeof s !== "number") return;
          firedDebrisCheckFor.add(fleetId);
          const dbgMsg = { type: "expedition.debris_check" as const, galaxy: g, system: s, origin_planet_id: originPlanet.id, reason };
          ws.send(dbgMsg);
          http.queueDownstream(dbgMsg);
          console.log(`[debris-check] FIRED fleet ${fleetId} ${reason}: G:S=${g}:${s} origin=${originPlanet.id}`);
        };
        // Signal A: scan current snapshot for mission=15 with return_at set.
        // Signal C (NEW): arrival_at transition past→future = fleet entered
        //   return phase (most reliable signal in practice — return_at often
        //   stays NULL even after fleet starts returning).
        const nowMs = Date.now();
        const currentExpIds = new Set<string>();
        for (const f of msg.snapshot.fleets_outbound ?? []) {
          if (typeof f.id !== "string") continue;
          if (f.mission !== 15) continue;
          currentExpIds.add(f.id);
          const prev = expLastSeen.get(f.id);
          const prevArrival = prev?.arrival_at ?? null;
          expLastSeen.set(f.id, { origin: f.origin, dest: f.dest, arrival_at: f.arrival_at ?? null, return_at: f.return_at ?? null });
          // Signal A — return_at appeared
          if (f.return_at !== null && f.return_at !== undefined) {
            fireFor(f.id, f.origin, f.dest, `return_at set (=${f.return_at})`);
            continue;
          }
          // Signal C — arrival_at jumped past → future (next phase deadline)
          if (prevArrival !== null && prevArrival < nowMs && (f.arrival_at ?? 0) > nowMs) {
            fireFor(f.id, f.origin, f.dest, `arrival_at jumped past→future (${prevArrival}→${f.arrival_at}) — phase transition`);
          }
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
        for (const [fid, info] of Array.from(expLastSeen.entries())) {
          if (currentExpIds.has(fid)) continue;
          if (info.return_at === null) {
            // Holding entry — keep expLastSeen so the next reappearance
            // (returning phase) can update return_at and Signal A/B will
            // fire correctly.
            continue;
          }
          fireFor(fid, info.origin, info.dest, "fleet disappeared from outbound (was returning → home)");
          expLastSeen.delete(fid);
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
        updateBuildShipsProgress(prev, msg.snapshot, goalsStore);
      } catch (e) {
        console.error("[ogamex/sidecar] ship-progress watcher threw", e);
      }
    }

    memoryWriter.push({
      state: msg.snapshot,
      goals: goalsStore.listActive(),
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
      const dispUid = getCurrentUserId();
      const result = priorityMerger.dispatch(msg.snapshot, dispUid);
      const actions = result.dispatched.map((d) => {
        const params = d.params as { building?: string; tech?: string; ship?: string };
        const label = params.building ?? params.tech ?? params.ship ?? d.action;
        return `${d.action}/${label}`;
      }).join(",");
      const uidTag = dispUid ? ` user=${dispUid.slice(0, 8)}…` : "";
      console.log(`[merger] dispatched=${result.dispatched.length} blocked=${result.blocked.length} done=0 actions=${actions}${uidTag}`);
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
      worldStateStore.appendEvent("event.daily_failure", payload);
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
      worldStateStore.appendEvent("event.emergency", payload);
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
    if (reporter === null) return;
    // Emergency push throws on failure (reporter contract). Swallow here so
    // a temporarily flaky Discord doesn't crash the relay — operator sees
    // the failure in plugin logs.
    void reporter.pushEmergency(msg.markdown_report).catch((err: unknown) => {
      console.error("[ogamex/sidecar] reporter.pushEmergency failed", err);
    });
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
    clearInterval(walCheckpointTimer);
    // Flush any pending debounced WorldState write BEFORE closing the SQLite
    // handle — otherwise the most recent snapshot may not land on disk.
    try { flushWorldStatePersist(); }
    catch (err) { console.error("[ogamex/sidecar] WorldState flush threw", err); }
    // Final checkpoint so the WAL on disk is fully merged before close.
    try { worldStateStore.checkpoint(); }
    catch (err) { console.error("[ogamex/sidecar] final WAL checkpoint threw", err); }
    await Promise.all([ws.stop(), http.stop()]);
    try {
      goalsStore.close();
    } catch (err) {
      console.error("[ogamex/sidecar] goalsStore.close failed", err);
    }
    try {
      worldStateStore.close();
      if (pgStore) {
        try { await pgStore.close(); }
        catch (err) { console.error("[ogamex/sidecar] pgStore.close failed", err); }
      }
    } catch (err) {
      console.error("[ogamex/sidecar] worldStateStore.close failed", err);
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
    goalsStore,
    worldStateStore,
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
    const expeditionStateFile = path.join(os.tmpdir(), "ogamex-expedition.json");
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
