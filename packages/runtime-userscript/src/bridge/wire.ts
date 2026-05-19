import type { BootHandle } from "../boot.js";
import { BridgeClient } from "./ws_client.js";

/**
 * M4.7 — wire BridgeClient into the userscript boot lifecycle.
 *
 * Extracted from main.ts so it's testable. main.ts wraps this with
 * Tampermonkey GM_getValue config; tests drive it directly.
 *
 * Periodic snapshot push uses a per-tick `setTimeout` chain rather than
 * `setInterval`, so fresh ±jitter is applied to each iteration.
 */

export interface WireBridgeOptions {
  bridgeUrl: string;
  bridgeToken: string;
  /** Default 10000 ms. */
  pushIntervalMs?: number;
  /** ± jitter applied to each push interval (uniform). Default 2000 ms. */
  jitterMs?: number;
  /** Userscript semantic version (passed in hello + state.snapshot envelopes). */
  userscriptVersion?: string;
  /** Strategy version mirror (placeholder until M5). Default 0. */
  strategyVersion?: number;
  /** Optional: inject a custom BridgeClient (tests). Otherwise constructs a default one. */
  client?: BridgeClient;
}

export interface WireBridgeHandle {
  /** Reference to the BridgeClient (constructed or injected). */
  client: BridgeClient;
  /** Stop timers + bus subscriptions; does NOT call client.stop() — caller owns the client lifecycle. */
  stop(): void;
}

const DEFAULT_PUSH_INTERVAL_MS = 10_000;
const DEFAULT_JITTER_MS = 2_000;
const DEFAULT_USERSCRIPT_VERSION = "0.0.1";
const DEFAULT_STRATEGY_VERSION = 0;

export async function wireBridge(
  boot: BootHandle,
  opts: WireBridgeOptions,
): Promise<WireBridgeHandle> {
  const client = opts.client ?? new BridgeClient({ reconnectOnLoss: true });
  const base = opts.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
  const jit = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const userscriptVersion = opts.userscriptVersion ?? DEFAULT_USERSCRIPT_VERSION;
  const strategyVersion = opts.strategyVersion ?? DEFAULT_STRATEGY_VERSION;

  await client.connect(opts.bridgeUrl, opts.bridgeToken);

  // Hello — fired immediately after the open event resolves.
  client.send({
    type: "hello",
    strategy_version: strategyVersion,
    userscript_version: userscriptVersion,
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (stopped) return;
    // Uniform ±jit jitter applied per tick.
    const delay = base + (Math.random() * 2 - 1) * jit;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      try {
        client.send({
          type: "state.snapshot",
          ts: Date.now(),
          snapshot: boot.store.state,
          strategy_version: strategyVersion,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[wireBridge] push failed", e);
      }
      schedule();
    }, Math.max(0, delay));
  };
  schedule();

  const offEmergency = boot.bus.on("emergency.attack", (payload: unknown) => {
    const p = (payload ?? {}) as {
      event_id?: string;
      from?: unknown;
      to?: unknown;
      arrives_at?: number;
    };
    const md = `🚨 **Attack detected** event=${p.event_id ?? "?"} arrives=${p.arrives_at ?? "?"}`;
    try {
      client.send({
        type: "event.emergency",
        subtype: "attack",
        data: payload,
        markdown_report: md,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[wireBridge] emergency forward failed", e);
    }
  });

  return {
    client,
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      offEmergency();
    },
  };
}
