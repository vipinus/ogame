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
  it("starts both WS + HTTP servers and exposes live ports via the handle", async () => {
    const handle = track(await startSidecar({
      wsPort: 0,
      httpPort: 0,
      bridgeToken: TOKEN,
    }));
    expect(handle.ws.port()).toBeGreaterThan(0);
    expect(handle.http.port()).toBeGreaterThan(0);
    expect(handle.ws.port()).not.toBe(handle.http.port());
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
    expect(content).toMatch(/OgameX online.*ws:\/\/127\.0\.0\.1:\d+.*http:\/\/127\.0\.0\.1:\d+/);
  });

  it("cross-server relay: WS hello also fires HTTP-side hello handler", async () => {
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

    const client = await connectWs(handle.ws.port(), TOKEN);
    const payload: Extract<UpstreamMsg, { type: "hello" }> = {
      type: "hello",
      strategy_version: 1,
      userscript_version: "0.0.1",
    };
    client.send(JSON.stringify(payload));

    const [hOnHttp, hOnWs] = await Promise.all([httpGot, wsGot]);
    expect(hOnHttp).toEqual(payload);
    expect(hOnWs).toEqual(payload);
    client.close();
  });

  it("stop() shuts down both servers: new WS connect fails afterwards", async () => {
    const handle = await startSidecar({
      wsPort: 0,
      httpPort: 0,
      bridgeToken: TOKEN,
    });
    const wsPort = handle.ws.port();
    const httpPort = handle.http.port();
    expect(wsPort).toBeGreaterThan(0);
    expect(httpPort).toBeGreaterThan(0);

    await handle.stop();

    // After stop, attempting to connect should fail (ECONNREFUSED) or time out.
    await expect(connectWs(wsPort, TOKEN)).rejects.toThrow();
    // HTTP port should also be closed.
    await expect(
      fetch(`http://127.0.0.1:${httpPort}/ogamex/v1/push`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow();
  });
});
