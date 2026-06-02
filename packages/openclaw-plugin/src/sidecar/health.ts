/**
 * M8.1 — `/v1/health` report builder.
 *
 * Pure composition of a HealthReport from injected runtime references. Lives
 * separate from `http_server.ts` so the JSON shape can be unit-tested without
 * spinning up a Node http server, and so operators can reuse the function in
 * other surfaces (CLI status command, structured log line, etc.).
 *
 * The "overall ok" bit is a strict AND of subsystem health: bridge open,
 * llm reachable, and at least one state.snapshot received. Anything weaker
 * would let an operator see a green badge while the sidecar is effectively
 * blind to the game.
 */

import type { WorldState } from "@ogamex/shared";

export interface HealthDeps {
  /** When the sidecar booted (ms epoch). */
  startedAt: number;
  /** Latest state.snapshot ts from userscript (ms), or null if never received. */
  lastUserscriptSeenAt: number | null;
  /** Whether the bridge has at least one active WS connection right now. */
  bridgeOpen: () => boolean;
  /**
   * Function that probes the LLM with a trivial request. Returns ok + rtt on
   * success; ok=false + error on failure. Caller is responsible for any
   * timeout/cancellation — buildHealthReport just awaits the promise.
   */
  llmPing: () => Promise<{ ok: boolean; rttMs: number | null; error?: string }>;
  /** Most recent worldState mirror, if any. */
  stateRef: { current: WorldState | null };
  /** Current strategy version (from StrategyManager.load().version). */
  strategyVersion: () => number;
  /** Phase 9c.1 — number of distinct user_ids whose state.snapshot has
   *  landed since this sidecar booted. 0 = single-tenant operator-only
   *  legacy mode. ≥1 = real multi-tenant flow. */
  multiTenantSnapshot?: () => {
    users_tracked: number;
    last_seen_max_age_seconds: number | null;
    /** Phase 9c.3 — number of non-legacy users whose SaveCoordinator /
     *  FailureAggregator instances have been minted by the manager. 0
     *  while only operator (legacy uid) is active; ≥1 once a foreign
     *  user pushes state.snapshot. */
    save_coord_instances?: number;
    failure_agg_instances?: number;
    reporter_instances?: number;
    poll_buckets?: Record<string, number>;
  };
  /** Optional persistence-tier stats. When absent, the `persistence` field
   *  is omitted from the report (older sidecars / unit tests that don't
   *  wire SQLite). */
  persistenceStats?: () => {
    db_path: string;
    db_size_bytes: number;
    wal_size_bytes: number;
    row_counts: {
      events: number;
      save_records: number;
      failure_cooldowns: number;
      world_state_present: boolean;
    };
  };
}

export interface HealthReport {
  /** Overall health: all subsystems ok. */
  ok: boolean;
  /** ms epoch when the report was built. */
  ts: number;
  sidecar: {
    started_at: number;
    uptime_seconds: number;
  };
  userscript: {
    connected: boolean;
    last_seen_at: number | null;
    last_seen_ago_seconds: number | null;
  };
  llm: {
    ok: boolean;
    rtt_ms: number | null;
    /** Omitted (not undefined) when ok — exactOptionalPropertyTypes friendly. */
    error?: string;
  };
  state: {
    has_snapshot: boolean;
    server_universe: string | null;
    planets_count: number;
    /** Identity slice per known planet — id + name + coords + type. Used by
     *  the add_goal CLI to populate planet_coords context without needing a
     *  full state.snapshot fetch. Empty array when no snapshot received. */
    planets: Array<{ id: string; name: string; coords: number[]; type: string }>;
    fleets_outbound_count: number;
    events_incoming_count: number;
    hostile_events_count: number;
  };
  strategy: {
    version: number;
  };
  multi_tenant?: {
    users_tracked: number;
    last_seen_max_age_seconds: number | null;
    save_coord_instances?: number;
    failure_agg_instances?: number;
    /** Phase 9c.5 — non-empty queue buckets and their entry counts.
     *  Key is "_legacy_" for operator/global-token bucket, otherwise the
     *  user_id uuid prefix (first 8 chars). Empty buckets are omitted. */
    poll_buckets?: Record<string, number>;
  };
  persistence?: {
    db_path: string;
    db_size_bytes: number;
    wal_size_bytes: number;
    row_counts: {
      events: number;
      save_records: number;
      failure_cooldowns: number;
      world_state_present: boolean;
    };
  };
}

