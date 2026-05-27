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
    // Empire fetch DECOUPLED from push (operator: "ogame 的改成事件触发").
    // Calling pollEmpire here meant every 5s push triggered an empire fetch
    // → 12 req/min of /empire even when nothing changed. Now empire is
    // event-driven from ApiExec (pre-dispatch + post-success) + a single
    // boot seed. Pushes carry whatever state currently is in the store.
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

  // data.refresh — sidecar asks userscript to actively re-scrape ogame for
  // fleets/resources, then push fresh state. Used by event-driven decision
  // flow (Plan A): daemon expedition trigger → sidecar enqueues data.refresh
  // → userscript runs harvests → fresh state.snapshot pushed → daemon reads
  // fresh state → decides.
  const offRefresh = client.on("data.refresh", (msg) => {
    const m = msg as { scope?: string; reason?: string };
    const scope = m.scope ?? "all";
    console.info(`[wireBridge] data.refresh recv scope=${scope} reason=${m.reason ?? ""}`);
    const w = window as Window & {
      __ogamexHarvestMovement?: () => Promise<void>;
      __ogamexPollEmpire?: () => Promise<void>;
      __ogamexHarvestFdSlots?: () => Promise<void>;
      __ogamexPushNow?: () => void;
    };
    // Run harvests in parallel; their setPartial calls fan-out via store
    // and trigger state.updated bus events. After harvests complete, force
    // an immediate state push so sidecar/daemon see fresh data ASAP.
    // Operator 2026-05-25 "远征有空槽没有自动起飞": daemon's free-slot
    // calc needs authoritative max_expedition_slots, which only the
    // /fleetdispatch HTML reliably exposes (includes lifeform bonus).
    // Pull it whenever sidecar requests a refresh.
    void (async (): Promise<void> => {
      const jobs: Promise<unknown>[] = [];
      if (scope === "all" || scope === "fleets") {
        if (typeof w.__ogamexHarvestMovement === "function") jobs.push(w.__ogamexHarvestMovement());
        if (typeof w.__ogamexPollEmpire === "function") jobs.push(w.__ogamexPollEmpire());
        if (typeof w.__ogamexHarvestFdSlots === "function") jobs.push(w.__ogamexHarvestFdSlots());
      }
      if (scope === "all" || scope === "resources") {
        if (typeof w.__ogamexPollEmpire === "function" && scope !== "fleets") jobs.push(w.__ogamexPollEmpire());
      }
      try { await Promise.allSettled(jobs); } catch { /* */ }
      if (typeof w.__ogamexPushNow === "function") w.__ogamexPushNow();
    })();
  });

  // save.recall_now — sidecar's SaveCoordinator decided this fleet's recall
  // margin elapsed and instructs the userscript to POST the recall. Cookies +
  // token live in the page world, so the actual ogame API call has to come
  // from here (sidecar can't cookie-auth into ogame). After the recall POST
  // succeeds, report back to /v1/save/recall-confirmed so the backend can
  // close the record.
  const offRecallNow = client.on("save.recall_now", (msg) => {
    const m = msg as { planet_id?: string; fleet_id?: number; reason?: string };
    // Operator 2026-05-27: frontend FSM 自己也会 fire recall (instant on hostile
    // clear). 如果 FSM 已经 RECALLING/RETURNED, backend 的这次 directive 重复,
    // ogame 会 reject success=false. 短路掉避免 console 噪音 + 假告警.
    try {
      const snapFn = (window as Window & { __ogamexEmergencySnapshot?: () => { state?: string; fleetId?: number | null } }).__ogamexEmergencySnapshot;
      const snap = snapFn ? snapFn() : null;
      if (snap && (snap.state === "RECALLING" || snap.state === "RETURNED") && snap.fleetId === m.fleet_id) {
        console.info(`[wireBridge] save.recall_now planet=${m.planet_id} fleet=${m.fleet_id} — FSM already in ${snap.state}, frontend handled it; skip backend duplicate.`);
        // Notify backend so it closes its own record (avoid re-fire).
        try {
          void fetch("https://ogame.anyfq.com/ogamex/v1/save/recall-confirmed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fleet_id: m.fleet_id, note: "frontend FSM already recalled" }),
          });
        } catch (_) { /* */ }
        return;
      }
    } catch (_) { /* fall through */ }
    let fid = m.fleet_id;
    // Operator 2026-05-26: backend sometimes sends fleet_id=0 (it cached the
    // placeholder before frontend patchFleetId ran). Fall back to local fsm
    // snapshot's real fleetId if available.
    if (fid === 0 || fid === undefined) {
      const snapFn = (window as Window & { __ogamexEmergencySnapshot?: () => { fleetId?: number | null } }).__ogamexEmergencySnapshot;
      const snap = snapFn ? snapFn() : null;
      if (snap?.fleetId && snap.fleetId > 0) {
        console.warn(`[wireBridge] save.recall_now: backend sent fleet=0, falling back to fsm.fleetId=${snap.fleetId}`);
        fid = snap.fleetId;
      } else {
        console.warn(`[wireBridge] save.recall_now: backend fleet=0 and fsm has no real id either — skip recall`);
        return;
      }
    }
    if (typeof fid !== "number") {
      console.warn(`[wireBridge] save.recall_now missing fleet_id`, m);
      return;
    }
    console.warn(`[wireBridge] 🪂 save.recall_now planet=${m.planet_id} fleet=${fid} reason=${m.reason ?? ""}`);
    const w = window as Window & {
      __ogamexRecallFleet?: (fleetId: number) => Promise<void>;
    };
    if (typeof w.__ogamexRecallFleet !== "function") {
      console.error(`[wireBridge] save.recall_now: __ogamexRecallFleet not exposed, cannot fire recall`);
      return;
    }
    const fidFinal = fid;
    void (async (): Promise<void> => {
      try {
        await w.__ogamexRecallFleet!(fidFinal);
        console.log(`[wireBridge] recall POST ok fleet=${fidFinal}, reporting back to backend`);
        try {
          await fetch("https://ogame.anyfq.com/ogamex/v1/save/recall-confirmed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fleet_id: fidFinal }),
          });
        } catch (e) {
          console.warn(`[wireBridge] recall-confirmed POST failed:`, e);
        }
      } catch (e) {
        // Operator 2026-05-27 evidence: recall POST returns
        // `{"success":false, "components":[], "newAjaxToken":"..."}` (no errors,
        // no message) when fleet has already landed (backend 5min margin too slow,
        // deploy mission to same-coord moon completes in <1min). Distinguish
        // "real failure" vs "fleet already landed" by checking fleets_outbound.
        const err = e instanceof Error ? e.message : String(e);
        try {
          const harvestFn = (window as Window & { __ogamexHarvestMovement?: () => Promise<void> }).__ogamexHarvestMovement;
          if (harvestFn) await harvestFn();
          const stateAccess = (window as Window & { __OGAMEX__?: { store?: { state?: { fleets_outbound?: Array<{ id?: string }> } } } }).__OGAMEX__;
          const outbound = stateAccess?.store?.state?.fleets_outbound ?? [];
          const fleetStillFlying = outbound.some(f => f.id === String(fidFinal));
          if (!fleetStillFlying) {
            console.warn(`[wireBridge] recall POST said success=false BUT fleet=${fidFinal} not in fleets_outbound — fleet already landed (backend timing). Notifying backend.`);
            try {
              await fetch("https://ogame.anyfq.com/ogamex/v1/save/recall-confirmed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fleet_id: fidFinal, note: "fleet already landed; treated as confirmed" }),
              });
            } catch (_) { /* */ }
            return;
          }
        } catch (_) { /* harvest check best-effort */ }
        console.error(`[wireBridge] recall POST FAILED fleet=${fidFinal} (still in outbound, real failure):`, err);
      }
    })();
  });

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
      offRefresh();
      offRecallNow();
    },
  };
}
