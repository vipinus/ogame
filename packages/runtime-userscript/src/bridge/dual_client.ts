import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";
import { BridgeClient } from "./ws_client.js";
import { HttpBridgeClient } from "./http_client.js";

/**
 * DualBridgeClient — races a WS connect against a timeout, falling back to
 * HTTP long-poll if WS doesn't open in time or rejects outright. This is
 * "fallback on initial connect failure" only: once a transport is chosen the
 * choice is fixed for the lifetime of the handle. Per-transport reconnect
 * logic stays inside each client.
 *
 * Motivation: Private Network Access preflight or corporate proxies can block
 * the ws:// upgrade entirely. The HTTP endpoints (M4.3) speak the same
 * envelope protocol and serve as a drop-in replacement.
 */

type DownstreamType = DownstreamMsg["type"];

export interface DualBridgeClientOptions {
  /** Inject for tests. Default constructs a real {@link BridgeClient}. */
  wsClientFactory?: () => BridgeClient;
  /** Inject for tests. Default constructs a real {@link HttpBridgeClient}. */
  httpClientFactory?: () => HttpBridgeClient;
  /** Max ms to wait for WS to open before giving up + trying HTTP. Default 5000. */
  wsConnectTimeoutMs?: number;
}

export interface DualBridgeHandle {
  /** Which transport is currently active. */
  transport(): "ws" | "http" | "none";
  /** Forwarded to the active client. */
  send(msg: UpstreamMsg): void | Promise<void>;
  /** Forwarded to the active client. */
  on<T extends DownstreamType>(
    type: T,
    handler: (msg: Extract<DownstreamMsg, { type: T }>) => void,
  ): () => void;
  stop(): void;
}

const DEFAULT_WS_CONNECT_TIMEOUT_MS = 5000;

export async function connectDualBridge(
  wsUrl: string,
  httpBaseUrl: string,
  token: string,
  opts: DualBridgeClientOptions = {},
): Promise<DualBridgeHandle> {
  const wsConnectTimeoutMs = opts.wsConnectTimeoutMs ?? DEFAULT_WS_CONNECT_TIMEOUT_MS;
  const wsFactory = opts.wsClientFactory ?? ((): BridgeClient => new BridgeClient());
  const httpFactory = opts.httpClientFactory ?? ((): HttpBridgeClient => new HttpBridgeClient());
  const wsClient = wsFactory();

  // Race WS connect against a timeout.
  const wsResult = await raceWithTimeout(
    wsClient.connect(wsUrl, token),
    wsConnectTimeoutMs,
  );

  if (wsResult.kind === "ok") {
    return makeHandleWs(wsClient);
  }

  // WS failed or timed out — clean up and try HTTP.
  try { wsClient.stop(); } catch { /* ignore */ }

  // Lazily construct the HTTP client only when we actually need it. This keeps
  // the WS-success path from instantiating an unused poll loop.
  const httpClient = httpFactory();

  let httpError: Error | null = null;
  try {
    await httpClient.connect(httpBaseUrl, token);
  } catch (e) {
    httpError = e instanceof Error ? e : new Error(String(e));
  }

  if (httpError !== null) {
    const wsErr = wsResult.kind === "timeout" ? "ws timeout" : `ws ${wsResult.error.message}`;
    throw new Error(`both transports failed: ${wsErr}; http ${httpError.message}`);
  }

  return makeHandleHttp(httpClient);
}

function makeHandleWs(wsClient: BridgeClient): DualBridgeHandle {
  let stopped = false;
  return {
    transport(): "ws" | "http" | "none" {
      return stopped ? "none" : "ws";
    },
    send(msg: UpstreamMsg): void | Promise<void> {
      wsClient.send(msg);
      return undefined;
    },
    on<T extends DownstreamType>(
      type: T,
      handler: (msg: Extract<DownstreamMsg, { type: T }>) => void,
    ): () => void {
      return wsClient.on(type, handler);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      try { wsClient.stop(); } catch { /* ignore */ }
    },
  };
}

function makeHandleHttp(httpClient: HttpBridgeClient): DualBridgeHandle {
  let stopped = false;
  return {
    transport(): "ws" | "http" | "none" {
      return stopped ? "none" : "http";
    },
    send(msg: UpstreamMsg): void | Promise<void> {
      return httpClient.send(msg);
    },
    on<T extends DownstreamType>(
      type: T,
      handler: (msg: Extract<DownstreamMsg, { type: T }>) => void,
    ): () => void {
      return httpClient.on(type, handler);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      try { httpClient.stop(); } catch { /* ignore */ }
    },
  };
}

type RaceResult =
  | { kind: "ok" }
  | { kind: "error"; error: Error }
  | { kind: "timeout" };

function raceWithTimeout(p: Promise<void>, timeoutMs: number): Promise<RaceResult> {
  return new Promise<RaceResult>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
    p.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ kind: "ok" });
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ kind: "error", error: e instanceof Error ? e : new Error(String(e)) });
      },
    );
  });
}