export async function buildHealthReport(deps: HealthDeps): Promise<HealthReport> {
  const now = Date.now();

  const bridgeOpen = safeCall(deps.bridgeOpen, false);
  const strategyVersion = safeCall(deps.strategyVersion, 0);

  // The LLM ping is the only async dep — caller controls its timeout. We
  // swallow exceptions so a thrown ping never crashes the report builder;
  // any error becomes llm.error.
  let llmOk = false;
  let llmRtt: number | null = null;
  let llmError: string | undefined;
  try {
    const probe = await deps.llmPing();
    llmOk = probe.ok;
    llmRtt = probe.rttMs;
    if (!probe.ok) {
      llmError = probe.error ?? "unknown llm error";
    }
  } catch (e) {
    llmOk = false;
    llmRtt = null;
    llmError = (e as Error).message;
  }

  const snapshot = deps.stateRef.current;
  const hasSnapshot = snapshot !== null;

  const hostileEventsCount = snapshot
    ? snapshot.events_incoming.filter((e) => e.hostile).length
    : 0;

  const lastSeenAgo = deps.lastUserscriptSeenAt === null
    ? null
    : Math.round((now - deps.lastUserscriptSeenAt) / 1000);

  // Construct llm slice conditionally so `error` is omitted (not set to
  // undefined) when the ping succeeded — required under
  // exactOptionalPropertyTypes.
  const llmSlice: HealthReport["llm"] = llmError === undefined
    ? { ok: llmOk, rtt_ms: llmRtt }
    : { ok: llmOk, rtt_ms: llmRtt, error: llmError };

  // Persistence-tier slice — wired only when caller supplied a stats fn.
  // Wrapped in try/catch so a SQLite hiccup never crashes the report.
  let persistenceSlice: HealthReport["persistence"] | undefined;
  if (deps.persistenceStats) {
    try { persistenceSlice = deps.persistenceStats(); }
    catch (e) { console.warn("[health] persistenceStats threw", e); }
  }
  let multiTenantSlice: HealthReport["multi_tenant"] | undefined;
  if (deps.multiTenantSnapshot) {
    try { multiTenantSlice = deps.multiTenantSnapshot(); }
    catch (e) { console.warn("[health] multiTenantSnapshot threw", e); }
  }

  return {
    ok: bridgeOpen && llmOk && hasSnapshot,
    ts: now,
    sidecar: {
      started_at: deps.startedAt,
      uptime_seconds: Math.round((now - deps.startedAt) / 1000),
    },
    userscript: {
      connected: bridgeOpen,
      last_seen_at: deps.lastUserscriptSeenAt,
      last_seen_ago_seconds: lastSeenAgo,
    },
    llm: llmSlice,
    state: {
      has_snapshot: hasSnapshot,
      server_universe: snapshot?.server.universe ?? null,
      planets_count: Object.keys(snapshot?.planets ?? {}).length ?? 0,
      planets: Object.values(snapshot?.planets ?? {})
        .filter((p) => Array.isArray(p.coords) && p.coords.length === 3)
        .map((p) => ({
          id: p.id, name: p.name ?? "", coords: [...(p.coords as readonly number[])], type: p.type ?? "planet",
        })),
      fleets_outbound_count: snapshot?.fleets_outbound.length ?? 0,
      events_incoming_count: snapshot?.events_incoming.length ?? 0,
      hostile_events_count: hostileEventsCount,
    },
    strategy: { version: strategyVersion },
    ...(multiTenantSlice !== undefined ? { multi_tenant: multiTenantSlice } : {}),
    ...(persistenceSlice !== undefined ? { persistence: persistenceSlice } : {}),
  };
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
