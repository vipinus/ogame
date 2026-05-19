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
import { Reporter } from "./reporter.js";
import { StrategyManager } from "./strategy_manager.js";
import { GoalsStore } from "./goals_store.js";
import { GeminiClient } from "./gemini_client.js";
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

export interface SidecarConfig {
  wsPort: number;
  httpPort: number;
  bridgeToken: string;
  discordChannelId?: string;
  /** Where to store strategy.json + git audit repo. Default ~/.openclaw/workspace/ogamex-strategy. */
  strategyRepoDir?: string;
  /** Path to goals SQLite file. Default ~/.openclaw/workspace/ogamex-goals.db. ":memory:" for tests. */
  goalsDbPath?: string;
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
  priorityMerger: PriorityMerger;
  failureAggregator: FailureAggregator;
  memoryWriter: MemoryWriterHandle;
  /** Current world-state mirror, populated by the state.snapshot handler. */
  stateRef: { current: WorldState | null };
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
        duration: "short",
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
    planets: [],
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
  const memoryDir = config.memoryDir ?? path.join(workspaceDir, "memory");

  const strategyManager = new StrategyManager({
    repoDir: strategyRepoDir,
    defaultStrategy: effectiveOpts.defaultStrategy ?? bootstrapStrategy(),
  });
  // init() is idempotent — safe to call even when the repo already exists.
  strategyManager.init();

  const goalsStore = new GoalsStore({ dbPath: goalsDbPath });

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

  // --- DebugBuffer (M8.5) --------------------------------------------------
  // Rings the last 100 dispatched directives + 100 upstream events. Wired
  // into both the PriorityMerger send path and the cross-transport relay
  // further below. Constructed up here so the HttpServer constructor can
  // close over `debug.snapshot` for the /v1/debug HTML page.
  const debug = new DebugBuffer();

  // --- Transports ----------------------------------------------------------
  const ws = new WsServer({ port: config.wsPort, token: config.bridgeToken });
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
      bridgeOpen: () => (ws as unknown as { clients: Set<unknown> }).clients.size > 0,
      llmPing: () => pingGemini(geminiClient),
      stateRef,
      strategyVersion: () => strategyManager.load().version,
    }),
    debugSnapshot: () => debug.snapshot(),
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
  const priorityMerger = new PriorityMerger({
    store: goalsStore,
    planGoal,
    send: (msg: DownstreamMsg) => {
      // M8.5: record every dispatched directive in the DebugBuffer so the
      // /v1/debug page can show what was sent + (later) whether it completed.
      // Other DownstreamMsg variants (strategy.full, ping…) are skipped — the
      // debug page is directive-centric, not bridge-traffic-centric.
      if (msg.type === "directive.dispatch") {
        debug.recordDispatch(msg.directive);
      }
      ws.send(msg);
      // HTTP-side consumers (long-poll) also need the directive — queue it
      // so a polling userscript receives the dispatch.
      http.queueDownstream(msg);
    },
  });

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
  });

  // -------------------------------------------------------------------------
  // Upstream handlers — registered ONCE against the wrapped on, which the
  // cross-transport relay fans both ws and http arrivals into.
  // -------------------------------------------------------------------------

  ws.on("state.snapshot", (msg) => {
    stateRef.current = msg.snapshot;
    lastSeen.at = Date.now();
    memoryWriter.push({
      state: msg.snapshot,
      goals: goalsStore.listActive(),
      strategy: strategyManager.load(),
    });
    // Dispatch active goals (idempotent — already-active rows still get a
    // freshly-planned next step). Synchronous; errors propagate inside the
    // relay's try/catch and won't crash the socket loop.
    priorityMerger.dispatch(msg.snapshot);
  });

  ws.on("event.daily_failure", (msg) => {
    // record() is async; fire-and-forget. We attach a catch so a stuck
    // analyzer never produces an unhandled rejection (which would crash
    // Node in --unhandled-rejections=strict mode).
    void failureAggregator.record({
      task: msg.task,
      attempts: msg.attempts,
      last_error: msg.last_error,
      context: msg.context,
    }).catch((err: unknown) => {
      console.error("[ogamex/sidecar] failureAggregator.record failed", err);
    });
  });

  ws.on("event.emergency", (msg) => {
    if (reporter === null) return;
    // Emergency push throws on failure (reporter contract). Swallow here so
    // a temporarily flaky Discord doesn't crash the relay — operator sees
    // the failure in plugin logs.
    void reporter.pushEmergency(msg.markdown_report).catch((err: unknown) => {
      console.error("[ogamex/sidecar] reporter.pushEmergency failed", err);
    });
  });

  ws.on("hello", () => {
    // The userscript has just connected and announced its strategy_version.
    // Reply with the canonical Strategy so it can reconcile any drift.
    // We use ws.send (broadcast to all connected clients) — the userscript
    // is the only expected consumer; if multiple clients are connected they
    // all benefit from the same snapshot.
    ws.send({ type: "strategy.full", strategy: strategyManager.load() });
  });

  // --- Online banner -------------------------------------------------------
  if (reporter !== null) {
    const wsPort = ws.port();
    const httpPort = http.port();
    const banner =
      `OgameX online — sidecar listening on ws://127.0.0.1:${wsPort}` +
      ` + http://127.0.0.1:${httpPort}`;
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
    memoryWriter.stop();
    await Promise.all([ws.stop(), http.stop()]);
    try {
      goalsStore.close();
    } catch (err) {
      console.error("[ogamex/sidecar] goalsStore.close failed", err);
    }
  };

  return {
    ws,
    http,
    reporter,
    strategyManager,
    goalsStore,
    priorityMerger,
    failureAggregator,
    memoryWriter,
    stateRef,
    stop,
  };
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
