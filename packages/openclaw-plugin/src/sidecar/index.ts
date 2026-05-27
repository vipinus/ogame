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
      function simulate(rootTechName: string, rootTargetLevel: number, rootKind: "research" | "building", planetId: string | undefined, useTreeBuilder: "regular" | "lifeform"): { tree: PrereqTreeNode | null; total: number } {
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
        const robotics = planet?.buildings?.["roboticsFactory"] ?? 0;
        const nanite = planet?.buildings?.["naniteFactory"] ?? 0;
        const lab = planet?.buildings?.["researchLab"] ?? 0;
        const buildSec = (cost: { m: number; c: number }, nodeKind: string): number => {
          if (nodeKind === "research") {
            const denom = 1000 * (1 + lab) * Math.max(1, researchSpeed);
            return denom > 0 ? ((cost.m + cost.c) / denom) * 3600 : 3600;
          }
          const denom = 2500 * (1 + robotics) * Math.pow(2, nanite) * Math.max(1, universeSpeed);
          return denom > 0 ? ((cost.m + cost.c) / denom) * 3600 : 3600;
        };
        const accumulate = (sec: number) => {
          bank.m = Math.min(bank.m + prodPerSec.m * sec, caps.m);
          bank.c = Math.min(bank.c + prodPerSec.c * sec, caps.c);
          bank.d = Math.min(bank.d + prodPerSec.d * sec, caps.d);
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
            current = kind === "research" ? (research[techName] ?? 0)
                    : techKind === "ship" || techKind === "defense" ? ((planet?.ships as Record<string, number> | undefined)?.[techName] ?? 0)
                    : (planet?.buildings?.[techName] ?? 0);
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
        return { tree, total };
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
          if (/^\d+:\d+:\d+$/.test(ref)) {
            for (const [id, p] of Object.entries(planets)) {
              const c = (p as { coords?: readonly number[] } | undefined)?.coords;
              if (Array.isArray(c) && c.join(":") === ref) return id;
            }
            return undefined;
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
        const planetRef = typeof r.goal.planet === "string" ? r.goal.planet : undefined;
        // Resolve planet ref (id-or-coord) to id for tree lookup.
        let resolvedPlanetId = planetRef;
        if (planetRef && /^\d+:\d+:\d+$/.test(planetRef)) {
          for (const [id, p] of Object.entries(planets)) {
            if (Array.isArray(p?.coords) && p.coords.join(":") === planetRef) {
              resolvedPlanetId = id; break;
            }
          }
        }
        if (r.goal.type === "research" && target.tech) {
          prereq_tree = simulate(target.tech, lvl, "research", resolvedPlanetId, "regular").tree;
        } else if (r.goal.type === "build" && target.building) {
          prereq_tree = simulate(target.building, lvl, "building", resolvedPlanetId, "regular").tree;
        } else if (r.goal.type === "lifeform_building" && target.building) {
          prereq_tree = simulate(target.building, lvl, "building", resolvedPlanetId, "lifeform").tree;
        } else if (r.goal.type === "build_ships") {
          const shipTarget = r.goal.target as { ship?: string; amount?: number };
          if (shipTarget.ship) {
            prereq_tree = simulate(shipTarget.ship, shipTarget.amount ?? 1, "building", resolvedPlanetId, "regular").tree;
          }
        }
        return {
          id: r.goal.id,
          type: r.goal.type,
          target: r.goal.target,
          planet: idToCoords(r.goal.planet),
          priority: r.goal.priority,
          status: r.status,
          reason: r.reason,
          is_main_goal: r.goal.is_main_goal === true,
          created_at: r.created_at,
          updated_at: r.updated_at,
          eta_at: (() => {
            const names = new Set<string>();
            collectPrereqNames(prereq_tree, names);
            return computeEta(r.goal as { type: string; target: unknown; planet?: unknown }, names);
          })(),
          prereq_tree,
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
    cancelGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.updateStatus(id, "cancelled", "via /v1/goals/{id}/cancel");
      return { ok: true };
    },
    pauseGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.updateStatus(id, "blocked", "paused by operator");
      return { ok: true };
    },
    resumeGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.updateStatus(id, "pending", "resumed by operator");
      return { ok: true };
    },
    setMainGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.setMainGoal(id);
      return { ok: true };
    },
    unsetMainGoal: (id) => {
      if (!goalsStore.get(id)) return { ok: false, reason: "goal not found" };
      goalsStore.setMainGoal(null);
      return { ok: true };
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
      saveCoordinator.recordLaunch(body);
      return { ok: true };
    },
    recordSaveRecallConfirmed: (fleet_id) => {
      saveCoordinator.recordRecallConfirmed(fleet_id);
      return { ok: true };
    },
    listActiveSaves: () => saveCoordinator.list(),
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
            const row = goalsStore.list().find((r) => r.goal.id === goalId);
            const type = row?.goal.type;
            if (type === "expedition" || type === "colonize" || type === "deploy" || type === "transport") {
              goalsStore.updateStatus(goalId, "cancelled", reason);
            } else {
              goalsStore.updateStatus(goalId, "blocked", reason);
            }
          } else if (result?.success === true) {
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
            if (type === "expedition" || type === "colonize" || type === "deploy" || type === "transport") {
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
            }
            // build / research / build_ships / lifeform_building → no-op,
            // planner detects terminal next tick.
          }
        }
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
  });
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
    const prev = stateRef.current;
    stateRef.current = msg.snapshot;
    lastSeen.at = Date.now();

    // SaveCoordinator: diff hostile events between snapshots so per-planet
    // FSM can advance IN_FLIGHT → RECALL_READY when all that planet's
    // pending hostiles drop from events_incoming.
    try { saveCoordinator.onSnapshot(msg.snapshot); }
    catch (e) { console.error("[save-coord] onSnapshot threw", e); }

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
    // Dispatch active goals (idempotent — already-active rows still get a
    // freshly-planned next step). Wrap in try/catch so a single goal's
    // planning failure does NOT swallow subsequent state.snapshots.
    // Operator busy guard — when userscript reports the operator is
    // actively clicking ogame UI (mousedown/keydown within last 60s), pause
    // ALL autonomous dispatch. Prevents our POSTs from competing with the
    // operator's own UI actions / triggering ogame's anti-bot rate limit.
    const userBusyUntil = (msg.snapshot.server as { user_busy_until?: number } | undefined)?.user_busy_until ?? 0;
    if (userBusyUntil > Date.now()) {
      console.log(`[merger] SKIP — operator active for ${Math.ceil((userBusyUntil - Date.now())/1000)}s more`);
      return;
    }
    try {
      const result = priorityMerger.dispatch(msg.snapshot);
      const actions = result.dispatched.map((d) => {
        const params = d.params as { building?: string; tech?: string; ship?: string };
        const label = params.building ?? params.tech ?? params.ship ?? d.action;
        return `${d.action}/${label}`;
      }).join(",");
      console.log(`[merger] dispatched=${result.dispatched.length} blocked=${result.blocked.length} done=0 actions=${actions}`);
    } catch (e) {
      console.error("[ogamex/sidecar] priorityMerger.dispatch threw", e);
    }
  });

  // Aggressive merger tick — 500ms. Most ticks are no-ops (dispatched=0)
  // when no new goals added. The cost is tiny (a few ms each) and the win
  // is sub-second dispatch latency once a goal is added. Operator wants
  // "中间不要等" — chain expeditions back-to-back through ApiExec.
  setInterval(() => {
    const snap = stateRef.current;
    if (!snap) return;
    const userBusyUntil = (snap.server as { user_busy_until?: number } | undefined)?.user_busy_until ?? 0;
    if (userBusyUntil > Date.now()) return;
    try {
      priorityMerger.dispatch(snap);
    } catch (e) {
      console.error("[ogamex/sidecar] periodic merger threw", e);
    }
  }, 500);

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
    // On reconnect, flush ANY queued downstream messages — stale directives
    // accumulated during the disconnect window are useless and would
    // overwhelm the userscript on resume (manifested as a queue of ~1000
    // crystalMine/solarPlant/residentialSector POSTs against ogame).
    if (http && typeof (http as unknown as { flushQueue?: () => void }).flushQueue === "function") {
      (http as unknown as { flushQueue: () => void }).flushQueue();
    }
    // Also reset merger's per-goal cooldown — fresh client deserves fresh
    // dispatch cycle, not silence because lastDispatchTs is from before
    // disconnect.
    if (typeof (priorityMerger as unknown as { resetCooldown?: () => void }).resetCooldown === "function") {
      (priorityMerger as unknown as { resetCooldown: () => void }).resetCooldown();
    }
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
    digestScheduler.stop();
    memoryWriter.stop();
    await Promise.all([ws.stop(), http.stop()]);
    try {
      goalsStore.close();
    } catch (err) {
      console.error("[ogamex/sidecar] goalsStore.close failed", err);
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
