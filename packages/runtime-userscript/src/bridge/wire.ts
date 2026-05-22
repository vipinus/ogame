import type { BootHandle } from "../boot.js";
import { BridgeClient } from "./ws_client.js";
import { HttpBridgeClient } from "./http_client.js";

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
  /** Default 60000 ms (1 minute) — matches the bridge auto-optimizer tick
   *  cadence; pushing more frequently buys nothing the optimizer can use. */
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

// Reduced 20→5s after operator feedback "延时太高了" — most goal→dispatch
// latency comes from waiting for the next state.snapshot push. Faster push
// = faster reactive dispatch. Trade: 4× more /v1/push traffic to sidecar.
const DEFAULT_PUSH_INTERVAL_MS = 5_000;
const DEFAULT_JITTER_MS = 2_000;
const DEFAULT_USERSCRIPT_VERSION = "0.0.1";
const DEFAULT_STRATEGY_VERSION = 0;

export async function wireBridge(
  boot: BootHandle,
  opts: WireBridgeOptions,
): Promise<WireBridgeHandle> {
  // Pick transport from URL scheme. http(s):// → HttpBridgeClient (long-poll);
  // ws(s):// → WebSocket BridgeClient. Operators on networks where the cloud
  // router can't proxy WebSocket can flip OGAMEX_BRIDGE_URL to https:// for
  // the same protocol envelopes via /v1/push + /v1/poll instead.
  const url = opts.bridgeUrl;
  const isHttp = /^https?:\/\//.test(url);
  const client = opts.client
    ?? (isHttp
      ? (new HttpBridgeClient() as unknown as BridgeClient)
      : new BridgeClient({ reconnectOnLoss: true }));
  const base = opts.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
  const jit = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const userscriptVersion = opts.userscriptVersion ?? DEFAULT_USERSCRIPT_VERSION;
  const strategyVersion = opts.strategyVersion ?? DEFAULT_STRATEGY_VERSION;

  // For HTTP transport, strip any trailing /push or /poll; HttpBridgeClient
  // appends /ogamex/v1/push and /ogamex/v1/poll automatically.
  const connectUrl = isHttp ? url.replace(/\/(push|poll|ws)\/?$/, "") : url;
  await client.connect(connectUrl, opts.bridgeToken);

  // Hello — fired immediately after the open event resolves.
  client.send({
    type: "hello",
    strategy_version: strategyVersion,
    userscript_version: userscriptVersion,
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Push the first snapshot at +2s after boot so the operator gets fast
  // first feedback (no 60s wait). Safe to do this now that the executor
  // uses SPA ajaxNavigation (doesn't trigger a full reload + boot loop)
  // and the goal_runner serializes execution. The 2s delay gives boot
  // time to populate planets/resources/production via the retry harvest.
  const pushOnce = (): void => {
    // Before each push, refresh cross-planet ship counts via ogame's empire
    // endpoint — daemon decisions (e.g. "ships sufficient for expedition?")
    // depend on accurate ship state. Owner observation: "准备起飞以前没有
    // 通过 api 拿新数据". Empire endpoint is single GET, doesn't touch
    // session-cp cookie. fire-and-forget; if it lands AFTER this push,
    // the next push has the data. Daemon's expeditionTick runs every 10s
    // and bridge's pushInterval is 5s, so within 2 pushes the data is fresh.
    const pollEmpire = (window as Window & { __ogamexPollEmpire?: () => Promise<void> }).__ogamexPollEmpire;
    if (typeof pollEmpire === "function") {
      void pollEmpire().catch(() => { /* ignore */ });
    }
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
  };
  // Expose a globally callable pushNow() so the click handler in boot.ts can
  // trigger immediate state.snapshot delivery to sidecar — closes the 5s
  // window where merger had stale user_busy_until and kept dispatching.
  // BootHandle has no win field; use globalThis.window directly.
  if (typeof window !== "undefined") {
    (window as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow = pushOnce;
  }
  const schedule = (): void => {
    if (stopped) return;
    const delay = base + (Math.random() * 2 - 1) * jit;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      pushOnce();
      schedule();
    }, Math.max(0, delay));
  };
  // First push at +2s, then every `base` ms.
  setTimeout(() => { if (!stopped) pushOnce(); }, 2000);
  schedule();

  // Resource-jump push trigger removed — combined with rapid retries it
  // burned through dispatch budget without helping when executor itself
  // can't navigate. Re-enable once SPA nav has a working primitive.

  const offEmergency = boot.bus.on("emergency.attack", (payload: unknown) => {
    const p = (payload ?? {}) as {
      event_id?: string;
      from?: unknown;
      to?: unknown;
      arrives_at?: number;
    };
    const fromStr = Array.isArray(p.from) ? `[${p.from.join(":")}]` : "?";
    const toStr = Array.isArray(p.to) ? `[${p.to.join(":")}]` : "?";
    const eta = typeof p.arrives_at === "number"
      ? new Date(p.arrives_at * 1000).toISOString().slice(11, 19)
      : "?";
    const md = `🚨 **ATTACK** ${fromStr} → ${toStr} arrival=${eta} (event=${p.event_id ?? "?"})`;
    try {
      const ret = client.send({
        type: "event.emergency",
        subtype: "attack",
        data: payload,
        markdown_report: md,
      });
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        (ret as Promise<unknown>)
          .catch((e: unknown) => console.warn(`[wireBridge] attack push FAILED`, e));
      }
    } catch (e) {
      console.warn("[wireBridge] attack forward threw", e);
    }
  });
  const offSpy = boot.bus.on("emergency.spy", (payload: unknown) => {
    const p = (payload ?? {}) as {
      event_id?: string;
      from?: unknown;
      to?: unknown;
      arrives_at?: number;
    };
    const fromStr = Array.isArray(p.from) ? `[${p.from.join(":")}]` : "?";
    const toStr = Array.isArray(p.to) ? `[${p.to.join(":")}]` : "?";
    const eta = typeof p.arrives_at === "number"
      ? new Date(p.arrives_at * 1000).toISOString().slice(11, 19)
      : "?";
    const md = `🛰️ **SPY PROBE** ${fromStr} → ${toStr} arrival=${eta} (event=${p.event_id ?? "?"})`;
    try {
      const ret = client.send({
        type: "event.emergency",
        subtype: "spy",
        data: payload,
        markdown_report: md,
      });
      // client.send returns Promise; surface failures so operator notices
      // (success path is silent — Discord arrival is the success signal).
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        (ret as Promise<unknown>)
          .catch((e: unknown) => console.warn(`[wireBridge] spy push FAILED`, e));
      }
    } catch (e) {
      console.warn("[wireBridge] spy forward threw", e);
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
      offSpy();
    },
  };
}
