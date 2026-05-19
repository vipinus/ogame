// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import WebSocket from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { BridgeClient } from "../../src/bridge/ws_client.js";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

// The `ws` package's WebSocket implements the browser `(url, protocols)`
// constructor signature, so it can stand in for the browser global in tests.
// We cast through unknown because `ws.WebSocket`'s type signature is wider
// than the DOM `WebSocket` (e.g. accepts a 3rd ClientOptions arg), but the
// 2-arg overload is fully compatible with BridgeClient's usage.
const WebSocketCtor = WebSocket as unknown as typeof globalThis.WebSocket;

interface TestServer {
  http: HttpServer;
  wss: WebSocketServer;
  port: number;
  /** sec-websocket-protocol header from the most recent upgrade. */
  lastUpgradeProtocol: string | null;
  /** All sockets currently open (server-side). */
  sockets: Set<WsWebSocket>;
  /** Messages received from clients, parsed JSON. */
  received: unknown[];
  /** Resolves on next client connection. */
  nextConnect: () => Promise<WsWebSocket>;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });

  let lastUpgradeProtocol: string | null = null;
  const sockets = new Set<WsWebSocket>();
  const received: unknown[] = [];
  let resolveNextConnect: ((ws: WsWebSocket) => void) | null = null;

  http.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const proto = req.headers["sec-websocket-protocol"];
    lastUpgradeProtocol = typeof proto === "string" ? proto : null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Accept the offered subprotocol so the handshake completes cleanly.
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WsWebSocket) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => { /* swallow */ });
    ws.on("message", (data) => {
      try { received.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    if (resolveNextConnect) {
      const r = resolveNextConnect;
      resolveNextConnect = null;
      r(ws);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error) => reject(e);
    http.once("error", onErr);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", onErr);
      resolve();
    });
  });

  const addr = http.address() as AddressInfo;
  const port = addr.port;

  return {
    http,
    wss,
    port,
    get lastUpgradeProtocol() { return lastUpgradeProtocol; },
    sockets,
    received,
    nextConnect: () =>
      new Promise<WsWebSocket>((resolve) => { resolveNextConnect = resolve; }),
    close: async () => {
      for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

let activeServers: TestServer[] = [];
let activeClients: BridgeClient[] = [];

function track(s: TestServer): TestServer { activeServers.push(s); return s; }
function trackClient(c: BridgeClient): BridgeClient { activeClients.push(c); return c; }

afterEach(async () => {
  for (const c of activeClients) { try { c.stop(); } catch { /* ignore */ } }
  activeClients = [];
  for (const s of activeServers) { try { await s.close(); } catch { /* ignore */ } }
  activeServers = [];
});

function url(s: TestServer): string { return `ws://127.0.0.1:${s.port}`; }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("BridgeClient", () => {
  it("resolves connect() once the WS open event fires", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    await c.connect(url(s), "tok");
    expect(c.status()).toBe("open");
  });

  it("send() forwards JSON-encoded UpstreamMsg to the server", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    const connP = s.nextConnect();
    await c.connect(url(s), "tok");
    const serverSocket = await connP;
    const recvP = new Promise<unknown>((resolve) => {
      serverSocket.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    const msg: Extract<UpstreamMsg, { type: "hello" }> = {
      type: "hello",
      strategy_version: 1,
      userscript_version: "0.0.1",
    };
    c.send(msg);
    expect(await recvP).toEqual(msg);
  });

  it("on(type, handler) invokes the handler with the parsed DownstreamMsg", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    const connP = s.nextConnect();
    await c.connect(url(s), "tok");
    const serverSocket = await connP;
    const got = new Promise<DownstreamMsg>((resolve) => {
      c.on("ping", (m) => resolve(m));
    });
    const payload: Extract<DownstreamMsg, { type: "ping" }> = { type: "ping", ts: 42 };
    serverSocket.send(JSON.stringify(payload));
    expect(await got).toEqual(payload);
  });

  it("authenticates by sending Sec-WebSocket-Protocol: bearer.<token>", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    const connP = s.nextConnect();
    await c.connect(url(s), "tok-123");
    await connP;
    expect(s.lastUpgradeProtocol).toBe("bearer.tok-123");
  });

  it("reconnects with exponential backoff when the server drops the connection", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({
      WebSocketCtor,
      reconnectOnLoss: true,
      initialBackoffMs: 20,
      maxBackoffMs: 100,
    }));
    const firstConnP = s.nextConnect();
    await c.connect(url(s), "tok");
    const firstSock = await firstConnP;
    expect(c.status()).toBe("open");

    const secondConnP = s.nextConnect();
    // Drop the first connection — client should auto-reconnect.
    firstSock.close();

    // Allow event loop to flush close → schedule.
    await sleep(5);
    expect(["reconnecting", "disconnected", "connecting"]).toContain(c.status());

    await secondConnP;
    // Wait for client-side open event.
    for (let i = 0; i < 50 && c.status() !== "open"; i++) await sleep(10);
    expect(c.status()).toBe("open");
  });

  it("stop() disables reconnect — no further connections after close", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({
      WebSocketCtor,
      reconnectOnLoss: true,
      initialBackoffMs: 10,
      maxBackoffMs: 50,
    }));
    await c.connect(url(s), "tok");
    expect(c.status()).toBe("open");
    const connsBefore = s.sockets.size;
    c.stop();
    expect(c.status()).toBe("stopped");
    // Wait longer than several backoff cycles.
    await sleep(120);
    expect(c.status()).toBe("stopped");
    // No new server-side connections after stop().
    expect(s.sockets.size).toBeLessThanOrEqual(connsBefore);
  });

  it("send() before connect drops the message with a warning and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
    try {
      const c = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
      expect(() => c.send({ type: "pong", ts: 1 })).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
