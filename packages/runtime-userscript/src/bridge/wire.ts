import type { BootHandle } from "../boot.js";
import { HttpBridgeClient } from "./http_client.js";

/**
 * M4.7 — wire HttpBridgeClient into the userscript boot lifecycle.
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
  /** Optional: inject a custom HttpBridgeClient (tests). Otherwise constructs a default one. */
  client?: HttpBridgeClient;
}

export interface WireBridgeHandle {
  /** Reference to the HttpBridgeClient (constructed or injected). */
  client: HttpBridgeClient;
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
  // v0.0.549 — operator 2026-05-31 "没用过 ws 就删了吧". HTTP long-poll only.
  // WS branch (HttpBridgeClient) retired: 100s CF idle timeout, browser inactive-
  // tab throttle, and zombie sockets all caused phantom reconnects without
  // adding any latency benefit for this game-automation workload (planner
  // ticks every 5s anyway). HttpBridgeClient covers all transport now:
  // /ogamex/v1/push for upstream, /ogamex/v1/poll for downstream long-poll.
  const url = opts.bridgeUrl;
  const isHttp = /^https?:\/\//.test(url);
  void isHttp; // retained for ad-hoc diagnostics; client is always HTTP now
  const client = opts.client ?? new HttpBridgeClient();
  const base = opts.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
  const jit = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const userscriptVersion = opts.userscriptVersion ?? DEFAULT_USERSCRIPT_VERSION;
  const strategyVersion = opts.strategyVersion ?? DEFAULT_STRATEGY_VERSION;

  // For HTTP transport, strip any trailing /push or /poll; HttpBridgeClient
  // appends /ogamex/v1/push and /ogamex/v1/poll automatically. Also coerce
  // wss:// / ws:// → https:// / http:// (operators with stale localStorage
  // URLs from the WS era are now silently upgraded to HTTP).
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  const connectUrl = httpUrl.replace(/\/(push|poll|ws)\/?$/, "");
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

  // v0.0.472 — expedition debris collection. Sidecar emits this when an
  // expedition fleet returns. Userscript fetches galaxy:system content, checks
  // pos 16 for debris field, dispatches explorer fleet (mission=8, destType=2)
  // to collect. Operator 2026-05-30 spec: explorer = "探路者", any positive
  // debris triggers; explorer count = ceil((m+c+d) / explorer_cargo_cap).
  const offDebrisCheck = client.on("expedition.debris_check", (msg) => {
    const m = msg as { galaxy?: number; system?: number; origin_planet_id?: string; reason?: string };
    const g = m.galaxy ?? 0, s = m.system ?? 0, origin = m.origin_planet_id ?? "";
    if (!g || !s || !origin) return;
    console.info(`[debris] check G:S=${g}:${s} origin=${origin} reason=${m.reason ?? ""}`);
    void (async (): Promise<void> => {
      try {
        // Fetch galaxy content directly (ogame ajax).
        const r = await fetch(`/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: new URLSearchParams({ galaxy: String(g), system: String(s) }).toString(),
        });
        if (!r.ok) { console.warn(`[debris] galaxy fetch HTTP ${r.status}`); return; }
        const json = await r.json() as Record<string, unknown>;
        // Find position 16's debris field. ogame v12 galaxy response shape:
        //   { galaxy: [{position:16, debris:{metal:N, crystal:N, deuterium?:N}, ...}, ...], ... }
        // OR { galaxy: { rows: [...] } } — try multiple paths.
        const rows: Array<Record<string, unknown>> = (() => {
          const galaxyField = json["galaxy"];
          if (Array.isArray(galaxyField)) return galaxyField as Array<Record<string, unknown>>;
          if (galaxyField && typeof galaxyField === "object") {
            const inner = (galaxyField as { rows?: unknown }).rows;
            if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
          }
          return [];
        })();
        const pos16 = rows.find((row) => Number(row["position"]) === 16);
        const debris = (pos16?.["debris"] ?? pos16?.["debrisField"]) as { metal?: number; crystal?: number; deuterium?: number } | undefined;
        const dm = Number(debris?.metal ?? 0);
        const dc = Number(debris?.crystal ?? 0);
        const dd = Number(debris?.deuterium ?? 0);
        const totalDebris = dm + dc + dd;
        if (totalDebris <= 0) {
          console.info(`[debris] G:S:16=${g}:${s}:16 — no debris field, skip`);
          return;
        }
        console.info(`[debris] G:S:16=${g}:${s}:16 has m=${dm} c=${dc} d=${dd} (total ${totalDebris})`);
        // Compute explorers needed (cap = 16000 standard for explorer).
        const win = window as Window & { __ogamexStore?: { state?: { server?: { ship_cargo_capacity?: { explorer?: number } } } } };
        const explorerCap = win.__ogamexStore?.state?.server?.ship_cargo_capacity?.explorer ?? 16000;
        const explorersNeeded = Math.max(1, Math.ceil(totalDebris / explorerCap));
        // Dispatch via fleet_api.sendFleet — mission=8 (collect debris), destType=2 (debris).
        try {
          const wTokMgr = (window as Window & { __ogamexTokenManager?: unknown }).__ogamexTokenManager;
          if (!wTokMgr) { console.warn("[debris] no tokenManager available"); return; }
          const { sendFleet } = await import("../api/fleet_api.js");
          const result = await sendFleet({
            ships: { explorer: explorersNeeded } as unknown as import("@ogamex/shared").ShipCount,
            cargo: { m: 0, c: 0, d: 0 },
            coords: [g, s, 16],
            destType: 2,
            mission: 8 as import("@ogamex/shared").MissionCode,
            speed: 10,
            sourcePlanetId: origin,
          }, { fetch: window.fetch.bind(window), token: wTokMgr as Parameters<typeof sendFleet>[1]["token"] });
          console.info(`[debris] explorer dispatched fleetId=${result.fleetId} count=${explorersNeeded}`);
        } catch (e) {
          console.error("[debris] sendFleet failed:", e);
        }
      } catch (e) {
        console.error("[debris] handler threw:", e);
      }
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
