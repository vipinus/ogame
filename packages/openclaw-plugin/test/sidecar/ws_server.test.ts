import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { WsServer } from "../../src/sidecar/ws_server.js";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

const TOKEN = "test-token-123";

// Helper: open a ws client and resolve on 'open', or reject on 'unexpected-response'/'error'/'close'.
function connect(port: number, opts?: { token?: string | null }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts?.token !== null && opts?.token !== undefined) {
      headers["Authorization"] = `Bearer ${opts.token}`;
    } else if (opts?.token === undefined) {
      headers["Authorization"] = `Bearer ${TOKEN}`;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const t = setTimeout(() => {
      reject(new Error("connect timeout"));
      try { ws.terminate(); } catch { /* ignore */ }
    }, 200);
    ws.once("open", () => { clearTimeout(t); resolve(ws); });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(t);
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
    ws.once("error", (err) => { clearTimeout(t); reject(err); });
  });
}

function nextMessage<T = unknown>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("nextMessage timeout")), 200);
    ws.once("message", (data) => {
      clearTimeout(t);
      try { resolve(JSON.parse(data.toString()) as T); }
      catch (e) { reject(e as Error); }
    });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function startServer(token = TOKEN): Promise<{ server: WsServer; port: number }> {
  const server = new WsServer({ port: 0, token });
  await server.start();
  const port = server.port();
  return { server, port };
}

let activeServers: WsServer[] = [];

afterEach(async () => {
  for (const s of activeServers) {
    try { await s.stop(); } catch { /* ignore */ }
  }
  activeServers = [];
});

function track(s: WsServer): WsServer { activeServers.push(s); return s; }

describe("WsServer", () => {
  it("accepts a connection with the correct Bearer token", async () => {
    const { server, port } = await startServer();
    track(server);
    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects a connection without an Authorization header", async () => {
    const { server, port } = await startServer();
    track(server);
    await expect(connect(port, { token: null })).rejects.toThrow(/401|unexpected-response/i);
  });

  it("rejects a connection with the wrong token", async () => {
    const { server, port } = await startServer();
    track(server);
    await expect(connect(port, { token: "nope" })).rejects.toThrow(/401|unexpected-response/i);
  });

  it("server.send → client receives the JSON-encoded DownstreamMsg", async () => {
    const { server, port } = await startServer();
    track(server);
    const ws = await connect(port);
    const recvP = nextMessage<DownstreamMsg>(ws);
    const msg: DownstreamMsg = { type: "ping", ts: 1 };
    server.send(msg);
    const recv = await recvP;
    expect(recv).toEqual(msg);
    ws.close();
  });

  it("dispatches incoming UpstreamMsg by type to typed handler", async () => {
    const { server, port } = await startServer();
    track(server);

    const got = new Promise<Extract<UpstreamMsg, { type: "hello" }>>((resolve) => {
      server.on("hello", (m) => resolve(m));
    });

    const ws = await connect(port);
    const payload: Extract<UpstreamMsg, { type: "hello" }> = {
      type: "hello",
      strategy_version: 1,
      userscript_version: "0.0.1",
    };
    ws.send(JSON.stringify(payload));

    const m = await got;
    expect(m).toEqual(payload);
    ws.close();
  });

  it("broadcasts server.send to all connected clients", async () => {
    const { server, port } = await startServer();
    track(server);
    const a = await connect(port);
    const b = await connect(port);
    const recvA = nextMessage<DownstreamMsg>(a);
    const recvB = nextMessage<DownstreamMsg>(b);
    const msg: DownstreamMsg = { type: "ping", ts: 42 };
    server.send(msg);
    const [ra, rb] = await Promise.all([recvA, recvB]);
    expect(ra).toEqual(msg);
    expect(rb).toEqual(msg);
    a.close();
    b.close();
  });

  it("accepts subprotocol-based auth (Sec-WebSocket-Protocol: bearer.<token>) for browser path", async () => {
    const { server, port } = await startServer();
    track(server);
    // Browser DOM WebSocket forbids custom request headers; bearer token is
    // smuggled via Sec-WebSocket-Protocol. ws lib does this when you pass it
    // as the second arg of new WebSocket(url, protocols).
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}`, `bearer.${TOKEN}`);
      const t = setTimeout(() => { reject(new Error("connect timeout")); try { w.terminate(); } catch { /* ignore */ } }, 200);
      w.once("open", () => { clearTimeout(t); resolve(w); });
      w.once("unexpected-response", (_req, res) => { clearTimeout(t); reject(new Error(`unexpected-response ${res.statusCode}`)); });
      w.once("error", (err) => { clearTimeout(t); reject(err); });
    });
    expect(ws.protocol).toBe(`bearer.${TOKEN}`); // server MUST echo the accepted protocol
    ws.close();
  });

  it("rejects subprotocol with wrong token", async () => {
    const { server, port } = await startServer();
    track(server);
    await expect(new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}`, "bearer.wrong-token");
      const t = setTimeout(() => { reject(new Error("connect timeout")); try { w.terminate(); } catch { /* ignore */ } }, 200);
      w.once("open", () => { clearTimeout(t); resolve(w); });
      w.once("unexpected-response", (_req, res) => { clearTimeout(t); reject(new Error(`unexpected-response ${res.statusCode}`)); });
      w.once("error", (err) => { clearTimeout(t); reject(err); });
    })).rejects.toThrow(/unexpected-response 401/);
  });

  it("responds to PNA preflight (OPTIONS) with allow headers", async () => {
    const { server, port } = await startServer();
    track(server);
    // Simulate Chrome's PNA preflight: OPTIONS + Access-Control-Request-Private-Network: true
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "OPTIONS",
      headers: {
        "Origin": "https://s1-en.ogame.org",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    const allowOrigin = res.headers.get("access-control-allow-origin") ?? "";
    expect(allowOrigin.length).toBeGreaterThan(0);
  });
});

// Helper accessor for AddressInfo typing (unused-direct but proves we wire types correctly).
export type _Addr = AddressInfo;
