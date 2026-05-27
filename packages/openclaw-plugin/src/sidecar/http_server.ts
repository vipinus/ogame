import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";
import {
  renderDebugHtml,
} from "./debug_render.js";
import type {
  DebugDirectiveEntry,
  DebugEventEntry,
} from "./debug_buffer.js";

/** Where the expedition pause/resume flag is persisted. Single shared file so
 *  the daily-task runner and the operator can both observe the same state. */
const EXPEDITION_STATE_FILE = path.join(os.tmpdir(), "ogamex-expedition.json");

function readExpeditionState(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(EXPEDITION_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed — treat as empty */
  }
  return {};
}

function writeExpeditionState(state: Record<string, unknown>): void {
  fs.writeFileSync(EXPEDITION_STATE_FILE, JSON.stringify(state, null, 2));
}

export interface HttpServerOptions {
  port: number;
  token: string;
  pollTimeoutMs?: number; // default 30000
  /**
   * M8.1: optional health-report builder. When supplied, `GET /ogamex/v1/health`
   * returns its serialized output. When absent, the endpoint still answers 200
   * with a minimal `{ok:true,ts}` heartbeat so operators can confirm the
   * sidecar process is alive without needing the bridge token.
   */
  healthReporter?: () => Promise<unknown>;
  /**
   * M8.5: optional debug-snapshot provider. When supplied, `GET /ogamex/v1/debug`
   * returns its snapshot rendered as HTML. When absent, the endpoint still
   * answers 200 with an empty page so operators can verify the sidecar is
   * routing correctly. NO auth required (operator view).
   */
  debugSnapshot?: () => { directives: DebugDirectiveEntry[]; events: DebugEventEntry[] };
  stateProvider?: () => unknown;
  /** Returns the bare goals array — server wraps in `{goals: [...]}`. */
  listGoals?: () => Array<unknown>;
  expeditionProvider?: () => unknown;
  emergencyProvider?: () => unknown;
  /** Per-action callbacks. URL-decoded id is passed. Return {ok:false,reason} for 404. */
  cancelGoal?: (id: string) => { ok: boolean; reason?: string };
  pauseGoal?: (id: string) => { ok: boolean; reason?: string };
  resumeGoal?: (id: string) => { ok: boolean; reason?: string };
  setMainGoal?: (id: string) => { ok: boolean; reason?: string };
  unsetMainGoal?: (id: string) => { ok: boolean; reason?: string };
  /** Create a species_discovery goal — POST /ogamex/v1/discovery/create. */
  createDiscoveryGoal?: (body: {
    source_planet: string; galaxy: number; base_system: number; range?: number;
  }) => { ok: boolean; goal_id?: string; reason?: string };
  /** Backend FSM hooks (operator 2026-05-24 "fsm 可以放后台"). Userscript
   *  POSTs to /v1/save/launched after a successful sendFleet; reports recall
   *  completion via /v1/save/recall-confirmed. SaveCoordinator owns
   *  pending-hostile tracking + recall scheduling and emits save.recall_now
   *  via downstream when ready. */
  recordSaveLaunched?: (body: {
    planet_id: string; fleet_id: number; hostile_event_ids: readonly string[];
  }) => { ok: boolean; reason?: string };
  recordSaveRecallConfirmed?: (fleet_id: number) => { ok: boolean; reason?: string };
  listActiveSaves?: () => Array<unknown>;
}

interface QueueEntry {
  id: string;
  msg: DownstreamMsg;
  ts: number;
}

type UpstreamHandler<T extends UpstreamMsg["type"]> = (
  msg: Extract<UpstreamMsg, { type: T }>,
) => void;

const PUSH_PATH = "/ogamex/v1/push";
const POLL_PATH = "/ogamex/v1/poll";
const HEALTH_PATH = "/ogamex/v1/health";
const DEBUG_PATH = "/ogamex/v1/debug";
const EXPEDITION_PAUSE_PATH = "/ogamex/v1/expedition/pause";
const EXPEDITION_RESUME_PATH = "/ogamex/v1/expedition/resume";
const EXPEDITION_TRIGGER_PATH = "/ogamex/v1/expedition/trigger";
const ALLOWED_ORIGIN = "https://*.ogame.org";

/**
 * HTTP long-poll bridge fallback (M4.3). Same protocol envelopes as WsServer,
 * but over HTTP for environments where Private Network Access blocks the
 * ws:// upgrade. Plain Node http — no express/fastify.
 */
