// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import type { BridgeClient } from "../../src/bridge/ws_client.js";
import type { HttpBridgeClient } from "../../src/bridge/http_client.js";
import { connectDualBridge } from "../../src/bridge/dual_client.js";

/**
 * Build a fake BridgeClient whose `connect` resolution we control.
 * Returns the fake + the controls for the deferred connect promise.
 */
function makeFakeWs(): {
  client: BridgeClient;
  resolveConnect: () => void;
  rejectConnect: (e: Error) => void;
  /** Whether connect() was called. */
  connectCalled: () => boolean;
  /** Whether stop() was called. */
  stopped: () => boolean;
  sends: unknown[];
} {
  let resolveFn: () => void = () => { /* set below */ };
  let rejectFn: (e: Error) => void = () => { /* set below */ };
  let called = false;
  let stopFlag = false;
  const sends: unknown[] = [];

  const fake = {
    connect: (_url: string, _token: string): Promise<void> => {
      called = true;
      return new Promise<void>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
    },
    send: (msg: unknown): void => { sends.push(msg); },
    on: (_type: string, _handler: (msg: unknown) => void): (() => void) => () => { /* no-op */ },
    stop: (): void => { stopFlag = true; },
    status: (): "open" | "stopped" => stopFlag ? "stopped" : "open",
  } as unknown as BridgeClient;

  return {
    client: fake,
    resolveConnect: () => resolveFn(),
    rejectConnect: (e: Error) => rejectFn(e),
    connectCalled: () => called,
    stopped: () => stopFlag,
    sends,
  };
}

function makeFakeHttp(resolve: boolean = true): {
  client: HttpBridgeClient;
  connectCalled: () => boolean;
  sends: unknown[];
  stopped: () => boolean;
} {
  let called = false;
  let stopFlag = false;
  const sends: unknown[] = [];
  const fake = {
    connect: (_url: string, _token: string): Promise<void> => {
      called = true;
      return resolve ? Promise.resolve() : Promise.reject(new Error("http boom"));
    },
    send: (msg: unknown): Promise<void> => { sends.push(msg); return Promise.resolve(); },
    on: (_type: string, _handler: (msg: unknown) => void): (() => void) => () => { /* no-op */ },
    stop: (): void => { stopFlag = true; },
    status: (): "open" | "stopped" => stopFlag ? "stopped" : "open",
  } as unknown as HttpBridgeClient;

  return {
    client: fake,
    connectCalled: () => called,
    sends,
    stopped: () => stopFlag,
  };
}

describe("connectDualBridge", () => {
  it("uses WS transport when WS connects successfully", async () => {
    const ws = makeFakeWs();
    const http = makeFakeHttp();
    const wsFactory = vi.fn(() => ws.client);
    const httpFactory = vi.fn(() => http.client);

    const connectP = connectDualBridge(
      "ws://127.0.0.1:18790",
      "http://127.0.0.1:18791",
      "tok",
      { wsClientFactory: wsFactory, httpClientFactory: httpFactory, wsConnectTimeoutMs: 1000 },
    );
    // Allow promise microtasks to schedule.
    ws.resolveConnect();
    const handle = await connectP;
    expect(handle.transport()).toBe("ws");
    expect(httpFactory).not.toHaveBeenCalled();
    expect(http.connectCalled()).toBe(false);
    // Send forwards to WS.
    await handle.send({ type: "pong", ts: 7 });
    expect(ws.sends).toEqual([{ type: "pong", ts: 7 }]);
    handle.stop();
  });

  it("falls back to HTTP when WS times out", async () => {
    const ws = makeFakeWs(); // never resolves
    const http = makeFakeHttp();
    const wsFactory = vi.fn(() => ws.client);
    const httpFactory = vi.fn(() => http.client);

    const handle = await connectDualBridge(
      "ws://127.0.0.1:18790",
      "http://127.0.0.1:18791",
      "tok",
      { wsClientFactory: wsFactory, httpClientFactory: httpFactory, wsConnectTimeoutMs: 30 },
    );
    expect(handle.transport()).toBe("http");
    expect(ws.stopped()).toBe(true);
    expect(http.connectCalled()).toBe(true);
    await handle.send({ type: "pong", ts: 1 });
    expect(http.sends).toEqual([{ type: "pong", ts: 1 }]);
    handle.stop();
  });

  it("falls back to HTTP when WS rejects synchronously", async () => {
    const ws = makeFakeWs();
    const http = makeFakeHttp();
    const wsFactory = vi.fn(() => ws.client);
    const httpFactory = vi.fn(() => http.client);

    const connectP = connectDualBridge(
      "ws://127.0.0.1:18790",
      "http://127.0.0.1:18791",
      "tok",
      { wsClientFactory: wsFactory, httpClientFactory: httpFactory, wsConnectTimeoutMs: 5000 },
    );
    ws.rejectConnect(new Error("ws blocked"));
    const handle = await connectP;
    expect(handle.transport()).toBe("http");
    expect(http.connectCalled()).toBe(true);
    handle.stop();
  });

  it("throws when both transports fail", async () => {
    const ws = makeFakeWs();
    const http = makeFakeHttp(false); // rejects
    const wsFactory = vi.fn(() => ws.client);
    const httpFactory = vi.fn(() => http.client);

    const connectP = connectDualBridge(
      "ws://127.0.0.1:18790",
      "http://127.0.0.1:18791",
      "tok",
      { wsClientFactory: wsFactory, httpClientFactory: httpFactory, wsConnectTimeoutMs: 20 },
    );
    await expect(connectP).rejects.toThrow(/both transports failed/i);
  });
});
