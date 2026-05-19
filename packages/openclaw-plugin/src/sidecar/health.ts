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
    fleets_outbound_count: number;
    events_incoming_count: number;
    hostile_events_count: number;
  };
  strategy: {
    version: number;
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
      planets_count: snapshot?.planets.length ?? 0,
      fleets_outbound_count: snapshot?.fleets_outbound.length ?? 0,
      events_incoming_count: snapshot?.events_incoming.length ?? 0,
      hostile_events_count: hostileEventsCount,
    },
    strategy: { version: strategyVersion },
  };
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