interface ResolvedHttpServerOptions {
  port: number;
  token: string;
  pollTimeoutMs: number;
  healthReporter?: () => Promise<unknown>;
  debugSnapshot?: () => { directives: DebugDirectiveEntry[]; events: DebugEventEntry[] };
  stateProvider?: () => unknown;
  /** Returns the bare goals array — server wraps in `{goals: [...]}`. */
  listGoals?: () => Array<unknown>;
  expeditionProvider?: () => unknown;
  emergencyProvider?: () => unknown;
  /** Per-action callbacks. URL-decoded id is passed. Return {ok:false,reason} for 404. */
  cancelGoal?: (id: string) => { ok: boolean; reason?: string };
  pauseGoal?: (id: string) => { ok: boolean; reason?: string };
  resumeGoal?: (id: string) => { ok: boolean; reason?: string };
  setMainGoal?: (id: string) => { ok: boolean; reason?: string };
  unsetMainGoal?: (id: string) => { ok: boolean; reason?: string };
  /** Create a species_discovery goal — POST /ogamex/v1/discovery/create. */
  createDiscoveryGoal?: (body: {
    source_planet: string; galaxy: number; base_system: number; range?: number;
  }) => { ok: boolean; goal_id?: string; reason?: string };
  recordSaveLaunched?: (body: {
    planet_id: string; fleet_id: number; hostile_event_ids: readonly string[];
  }) => { ok: boolean; reason?: string };
  recordSaveRecallConfirmed?: (fleet_id: number) => { ok: boolean; reason?: string };
  listActiveSaves?: () => Array<unknown>;
}

export class HttpServer {
  private readonly opts: ResolvedHttpServerOptions;
  private readonly handlers = new Map<string, Set<(msg: UpstreamMsg) => void>>();
  private readonly queue: QueueEntry[] = [];
  private readonly waiters: Array<(entries: QueueEntry[]) => void> = [];
  private server: http.Server | null = null;
  /** Event-driven expedition trigger timestamp. Bumped on POST trigger; read
   *  via GET poll by the discord-bridge daemon to know when to fire tick. */
  private expeditionTriggerTs = 0;
  /** External API — sidecar/index.ts state.snapshot delta detector can call
   *  this on fleet-return detection to bump trigger ts. */
  public bumpExpeditionTrigger(): void {
    this.expeditionTriggerTs = Date.now();
  }

  constructor(opts: HttpServerOptions) {
    this.opts = {
      port: opts.port,
      token: opts.token,
      pollTimeoutMs: opts.pollTimeoutMs ?? 30000,
      ...(opts.healthReporter !== undefined ? { healthReporter: opts.healthReporter } : {}),
      ...(opts.debugSnapshot !== undefined ? { debugSnapshot: opts.debugSnapshot } : {}),
      ...(opts.stateProvider !== undefined ? { stateProvider: opts.stateProvider } : {}),
      ...(opts.listGoals !== undefined ? { listGoals: opts.listGoals } : {}),
      ...(opts.expeditionProvider !== undefined ? { expeditionProvider: opts.expeditionProvider } : {}),
      ...(opts.emergencyProvider !== undefined ? { emergencyProvider: opts.emergencyProvider } : {}),
      ...(opts.cancelGoal !== undefined ? { cancelGoal: opts.cancelGoal } : {}),
      ...(opts.pauseGoal !== undefined ? { pauseGoal: opts.pauseGoal } : {}),
      ...(opts.resumeGoal !== undefined ? { resumeGoal: opts.resumeGoal } : {}),
      ...(opts.setMainGoal !== undefined ? { setMainGoal: opts.setMainGoal } : {}),
      ...(opts.unsetMainGoal !== undefined ? { unsetMainGoal: opts.unsetMainGoal } : {}),
      ...(opts.createDiscoveryGoal !== undefined ? { createDiscoveryGoal: opts.createDiscoveryGoal } : {}),
      ...(opts.recordSaveLaunched !== undefined ? { recordSaveLaunched: opts.recordSaveLaunched } : {}),
      ...(opts.recordSaveRecallConfirmed !== undefined ? { recordSaveRecallConfirmed: opts.recordSaveRecallConfirmed } : {}),
      ...(opts.listActiveSaves !== undefined ? { listActiveSaves: opts.listActiveSaves } : {}),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.once("error", reject);
      server.listen(this.opts.port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Resolve any in-flight long-poll waiters immediately.
      while (this.waiters.length > 0) {
        const w = this.waiters.shift();
        if (w) w([]);
      }
      const s = this.server;
      if (!s) { resolve(); return; }
      this.server = null;
      s.close(() => resolve());
      // Force-close keep-alive sockets so close() returns promptly.
      // (Node's http server otherwise waits for idle keep-alives.)
      // closeAllConnections exists on Node 18.2+.
      const maybe = s as http.Server & { closeAllConnections?: () => void };
      if (typeof maybe.closeAllConnections === "function") {
        maybe.closeAllConnections();
      }
    });
  }

