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
  /** Per-action callbacks. URL-decoded id is passed. Return {ok:false,reason} for 404. */
  cancelGoal?: (id: string) => { ok: boolean; reason?: string };
  pauseGoal?: (id: string) => { ok: boolean; reason?: string };
  resumeGoal?: (id: string) => { ok: boolean; reason?: string };
  setMainGoal?: (id: string) => { ok: boolean; reason?: string };
  unsetMainGoal?: (id: string) => { ok: boolean; reason?: string };
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
  /** Per-action callbacks. URL-decoded id is passed. Return {ok:false,reason} for 404. */
  cancelGoal?: (id: string) => { ok: boolean; reason?: string };
  pauseGoal?: (id: string) => { ok: boolean; reason?: string };
  resumeGoal?: (id: string) => { ok: boolean; reason?: string };
  setMainGoal?: (id: string) => { ok: boolean; reason?: string };
  unsetMainGoal?: (id: string) => { ok: boolean; reason?: string };
}

export class HttpServer {
  private readonly opts: ResolvedHttpServerOptions;
  private readonly handlers = new Map<string, Set<(msg: UpstreamMsg) => void>>();
  private readonly queue: QueueEntry[] = [];
  private readonly waiters: Array<(entries: QueueEntry[]) => void> = [];
  private server: http.Server | null = null;

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
      ...(opts.cancelGoal !== undefined ? { cancelGoal: opts.cancelGoal } : {}),
      ...(opts.pauseGoal !== undefined ? { pauseGoal: opts.pauseGoal } : {}),
      ...(opts.resumeGoal !== undefined ? { resumeGoal: opts.resumeGoal } : {}),
      ...(opts.setMainGoal !== undefined ? { setMainGoal: opts.setMainGoal } : {}),
      ...(opts.unsetMainGoal !== undefined ? { unsetMainGoal: opts.unsetMainGoal } : {}),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => {
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
    const entry: QueueEntry = {
      id: `m-${Date.now()}-${randomUUID().slice(0, 8)}`,
      msg,
      ts: Date.now(),
    };
    this.queue.push(entry);
    // Wake any waiting long-pollers.
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w([entry]);
    }
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
    // Goal mutation endpoints (no auth). POST /v1/goals/{id}/{action}
    if (method === "POST") {
      const m = url?.match(/^\/ogamex\/v1\/goals\/([^/]+)\/(cancel|pause|resume|set-main|unset-main)$/);
      if (m) {
        const [, idEnc, action] = m;
        const id = decodeURIComponent(idEnc!);
        this.handleGoalAction(res, id, action! as "cancel" | "pause" | "resume" | "set-main" | "unset-main");
        return;
      }
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
    if (url === EXPEDITION_PAUSE_PATH) {
      this.handleExpeditionFlag(res, true);
      return;
    }
    if (url === EXPEDITION_RESUME_PATH) {
      this.handleExpeditionFlag(res, false);
      return;
    }

    this.writeCorsHeaders(res);
    res.statusCode = 404;
    res.end();
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
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
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
