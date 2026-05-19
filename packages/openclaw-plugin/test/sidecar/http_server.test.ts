import { describe, it, expect, afterEach } from "vitest";
import { HttpServer } from "../../src/sidecar/http_server.js";
import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

const TOKEN = "test-token-123";

let activeServers: HttpServer[] = [];

afterEach(async () => {
  for (const s of activeServers) {
    try { await s.stop(); } catch { /* ignore */ }
  }
  activeServers = [];
});

function track(s: HttpServer): HttpServer { activeServers.push(s); return s; }

async function startServer(opts?: { pollTimeoutMs?: number }): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = new HttpServer({
    port: 0,
    token: TOKEN,
    ...(opts?.pollTimeoutMs !== undefined ? { pollTimeoutMs: opts.pollTimeoutMs } : {}),
  });
  await server.start();
  track(server);
  const port = (server as unknown as { port: () => number }).port();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("HttpServer", () => {
  it("OPTIONS /ogamex/v1/push returns 204 with PNA headers", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/ogamex/v1/push`, {
      method: "OPTIONS",
      headers: {
        "Origin": "https://s1-en.ogame.org",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    const allowOrigin = res.headers.get("access-control-allow-origin") ?? "";
    expect(allowOrigin.length).toBeGreaterThan(0);
    const allowMethods = (res.headers.get("access-control-allow-methods") ?? "").toLowerCase();
    expect(allowMethods).toContain("post");
    expect(allowMethods).toContain("options");
    const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("content-type");
    // Body should be empty for 204 — must read to release connection.
    await res.text();
  });

  it("POST /push without auth → 401", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/ogamex/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "hello", strategy_version: 1, userscript_version: "0.0.1" }),
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("POST /push with valid auth dispatches to subscribed handler", async () => {
    const { server, baseUrl } = await startServer();

    const got = new Promise<Extract<UpstreamMsg, { type: "hello" }>>((resolve) => {
      server.on("hello", (m) => resolve(m));
    });

    const payload: Extract<UpstreamMsg, { type: "hello" }> = {
      type: "hello",
      strategy_version: 1,
      userscript_version: "0.0.1",
    };
    const res = await fetch(`${baseUrl}/ogamex/v1/push`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    await res.text();
    const m = await got;
    expect(m).toEqual(payload);
  });

  it("POST /poll returns queued messages immediately", async () => {
    const { server, baseUrl } = await startServer({ pollTimeoutMs: 500 });
    const m1: DownstreamMsg = { type: "ping", ts: 100 };
    const m2: DownstreamMsg = { type: "ping", ts: 200 };
    server.queueDownstream(m1);
    server.queueDownstream(m2);

    const res = await fetch(`${baseUrl}/ogamex/v1/poll`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ since_ts: 0 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: DownstreamMsg[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages).toEqual([m1, m2]);
  });

  it("POST /poll returns empty array after pollTimeoutMs when no messages queued", async () => {
    const { baseUrl } = await startServer({ pollTimeoutMs: 50 });
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/ogamex/v1/poll`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ since_ts: 0 }),
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: DownstreamMsg[] };
    expect(body.messages).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(40); // ~50ms long-poll
    expect(elapsed).toBeLessThan(1000);
  });

  it("POST /poll resolves early when a message is queued mid-poll", async () => {
    const { server, baseUrl } = await startServer({ pollTimeoutMs: 5000 });
    const t0 = Date.now();
    const pollP = fetch(`${baseUrl}/ogamex/v1/poll`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ since_ts: 0 }),
    });
    const msg: DownstreamMsg = { type: "ping", ts: 999 };
    setTimeout(() => server.queueDownstream(msg), 20);
    const res = await pollP;
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: DownstreamMsg[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual(msg);
    expect(elapsed).toBeLessThan(500);
  });
});