  /** Exposed for tests (mirrors WsServer.port()). */
  port(): number {
    if (!this.server) throw new Error("HttpServer not started");
    const addr = this.server.address() as AddressInfo | null;
    if (!addr || typeof addr === "string") throw new Error("HttpServer address unavailable");
    return addr.port;
  }

  queueDownstream(msg: DownstreamMsg): void {
    // Dedup directive.dispatch — if a directive with the same content
    // (action+building+target_level+planet_id) is already pending undelivered,
    // drop this one. Without dedup, sidecar's tight merger tick keeps emitting
    // new dir-<uuid> for the SAME logical work when client is offline, and on
    // reconnect dumps hundreds at once → ogame anti-bot trip.
    if (msg.type === "directive.dispatch") {
      const d = (msg as { directive?: { action?: string; params?: Record<string, unknown> } }).directive;
      // Expedition is BATCH-launchable — each directive = 1 fleet, even
      // if all share identical params (same ship template, same target).
      // Dedupe only the persistent actions (build/research) where a 2nd
      // identical entry means nothing new.
      const isDedupableAction = d?.action === "build" || d?.action === "build_universal"
        || d?.action === "research" || d?.action === "build_ships" || d?.action === "build_defense";
      const sig = (d && isDedupableAction) ? `${d.action}|${JSON.stringify(d.params ?? {})}` : "";
      if (sig) {
        for (const e of this.queue) {
          if (e.msg.type === "directive.dispatch") {
            const ed = (e.msg as { directive?: { action?: string; params?: Record<string, unknown> } }).directive;
            const esig = ed ? `${ed.action}|${JSON.stringify(ed.params ?? {})}` : "";
            if (esig === sig) {
              console.log(`[http_server] dedup directive ${sig.slice(0, 80)} — already queued`);
              return;
            }
          }
        }
      }
    }
    const entry: QueueEntry = {
      id: `m-${Date.now()}-${randomUUID().slice(0, 8)}`,
      msg,
      ts: Date.now(),
    };
    // Hard cap to prevent unbounded growth during long client disconnect.
    const MAX_QUEUE = 50;
    if (this.queue.length >= MAX_QUEUE) {
      // Drop oldest directive.dispatch first; keep state.snapshot (caller
      // needs latest) — actually state goes the OTHER direction (upstream),
      // so just drop oldest entry overall.
      const dropped = this.queue.shift();
      console.warn(`[http_server] queue cap ${MAX_QUEUE} hit, dropped ${dropped?.id ?? "?"}`);
    }
    this.queue.push(entry);
    // Wake any waiting long-pollers.
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w([entry]);
    }
  }

  // Drop ALL queued downstream messages — invoked on `hello` (client reconnect)
  // to prevent dumping stale directives that piled up during the disconnect.
  flushQueue(): void {
    const n = this.queue.length;
    this.queue.length = 0;
    if (n > 0) console.warn(`[http_server] flushed ${n} stale queued messages on reconnect`);
  }

  on<T extends UpstreamMsg["type"]>(type: T, handler: UpstreamHandler<T>): void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(handler as (msg: UpstreamMsg) => void);
  }

  // --- internals ---------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      this.writeCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    // M8.1: /health is GET-only, NO auth required — operators may not have
    // the bridge token but still need a way to verify the sidecar is alive.
    if (method === "GET" && url === HEALTH_PATH) {
      void this.handleHealth(res);
      return;
    }

    // M8.5: /debug is GET-only, NO auth required — operator view, served as
    // a self-contained HTML page that lists the last 100 directives + events.
    if (method === "GET" && url === DEBUG_PATH) {
      this.handleDebug(res);
      return;
    }

    // Operator API (no auth, LAN trust). GET state/goals/expedition.
    if (method === "GET" && url === "/ogamex/v1/state") {
      this.handleProviderGet(res, this.opts.stateProvider);
      return;
    }
    if (method === "GET" && url === "/ogamex/v1/goals") {
      // listGoals returns the bare array. Wrap in {goals: [...]}. If not
      // wired, return empty list (operator UI can still load).
      this.writeCorsHeaders(res);
      const goals = this.opts.listGoals ? this.opts.listGoals() : [];
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ goals }));
      return;
    }
    if (method === "GET" && url === "/ogamex/v1/expedition") {
      this.handleProviderGet(res, this.opts.expeditionProvider);
      return;
    }
    if (method === "GET" && url === "/ogamex/v1/emergency") {
      this.handleProviderGet(res, this.opts.emergencyProvider);
      return;
    }
    if (method === "GET" && url === EXPEDITION_TRIGGER_PATH) {
      // Tiny endpoint — daemon polls this every 1s instead of running
      // a 10s setInterval expeditionTick. Body is ~30 bytes.
      this.writeCorsHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ trigger_ts: this.expeditionTriggerTs }));
      return;
    }
    // Serve userscript file for tampermonkey installation. Path is fixed —
    // operator drops the built .user.js at /tmp/ogame-runtime.user.js. No
    // auth (public install link). Cache-bust headers to avoid CDN sticking
    // a stale 405 / old version.
    if (method === "GET" && url?.startsWith("/dl/") && url.endsWith(".user.js")) {
      // Match any /dl/...user.js — version-pinned paths bust CDN cache.
      this.handleUserscriptDownload(res);
      return;
    }
    // Goal mutation endpoints (no auth). POST /v1/goals/{id}/{action}
    if (method === "POST") {
      const m = url?.match(/^\/ogamex\/v1\/goals\/([^/]+)\/(cancel|pause|resume|set-main|unset-main)$/);
      if (m) {
        const [, idEnc, action] = m;
        const id = decodeURIComponent(idEnc!);
        this.handleGoalAction(res, id, action! as "cancel" | "pause" | "resume" | "set-main" | "unset-main");
        return;
      }
      // Event-driven expedition trigger — public (no-auth). The trigger ts
      // is a low-value flag (just signals daemon to fire its tick); making
      // it public lets userscript POST without needing bridge token in the
      // sandboxed page world.
      // Also queue a data.refresh downstream → userscript actively re-scrapes
      // fleets/resources/empire before the next state push. Daemon waits ~2s
      // after seeing trigger_ts change before reading /v1/state → fresh data.
      if (url === EXPEDITION_TRIGGER_PATH) {
        this.expeditionTriggerTs = Date.now();
        this.queueDownstream({ type: "data.refresh", scope: "all", reason: "expedition.trigger" });
        this.writeCorsHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, ts: this.expeditionTriggerTs }));
        return;
      }
      // Species discovery — create goal. Public no-auth (panel button click,
      // operator-only LAN). Body: JSON {source_planet, galaxy, base_system,
      // range}. Returns {ok, goal_id}.
      if (url === "/ogamex/v1/discovery/create") {
        void this.handleDiscoveryCreate(req, res);
        return;
      }
      // Save-coordinator endpoints (operator 2026-05-24 "fsm 可以放后台").
      // Public no-auth like discovery/expedition triggers — LAN-only trust.
      if (url === "/ogamex/v1/save/launched") {
        void this.handleSaveLaunched(req, res);
        return;
      }
      if (url === "/ogamex/v1/save/recall-confirmed") {
        void this.handleSaveRecallConfirmed(req, res);
        return;
      }
      // Operator 2026-05-26: "远征的 stop 按钮无效" — pause/resume 端点之前
      // 在 auth check 之后, panel 不带 bearer token → 401 拒绝. 移到 public
      // 区跟 discovery/save 端点一致 (LAN-only trust).
      if (url === EXPEDITION_PAUSE_PATH) {
        this.handleExpeditionFlag(res, true);
        return;
      }
      if (url === EXPEDITION_RESUME_PATH) {
        this.handleExpeditionFlag(res, false);
        return;
      }
    }
    if (method === "GET" && url === "/ogamex/v1/save/active") {
      this.handleProviderGet(res, this.opts.listActiveSaves
        ? () => this.opts.listActiveSaves?.()
        : undefined);
      return;
    }

    if (method !== "POST") {
      this.writeCorsHeaders(res);
      res.statusCode = 405;
      res.end();
      return;
    }

    if (!this.checkAuth(req)) {
      this.writeCorsHeaders(res);
      res.statusCode = 401;
      res.end();
      return;
    }

    if (url === PUSH_PATH) {
      void this.handlePush(req, res);
      return;
    }
    if (url === POLL_PATH) {
      void this.handlePoll(req, res);
      return;
    }
    // (EXPEDITION_PAUSE_PATH / RESUME / TRIGGER_PATH handled above — public, no-auth)

    this.writeCorsHeaders(res);
    res.statusCode = 404;
    res.end();
  }

  /**
   * Serve the built userscript .user.js for tampermonkey install. Reads
   * /tmp/ogame-runtime.user.js (operator drops latest dist there during
   * deploy). 404 if missing. No-cache headers tell CDN never to cache —
   * userscript updates land in operator browsers on next page reload.
   */
  private handleUserscriptDownload(res: http.ServerResponse): void {
    this.writeCorsHeaders(res);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const body = fs.readFileSync("/tmp/ogame-runtime.user.js");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(body);
    } catch (e) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end(`userscript file not found: ${(e as Error).message}`);
    }
  }

  /**
   * Generic GET handler — call optional provider, return JSON. 503 if not configured.
   */
  private handleProviderGet(res: http.ServerResponse, provider?: () => unknown): void {
    this.writeCorsHeaders(res);
    if (!provider) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, reason: "no provider wired" }));
      return;
    }
    try {
      const body = provider();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, reason: (e as Error).message }));
    }
  }

  /** POST /v1/discovery/create — body JSON parsed → callback to sidecar/index. */
  private async handleSaveLaunched(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.writeCorsHeaders(res);
    if (!this.opts.recordSaveLaunched) {
      res.statusCode = 501;
      res.end(JSON.stringify({ ok: false, reason: "recordSaveLaunched not wired" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { planet_id?: string; fleet_id?: number; hostile_event_ids?: readonly string[] };
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, reason: "bad json" })); return; }
    if (!body.planet_id || typeof body.fleet_id !== "number" || !Array.isArray(body.hostile_event_ids)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "need planet_id+fleet_id(number)+hostile_event_ids(string[])" }));
      return;
    }
    const out = this.opts.recordSaveLaunched({
      planet_id: body.planet_id,
      fleet_id: body.fleet_id,
      hostile_event_ids: body.hostile_event_ids,
    });
    res.statusCode = out.ok ? 200 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out));
  }

  private async handleSaveRecallConfirmed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.writeCorsHeaders(res);
    if (!this.opts.recordSaveRecallConfirmed) {
      res.statusCode = 501;
      res.end(JSON.stringify({ ok: false, reason: "recordSaveRecallConfirmed not wired" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { fleet_id?: number };
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, reason: "bad json" })); return; }
    if (typeof body.fleet_id !== "number") {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "need fleet_id(number)" }));
      return;
    }
    const out = this.opts.recordSaveRecallConfirmed(body.fleet_id);
    res.statusCode = out.ok ? 200 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out));
  }

  private async handleDiscoveryCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.writeCorsHeaders(res);
    if (!this.opts.createDiscoveryGoal) {
      res.statusCode = 501;
      res.end(JSON.stringify({ ok: false, reason: "createDiscoveryGoal not wired" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { source_planet?: string; galaxy?: number; base_system?: number; range?: number };
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, reason: "bad json" })); return; }
    if (!body.source_planet || !body.galaxy || !body.base_system) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "need source_planet+galaxy+base_system" }));
      return;
    }
    const out = this.opts.createDiscoveryGoal({
      source_planet: body.source_planet,
      galaxy: body.galaxy,
      base_system: body.base_system,
      range: body.range ?? 10,
    });
    res.statusCode = out.ok ? 200 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out));
  }

  /**
   * POST /v1/goals/{id}/{action} — delegate to wired goalAction hook.
   */
  private handleGoalAction(res: http.ServerResponse, id: string, action: "cancel" | "pause" | "resume" | "set-main" | "unset-main"): void {
    this.writeCorsHeaders(res);
    const fn = action === "cancel" ? this.opts.cancelGoal
             : action === "pause"  ? this.opts.pauseGoal
             : action === "resume" ? this.opts.resumeGoal
             : action === "set-main"   ? this.opts.setMainGoal
             : action === "unset-main" ? this.opts.unsetMainGoal
             : undefined;
    if (!fn) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, reason: `no ${action} handler wired` }));
      return;
    }
    try {
      const result = fn(id);
      res.statusCode = result.ok ? 200 : 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, reason: (e as Error).message }));
    }
  }

  /**
   * Write the boolean `paused` flag into the shared expedition-state file.
   * Read-modify-write the JSON object so any other keys (e.g. last_run_at)
   * survive the toggle.
   */
  private handleExpeditionFlag(res: http.ServerResponse, paused: boolean): void {
    let ok = true;
    let error: string | undefined;
    try {
      const state = readExpeditionState();
      state["paused"] = paused;
      state["updated_at"] = Date.now();
      writeExpeditionState(state);
    } catch (e) {
      ok = false;
      error = (e as Error).message;
    }
    this.writeCorsHeaders(res);
    res.statusCode = ok ? 200 : 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(ok ? { ok: true, paused } : { ok: false, error }));
  }

  private writeCorsHeaders(res: http.ServerResponse): void {
    // Browsers reject wildcard host patterns (e.g. "*.ogame.org") — only "*"
    // or an exact origin match works. Echo the Origin back if it matches
    // ogame.org / ogame.gameforge.com domains; else default to "*" (LAN trust).
    // Read origin via res.req — Node 10+ back-ref to IncomingMessage.
    const req = (res as { req?: http.IncomingMessage }).req;
    const origin = req?.headers.origin;
    const allowOrigin = typeof origin === "string" && /^https?:\/\/[^/]*\.ogame\.(org|gameforge\.com)$/.test(origin)
      ? origin
      : "*";
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return false;
    const expected = `Bearer ${this.opts.token}`;
    return header === expected;
  }

  private handleDebug(res: http.ServerResponse): void {
    const snap = this.opts.debugSnapshot
      ? this.opts.debugSnapshot()
      : { directives: [], events: [] };
    const html = renderDebugHtml(snap);
    this.writeCorsHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }

  private async handleHealth(res: http.ServerResponse): Promise<void> {
    let report: unknown = { ok: true, ts: Date.now() };
    if (this.opts.healthReporter) {
      try {
        report = await this.opts.healthReporter();
      } catch (e) {
        // A throwing health reporter must not 500 the endpoint — operators
        // need *some* response. Surface the error inside the JSON body.
        report = { ok: false, ts: Date.now(), error: (e as Error).message };
      }
    }
    this.writeCorsHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(report));
  }

  private async handlePush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      this.writeCorsHeaders(res);
      res.statusCode = 400;
      res.end();
      return;
    }

    if (!isUpstream(body)) {
      this.writeCorsHeaders(res);
      res.statusCode = 400;
      res.end();
      return;
    }

    const set = this.handlers.get(body.type);
    if (set) {
      for (const h of set) {
        try { h(body); } catch { /* swallow handler errors */ }
      }
    }

    this.writeCorsHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }

  private async handlePoll(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { since_ts?: number; ack_ids?: string[] };
    try {
      const parsed = await readJson(req);
      body = (parsed ?? {}) as { since_ts?: number; ack_ids?: string[] };
    } catch {
      this.writeCorsHeaders(res);
      res.statusCode = 400;
      res.end();
      return;
    }

    const sinceTs = typeof body.since_ts === "number" ? body.since_ts : 0;
    const ackIds = new Set(Array.isArray(body.ack_ids) ? body.ack_ids : []);

    const filterReady = (): QueueEntry[] =>
      this.queue.filter((e) => e.ts > sinceTs && !ackIds.has(e.id));

    let ready = filterReady();
    if (ready.length > 0) {
      this.respondPoll(res, ready);
      return;
    }

    // Long-poll: wait until something arrives or timeout fires.
    let settled = false;
    const waiter = (_entries: QueueEntry[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const list = filterReady();
      this.respondPoll(res, list);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = this.waiters.indexOf(waiter);
      if (idx >= 0) this.waiters.splice(idx, 1);
      this.respondPoll(res, []);
    }, this.opts.pollTimeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.waiters.push(waiter);

    // If the client disconnects mid-poll, abandon the waiter quietly.
    req.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const idx = this.waiters.indexOf(waiter);
      if (idx >= 0) this.waiters.splice(idx, 1);
    });
    ready = filterReady();
    if (ready.length > 0 && !settled) {
      settled = true;
      clearTimeout(timer);
      const idx = this.waiters.indexOf(waiter);
      if (idx >= 0) this.waiters.splice(idx, 1);
      this.respondPoll(res, ready);
    }
  }

  private respondPoll(res: http.ServerResponse, messages: QueueEntry[]): void {
    this.writeCorsHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ messages: messages.map((e) => e.msg) }));
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1024 * 1024; // 1 MiB cap
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e as Error); }
    });
    req.on("error", reject);
  });
}

function isUpstream(v: unknown): v is UpstreamMsg {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === "string";
}
