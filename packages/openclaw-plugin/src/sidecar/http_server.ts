import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";
import { runWithUser, getCurrentUserId } from "./user_context.js";

// Phase 9c.5 — symbolic bucket id for truly anonymous traffic (no Bearer,
// no operator uid configured — only happens in test/CI smoke runs). In
// production, OGAMEX_LEGACY_USER_ID is set to the operator's PG uid and
// queueDownstream/dispatchPoll route operator-side traffic into THAT
// uid's bucket, so write/read paths converge there. LEGACY_BUCKET is
// only used as the absolute fallback when no operator uid is configured.
const LEGACY_BUCKET = "_legacy_";

// Read at CALL time, not module init — run_sidecar.mjs sets the env var
// AFTER its `import { startSidecar }` line (ESM hoisting puts the import
// effectively before the assignment), so a module-init `process.env` read
// would always come back empty. queueDownstream / dispatchPoll prefer
// the operator uid over LEGACY_BUCKET so the daemon's no-Bearer writes
// and operator's per-user Bearer poll land in the SAME bucket. Without
// this, operator's expeditions written by the daemon stranded in
// LEGACY_BUCKET while operator's poll read from his own uid bucket
// (2026-06-02 incident).
const fallbackBucketUid = (): string => {
  const operatorUid = (process.env.OGAMEX_LEGACY_USER_ID ?? "").trim();
  return operatorUid || LEGACY_BUCKET;
};
import {
  renderDebugHtml,
} from "./debug_render.js";
import type {
  DebugDirectiveEntry,
  DebugEventEntry,
} from "./debug_buffer.js";

/** Where the expedition pause/resume flag is persisted. Single shared file so
 *  the daily-task runner and the operator can both observe the same state.
 *
 *  operator 2026-06-04 "远征设置里面的舰队配置不生效了" — root cause: sidecar
 *  wrote /tmp/ogamex-expedition.json but daemon (discord_bridge.mjs:1396)
 *  reads ~/.openclaw/workspace/ogamex/runtime/ogamex-expedition.json.
 *  Migration v0.0.635 [[reference_sidecar_deploy]] moved dbs out of /tmp,
 *  this file path was missed. Realign to daemon's canonical location so
 *  panel template edits propagate to next expedition tick. Env override
 *  OGAMEX_EXPEDITION_STATE_FILE for non-default deploys (CI/tests). */
