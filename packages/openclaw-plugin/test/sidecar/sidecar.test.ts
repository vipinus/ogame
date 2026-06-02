import { describe, it, expect, vi, afterEach } from "vitest";
import WebSocket from "ws";
import { startSidecar, type SidecarHandle } from "../../src/sidecar/index.js";
import type { UpstreamMsg } from "@ogamex/shared";

const TOKEN = "test-token-sidecar";

let active: SidecarHandle[] = [];

afterEach(async () => {
  for (const h of active) {
    try { await h.stop(); } catch { /* ignore */ }
  }
  active = [];
});

function track(h: SidecarHandle): SidecarHandle { active.push(h); return h; }

function connectWs(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const t = setTimeout(() => {
      reject(new Error("connect timeout"));
      try { ws.terminate(); } catch { /* ignore */ }
    }, 500);
    ws.once("open", () => { clearTimeout(t); resolve(ws); });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(t);
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

describe("startSidecar", () => {
  // v0.0.549 — operator removed the live WsServer ("没用过 ws 就删了吧").
  // ws.port() is a stub returning 0; ws.on/ws.send are no-ops. All
  // upstream traffic now arrives via HttpServer long-poll. These tests
  // assert the HTTP path lifecycle; WS-port-dependent assertions have
  // been adapted accordingly.

  it("starts HTTP server and exposes a live port via the handle", async () => {
    const handle = track(await startSidecar({
      wsPort: 0,
      httpPort: 0,
      bridgeToken: TOKEN,
    }));
    expect(handle.http.port()).toBeGreaterThan(0);
    // WS is stubbed to 0; document the contract so a future re-enable is obvious.
    expect(handle.ws.port()).toBe(0);
  });

  it("without discordChannelId → reporter is null and no send is invoked", async () => {
    const sendDiscord = vi.fn<(channelId: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const handle = track(await startSidecar(
      { wsPort: 0, httpPort: 0, bridgeToken: TOKEN },
      { sendDiscord },
    ));
    expect(handle.reporter).toBeNull();
    expect(sendDiscord).not.toHaveBeenCalled();
  });

  it("with discordChannelId + injected sendDiscord → sends an 'OgameX online' emergency", async () => {
    const sendDiscord = vi.fn<(channelId: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const handle = track(await startSidecar(
      { wsPort: 0, httpPort: 0, bridgeToken: TOKEN, discordChannelId: "chan-xyz" },
      { sendDiscord },
    ));
    expect(handle.reporter).not.toBeNull();
    expect(sendDiscord).toHaveBeenCalledTimes(1);
    const [channelId, content] = sendDiscord.mock.calls[0]!;
    expect(channelId).toBe("chan-xyz");
    // v0.0.549 — banner content dropped the ws:// segment when WsServer
    // was stubbed; only the HTTP listener remains in the message.
    expect(content).toMatch(/OgameX online.*http:\/\/127\.0\.0\.1:\d+/);
  });

  it("cross-server relay: HTTP push fans into BOTH transport registries", async () => {
    // v0.0.549 — WS is stubbed but the wrapped registry still mirrors any
    // arrival into both http.on AND ws.on. POST /push, expect both
    // handlers to fire (no-op ws stub still resolves its on() registration).
    const handle = track(await startSidecar({
      wsPort: 0,
      httpPort: 0,
      bridgeToken: TOKEN,
    }));

    const httpGot = new Promise<Extract<UpstreamMsg, { type: "hello" }>>((resolve) => {
      handle.http.on("hello", (m) => resolve(m));
    });
    const wsGot = new Promise<Extract<UpstreamMsg, { type: "hello" }>>((resolve) => {
      handle.ws.on("hello", (m) => resolve(m));
    });

    const payload: Extract<UpstreamMsg, { type: "hello" }> = {
      type: "hello",
      strategy_version: 1,
      userscript_version: "0.0.1",
    };
    const res = await fetch(`http://127.0.0.1:${handle.http.port()}/ogamex/v1/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);

    const [hOnHttp, hOnWs] = await Promise.all([httpGot, wsGot]);
    expect(hOnHttp).toEqual(payload);
    expect(hOnWs).toEqual(payload);
  });

  it("stop() shuts down the HTTP server — new connect fails afterwards", async () => {
    const handle = await startSidecar({
      wsPort: 0,
      httpPort: 0,
      bridgeToken: TOKEN,
    });
    const httpPort = handle.http.port();
    expect(httpPort).toBeGreaterThan(0);

    await handle.stop();

    // After stop, HTTP port should be closed → fetch rejects with ECONNREFUSED.
    await expect(
      fetch(`http://127.0.0.1:${httpPort}/ogamex/v1/push`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow();
    // WS is stubbed in v0.0.549 — no port to test post-stop.
  });
});
