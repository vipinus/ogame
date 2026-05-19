// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import WebSocket from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { BridgeClient } from "../../src/bridge/ws_client.js";
import { wireBridge, type WireBridgeHandle } from "../../src/bridge/wire.js";
import { EventBus } from "../../src/event_bus.js";
import { StateStore } from "../../src/state_store.js";
import type { BootHandle, BootSummary } from "../../src/boot.js";

// `ws` package's WebSocket honours the (url, protocols) browser signature.
const WebSocketCtor = WebSocket as unknown as typeof globalThis.WebSocket;

interface TestServer {
  http: HttpServer;
  wss: WebSocketServer;
  port: number;
  sockets: Set<WsWebSocket>;
  received: unknown[];
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WsWebSocket>();
  const received: unknown[] = [];

  http.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
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
  return {
    http,
    wss,
    port: addr.port,
    sockets,
    received,
    close: async () => {
      for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function makeBoot(): BootHandle {
  const bus = new EventBus();
  const store = new StateStore(bus, null);
  const summary: BootSummary = {
    resources_ok: false,
    storage_ok: false,
    production_ok: false,
    lifeform_resources_ok: false,
    events_count: 0,
    planets_count: 0,
    fleet_movements_count: 0,
    token_present: false,
    ogame_meta: {},
  };
  return { bus, store, summary, stop: () => { /* noop */ } };
}

/**
 * Poll a predicate up to `timeoutMs`, sleeping `stepMs` between checks.
 * Robust under vitest parallel-worker scheduling (fixed sleeps can be starved).
 */
async function waitFor(pred: () => boolean, timeoutMs = 2000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let activeServers: TestServer[] = [];
let activeWires: WireBridgeHandle[] = [];
let activeClients: BridgeClient[] = [];

function track(s: TestServer): TestServer { activeServers.push(s); return s; }
function trackWire(w: WireBridgeHandle): WireBridgeHandle { activeWires.push(w); return w; }
function trackClient(c: BridgeClient): BridgeClient { activeClients.push(c); return c; }

afterEach(async () => {
  for (const w of activeWires) { try { w.stop(); } catch { /* ignore */ } }
  activeWires = [];
  for (const c of activeClients) { try { c.stop(); } catch { /* ignore */ } }
  activeClients = [];
  for (const s of activeServers) { try { await s.close(); } catch { /* ignore */ } }
  activeServers = [];
});

function url(s: TestServer): string { return `ws://127.0.0.1:${s.port}`; }

function received(s: TestServer, type: string): unknown[] {
  return s.received.filter((m): m is { type: string } & Record<string, unknown> =>
    typeof m === "object" && m !== null && (m as { type?: unknown }).type === type,
  );
}

describe("wireBridge", () => {
  it("sends hello message on connect", async () => {
    const s = track(await startServer());
    const boot = makeBoot();
    const client = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    trackWire(await wireBridge(boot, {
      bridgeUrl: url(s),
      bridgeToken: "tok",
      pushIntervalMs: 10_000,
      jitterMs: 0,
      client,
    }));
    await waitFor(() => received(s, "hello").length >= 1);
    const hellos = received(s, "hello");
    expect(hellos.length).toBeGreaterThanOrEqual(1);
    expect(hellos[0]).toEqual({
      type: "hello",
      strategy_version: 0,
      userscript_version: "0.0.1",
    });
  });

  it("pushes state.snapshot within first interval", async () => {
    const s = track(await startServer());
    const boot = makeBoot();
    const client = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    trackWire(await wireBridge(boot, {
      bridgeUrl: url(s),
      bridgeToken: "tok",
      pushIntervalMs: 50,
      jitterMs: 10,
      client,
    }));
    await waitFor(() => received(s, "state.snapshot").length >= 1, 500);
    const snaps = received(s, "state.snapshot");
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const first = snaps[0] as { snapshot: unknown; strategy_version: number; ts: number };
    expect(first.snapshot).toEqual(boot.store.state);
    expect(first.strategy_version).toBe(0);
    expect(typeof first.ts).toBe("number");
  });

  it("keeps pushing snapshots on subsequent intervals", async () => {
    const s = track(await startServer());
    const boot = makeBoot();
    const client = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    trackWire(await wireBridge(boot, {
      bridgeUrl: url(s),
      bridgeToken: "tok",
      pushIntervalMs: 50,
      jitterMs: 10,
      client,
    }));
    await waitFor(() => received(s, "state.snapshot").length >= 2, 1000);
    expect(received(s, "state.snapshot").length).toBeGreaterThanOrEqual(2);
  });

  it("forwards emergency.attack bus events as event.emergency", async () => {
    const s = track(await startServer());
    const boot = makeBoot();
    const client = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    trackWire(await wireBridge(boot, {
      bridgeUrl: url(s),
      bridgeToken: "tok",
      pushIntervalMs: 10_000,
      jitterMs: 0,
      client,
    }));
    // Wait for connection + hello to flush before emitting, so the client
    // is OPEN when we fire the event.
    await waitFor(() => received(s, "hello").length >= 1);

    const payload = {
      event_id: "ev-1",
      from: [1, 100, 8],
      to: [1, 200, 8],
      arrives_at: 1234567890,
    };
    boot.bus.emit("emergency.attack", payload);

    await waitFor(() => received(s, "event.emergency").length >= 1, 500);
    const events = received(s, "event.emergency");
    expect(events.length).toBe(1);
    const ev = events[0] as { subtype: string; data: unknown; markdown_report: string };
    expect(ev.subtype).toBe("attack");
    expect(ev.data).toEqual(payload);
    expect(ev.markdown_report).toMatch(/Attack detected\*\* event=ev-1/);
  });

  it("stop() halts the push loop", async () => {
    const s = track(await startServer());
    const boot = makeBoot();
    const client = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    const wire = await wireBridge(boot, {
      bridgeUrl: url(s),
      bridgeToken: "tok",
      pushIntervalMs: 50,
      jitterMs: 10,
      client,
    });
    // Don't track via trackWire since we're calling stop() manually.
    await waitFor(() => received(s, "state.snapshot").length >= 1, 500);
    wire.stop();
    const countAtStop = received(s, "state.snapshot").length;
    await sleep(200);
    // No additional snapshots after stop().
    expect(received(s, "state.snapshot").length).toBe(countAtStop);
  });

  it("stop() unsubscribes from emergency.attack", async () => {
    const s = track(await startServer());
    const boot = makeBoot();
    const client = trackClient(new BridgeClient({ WebSocketCtor, reconnectOnLoss: false }));
    const wire = await wireBridge(boot, {
      bridgeUrl: url(s),
      bridgeToken: "tok",
      pushIntervalMs: 10_000,
      jitterMs: 0,
      client,
    });
    await waitFor(() => received(s, "hello").length >= 1);
    wire.stop();
    boot.bus.emit("emergency.attack", { event_id: "ev-after-stop" });
    await sleep(100);
    expect(received(s, "event.emergency").length).toBe(0);
  });
});
