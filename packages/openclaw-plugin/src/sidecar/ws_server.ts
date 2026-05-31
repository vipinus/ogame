import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

export interface WsServerOptions {
  port: number;
  token: string;
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

  async start(): Promise<void> {
    if (this.http) return;

    const http = createServer((req, res) => this.onHttpRequest(req, res));
    // handleProtocols: echo back the bearer subprotocol that auth accepted, so
    // browser DOM WebSocket sees its requested protocol acknowledged and stays open.
    const expectedProto = `bearer.${this.options.token}`;
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has(expectedProto) ? expectedProto : false),
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
    const authResult = this.checkAuth(req);
    if (!authResult.ok) {
      // Bare HTTP 401 — ws's client will emit 'unexpected-response'.
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
    // Subprotocol selection is handled by the WebSocketServer's handleProtocols
    // option (configured in start()), which ensures the upgrade response echoes
    // the bearer.<token> protocol so browser clients stay open.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
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
