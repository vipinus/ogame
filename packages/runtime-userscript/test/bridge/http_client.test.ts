// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpBridgeClient } from "../../src/bridge/http_client.js";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

interface ReceivedPush { headers: Record<string, string | string[] | undefined>; body: unknown }
interface ReceivedPoll { headers: Record<string, string | string[] | undefined>; body: { since_ts?: number; ack_ids?: string[] } }

interface TestServer {
  http: HttpServer;
  port: number;
  pushReceived: ReceivedPush[];
  pollReceived: ReceivedPoll[];
  /** Queue of downstream messages to return on the next poll. */
  pendingDownstream: DownstreamMsg[];
  /** Override token. If set, requests with mismatched Authorization get 401. */
  expectedToken: string;
  /** Force the next N poll responses to error (HTTP 500). */
  forcePollErrorCount: number;
  close(): Promise<void>;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e as Error); }
    });
    req.on("error", reject);
  });
}

async function startServer(opts: { token?: string } = {}): Promise<TestServer> {
  const state: TestServer = {
    http: null as unknown as HttpServer,
    port: 0,
    pushReceived: [],
    pollReceived: [],
    pendingDownstream: [],
    expectedToken: opts.token ?? "tok",
    forcePollErrorCount: 0,
    close: async (): Promise<void> => { /* set below */ },
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const url = req.url ?? "/";
      const method = (req.method ?? "GET").toUpperCase();
      if (method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }

      // Auth
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${state.expectedToken}`) {
        res.statusCode = 401;
        res.end();
        return;
      }

      if (url === "/ogamex/v1/push") {
        let body: unknown;
        try { body = await readJson(req); } catch { res.statusCode = 400; res.end(); return; }
        state.pushReceived.push({ headers: req.headers, body });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === "/ogamex/v1/poll") {
        let body: unknown;
        try { body = await readJson(req); } catch { res.statusCode = 400; res.end(); return; }
        state.pollReceived.push({
          headers: req.headers,
          body: (body ?? {}) as { since_ts?: number; ack_ids?: string[] },
        });
        if (state.forcePollErrorCount > 0) {
          state.forcePollErrorCount -= 1;
          res.statusCode = 500;
          res.end();
          return;
        }
        const messages = state.pendingDownstream.splice(0, state.pendingDownstream.length);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ messages }));
        return;
      }

      res.statusCode = 404;
      res.end();
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  state.http = server;
  state.port = addr.port;
  state.close = (): Promise<void> => new Promise<void>((resolve) => {
    server.close(() => resolve());
    const maybe = server as HttpServer & { closeAllConnections?: () => void };
    if (typeof maybe.closeAllConnections === "function") maybe.closeAllConnections();
  });
  return state;
}

let activeServers: TestServer[] = [];
let activeClients: HttpBridgeClient[] = [];

function track(s: TestServer): TestServer { activeServers.push(s); return s; }
function trackClient(c: HttpBridgeClient): HttpBridgeClient { activeClients.push(c); return c; }

afterEach(async () => {
  for (const c of activeClients) { try { c.stop(); } catch { /* ignore */ } }
  activeClients = [];
  for (const s of activeServers) { try { await s.close(); } catch { /* ignore */ } }
  activeServers = [];
});

function baseUrl(s: TestServer): string { return `http://127.0.0.1:${s.port}`; }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("HttpBridgeClient", () => {
  it("send() POSTs to /push with Bearer auth header and JSON body", async () => {
    const s = track(await startServer());
    const c = trackClient(new HttpBridgeClient({ pollTimeoutHintMs: 50 }));
    await c.connect(baseUrl(s), "tok");
    const msg: Extract<UpstreamMsg, { type: "hello" }> = {
      type: "hello",
      strategy_version: 1,
      userscript_version: "0.0.1",
    };
    await c.send(msg);
    expect(s.pushReceived.length).toBe(1);
    const rec = s.pushReceived[0]!;
    expect(rec.headers["authorization"]).toBe("Bearer tok");
    expect(rec.body).toEqual(msg);
  });

  it("poll loop receives queued messages and dispatches to on() subscribers", async () => {
    const s = track(await startServer());
    const c = trackClient(new HttpBridgeClient({ pollTimeoutHintMs: 50 }));
    const payload: Extract<DownstreamMsg, { type: "ping" }> = { type: "ping", ts: 123 };
    s.pendingDownstream.push(payload);

    const got = new Promise<DownstreamMsg>((resolve) => {
      c.on("ping", (m) => resolve(m));
    });

    await c.connect(baseUrl(s), "tok");
    const received = await got;
    expect(received).toEqual(payload);
  });

  it("returns 401 when token is wrong → transitions to error then back to open after retry", async () => {
    const s = track(await startServer({ token: "correct" }));
    // Client uses wrong token initially; we'll observe the error state then
    // verify it recovers when we swap the server's expectedToken so subsequent
    // requests succeed. We exercise this via the public surface by using a
    // short errorBackoffMs and watching status().
    const c = trackClient(new HttpBridgeClient({ pollTimeoutHintMs: 50, errorBackoffMs: 30 }));
    await c.connect(baseUrl(s), "wrong");
    // Initial connect returns immediately; the poll loop should hit 401.
    // Wait until we observe status === "error".
    let sawError = false;
    for (let i = 0; i < 50 && !sawError; i++) {
      if (c.status() === "error") { sawError = true; break; }
      await sleep(10);
    }
    expect(sawError).toBe(true);

    // Now make the server accept the (wrong) token so polls succeed.
    s.expectedToken = "wrong";
    let recovered = false;
    for (let i = 0; i < 50 && !recovered; i++) {
      if (c.status() === "open") { recovered = true; break; }
      await sleep(20);
    }
    expect(recovered).toBe(true);
  });

  it("stop() halts the poll loop — server sees no further polls", async () => {
    const s = track(await startServer());
    const c = trackClient(new HttpBridgeClient({ pollTimeoutHintMs: 30, errorBackoffMs: 30 }));
    await c.connect(baseUrl(s), "tok");
    // Let one or two polls happen.
    await sleep(80);
    const before = s.pollReceived.length;
    c.stop();
    expect(c.status()).toBe("stopped");
    // Wait & confirm no further poll requests show up server-side.
    await sleep(200);
    const after = s.pollReceived.length;
    // Allow at most 1 in-flight poll completion to be recorded after stop.
    expect(after - before).toBeLessThanOrEqual(1);
    // And no NEW polls scheduled after that:
    await sleep(150);
    expect(s.pollReceived.length).toBe(after);
  });

  it("on() returns unsub function — unsubscribed handler does not fire", async () => {
    const s = track(await startServer());
    const c = trackClient(new HttpBridgeClient({ pollTimeoutHintMs: 30 }));

    let calls = 0;
    const unsub = c.on("ping", () => { calls += 1; });

    s.pendingDownstream.push({ type: "ping", ts: 1 });
    await c.connect(baseUrl(s), "tok");
    // wait for first dispatch
    for (let i = 0; i < 50 && calls === 0; i++) await sleep(10);
    expect(calls).toBe(1);

    unsub();
    s.pendingDownstream.push({ type: "ping", ts: 2 });
    // give the loop time to poll & "would" dispatch
    await sleep(150);
    expect(calls).toBe(1);
  });
});
