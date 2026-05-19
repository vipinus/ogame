/**
 * M4.5 — Sidecar boot.
 *
 * Wires together the M4.2 WsServer, M4.3 HttpServer, and M4.4 Reporter into
 * a single lifecycle handle. The OpenClaw plugin entry (`src/index.ts`)
 * imports `startSidecar` and fires it on module load when configured via env.
 *
 * Both transports carry the same protocol envelope (UpstreamMsg /
 * DownstreamMsg). A message arriving on either transport must reach
 * subscribers that registered against the *other* transport, because the
 * userscript may bridge over WS *or* HTTP long-poll depending on the host
 * environment. We achieve this by overriding the returned handle's `on`
 * methods so that each registration is mirrored into a shared per-type
 * registry; both servers' raw `on` is wired once to broadcast into that
 * registry. Consumers get transport-agnostic delivery.
 */
import { spawn } from "node:child_process";
import { WsServer } from "./ws_server.js";
import { HttpServer } from "./http_server.js";
import { Reporter } from "./reporter.js";
import type { UpstreamMsg } from "@ogamex/shared";

export interface SidecarConfig {
  wsPort: number;
  httpPort: number;
  bridgeToken: string;
  discordChannelId?: string;
}

export interface SidecarHandle {
  ws: WsServer;
  http: HttpServer;
  reporter: Reporter | null;
  stop(): Promise<void>;
}

export interface StartSidecarOptions {
  /** Override the Discord transport. Tests inject a vi.fn; prod uses defaultDiscordSend. */
  sendDiscord?: (channelId: string, content: string) => Promise<void>;
}

// All UpstreamMsg variants we relay between transports. Keep in sync with
// `UpstreamMsg["type"]` in @ogamex/shared. We can't enumerate a TS union at
// runtime, so this list is the source of truth for the relay.
const UPSTREAM_TYPES: ReadonlyArray<UpstreamMsg["type"]> = [
  "hello",
  "state.snapshot",
  "event.emergency",
  "event.daily_failure",
  "event.directive_completed",
  "event.extractor_failure",
  "audit.condition_unmet",
  "pong",
];

/**
 * Spin up all sidecar servers + (optionally) the Reporter and return a handle.
 * Resolves only after both servers are listening.
 */
export async function startSidecar(
  config: SidecarConfig,
  opts?: StartSidecarOptions,
): Promise<SidecarHandle> {
  const ws = new WsServer({ port: config.wsPort, token: config.bridgeToken });
  const http = new HttpServer({ port: config.httpPort, token: config.bridgeToken });

  // Start both in parallel — they bind to independent OS-assigned ports.
  await Promise.all([ws.start(), http.start()]);

  // --- Cross-transport relay ------------------------------------------------
  // Shared registry of consumer-supplied handlers per UpstreamMsg type. The
  // raw WsServer / HttpServer each get exactly ONE relay listener per type
  // that fans out into this registry. Consumers register via the wrapped
  // handle.ws.on / handle.http.on (below) which adds to the shared set, so
  // it doesn't matter which transport delivered the message.
  type AnyHandler = (m: UpstreamMsg) => void;
  const registry = new Map<UpstreamMsg["type"], Set<AnyHandler>>();
  for (const t of UPSTREAM_TYPES) {
    const set = new Set<AnyHandler>();
    registry.set(t, set);
    const fan = (m: UpstreamMsg): void => {
      for (const h of set) {
        try { h(m); } catch { /* handler errors must not crash the relay */ }
      }
    };
    // Each server's typed `on` requires the literal type parameter — but
    // because we're iterating, we erase the type and cast at the boundary.
    // The handler itself is variant-safe (set only stores callbacks that
    // were registered against the same `t`).
    (ws as unknown as { on: (type: string, h: AnyHandler) => void }).on(t, fan);
    (http as unknown as { on: (type: string, h: AnyHandler) => void }).on(t, fan);
  }

  // Wrap ws.on / http.on so consumer registrations land in the shared
  // registry. We MUTATE the instances (not the prototype) so other instances
  // are unaffected. Original methods are intentionally hidden — direct
  // access would bypass the relay, which is exactly what we want to prevent.
  const wrapOn = <K extends UpstreamMsg["type"]>(
    type: K,
    handler: (msg: Extract<UpstreamMsg, { type: K }>) => void,
  ): void => {
    const set = registry.get(type);
    if (!set) {
      // Should never happen if UPSTREAM_TYPES is exhaustive, but guard anyway.
      throw new Error(`startSidecar: unknown UpstreamMsg type "${type}"`);
    }
    set.add(handler as unknown as AnyHandler);
  };
  ws.on = wrapOn as typeof ws.on;
  http.on = wrapOn as typeof http.on;

  let reporter: Reporter | null = null;
  if (config.discordChannelId !== undefined && config.discordChannelId !== "") {
    const send = opts?.sendDiscord ?? defaultDiscordSend;
    reporter = new Reporter({ channelId: config.discordChannelId, send });
    const wsPort = ws.port();
    const httpPort = http.port();
    const banner =
      `OgameX online — sidecar listening on ws://127.0.0.1:${wsPort}` +
      ` + http://127.0.0.1:${httpPort}`;
    // Failure to send the banner must not abort sidecar boot — the bridge
    // itself is healthy; the operator just won't see the online ping.
    try {
      await reporter.pushEmergency(banner);
    } catch (err) {
      console.error("[ogamex/sidecar] failed to send online banner", err);
    }
  } else {
    console.info("[ogamex/sidecar] OgameX online (no discord channel configured)");
  }

  const stop = async (): Promise<void> => {
    await Promise.all([ws.stop(), http.stop()]);
  };

  return { ws, http, reporter, stop };
}

/**
 * Production default — shells out to the OpenClaw CLI to deliver to Discord.
 * Tests do NOT exercise this path (they inject a vi.fn). Uses `spawn` with an
 * arg array — NOT `exec` — so message contents cannot inject shell commands.
 */
export function defaultDiscordSend(channelId: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "openclaw",
      ["message", "send", "--channel", "discord", "--target", channelId, "--message", content],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (err) => reject(err));
    child.once("exit", (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(
        `openclaw message send exited with code ${code ?? "null"}` +
        (stderr.length > 0 ? `: ${stderr.trim()}` : ""),
      ));
    });
  });
}
