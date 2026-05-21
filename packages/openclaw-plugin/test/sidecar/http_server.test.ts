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

  it("GET /ogamex/v1/health without auth → 200 with default heartbeat JSON", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/ogamex/v1/health`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: number };
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("number");
  });

  it("GET /ogamex/v1/health with healthReporter → returns its serialized output", async () => {
    const server = new HttpServer({
      port: 0,
      token: TOKEN,
      healthReporter: async () => ({ ok: false, ts: 123, custom: "hello" }),
    });
    await server.start();
    track(server);
    const port = (server as unknown as { port: () => number }).port();
    const res = await fetch(`http://127.0.0.1:${port}/ogamex/v1/health`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: number; custom: string };
    expect(body).toEqual({ ok: false, ts: 123, custom: "hello" });
  });

  describe("operator goals endpoints (no-auth)", () => {
    async function startWithGoalHooks(hooks: {
      listGoals?: () => Array<unknown>;
      cancelGoal?: (id: string) => { ok: boolean; reason?: string };
      pauseGoal?: (id: string) => { ok: boolean; reason?: string };
      resumeGoal?: (id: string) => { ok: boolean; reason?: string };
    }): Promise<string> {
      const server = new HttpServer({ port: 0, token: TOKEN, ...hooks });
      await server.start();
      track(server);
      const port = (server as unknown as { port: () => number }).port();
      return `http://127.0.0.1:${port}`;
    }

    it("GET /v1/goals returns goals array from listGoals callback", async () => {
      const goals = [{ id: "g1", type: "research", status: "active", priority: 5 }];
      const baseUrl = await startWithGoalHooks({ listGoals: () => goals });
      const res = await fetch(`${baseUrl}/ogamex/v1/goals`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { goals: typeof goals };
      expect(body.goals).toEqual(goals);
    });

    it("GET /v1/goals returns empty list when listGoals not wired", async () => {
      const baseUrl = await startWithGoalHooks({});
      const res = await fetch(`${baseUrl}/ogamex/v1/goals`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { goals: unknown[] };
      expect(body.goals).toEqual([]);
    });

    it("POST /v1/goals/<id>/cancel calls cancelGoal and returns ok", async () => {
      const calls: string[] = [];
      const baseUrl = await startWithGoalHooks({
        cancelGoal: (id) => { calls.push(id); return { ok: true }; },
      });
      const res = await fetch(`${baseUrl}/ogamex/v1/goals/abc-123/cancel`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(calls).toEqual(["abc-123"]);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("POST /v1/goals/<id>/cancel returns 404 when handler reports goal not found", async () => {
      const baseUrl = await startWithGoalHooks({
        cancelGoal: () => ({ ok: false, reason: "goal not found" }),
      });
      const res = await fetch(`${baseUrl}/ogamex/v1/goals/missing/cancel`, { method: "POST" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; reason: string };
      expect(body).toEqual({ ok: false, reason: "goal not found" });
    });

    it("POST /v1/goals/<id>/cancel returns 503 when cancelGoal not wired", async () => {
      const baseUrl = await startWithGoalHooks({});
      const res = await fetch(`${baseUrl}/ogamex/v1/goals/x/cancel`, { method: "POST" });
      expect(res.status).toBe(503);
      await res.text();
    });

    it("POST /v1/goals/<id>/pause and /resume route to the correct handler", async () => {
      const calls: Array<{ action: string; id: string }> = [];
      const baseUrl = await startWithGoalHooks({
        pauseGoal: (id) => { calls.push({ action: "pause", id }); return { ok: true }; },
        resumeGoal: (id) => { calls.push({ action: "resume", id }); return { ok: true }; },
      });
      let res = await fetch(`${baseUrl}/ogamex/v1/goals/g7/pause`, { method: "POST" });
      expect(res.status).toBe(200);
      await res.text();
      res = await fetch(`${baseUrl}/ogamex/v1/goals/g7/resume`, { method: "POST" });
      expect(res.status).toBe(200);
      await res.text();
      expect(calls).toEqual([{ action: "pause", id: "g7" }, { action: "resume", id: "g7" }]);
    });

    it("URL-decodes goal id before passing to handler", async () => {
      const got: string[] = [];
      const baseUrl = await startWithGoalHooks({
        cancelGoal: (id) => { got.push(id); return { ok: true }; },
      });
      const res = await fetch(`${baseUrl}/ogamex/v1/goals/has%20space/cancel`, { method: "POST" });
      expect(res.status).toBe(200);
      await res.text();
      expect(got).toEqual(["has space"]);
    });
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
