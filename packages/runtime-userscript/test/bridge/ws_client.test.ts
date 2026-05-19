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

    // Verify the END state: the server observes a fresh connection AND the
    // client transitions back to "open". The intermediate states
    // (reconnecting/disconnected/connecting) race-condition under
    // parallel-worker load — close→reconnect can complete inside the
    // smallest sleep window, so asserting them was flaky.
    await secondConnP;
    for (let i = 0; i < 100 && c.status() !== "open"; i++) await sleep(10);
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
      // replayOnReconnect:false preserves the historical drop-on-disconnect
      // semantics this test was written against (the default is now true,
      // which would queue the message instead — see M7.4 replay queue tests
      // below for that path).
      const c = trackClient(new BridgeClient({
        WebSocketCtor, reconnectOnLoss: false, replayOnReconnect: false,
      }));
      expect(() => c.send({ type: "pong", ts: 1 })).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // --- M7.4: replay queue ---

  it("queues sends issued before connect() and flushes them on open", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    const msg: Extract<UpstreamMsg, { type: "hello" }> = {
      type: "hello",
      strategy_version: 1,
      userscript_version: "0.0.1",
    };
    // Send BEFORE connect — should be queued.
    c.send(msg);
    expect(c.queuedCount()).toBe(1);
    expect(c.droppedCount()).toBe(0);

    const connP = s.nextConnect();
    await c.connect(url(s), "tok");
    const serverSocket = await connP;

    const recvP = new Promise<unknown>((resolve) => {
      serverSocket.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    expect(await recvP).toEqual(msg);
    expect(c.queuedCount()).toBe(0);
  });

  it("queues sends issued while reconnecting and flushes them on reopen", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({
      WebSocketCtor,
      reconnectOnLoss: true,
      initialBackoffMs: 10,
      maxBackoffMs: 50,
    }));
    const firstConnP = s.nextConnect();
    await c.connect(url(s), "tok");
    const firstSock = await firstConnP;
    expect(c.status()).toBe("open");

    const secondConnP = s.nextConnect();
    // Drop server-side; client transitions reconnecting → connecting → open.
    firstSock.close();

    // Poll until the status leaves "open" — at that point a send() will queue.
    for (let i = 0; i < 100 && c.status() === "open"; i++) await sleep(2);
    expect(c.status()).not.toBe("open");

    const msg: Extract<UpstreamMsg, { type: "pong" }> = { type: "pong", ts: 7 };
    c.send(msg);
    expect(c.queuedCount()).toBeGreaterThan(0);

    const secondSock = await secondConnP;
    const recvP = new Promise<unknown>((resolve) => {
      secondSock.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    expect(await recvP).toEqual(msg);
    for (let i = 0; i < 50 && c.queuedCount() !== 0; i++) await sleep(2);
    expect(c.queuedCount()).toBe(0);
  });

  it("drops the oldest queued messages when maxQueueSize is exceeded", async () => {
    const s = track(await startServer());
    const c = trackClient(new BridgeClient({
      WebSocketCtor, reconnectOnLoss: false, maxQueueSize: 3,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
    try {
      // 5 distinguishable messages before connect — only the latest 3 (ts 3,4,5)
      // should survive after FIFO eviction.
      for (let ts = 1; ts <= 5; ts++) {
        c.send({ type: "pong", ts });
      }
      expect(c.queuedCount()).toBe(3);
      expect(c.droppedCount()).toBe(2);

      const connP = s.nextConnect();
      await c.connect(url(s), "tok");
      const serverSocket = await connP;

      const received: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        serverSocket.on("message", (data) => {
          received.push(JSON.parse(data.toString()));
          if (received.length === 3) resolve();
        });
      });
      await done;
      expect(received).toEqual([
        { type: "pong", ts: 3 },
        { type: "pong", ts: 4 },
        { type: "pong", ts: 5 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not queue when replayOnReconnect is false; drops with warning instead", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
    try {
      const c = trackClient(new BridgeClient({
        WebSocketCtor, reconnectOnLoss: false, replayOnReconnect: false,
      }));
      c.send({ type: "pong", ts: 1 });
      expect(c.queuedCount()).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("stop() clears the pending replay queue", () => {
    const c = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    for (let ts = 1; ts <= 5; ts++) c.send({ type: "pong", ts });
    expect(c.queuedCount()).toBe(5);
    c.stop();
    expect(c.queuedCount()).toBe(0);
  });
});