const EXPEDITION_STATE_FILE = process.env.OGAMEX_EXPEDITION_STATE_FILE
  ?? path.join(os.homedir(), ".openclaw/workspace/ogamex/runtime/ogamex-expedition.json");

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
  listGoals?: (userId?: string) => Array<unknown>;
  expeditionProvider?: () => unknown;
  emergencyProvider?: () => unknown;
  /** v0.0.636 — backed by worldStateStore. GET /v1/events?limit=N&type=foo.
   *  Returns most-recent-first audit log rows from the persisted events table.
   *  When `type` is supplied, filters server-side; absent ⇒ all types. */
  listEvents?: (limit: number, type?: string) => Array<unknown>;
  resolveUserToken?: (bearer: string) => Promise<string | null>;
  /** Operator 2026-06-04 "全做" — read/write per-user in-game panel toggle
   *  flags (mirrors user_settings.section_settings jsonb). */
  sectionSettingsRead?: (uid: string) => Promise<Record<string, unknown>>;
  sectionSettingsWrite?: (uid: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Operator 2026-06-04 "flagship 信号灯" — true if WsServer has an open ws
   *  socket tagged with uid. Used by /v1/me/bridge-status. */
  wsHasUidConnected?: (uid: string) => boolean;
  /** Operator 2026-06-04 "红灯 = TM 离线" — seconds since this uid last pushed
   *  state.snapshot (PG ogame_world_state.updated_at). null = never pushed. */
  userLastSeenAgoSec?: (uid: string) => Promise<number | null>;
  /** Per-action callbacks. URL-decoded id is passed. Return {ok:false,reason} for 404. */
  cancelGoal?: (id: string) => { ok: boolean; reason?: string; cascaded?: number };
  pauseGoal?: (id: string) => { ok: boolean; reason?: string };
  resumeGoal?: (id: string) => { ok: boolean; reason?: string };
  setMainGoal?: (id: string) => { ok: boolean; reason?: string };
  unsetMainGoal?: (id: string) => { ok: boolean; reason?: string };
  /** M4 — create an arbitrary goal from the panel modal. POST /v1/goals/create. */
  createGoal?: (body: { type: string; target: Record<string, unknown>; planet?: string; priority?: number }) => { ok: boolean; goal_id?: string; reason?: string };
  /** M4 — parse free-form NL into a goal-shape without storing. POST /v1/goals/parse. */
  parseGoalNL?: (description: string) => Promise<{ ok: boolean; parsed?: { type: string; target: Record<string, unknown>; planet?: string; priority?: number }; reason?: string }>;
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
  listActiveSaves?: (userId?: string) => Array<unknown>;
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
  listGoals?: (userId?: string) => Array<unknown>;
  expeditionProvider?: () => unknown;
  emergencyProvider?: () => unknown;
  listEvents?: (limit: number, type?: string) => Array<unknown>;
  resolveUserToken?: (bearer: string) => Promise<string | null>;
  /** Operator 2026-06-04 "全做" — read/write per-user in-game panel toggle
   *  flags (mirrors user_settings.section_settings jsonb). */
  sectionSettingsRead?: (uid: string) => Promise<Record<string, unknown>>;
  sectionSettingsWrite?: (uid: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Operator 2026-06-04 "flagship 信号灯" — true if WsServer has an open ws
   *  socket tagged with uid. Used by /v1/me/bridge-status. */
  wsHasUidConnected?: (uid: string) => boolean;
  /** Operator 2026-06-04 "红灯 = TM 离线" — seconds since this uid last pushed
   *  state.snapshot (PG ogame_world_state.updated_at). null = never pushed. */
  userLastSeenAgoSec?: (uid: string) => Promise<number | null>;
  /** Per-action callbacks. URL-decoded id is passed. Return {ok:false,reason} for 404. */
  cancelGoal?: (id: string) => { ok: boolean; reason?: string; cascaded?: number };
  pauseGoal?: (id: string) => { ok: boolean; reason?: string };
  resumeGoal?: (id: string) => { ok: boolean; reason?: string };
  setMainGoal?: (id: string) => { ok: boolean; reason?: string };
  unsetMainGoal?: (id: string) => { ok: boolean; reason?: string };
  /** M4 — create an arbitrary goal from the panel modal. POST /v1/goals/create. */
  createGoal?: (body: { type: string; target: Record<string, unknown>; planet?: string; priority?: number }) => { ok: boolean; goal_id?: string; reason?: string };
  /** M4 — parse free-form NL into a goal-shape without storing. POST /v1/goals/parse. */
  parseGoalNL?: (description: string) => Promise<{ ok: boolean; parsed?: { type: string; target: Record<string, unknown>; planet?: string; priority?: number }; reason?: string }>;
  /** Create a species_discovery goal — POST /ogamex/v1/discovery/create. */
  createDiscoveryGoal?: (body: {
    source_planet: string; galaxy: number; base_system: number; range?: number;
  }) => { ok: boolean; goal_id?: string; reason?: string };
  recordSaveLaunched?: (body: {
    planet_id: string; fleet_id: number; hostile_event_ids: readonly string[];
  }) => { ok: boolean; reason?: string };
  recordSaveRecallConfirmed?: (fleet_id: number) => { ok: boolean; reason?: string };
  listActiveSaves?: (userId?: string) => Array<unknown>;
}

export class HttpServer {
  private readonly opts: ResolvedHttpServerOptions;
  private readonly handlers = new Map<string, Set<(msg: UpstreamMsg) => void>>();
  // Phase 9c.5 — per-user downstream queues. Each bucket has its own
  // queue + waiters so a poll from user A never sees user B's messages.
  // LEGACY_BUCKET holds operator's traffic (global-token poll + send
  // sites without explicit uid + no-ALS internal triggers).
  private readonly buckets = new Map<string, QueueEntry[]>();
  private readonly bucketWaiters = new Map<string, Array<(entries: QueueEntry[]) => void>>();
  private bucketQueue(uid: string): QueueEntry[] {
    let q = this.buckets.get(uid);
    if (!q) { q = []; this.buckets.set(uid, q); }
    return q;
  }
  private bucketWaiterList(uid: string): Array<(entries: QueueEntry[]) => void> {
    let w = this.bucketWaiters.get(uid);
    if (!w) { w = []; this.bucketWaiters.set(uid, w); }
    return w;
  }
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
      ...(opts.listEvents !== undefined ? { listEvents: opts.listEvents } : {}),
      ...(opts.resolveUserToken !== undefined ? { resolveUserToken: opts.resolveUserToken } : {}),
      ...(opts.sectionSettingsRead !== undefined ? { sectionSettingsRead: opts.sectionSettingsRead } : {}),
      ...(opts.sectionSettingsWrite !== undefined ? { sectionSettingsWrite: opts.sectionSettingsWrite } : {}),
      ...(opts.wsHasUidConnected !== undefined ? { wsHasUidConnected: opts.wsHasUidConnected } : {}),
      ...(opts.userLastSeenAgoSec !== undefined ? { userLastSeenAgoSec: opts.userLastSeenAgoSec } : {}),
      ...(opts.cancelGoal !== undefined ? { cancelGoal: opts.cancelGoal } : {}),
      ...(opts.pauseGoal !== undefined ? { pauseGoal: opts.pauseGoal } : {}),
      ...(opts.resumeGoal !== undefined ? { resumeGoal: opts.resumeGoal } : {}),
      ...(opts.setMainGoal !== undefined ? { setMainGoal: opts.setMainGoal } : {}),
      ...(opts.unsetMainGoal !== undefined ? { unsetMainGoal: opts.unsetMainGoal } : {}),
      ...(opts.createDiscoveryGoal !== undefined ? { createDiscoveryGoal: opts.createDiscoveryGoal } : {}),
      ...(opts.createGoal !== undefined ? { createGoal: opts.createGoal } : {}),
      ...(opts.parseGoalNL !== undefined ? { parseGoalNL: opts.parseGoalNL } : {}),
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

  /** Operator 2026-06-04 — return raw node http server for WS upgrade attach.
   *  Lets WsServer.attachToHttpServer(httpServer.getRawServer()) reuse same
   *  port via Upgrade handling; CF tunnel transparently forwards Upgrade
   *  headers to HTTP origins so no separate WS port / cf-router routing
   *  needed. Returns null before start() resolves. */
  getRawServer(): http.Server | null {
    return this.server;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Resolve any in-flight long-poll waiters across ALL buckets immediately.
      for (const waiters of this.bucketWaiters.values()) {
        while (waiters.length > 0) {
          const w = waiters.shift();
          if (w) w([]);
        }
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

  /** Phase 9c.5 diagnostic — bucket sizes (uid prefix → entry count).
   *  Used by /v1/health.multi_tenant to surface per-user queue depth. */
  pollBucketSizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [uid, q] of this.buckets.entries()) {
      if (q.length === 0) continue;
      out[uid === LEGACY_BUCKET ? "_legacy_" : uid.slice(0, 8)] = q.length;
    }
    return out;
  }

  queueDownstream(msg: DownstreamMsg, explicitUid?: string): void {
    // Phase 9c.5 — uid resolution priority: explicit (manager closure has
    // bound uid) → AsyncLocalStorage (dispatch chain inherits the push
    // request's user) → operator uid env fallback → LEGACY_BUCKET sentinel.
    // The operator-fallback step (added 2026-06-02) ensures daemon's
    // no-Bearer writes converge with operator's per-user Bearer poll on
    // the same bucket key, instead of write→LEGACY/read→uid mismatch.
    const uid = explicitUid ?? getCurrentUserId() ?? fallbackBucketUid();
    const q = this.bucketQueue(uid);
    // Dedup directive.dispatch — if a directive with the same content
    // (action+building+target_level+planet_id) is already pending undelivered,
    // drop this one. Without dedup, sidecar's tight merger tick keeps emitting
    // new dir-<uuid> for the SAME logical work when client is offline, and on
    // reconnect dumps hundreds at once → ogame anti-bot trip.
    // Dedup is per-bucket — user2's directive can't collide with operator's.
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
        for (const e of q) {
          if (e.msg.type === "directive.dispatch") {
            const ed = (e.msg as { directive?: { action?: string; params?: Record<string, unknown> } }).directive;
            const esig = ed ? `${ed.action}|${JSON.stringify(ed.params ?? {})}` : "";
            if (esig === sig) {
              console.log(`[http_server] dedup directive ${sig.slice(0, 80)} — already queued (bucket=${uid.slice(0,8)})`);
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
    if (q.length >= MAX_QUEUE) {
      const dropped = q.shift();
      console.warn(`[http_server] queue cap ${MAX_QUEUE} hit, dropped ${dropped?.id ?? "?"} (bucket=${uid.slice(0,8)})`);
    }
    q.push(entry);
    // Wake any waiting long-pollers ON THIS BUCKET only.
    const waiters = this.bucketWaiters.get(uid);
    if (waiters && waiters.length > 0) {
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w([entry]);
      }
    }
  }

  // Drop ALL queued downstream messages for a bucket — invoked on `hello`
  // (client reconnect). Without explicit uid, defaults to the operator
  // uid fallback (or LEGACY_BUCKET sentinel if env not set).
  flushQueue(explicitUid?: string): void {
    const uid = explicitUid ?? getCurrentUserId() ?? fallbackBucketUid();
    const q = this.buckets.get(uid);
    if (!q) return;
    const n = q.length;
    q.length = 0;
    if (n > 0) console.warn(`[http_server] flushed ${n} stale queued messages on reconnect (bucket=${uid.slice(0,8)})`);
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

    // v0.0.644 — operator 2026-06-01 部署 ogame.anyfq.com SaaS 网站.
    // CF tunnel 在 192.168.2.250 token-managed, 改 ingress 要走 CF dashboard.
    // 短路: sidecar 自己 fan out — sidecar 自家路径 (/ogamex/* + /dl/*)
    // 走原逻辑, 其余全部代理到本机 Next.js 3002 (ogame-next 站点)。
    if (
      method !== "OPTIONS" &&
      !url.startsWith("/ogamex/") &&
      !url.startsWith("/dl/")
    ) {
      this.proxyToNext(req, res);
      return;
    }

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
    if (method === "GET" && (url === "/ogamex/v1/goals" || url?.startsWith("/ogamex/v1/goals?"))) {
      // v0.0.509 — operator 2026-05-31 chrome 崩 实证: 5807 goals 在 store,
      // 95%+ 是 completed/cancelled 历史, 响应 3.66 MB, panel 3s 拉一次
      // 每分钟 73 MB 下载 → JS heap OOM。 默认只返回 non-terminal,
      // ?all=true 显式要全量 (panel 历史视图 / 调试用).
      // Phase 9c.7 — Bearer-aware filter: per-user Bearer → only that
      // user's goals via listGoals(uid); legacy → all goals; unknown → 401.
      void (async () => {
        const r = await this.resolveBearer(req);
        if (r.kind === "forbidden") {
          this.writeCorsHeaders(res);
          res.statusCode = 401;
          res.end();
          return;
        }
        this.writeCorsHeaders(res);
        const uid = r.kind === "user" ? r.uid : undefined;
        const allGoals = this.opts.listGoals
          ? this.opts.listGoals(uid) as Array<{ status?: string }>
          : [];
        const includeAll = (url ?? "").includes("all=true");
        const goals = includeAll
          ? allGoals
          : allGoals.filter((g) => g?.status !== "completed" && g?.status !== "cancelled");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ goals }));
      })();
      return;
    }
    if (method === "GET" && url === "/ogamex/v1/expedition") {
      this.handleProviderGet(res, this.opts.expeditionProvider);
      return;
    }
    // v0.0.636 — operator audit view backed by worldStateStore events table.
    // GET /ogamex/v1/events?limit=N&type=foo. Defaults to 100, cap at 1000
    // to prevent payload bloat. No auth (LAN trust).
    if (method === "GET" && (url === "/ogamex/v1/events" || url?.startsWith("/ogamex/v1/events?"))) {
      this.writeCorsHeaders(res);
      if (!this.opts.listEvents) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, reason: "no events store wired" }));
        return;
      }
      const u = new URL(url ?? "/ogamex/v1/events", "http://_");
      const limitRaw = Number(u.searchParams.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : 100;
      const typeFilter = u.searchParams.get("type") ?? undefined;
      const events = this.opts.listEvents(limit, typeFilter);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ events }));
      return;
    }
    // Operator 2026-05-29: M2 expedition settings modal — panel reads/writes
    // the full /tmp/ogamex-expedition.json (template + paused + enabled +
    // target_position). Public no-auth like discovery/expedition triggers
    // (LAN-only trust). Daemon reloads the file every expeditionTick via
    // loadExpeditionConfig() so writes take effect on the next tick.
    if (method === "GET" && url === "/ogamex/v1/expedition/config") {
      this.writeCorsHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(readExpeditionState()));
      return;
    }
    // Operator 2026-05-29 "panel 名称改成 oGame+版本号 + 更新按钮 (没有
    // 更新就隐藏)": panel polls this endpoint, compares with its own boot
    // version, shows the update button when newer. Returns the @version
    // line from the served userscript at /tmp/ogame-runtime.user.js.
    if (method === "GET" && url === "/ogamex/v1/runtime-version") {
      this.writeCorsHeaders(res);
      let version = "0.0.0";
      let downloadURL: string | null = null;
      try {
        // `fs` is already imported at the top of this module as a namespace.
        const txt = fs.readFileSync("/tmp/ogame-runtime.user.js", "utf-8").slice(0, 8000);
        const vm = txt.match(/@version\s+(\S+)/);
        if (vm && vm[1]) version = vm[1];
        const dm = txt.match(/@downloadURL\s+(\S+)/);
        if (dm && dm[1]) downloadURL = dm[1];
      } catch (e) { console.warn("[runtime-version] read /tmp/ogame-runtime.user.js failed:", e); }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ version, downloadURL }));
      return;
    }
    if (method === "GET" && url === "/ogamex/v1/emergency") {
      this.handleProviderGet(res, this.opts.emergencyProvider);
      return;
    }
    // section-settings — operator "全做" bidir sync.
    if ((method === "GET" || method === "POST") && url === "/ogamex/v1/section-settings") {
      void this.dispatchSectionSettings(req, res, method);
      return;
    }
    // Operator "flagship 信号灯" — per-user bridge transport status for web dot.
    if (method === "GET" && url === "/ogamex/v1/me/bridge-status") {
      void this.dispatchBridgeStatus(req, res);
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
    // Goal mutation endpoints. Phase 9c.7 — Bearer-aware:
    //   no Bearer / global token → legacy single-tenant mutation
    //   per-user Bearer        → runWithUser-wrapped + ownership check
    //   unknown Bearer         → 401
    if (method === "POST") {
      const m = url?.match(/^\/ogamex\/v1\/goals\/([^/]+)\/(cancel|pause|resume|set-main|unset-main)$/);
      if (m) {
        const [, idEnc, action] = m;
        const id = decodeURIComponent(idEnc!);
        void (async () => {
          const r = await this.resolveBearer(req);
          if (r.kind === "forbidden") {
            this.writeCorsHeaders(res);
            res.statusCode = 401;
            res.end();
            return;
          }
          if (r.kind === "user") {
            runWithUser(r.uid, () => {
              this.handleGoalAction(res, id, action! as "cancel" | "pause" | "resume" | "set-main" | "unset-main");
            });
          } else {
            this.handleGoalAction(res, id, action! as "cancel" | "pause" | "resume" | "set-main" | "unset-main");
          }
        })();
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
      // v0.0.490 — debug log relay. userscript pushes diagnostic text here,
      // sidecar prints to stdout so journalctl captures it. Public no-auth
      // (diagnostic only, LAN-bound). Body: { tag, text }.
      if (url === "/ogamex/v1/debug/log") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { tag?: string; text?: string };
            const tag = typeof parsed.tag === "string" ? parsed.tag : "unknown";
            const text = typeof parsed.text === "string" ? parsed.text : "";
            console.log(`[debug-log:${tag}] ${text}`);
          } catch { console.log(`[debug-log:parse-fail] ${body.slice(0, 500)}`); }
          this.writeCorsHeaders(res);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      // v0.0.568 — trigger debris-check for the operator's CURRENT viewed
      // planet (no params; userscript reads meta[name=ogame-planet-id]).
      // Sentinel origin_planet_id="_CURRENT_" tells wire.ts to self-resolve.
      if (url === "/ogamex/v1/debug/trigger-debris-check-current") {
        const msg = { type: "expedition.debris_check" as const, galaxy: 0, system: 0, origin_planet_id: "_CURRENT_", reason: "manual trigger current planet" };
        this.queueDownstream(msg);
        console.log(`[debug] trigger-debris-check-current enqueued (sentinel _CURRENT_)`);
        this.writeCorsHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, enqueued: msg }));
        return;
      }
      // v0.0.562 — manual debris-check trigger. Operator 2026-06-01: 触发
      // 一下这个任务. Bypasses the snapshot-based fleet detection so the
      // full debris-check → galaxy fetch → mission=8 explorer dispatch chain
      // can be exercised without waiting for an expedition fleet to return.
      // Public no-auth, LAN-only. Body: { galaxy, system, origin_planet_id }.
      if (url === "/ogamex/v1/debug/trigger-debris-check") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { galaxy?: unknown; system?: unknown; origin_planet_id?: unknown };
            const g = typeof parsed.galaxy === "number" ? parsed.galaxy : 0;
            const s = typeof parsed.system === "number" ? parsed.system : 0;
            const pid = typeof parsed.origin_planet_id === "string" ? parsed.origin_planet_id : "";
            if (!g || !s || !pid) {
              this.writeCorsHeaders(res);
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: "need {galaxy:number, system:number, origin_planet_id:string}" }));
              return;
            }
            const msg = { type: "expedition.debris_check" as const, galaxy: g, system: s, origin_planet_id: pid, reason: "manual debug trigger" };
            this.queueDownstream(msg);
            console.log(`[debug] manual trigger-debris-check enqueued: G:S=${g}:${s} origin=${pid}`);
            this.writeCorsHeaders(res);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, enqueued: msg }));
          } catch (e) {
            this.writeCorsHeaders(res);
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
        return;
      }
      // Species discovery — create goal. Public no-auth (panel button click,
      // operator-only LAN). Body: JSON {source_planet, galaxy, base_system,
      // range}. Returns {ok, goal_id}.
      if (url === "/ogamex/v1/discovery/create") {
        void this.handleDiscoveryCreate(req, res);
        return;
      }
      // M4 — generic goal creation. Body: { type, target, planet?, priority? }.
      // Phase 9c.7 — Bearer-aware: per-user Bearer wraps handleGoalCreate in
      // runWithUser so goalsStore.addForUser tags row with that uid.
      if (url === "/ogamex/v1/goals/create") {
        void (async () => {
          const r = await this.resolveBearer(req);
          if (r.kind === "forbidden") {
            this.writeCorsHeaders(res);
            res.statusCode = 401;
            res.end();
            return;
          }
          if (r.kind === "user") {
            runWithUser(r.uid, () => { void this.handleGoalCreate(req, res); });
          } else {
            void this.handleGoalCreate(req, res);
          }
        })();
        return;
      }
      // M4 — NL parse. Body: { description }. Returns parsed goal shape
      // WITHOUT storing — operator confirms in the modal before create.
      if (url === "/ogamex/v1/goals/parse") {
        void this.handleGoalParse(req, res);
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
      // Operator 2026-05-29: M2 expedition settings modal — POST full config
      // (template + paused + enabled + target_position) and persist. Body is
      // shallow-merged into the existing state so callers can send partial
      // updates without clobbering fields they don't touch.
      if (url === "/ogamex/v1/expedition/config") {
        void this.handleExpeditionConfigPost(req, res);
        return;
      }
    }
    if (method === "GET" && url === "/ogamex/v1/save/active") {
      void this.dispatchSaveActive(req, res);
      return;
    }

    if (method !== "POST") {
      this.writeCorsHeaders(res);
      res.statusCode = 405;
      res.end();
      return;
    }

    // Phase 9a — split auth path. Global token (operator's primary channel)
    // always accepted. Per-user Bearer tokens (from user_settings.bridge_token)
    // are deferred to dispatchPush which does the async PG lookup.
    const globalAuthOk = this.checkAuth(req);
    if (url === PUSH_PATH) {
      void this.dispatchPush(req, res, globalAuthOk);
      return;
    }
    // Phase 9c.5 — POLL gets the same split auth as PUSH: global token →
    // operator LEGACY_BUCKET; per-user Bearer → resolve to that user's
    // bucket; neither → 401.
    if (url === POLL_PATH) {
      void this.dispatchPoll(req, res, globalAuthOk);
      return;
    }
    if (!globalAuthOk) {
      this.writeCorsHeaders(res);
      res.statusCode = 401;
      res.end();
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

  /**
   * M4 — POST /v1/goals/create. Body JSON: { type: string, target: object,
   * planet?: string, priority?: number }. Delegates to wired createGoal
   * callback. No auth (LAN-only trust like discovery/expedition triggers).
   */
  private async handleGoalCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.writeCorsHeaders(res);
    if (!this.opts.createGoal) {
      res.statusCode = 501;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, reason: "createGoal not wired" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { type?: string; target?: unknown; planet?: string; priority?: number };
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, reason: "bad json" })); return; }
    if (typeof body.type !== "string" || !body.type) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "need type:string" }));
      return;
    }
    if (!body.target || typeof body.target !== "object" || Array.isArray(body.target)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "need target:object" }));
      return;
    }
    const out = this.opts.createGoal({
      type: body.type,
      target: body.target as Record<string, unknown>,
      ...(typeof body.planet === "string" ? { planet: body.planet } : {}),
      ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
    });
    res.statusCode = out.ok ? 200 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out));
  }

  /**
   * M4 — POST /v1/goals/parse. Body: { description: string }. Returns the
   * parsed goal shape (without storing) so the panel modal can pre-fill the
   * form for operator review. Delegates to wired parseGoalNL callback.
   */
  private async handleGoalParse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.writeCorsHeaders(res);
    if (!this.opts.parseGoalNL) {
      res.statusCode = 501;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, reason: "parseGoalNL not wired (gemini api key missing?)" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { description?: string };
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, reason: "bad json" })); return; }
    if (typeof body.description !== "string" || !body.description.trim()) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "need description:string" }));
      return;
    }
    try {
      const out = await this.opts.parseGoalNL(body.description.trim());
      res.statusCode = out.ok ? 200 : 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
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

  /**
   * M2 — accept partial JSON config and shallow-merge into the on-disk
   * expedition state file. Acceptable keys: `template` (ShipCount map),
   * `paused` (bool), `enabled` (bool), `target_position` (1-16).
   * Daemon's expeditionTick re-reads the file on every tick.
   */
  private async handleExpeditionConfigPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let bodyStr = "";
    try {
      for await (const chunk of req) bodyStr += String(chunk);
    } catch {
      this.writeCorsHeaders(res);
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "body read failed" }));
      return;
    }
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(bodyStr || "{}") as Record<string, unknown>;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("not an object");
    } catch (e) {
      this.writeCorsHeaders(res);
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: `bad JSON: ${(e as Error).message}` }));
      return;
    }
    const allowed = new Set(["template", "paused", "enabled", "target_position", "enabled_planets", "auto_build_ships"]);
    try {
      const state = readExpeditionState();
      for (const [k, v] of Object.entries(patch)) {
        if (!allowed.has(k)) continue;
        state[k] = v;
      }
      state["updated_at"] = Date.now();
      writeExpeditionState(state);
      this.writeCorsHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, state }));
    } catch (e) {
      this.writeCorsHeaders(res);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }

  /** Operator 2026-06-04 "flagship 信号灯" — per-user bridge transport status.
   *  Returns:
   *    { ws_connected: bool, http_last_seen_ago_sec: number|null }
   *  ws_connected: true when WsServer has an open socket tagged with this uid.
   *  http_last_seen_ago_sec: derived from HttpServer's bucket last activity
   *    (best-effort). Caller renders dot per:
   *    ws_connected → 绿; http_last_seen < 60s → 黄; else 红. */
  private async dispatchBridgeStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const r = await this.resolveBearer(req);
    if (r.kind === "forbidden") { this.writeCorsHeaders(res); res.statusCode = 401; res.end(); return; }
    if (r.kind === "legacy") { this.writeCorsHeaders(res); res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "user_token_required" })); return; }
    const uid = r.uid;
    let wsConnected = false;
    try {
      const hook = this.opts.wsHasUidConnected;
      if (hook) wsConnected = hook(uid);
    } catch (e) { console.warn("[http] wsHasUidConnected threw", e); }
    // Operator 2026-06-04 "红灯 = TM 离线" — derive last-push-ago from PG
    // ogame_world_state.updated_at for this uid (sidecar upserts that row
    // on every state.snapshot push, transport-agnostic). null → never pushed.
    let lastPushAgoSec: number | null = null;
    try {
      const hook = this.opts.userLastSeenAgoSec;
      if (hook) lastPushAgoSec = await hook(uid);
    } catch (e) { console.warn("[http] userLastSeenAgoSec threw", e); }
    this.writeCorsHeaders(res); res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ws_connected: wsConnected, last_push_ago_sec: lastPushAgoSec, ts: Date.now() }));
  }

  /** S4 — section-settings GET/POST. Bearer-scoped; uses provided callbacks
   *  (sectionSettingsRead/Write) which talk to user_settings.section_settings
   *  jsonb. Operator 2026-06-04 "全做". */
  private async dispatchSectionSettings(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
  ): Promise<void> {
    const r = await this.resolveBearer(req);
    if (r.kind === "forbidden") {
      this.writeCorsHeaders(res); res.statusCode = 401; res.end(); return;
    }
    if (r.kind === "legacy") {
      // No multi-tenant uid → cannot scope; refuse.
      this.writeCorsHeaders(res); res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "user_token_required" })); return;
    }
    const uid = r.uid;
    if (method === "GET") {
      if (!this.opts.sectionSettingsRead) {
        this.writeCorsHeaders(res); res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, error: "section_settings_unavailable" })); return;
      }
      try {
        const settings = await this.opts.sectionSettingsRead(uid);
        this.writeCorsHeaders(res); res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ settings }));
      } catch (e) {
        this.writeCorsHeaders(res); res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }
    // POST — patch + merge + return
    if (!this.opts.sectionSettingsWrite) {
      this.writeCorsHeaders(res); res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: "section_settings_write_unavailable" })); return;
    }
    let bodyStr = "";
    try { for await (const c of req) bodyStr += String(c); }
    catch { this.writeCorsHeaders(res); res.statusCode = 400; res.end("body read failed"); return; }
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(bodyStr || "{}") as Record<string, unknown>;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("not an object");
    } catch (e) {
      this.writeCorsHeaders(res); res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: (e as Error).message })); return;
    }
    try {
      const merged = await this.opts.sectionSettingsWrite(uid, patch);
      this.writeCorsHeaders(res); res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, settings: merged }));
    } catch (e) {
      this.writeCorsHeaders(res); res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }

  /**
   * v0.0.644 — Proxy any non-sidecar-API request to the local Next.js server
   * at 127.0.0.1:3002 (ogame-next, the ogame.anyfq.com SaaS site). Lets a
   * single CF tunnel ingress (`ogame.anyfq.com → europa:28791`) serve BOTH
   * the sidecar API (paths under `/ogamex/*` + `/dl/*`) and the Next.js
   * SaaS site (everything else) without touching the CF tunnel config.
   *
   * Forwards method, headers, body. Streams response back. Failures become
   * 502 so the operator sees a clear "next.js down" signal.
   */
  private proxyToNext(req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers = { ...req.headers };
    headers["x-forwarded-host"] = req.headers["host"] ?? "";
    headers["x-forwarded-proto"] = "https";
    headers["host"] = "127.0.0.1:3002";
    const upstream = http.request({
      host: "127.0.0.1",
      port: 3002,
      method: req.method,
      path: req.url,
      headers,
      timeout: 30_000,
    }, (upRes) => {
      res.statusCode = upRes.statusCode ?? 502;
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined) res.setHeader(k, v as string | string[]);
      }
      upRes.pipe(res);
    });
    upstream.on("error", (e: NodeJS.ErrnoException) => {
      console.warn("[next-proxy] error:", e.code ?? e.message);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("content-type", "text/plain");
        res.end(`next-proxy: upstream unreachable (${e.code ?? "ERR"})`);
      } else {
        res.end();
      }
    });
    req.pipe(upstream);
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
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
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

  /**
   * v0.0.645 — Phase 9a entry. If resolveUserToken is wired, look up the
   * Bearer in PG to get the user_id, then wrap handlePush() in
   * AsyncLocalStorage so every downstream shadow write (priorityMerger,
   * saveCoordinator, failureAggregator) sees that user_id. When the
   * resolver returns null (token belongs to no user, e.g. operator's
   * global token), the request runs without any per-request user_id and
   * env defaults take over.
   */
  private async dispatchPush(req: http.IncomingMessage, res: http.ServerResponse, globalAuthOk: boolean): Promise<void> {
    let userId: string | null = null;
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : "";
    if (this.opts.resolveUserToken && bearer && bearer !== this.opts.token) {
      try { userId = await this.opts.resolveUserToken(bearer); }
      catch (e) { console.warn("[http] resolveUserToken threw", e); }
    }
    // Auth: global token OK ⇒ run (no userId); per-user token resolved ⇒
    // run wrapped in ALS; neither ⇒ 401.
    if (!globalAuthOk && !userId) {
      this.writeCorsHeaders(res);
      res.statusCode = 401;
      res.end();
      return;
    }
    if (userId) {
      runWithUser(userId, () => { void this.handlePush(req, res); });
      return;
    }
    void this.handlePush(req, res);
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

  /** Phase 9c.7 — Bearer resolution for any endpoint that needs to
   *  identify the caller (read or mutate). Returns one of:
   *    { kind: "legacy" } — no Bearer OR global token; caller runs in
   *      legacy single-tenant mode (operator semantics preserved).
   *    { kind: "user", uid } — Bearer resolved to a PG user; caller
   *      should wrap downstream work in runWithUser(uid, ...).
   *    { kind: "forbidden" } — Bearer present, didn't match global,
   *      didn't resolve; caller responds 401. */
  private async resolveBearer(req: http.IncomingMessage): Promise<
    { kind: "legacy" } | { kind: "user"; uid: string } | { kind: "forbidden" }
  > {
    const globalAuthOk = this.checkAuth(req);
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : "";
    if (globalAuthOk) return { kind: "legacy" };
    if (!bearer) return { kind: "legacy" };
    if (this.opts.resolveUserToken) {
      try {
        const uid = await this.opts.resolveUserToken(bearer);
        if (uid) return { kind: "user", uid };
      } catch (e) { console.warn("[http] resolveBearer threw", e); }
    }
    return { kind: "forbidden" };
  }

  /** Phase 9c.6 — resolve Bearer for GET /v1/save/active. Global token →
   *  legacy listing (sqlite). Per-user Bearer → user-scoped listing.
   *  No Bearer at all → legacy listing (preserves operator's debug-UI
   *  fetch which historically had no auth header). */
  private async dispatchSaveActive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const globalAuthOk = this.checkAuth(req);
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : "";
    let userId: string | undefined;
    if (!globalAuthOk && this.opts.resolveUserToken && bearer) {
      try {
        const uid = await this.opts.resolveUserToken(bearer);
        if (uid) userId = uid;
        else {
          // Bearer present, didn't match global, didn't resolve → 401.
          this.writeCorsHeaders(res);
          res.statusCode = 401;
          res.end();
          return;
        }
      } catch (e) {
        console.warn("[http] save/active resolveUserToken threw", e);
        this.writeCorsHeaders(res);
        res.statusCode = 401;
        res.end();
        return;
      }
    }
    // userId === undefined here = legacy fallback (operator/no-auth path).
    this.handleProviderGet(res, this.opts.listActiveSaves
      ? () => this.opts.listActiveSaves?.(userId)
      : undefined);
  }

  /** Phase 9c.5 — resolve poll auth and route to the right bucket.
   *  Bearer matches global token → LEGACY_BUCKET (operator).
   *  Bearer resolves via PG → that user's bucket.
   *  Neither → 401. */
  private async dispatchPoll(req: http.IncomingMessage, res: http.ServerResponse, globalAuthOk: boolean): Promise<void> {
    let bucketUid: string | null = null;
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : "";
    if (globalAuthOk) {
      // Phase 9c.5 hotfix 2026-06-02 — global-token poll routes to the
      // operator's uid bucket (when env-configured) so it reads the same
      // bucket that any unauthenticated/legacy-uid write lands in. Falls
      // back to LEGACY_BUCKET only in test/CI without operator config.
      bucketUid = fallbackBucketUid();
    } else if (this.opts.resolveUserToken && bearer) {
      try {
        const uid = await this.opts.resolveUserToken(bearer);
        if (uid) bucketUid = uid;
      } catch (e) { console.warn("[http] poll resolveUserToken threw", e); }
    }
    if (!bucketUid) {
      this.writeCorsHeaders(res);
      res.statusCode = 401;
      res.end();
      return;
    }
    void this.handlePoll(req, res, bucketUid);
  }

  private async handlePoll(req: http.IncomingMessage, res: http.ServerResponse, bucketUid: string): Promise<void> {
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

    // v0.0.555 — operator 2026-05-31 "资源够了为什么不建" root cause:
    // queue accumulated stale directive entries (action|params dedup at
    // queueDownstream kept matching against them, dropping fresh dispatches).
    // First-ever dispatch was delivered to userscript at some point; the
    // entry stayed in queue forever. Next dispatch (different dirId, same
    // action+params) hit dedup → dropped → userscript never saw it →
    // goal stayed "active" → planner re-dispatched 30s later → dropped again.
    // Fix: prune any queue entry with ts <= since_ts. Client's cursor having
    // moved past those ts means it already consumed them; they cannot
    // re-deliver. Now dedup at queueDownstream sees a CLEAN queue and lets
    // legitimate new dispatches through. Phase 9c.5: prune per-bucket only.
    const q = this.bucketQueue(bucketUid);
    if (sinceTs > 0) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i]!.ts <= sinceTs) q.splice(i, 1);
      }
    }

    const filterReady = (): QueueEntry[] =>
      q.filter((e) => e.ts > sinceTs && !ackIds.has(e.id));

    let ready = filterReady();
    if (ready.length > 0) {
      this.respondPoll(res, ready);
      return;
    }

    // Long-poll: wait until something arrives on THIS bucket or timeout fires.
    const waiters = this.bucketWaiterList(bucketUid);
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
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      this.respondPoll(res, []);
    }, this.opts.pollTimeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    waiters.push(waiter);

    // If the client disconnects mid-poll, abandon the waiter quietly.
    req.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
    });
    ready = filterReady();
    if (ready.length > 0 && !settled) {
      settled = true;
      clearTimeout(timer);
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
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
