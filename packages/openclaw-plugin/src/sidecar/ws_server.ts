import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

export interface WsServerOptions {
  port: number;
  token: string;
  /** Operator 2026-06-04 — per-user Bearer token resolver. WS clients
   *  authenticated via per-user bridge_token (not the global one) get their
   *  user_id tagged on the socket so downstream broadcasts can route per
   *  user. Returns null for unknown tokens. */
  resolveUserToken?: (bearer: string) => Promise<string | null>;
}

type Handler<T extends UpstreamMsg["type"]> = (msg: Extract<UpstreamMsg, { type: T }>) => void;
type HandlerMap = { [K in UpstreamMsg["type"]]?: Set<Handler<K>> };

// Spec §10.1 PNA: Chrome's Private Network Access preflight requires these headers
// on OPTIONS responses for any cross-origin request hitting a private/localhost target.
const PNA_ALLOW_ORIGIN = "https://*.ogame.org";

export class WsServer {
  private readonly options: WsServerOptions;
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly handlers: HandlerMap = {};
  private readonly clients = new Set<WebSocket>();
  // v0.0.545 — heartbeat (operator 2026-05-31 "后台应该往前台发心跳检测").
  // Server sends ping every PING_INTERVAL_MS. Each client gets isAlive=true on
  // connect + pong arrival. Sweep every PING_INTERVAL_MS: if isAlive still
  // false (no pong since last ping) → terminate the socket. Browser auto-
  // replies to ping at protocol level; userscript needs no code change.
  // Terminate triggers client's onclose → existing reconnectOnLoss path fires.
  private static readonly PING_INTERVAL_MS = 30_000;
  private readonly aliveFlags = new WeakMap<WebSocket, boolean>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WsServerOptions) {
    this.options = options;
  }

  /** Operator 2026-06-04 — attach WS upgrade handler to an EXISTING http
   *  server (e.g. sidecar's HttpServer on :28791). Same-port WS; CF tunnel
   *  auto-forwards Upgrade for HTTP origins → no separate :28790 / cf-router
   *  routing needed. `start()` (which spawns its own port) is the legacy
   *  path; new code should call attachToHttpServer(rawHttpServer) instead. */
  attachToHttpServer(rawHttp: HttpServer): void {
    if (this.wss) return;
    // Operator 2026-06-04 — accept ANY bearer.<X> protocol; auth is validated
    // in checkAuthAsync (global token OR per-user bridge_token). Echoing the
    // matching protocol back is required for browsers to keep the socket open.
    const globalProto = `bearer.${this.options.token}`;
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        if (protocols.has(globalProto)) return globalProto;
        for (const p of protocols) {
          if (typeof p === "string" && p.startsWith("bearer.") && p.length > "bearer.".length) return p;
        }
        return false;
      },
    });
    rawHttp.on("upgrade", (req, socket, head) => {
      console.info(`[ws] upgrade event fired url=${req.url} proto=${req.headers["sec-websocket-protocol"]}`);
      // Only handle /ws — any other path is delegated to the http server's
      // own logic (which will close socket if not handled).
      if (req.url !== "/ws") return;
      this.onUpgrade(req, socket as unknown as Duplex, head, wss);
    });
    console.info(`[ws] post-attach listenerCount(upgrade)=${rawHttp.listenerCount("upgrade")}`);
    wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.aliveFlags.set(ws, true);
      ws.on("pong", () => { this.aliveFlags.set(ws, true); });
      ws.on("close", () => { this.clients.delete(ws); this.aliveFlags.delete(ws); });
      ws.on("error", () => { /* swallow; close will follow */ });
      ws.on("message", (data) => this.onMessage(data));
    });
    this.wss = wss;
    // Ping sweep for liveness — same as legacy start().
    this.pingTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (this.aliveFlags.get(ws) === false) {
          console.warn(`[ws] terminating zombie socket (no pong in ${WsServer.PING_INTERVAL_MS / 1000}s)`);
          try { ws.terminate(); } catch { /* */ }
          continue;
        }
        this.aliveFlags.set(ws, false);
        try { ws.ping(); } catch { /* */ }
      }
    }, WsServer.PING_INTERVAL_MS);
    console.info(`[ws] attached to existing http server (same port, no separate :${this.options.port})`);
  }

  async start(): Promise<void> {
    if (this.http) return;

    const http = createServer((req, res) => this.onHttpRequest(req, res));
    // handleProtocols: echo back the bearer subprotocol that auth accepted, so
    // browser DOM WebSocket sees its requested protocol acknowledged and stays open.
    // Operator 2026-06-04 — accept ANY bearer.<X> protocol; auth is validated
    // in checkAuthAsync (global token OR per-user bridge_token). Echoing the
    // matching protocol back is required for browsers to keep the socket open.
    const globalProto = `bearer.${this.options.token}`;
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        if (protocols.has(globalProto)) return globalProto;
        for (const p of protocols) {
          if (typeof p === "string" && p.startsWith("bearer.") && p.length > "bearer.".length) return p;
        }
        return false;
      },
    });

    http.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head, wss));

    wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.aliveFlags.set(ws, true);
      ws.on("pong", () => { this.aliveFlags.set(ws, true); });
      ws.on("close", () => { this.clients.delete(ws); this.aliveFlags.delete(ws); });
      ws.on("error", () => { /* swallow; close will follow */ });
      ws.on("message", (data) => this.onMessage(data));
    });

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      http.once("error", onErr);
      http.listen(this.options.port, "0.0.0.0", () => {
        http.off("error", onErr);
        resolve();
      });
    });

    this.http = http;
    this.wss = wss;

    // v0.0.545 — periodic ping sweep. Pings live clients; terminates zombies.
    this.pingTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (this.aliveFlags.get(ws) === false) {
          // Missed last pong. Force-close → client's onclose → reconnect.
          console.warn(`[ws] terminating zombie socket (no pong in ${WsServer.PING_INTERVAL_MS / 1000}s)`);
          try { ws.terminate(); } catch { /* */ }
          continue;
        }
        this.aliveFlags.set(ws, false);
        try { ws.ping(); } catch { /* swallow; close will follow */ }
      }
    }, WsServer.PING_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    const http = this.http;
    this.wss = null;
    this.http = null;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (wss) {
      for (const ws of this.clients) {
        try { ws.close(1001, "server stopping"); } catch { /* ignore */ }
      }
      this.clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (http) {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  send(msg: DownstreamMsg): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  on<T extends UpstreamMsg["type"]>(type: T, handler: Handler<T>): void {
    let set = this.handlers[type] as Set<Handler<T>> | undefined;
    if (!set) {
      set = new Set<Handler<T>>();
      // Index by literal type — safe assignment.
      (this.handlers as Record<string, Set<Handler<T>>>)[type] = set;
    }
    set.add(handler);
  }

  /** Returns the actual port the server is listening on (resolves OS-assigned port=0). */
  port(): number {
    const addr = this.http?.address();
    if (addr && typeof addr === "object") return (addr as AddressInfo).port;
    return this.options.port;
  }

  // --- internals ---

  private onHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // Spec §10.1: PNA preflight — Chrome sends OPTIONS with
    // Access-Control-Request-Private-Network: true before allowing a public origin
    // (ogame.org) to talk to 127.0.0.1.
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", PNA_ALLOW_ORIGIN);
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.end();
      return;
    }
    // Non-upgrade, non-OPTIONS traffic is not supported.
    res.statusCode = 426; // Upgrade Required
    res.setHeader("Content-Type", "text/plain");
    res.end("Upgrade Required");
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    // Async wrapper — checkAuth may need to call resolveUserToken (DB lookup).
    void (async (): Promise<void> => {
      const authResult = await this.checkAuthAsync(req);
      if (!authResult.ok) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\n" +
          'WWW-Authenticate: Bearer realm="ogamex"\r\n' +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n"
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Tag socket with resolved uid so downstream broadcasts can route per-user.
        if (authResult.uid) {
          this.socketUid.set(ws, authResult.uid);
        }
        wss.emit("connection", ws, req);
      });
    })();
  }

  /** WeakMap of socket → resolved uid (only set for per-user Bearer; legacy
   *  global token clients are untagged). Set in onUpgrade after authentication. */
  private readonly socketUid = new WeakMap<WebSocket, string>();

  /** Operator 2026-06-04 — return uid for a connected socket (null if global
   *  token or unknown). Lets broadcastSectionUpdate filter clients by user_id. */
  uidFor(ws: WebSocket): string | null {
    return this.socketUid.get(ws) ?? null;
  }

  /** Operator 2026-06-04 "flagship 信号灯" — true if any open ws client is
   *  uid-tagged with the given user_id. Used by /ogamex/v1/me/bridge-status
   *  to surface WS vs HTTP transport in the web dashboard dot. */
  hasUidConnected(uid: string): boolean {
    if (!uid) return false;
    for (const ws of this.clients) {
      if (this.socketUid.get(ws) === uid) return true;
    }
    return false;
  }

  private async checkAuthAsync(req: IncomingMessage): Promise<{ ok: boolean; uid?: string }> {
    // 1) Global token via header or subprotocol
    const local = this.checkAuth(req);
    if (local.ok) return { ok: true };
    // 2) Per-user resolver (extracts bearer from header or subprotocol)
    if (!this.options.resolveUserToken) return { ok: false };
    let bearer = "";
    const auth = req.headers["authorization"];
    if (typeof auth === "string") {
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (m && m[1]) bearer = m[1].trim();
    }
    if (!bearer) {
      const proto = req.headers["sec-websocket-protocol"];
      if (typeof proto === "string") {
        for (const c of proto.split(",")) {
          const t = c.trim();
          if (t.startsWith("bearer.")) { bearer = t.slice("bearer.".length); break; }
        }
      }
    }
    if (!bearer) return { ok: false };
    try {
      const uid = await this.options.resolveUserToken(bearer);
      if (uid) return { ok: true, uid };
    } catch (e) { console.warn("[ws] resolveUserToken threw", e); }
    return { ok: false };
  }

  /**
   * Auth accepts two transports:
   * - `Authorization: Bearer <token>` (Node-side / WS tools)
   * - `Sec-WebSocket-Protocol: bearer.<token>` (browser path — DOM WebSocket
   *   forbids custom request headers, so token is smuggled as a subprotocol name)
   */
  private checkAuth(req: IncomingMessage): { ok: boolean; via?: "header" | "subprotocol"; protocol?: string } {
    // Path 1: Authorization header
    const auth = req.headers["authorization"];
    if (typeof auth === "string") {
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (m && m[1]?.trim() === this.options.token) {
        return { ok: true, via: "header" };
      }
    }
    // Path 2: Sec-WebSocket-Protocol subprotocol (browser path)
    const proto = req.headers["sec-websocket-protocol"];
    if (typeof proto === "string") {
      const candidates = proto.split(",").map((s) => s.trim());
      const wanted = `bearer.${this.options.token}`;
      if (candidates.includes(wanted)) {
        return { ok: true, via: "subprotocol", protocol: wanted };
      }
    }
    return { ok: false };
  }

  private onMessage(data: unknown): void {
    let text: string;
    if (typeof data === "string") text = data;
    else if (Buffer.isBuffer(data)) text = data.toString("utf8");
    else if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString("utf8");
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else return;

    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return; }

    if (!parsed || typeof parsed !== "object") return;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string") return;

    const set = (this.handlers as Record<string, Set<(m: UpstreamMsg) => void> | undefined>)[type];
    if (!set) return;
    for (const h of set) {
      try { h(parsed as UpstreamMsg); }
      catch { /* handler errors must not crash the socket loop */ }
    }
  }
}
