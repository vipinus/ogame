import type { BootHandle } from "../boot.js";
import { HttpBridgeClient } from "./http_client.js";
import { BridgeClient as WsBridgeClient } from "./ws_client.js";
import { setVisibleInterval } from "../util/visible_interval.js";

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
  /** Optional: inject a custom HTTP or WS client (tests). Otherwise constructs by URL scheme. */
  client?: HttpBridgeClient | WsBridgeClient;
}

export interface WireBridgeHandle {
  /** Reference to the active client (constructed or injected). May be either
   *  WS (BridgeClient) or HTTP (HttpBridgeClient) — both expose the same
   *  `send` / `on` / `stop` shape. */
  client: HttpBridgeClient | WsBridgeClient;
  /** Stop timers + bus subscriptions; does NOT call client.stop() — caller owns the client lifecycle. */
  stop(): void;
}

// Reduced 20→5s after operator feedback "延時太高了" — most goal→dispatch
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
  // v0.0.549 retired WS (HTTP long-poll only). Operator 2026-06-04 re-enabled
  // WS now that sidecar uses same-port Upgrade (CF tunnel transparently
  // forwards). Pick transport by URL scheme:
  //   wss:// or ws://  → BridgeClient (real WS, instant push)
  //   https:// http:// → HttpBridgeClient (long-poll fallback)
  // Operator can override DEFAULT_BRIDGE_URL via localStorage / GM_setValue
  // (key "OGAMEX_BRIDGE_URL") to flip between the two.
  const url = opts.bridgeUrl;
  const wantsWs = /^wss?:\/\//i.test(url);
  const base = opts.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
  const jit = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const userscriptVersion = opts.userscriptVersion ?? DEFAULT_USERSCRIPT_VERSION;
  const strategyVersion = opts.strategyVersion ?? DEFAULT_STRATEGY_VERSION;

  // URL normalization — strip trailing /push|/poll|/ws (clients re-add).
  const stripTrailing = (u: string): string => u.replace(/\/(push|poll|ws)\/?$/, "");
  let client: HttpBridgeClient | WsBridgeClient;
  // Operator 2026-06-04 "添加信号灯" — expose bridge transport+status on
  // window so panel header can render a colored dot (green/yellow/red).
  let transport: "ws" | "http" = "http";
  // v0.0.1021 Phase 2 — owner 2026-06-09 "前端和后端做池连接做好持久化": 跟 status
  // 监 reconnect 跳变 (非 open → open) → 触发 drainPendingAcks 把 localStorage
  // queue 里上次没送达的 ack 重发. 第一次 status 见到 "open" 也 drain (boot
  // 时机比 goal_runner 早一拍, 双触发 idempotent — sidecar dedupe).
  let lastStatus = "init";
  const publishStatus = (): void => {
    try {
      const w = window as Window & { __ogamexBridgeStatus?: { transport: "ws" | "http"; status: string } };
      const status = client ? client.status() : "disconnected";
      if (lastStatus !== "open" && status === "open") {
        void import("../goal_runner.js").then(({ drainPendingAcks }) => {
          void drainPendingAcks();
        }).catch((e) => console.warn("[wire] drainPendingAcks lazy import threw", e));
      }
      lastStatus = status;
      w.__ogamexBridgeStatus = { transport, status };
    } catch { /* */ }
  };
  if (opts.client) {
    client = opts.client;
    await client.connect(stripTrailing(url), opts.bridgeToken);
    transport = "client" in opts.client ? "http" : "ws"; // best-effort guess
  } else if (wantsWs) {
    const wsUrl = stripTrailing(url) + "/ws";
    const ws = new WsBridgeClient();
    try {
      await ws.connect(wsUrl, opts.bridgeToken);
      client = ws;
      transport = "ws";
      console.info(`[wireBridge] WS connected ${wsUrl}`);
    } catch (e) {
      console.warn(`[wireBridge] WS connect failed (${(e as Error).message}); falling back to HTTP long-poll`);
      try { ws.stop(); } catch { /* */ }
      const httpUrl = stripTrailing(url).replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
      client = new HttpBridgeClient();
      transport = "http";
      await client.connect(httpUrl, opts.bridgeToken);
    }
  } else {
    client = new HttpBridgeClient();
    transport = "http";
    await client.connect(stripTrailing(url), opts.bridgeToken);
  }
  publishStatus();
  // v0.0.991 — owner "idle tab JS 心跳 可以取消": setVisibleInterval, hidden
  // tab 时整个 publishStatus 停. 可见时 catch-up 一次立刻发, 之后 1s 续poll.
  // 隐藏 tab 没人看 light, 不需要每秒推.
  const statusPollHandle = setVisibleInterval(publishStatus, 1000);
  void statusPollHandle;

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
    // Empire fetch DECOUPLED from push (operator: "ogame 的改成事件觸發").
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
    // Operator 2026-05-25 "遠征有空槽沒有自動起飛": daemon's free-slot
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
  // v0.0.567 — defense-in-depth dedup. Operator 2026-06-01 observed 3 mission=8
  // dispatched for same return: sidecar's firedDebrisCheckFor was being
  // GC'd prematurely (fixed sidecar-side), but wire should ALSO guard against
  // duplicate dispatches in case any future code path re-fires the message.
  // Key by origin_planet_id + dest G:S, 10-min TTL (debris harvest round trip
  // is minutes; dedup window covers same-fleet re-fire without blocking new
  // legitimate harvests for a fresh expedition return to the same coord).
  const recentHarvestDispatch = new Map<string, number>();
  // v0.0.670 — operator 2026-06-03 "10min 太长了 6": 收紧至 6min。
  // recentHarvestDispatch 只 dedup 真正 DISPATCH 过的 harvest（同
  // origin→G:S）。6min 仍宽于一次 explorer 单程往返时间，不会触发
  // 同一残骸场双发；同时让 sidecar 改进后的 A/B/C 三信号每个有
  // 独立扫描窗口，被前一发挡住的概率降到极低。
  // Operator 2026-06-04 "全做" → true bidir section_settings sync. Sidecar
  // pushes this whenever PG user_settings.section_settings changes (website
  // modal or another userscript instance). Apply to localStorage immediately
  // so in-game panel reflects without F5.
  const offSectionSettings = client.on("section_settings.update", (msg) => {
    const m = msg as { settings?: Record<string, string | boolean>; reason?: string };
    const settings = m.settings ?? {};
    let applied = 0;
    for (const [k, v] of Object.entries(settings)) {
      if (typeof v !== "string" && typeof v !== "boolean") continue;
      try {
        window.localStorage.setItem(k, typeof v === "boolean" ? String(v) : v);
        applied++;
      } catch { /* */ }
    }
    console.info(`[wireBridge] section_settings.update applied ${applied} key(s) reason=${m.reason ?? "?"}`);
  });

  const HARVEST_DEDUP_TTL_MS = 6 * 60 * 1000;
  const offDebrisCheck = client.on("expedition.debris_check", (msg) => {
    const m = msg as { galaxy?: number; system?: number; position?: number; origin_planet_id?: string; reason?: string };
    let g = m.galaxy ?? 0, s = m.system ?? 0, origin = m.origin_planet_id ?? "";
    // v0.0.570 — operator 2026-06-01 "普通回收是用回收船不是探路者, 只有
    // 16號位置是探路者". `target_position` selects which debris field to
    // harvest within the system. Default 16 (expedition slot) for
    // backwards compat — sidecar's auto-fire from expedition return uses
    // dest_position=16. Ship type follows: pos===16 → pathfinder/explorer,
    // pos∈[1,15] → recycler.
    // v0.0.880 — owner 2026-06-07 撤 v0.0.879: 两个回收都要 (远征槽 :16 +
    // 本家位 1-15), 不是二选一. 恢复原默认 16, v0.0.641 二次扫 home 仍跑.
    let targetPosition = typeof m.position === "number" && m.position >= 1 && m.position <= 16 ? m.position : 16;
    // v0.0.568 — sentinel _CURRENT_ resolves to the operator's currently
    // viewed planet (meta[name=ogame-planet-id]) + its coords via the
    // sidecar-pushed empire snapshot in __ogamexStore.
    if (origin === "_CURRENT_") {
      try {
        const metaEl = document.querySelector('meta[name="ogame-planet-id"]') as HTMLMetaElement | null;
        const realCp = metaEl?.content ?? "";
        const winStore = (window as Window & {
          __ogamexStore?: { state?: { planets?: Record<string, { coords?: readonly number[]; type?: string }> } };
        }).__ogamexStore;
        const planet = realCp ? winStore?.state?.planets?.[realCp] : undefined;
        if (!realCp || !planet || !Array.isArray(planet.coords) || planet.coords.length < 3) {
          const failMsg = `_CURRENT_ resolve failed: meta=${realCp || "<empty>"} planet=${JSON.stringify(planet ?? null)}`;
          console.warn(`[debris] ${failMsg}`);
          void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
            method: "POST", credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag: "debris-current-fail", text: failMsg }),
          }).catch(() => { /* */ });
          return;
        }
        g = planet.coords[0]!;
        s = planet.coords[1]!;
        targetPosition = planet.coords[2]!;
        origin = realCp;
        // operator 2026-06-01: 回收永遠從星球出發. If operator is viewing a
        // moon, swap origin to the sibling planet at the same coords.
        if (planet.type === "moon" && winStore?.state?.planets) {
          const coordKey = planet.coords.slice(0, 3).join(":");
          const sibling = Object.entries(winStore.state.planets)
            .find(([, p]) => Array.isArray(p?.coords) && (p.coords as number[]).join(":") === coordKey && p.type === "planet");
          if (sibling) {
            console.info(`[debris] _CURRENT_ moon→planet swap: ${realCp}→${sibling[0]} at ${coordKey}`);
            origin = sibling[0];
          } else {
            console.warn(`[debris] _CURRENT_ moon ${realCp} has no planet sibling at ${coordKey}; aborting`);
            return;
          }
        }
        const okMsg = `_CURRENT_ resolved → origin=${origin} coords=${g}:${s}:${planet.coords[2]} type=${planet.type ?? "?"}`;
        console.info(`[debris] ${okMsg}`);
        void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
          method: "POST", credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag: "debris-current-ok", text: okMsg }),
        }).catch(() => { /* */ });
      } catch (e) {
        console.error("[debris] _CURRENT_ resolve threw:", e);
        return;
      }
    }
    if (!g || !s || !origin) return;
    // v0.0.782 — main-path dedup RESTORED. Operator 2026-06-05 evidence:
    // 3:260:9 → 3:260:16 4 次 recycler dispatch in 30 分钟 (15:39/15:44/
    // 15:52/15:57). 同 origin 多 fleet 同 dest 时 sidecar fires N 次 (per
    // fleet), wire 假设"1 fleet 1 fire" 不再成立. dedupKey 之前定义没用,
    // 现在恢复 entry-side check — 6min 内同 origin→G:S 只发 1 次 recycler.
    // 6min 宽于 explorer 单程 + 收集 + 回程, 不阻塞合法 fresh debris.
    const dedupKey = `${origin}→${g}:${s}`;
    {
      const lastDispatchTs = recentHarvestDispatch.get(dedupKey) ?? 0;
      const ageMs = Date.now() - lastDispatchTs;
      if (lastDispatchTs > 0 && ageMs < HARVEST_DEDUP_TTL_MS) {
        const ageSec = Math.round(ageMs / 1000);
        const ttlSec = Math.round(HARVEST_DEDUP_TTL_MS / 1000);
        console.info(`[debris] DEDUP main-path skip ${dedupKey} (last ${ageSec}s ago, TTL=${ttlSec}s)`);
        return;
      }
    }
    // v0.0.570 — ship type selection per position. expedition slot (16)
    // requires pathfinder/explorer (id=219); regular battle debris at any
    // position 1-15 uses recycler (id=209, ogame's standard collector).
    const harvestShipKey = targetPosition === 16 ? "explorer" : "recycler";
    console.info(`[debris] check G:S=${g}:${s}:${targetPosition} origin=${origin} ship=${harvestShipKey} reason=${m.reason ?? ""}`);
    // v0.0.783 — operator 2026-06-05 "回家就派一次不用等30s, 失败 30s 后重派".
    // 包成 attemptHarvest(n), 失败时 setTimeout 30s 重调 (max attempt=2). dedup
    // SET 只在 sendFleet 成功路径, retry 进 IIFE 时 dedup 仍空, 自然继续.
    const attemptHarvest = async (attempt: number): Promise<void> => {
      let dispatchedThisAttempt = false;
      try {
        // v0.0.570 — operator 2026-06-01 "切 cp 要走標準接口". Galaxy fetch
        // now goes through cpPostWithRetry (the unified entry) instead of
        // raw fetch — aligns with discover/galaxy chain (api_executor.ts:994
        // Phase 3 migration). Provides the same mutex + restore + click-lock
        // protection as every other cp= fetch.
        const wTokMgr = (window as Window & { __ogamexTokenManager?: unknown }).__ogamexTokenManager;
        if (!wTokMgr) { console.warn("[debris] no tokenManager available for galaxy fetch"); return; }
        const { cpPostWithRetry } = await import("../api/fleet_api.js");
        // v0.0.572 — operator 2026-06-01 "切 cp 跳星球的問題". v0.0.570 set
        // skipRestore:true here (copied from api_executor's discover-galaxy
        // path which lives inside execute()'s own restore chain). wire.ts
        // has NO outer restore — leaving skipRestore:true meant the cp shift
        // to `origin` was NEVER reverted, so operator's top-bar stayed on
        // origin instead of bouncing back to their viewed planet. Fix:
        // remove skipRestore (default = false → safe_fetch auto-restores).
        const galRes = await cpPostWithRetry({
          endpoint: `/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1`,
          sourcePlanetId: origin,
          token: wTokMgr as NonNullable<Parameters<typeof cpPostWithRetry>[0]["token"]>,
          action: "debris:galaxy",
          method: "POST",
          tokenProvider: async () => "",
          buildBody: () => {
            const b = new URLSearchParams();
            b.set("galaxy", String(g));
            b.set("system", String(s));
            return b;
          },
          successCheck: (j) => !!j["system"],
          // v0.0.783 — operator 2026-06-05 "api 返回失败重试就好了, 为啥要派
          // 两次". 之前 maxAttempts=1 + sidecar Signal C 兜底 = 派两次 fleet.
          // 正确语义: galaxy fetch 失败时 wire 自己 retry 3 次, signal 只 fire
          // 一次. cpPostWithRetry 已经内置 token race + 失败 backoff, 直接
          // 把 attempts 提高.
          maxAttempts: 3,
        });
        if (galRes.status !== 200) { console.warn(`[debris] galaxy fetch HTTP ${galRes.status} after retries — giving up this signal`); return; }
        const json = (galRes.json ?? {}) as Record<string, unknown>;
        // v0.0.564 — operator 2026-06-01 forensic via /v1/debug/log mirror:
        // ogame v12 fetchGalaxyContent response shape is `{system: {galaxyContent:[...]}, token, ...}`,
        // NOT `{galaxy: [...]}`. The galaxy[] / galaxy.rows[] paths were
        // legacy guesses that never matched real responses — every harvest
        // probe silently skipped. Read from `system.galaxyContent` (the same
        // path api_executor.ts:1020 discover/galaxy chain already uses).
        const rows: Array<Record<string, unknown>> = (() => {
          const sysField = json["system"];
          if (sysField && typeof sysField === "object") {
            const gc = (sysField as { galaxyContent?: unknown }).galaxyContent;
            if (Array.isArray(gc)) return gc as Array<Record<string, unknown>>;
          }
          // Legacy fallback paths kept just in case ogame skin variant differs.
          const galaxyField = json["galaxy"];
          if (Array.isArray(galaxyField)) return galaxyField as Array<Record<string, unknown>>;
          if (galaxyField && typeof galaxyField === "object") {
            const inner = (galaxyField as { rows?: unknown }).rows;
            if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
          }
          return [];
        })();
        // v0.0.643 — operator 2026-06-01 實證: 遠征槽 :16 戰利品永遠 skip。
        // 根因: ogame v12 fetchGalaxyContent 的 system.galaxyContent[] 只裝
        // pos 1-15, 遠征槽資料在 root 的 reservedPositions 字段裏 (rootKeys
        // 一直顯示它存在)。Fallback: pos 16 找不到時, 掃 reservedPositions
        // (兜底數組+對象兩種 shape) 找 position=16 的 debris record。
        // Shape variants 同 pos 1-15 (planetType=2 或 recyclePossible=true)。
        let posRow = rows.find((row) => Number(row["position"]) === targetPosition);
        if (!posRow && targetPosition === 16) {
          const rp = json["reservedPositions"];
          let rpRow: Record<string, unknown> | undefined;
          if (Array.isArray(rp)) {
            rpRow = (rp as Array<Record<string, unknown>>).find((row) => Number(row["position"]) === 16);
          } else if (rp && typeof rp === "object") {
            const rec = rp as Record<string, unknown>;
            const candidate = rec["16"] ?? rec[16 as unknown as string];
            if (candidate && typeof candidate === "object") {
              const cAsRow = candidate as Record<string, unknown>;
              // Normalize: if candidate doesn't have `planets`, wrap it as the entry directly.
              rpRow = "planets" in cAsRow
                ? cAsRow
                : { position: 16, planets: candidate };
            }
          }
          if (rpRow) {
            posRow = rpRow;
            console.info(`[debris] FALLBACK :16 found in reservedPositions (shape=${Array.isArray(rp) ? "array" : "object"})`);
          }
        }
        // v0.0.571 — operator 2026-06-01 forensic 2nd round: ogame v12
        // position 1-15 returns `planets` as an ARRAY (may contain planet +
        // moon + debris entries at the same coord), position 16 returns it
        // as a single object (only debris ever lives at :16). Normalize both
        // shapes by searching for an entry with planetType===2 or
        // recyclePossible===true — that's the debris record we care about.
        type DebrisEntry = {
          planetType?: number; recyclePossible?: boolean; requiredShips?: number;
          resources?: { metal?: { amount?: number }; crystal?: { amount?: number }; deuterium?: { amount?: number } };
        };
        const planetsField: unknown = posRow?.["planets"] ?? null;
        const planetsArr: DebrisEntry[] = Array.isArray(planetsField)
          ? (planetsField as DebrisEntry[])
          : (planetsField && typeof planetsField === "object" ? [planetsField as DebrisEntry] : []);
        const debrisPlanet: DebrisEntry | null = planetsArr.find(
          (e) => e?.planetType === 2 || e?.recyclePossible === true,
        ) ?? null;
        const isDebrisField = !!debrisPlanet;
        const dm = isDebrisField ? Number(debrisPlanet?.resources?.metal?.amount ?? 0) : 0;
        const dc = isDebrisField ? Number(debrisPlanet?.resources?.crystal?.amount ?? 0) : 0;
        const dd = isDebrisField ? Number(debrisPlanet?.resources?.deuterium?.amount ?? 0) : 0;
        const totalDebris = dm + dc + dd;
        const ogameRequiredShips = isDebrisField ? Number(debrisPlanet?.requiredShips ?? 0) : 0;
        // v0.0.563 — operator 2026-06-01: 飛行列表沒看到回收 → 驗證 ogame v12
        // galaxy response 真實 shape。dump rows[0] + pos16 + root keys.
        try {
          const rootKeys = Object.keys(json).slice(0, 20).join(",");
          const firstRowKeys = rows[0] ? Object.keys(rows[0]).slice(0, 20).join(",") : "<no rows>";
          const posJson = posRow ? JSON.stringify(posRow).slice(0, 800) : `<no pos${targetPosition} row>`;
          // v0.0.642 — operator 2026-06-01 實證: ogame v12 galaxyContent
          // 只裝 pos 1-15, :16 不在 rows 裏, 懷疑在 reservedPositions 或
          // system 別的子字段。Dump 一遍真正看 :16 資料在哪。
          const reservedDump = JSON.stringify(json["reservedPositions"] ?? null).slice(0, 1200);
          const systemKeys = json["system"] && typeof json["system"] === "object"
            ? Object.keys(json["system"] as Record<string, unknown>).slice(0, 20).join(",")
            : "<no system>";
          const diag = `G:S=${g}:${s} target=${targetPosition} rowsLen=${rows.length} rootKeys=[${rootKeys}] firstRowKeys=[${firstRowKeys}] systemKeys=[${systemKeys}] reservedPositions=${reservedDump} pos${targetPosition}=${posJson}`;
          console.info(`[debris-raw] ${diag}`);
          // mirror to sidecar journal — operator can verify via journalctl.
          void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
            method: "POST", credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag: "debris-raw", text: diag }),
          }).catch(() => { /* */ });
        } catch { /* */ }
        // v0.0.641 — flip "skip + return" to "skip but continue" so the
        // v0.0.641 home-planet scan further down still runs even when the
        // primary targetPosition (typically :16) has no debris.
        const primaryHasDebris = totalDebris > 0;
        if (!primaryHasDebris) {
          const skipMsg = `G:S:${targetPosition}=${g}:${s}:${targetPosition} — no debris field at primary slot, will still scan home planet (isDebrisField=${isDebrisField})`;
          console.info(`[debris] ${skipMsg}`);
          try {
            void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
              method: "POST", credentials: "omit",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tag: "debris-skip", text: skipMsg }),
            }).catch(() => { /* */ });
          } catch { /* */ }
        } else {
          console.info(`[debris] G:S:${targetPosition}=${g}:${s}:${targetPosition} has m=${dm} c=${dc} d=${dd} (total ${totalDebris}) ogameRequiredShips=${ogameRequiredShips} ship=${harvestShipKey}`);
        }
        if (primaryHasDebris) {
        // v0.0.570 — operator 2026-06-01: ship type depends on position
        // (pos 16 → pathfinder/explorer, pos 1-15 → recycler). Inventory
        // check + dispatch both keyed by harvestShipKey.
        const winFull = window as Window & {
          __ogamexStore?: {
            state?: {
              server?: { ship_cargo_capacity?: Record<string, number> };
              planets?: Record<string, {
                ships?: Record<string, number>;
                resources?: { m?: number; c?: number; d?: number };
              }>;
            };
          };
        };
        const shipCargoMap = winFull.__ogamexStore?.state?.server?.ship_cargo_capacity ?? {};
        // Fallback per-ship cargo cap: explorer 16000, recycler 20000 (ogame
        // standard pre-hyperspace; ship_cargo_capacity store value preferred
        // when present — accounts for hyperspace tech bonus).
        const shipCap = Number(shipCargoMap[harvestShipKey] ?? (harvestShipKey === "explorer" ? 16000 : 20000));
        const shipsNeeded = ogameRequiredShips > 0
          ? ogameRequiredShips
          : Math.max(1, Math.ceil(totalDebris / shipCap));
        const srcPlanet = winFull.__ogamexStore?.state?.planets?.[origin];
        const shipsAvailable = Number(srcPlanet?.ships?.[harvestShipKey] ?? 0);
        const planetD = Number(srcPlanet?.resources?.d ?? 0);
        const inventoryMsg = `origin=${origin} inventory: ${harvestShipKey}=${shipsAvailable} d=${planetD} | needed=${shipsNeeded} cap=${shipCap}/ship totalDebris=${totalDebris}`;
        console.info(`[debris] ${inventoryMsg}`);
        try {
          void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
            method: "POST", credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag: "debris-inv", text: inventoryMsg }),
          }).catch(() => { /* */ });
        } catch { /* */ }
        if (shipsAvailable <= 0) {
          console.warn(`[debris] SKIP primary — origin=${origin} has 0 ${harvestShipKey} ships; v0.0.641 still continues to home scan`);
        } else {
        const shipsToSend = Math.min(shipsNeeded, shipsAvailable);
        if (shipsToSend < shipsNeeded) {
          console.warn(`[debris] ${harvestShipKey} short — need=${shipsNeeded} have=${shipsAvailable} → send=${shipsToSend} (partial harvest)`);
        }
        // Dispatch via fleet_api.sendFleet — mission=8 (collect debris), destType=2.
        try {
          const { sendFleet } = await import("../api/fleet_api.js");
          const result = await sendFleet({
            ships: { [harvestShipKey]: shipsToSend } as unknown as import("@ogamex/shared").ShipCount,
            cargo: { m: 0, c: 0, d: 0 },
            coords: [g, s, targetPosition],
            destType: 2,
            mission: 8 as import("@ogamex/shared").MissionCode,
            speed: 10,
            sourcePlanetId: origin,
          }, { fetch: window.fetch.bind(window), token: wTokMgr as Parameters<typeof sendFleet>[1]["token"] });
          const okMsg = `${harvestShipKey} dispatched fleetId=${result.fleetId} count=${shipsToSend} (needed=${shipsNeeded} avail=${shipsAvailable}) target=${g}:${s}:${targetPosition}`;
          console.info(`[debris] ${okMsg}`);
          // v0.0.567 — mark dedup AFTER successful dispatch so failed
          // sendFleet (insufficient ships, ogame race, etc.) doesn't block
          // legitimate retry.
          recentHarvestDispatch.set(dedupKey, Date.now());
          dispatchedThisAttempt = true;
          try {
            void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
              method: "POST", credentials: "omit",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tag: "debris-ok", text: okMsg }),
            }).catch(() => { /* */ });
          } catch { /* */ }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("[debris] sendFleet failed:", e);
          try {
            void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
              method: "POST", credentials: "omit",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tag: "debris-fail", text: `sendFleet error: ${errMsg.slice(0, 300)}` }),
            }).catch(() => { /* */ });
          } catch { /* */ }
        }
        } // end ships-available else (v0.0.641)
        } // end if (primaryHasDebris) (v0.0.641)
        // v0.0.641 — operator 2026-06-01 "本星有廢墟" 實證: 1:486:7 戰鬥
        // 殘骸 c=14000 需 1 recycler, 但 sidecar 自動 debris-check 只查 :16
        // (遠征槽), 漏家星位 7 的戰鬥殘骸。Galaxy fetch 已拿到全 system,
        // 同一份 rows 順便掃 origin planet 自己的位置, 有 debris 也派
        // recycler (mission=8)。避免漏底。
        try {
          const winStore2 = (window as Window & {
            __ogamexStore?: { state?: { planets?: Record<string, { coords?: readonly number[]; ships?: Record<string, number> }> } };
          }).__ogamexStore;
          const planet = winStore2?.state?.planets?.[origin];
          const planetPos = Array.isArray(planet?.coords) && planet!.coords.length >= 3
            ? Number(planet!.coords[2]) : 0;
          if (planetPos > 0 && planetPos !== targetPosition) {
            // Reuse rows from earlier fetch (same G:S galaxy).
            const homePosRow = rows.find((row) => Number(row["position"]) === planetPos);
            const homePlanetsField: unknown = homePosRow?.["planets"] ?? null;
            const homePlanetsArr: DebrisEntry[] = Array.isArray(homePlanetsField)
              ? (homePlanetsField as DebrisEntry[])
              : (homePlanetsField && typeof homePlanetsField === "object" ? [homePlanetsField as DebrisEntry] : []);
            const homeDebris = homePlanetsArr.find((e) => e?.planetType === 2 || e?.recyclePossible === true) ?? null;
            if (homeDebris) {
              const hm = Number(homeDebris.resources?.metal?.amount ?? 0);
              const hc = Number(homeDebris.resources?.crystal?.amount ?? 0);
              const hd = Number(homeDebris.resources?.deuterium?.amount ?? 0);
              const homeTotal = hm + hc + hd;
              const homeReq = Number(homeDebris.requiredShips ?? 0);
              const homeDedupKey = `${origin}→${g}:${s}:${planetPos}`;
              const homeLast = recentHarvestDispatch.get(homeDedupKey) ?? 0;
              const homeAge = (Date.now() - homeLast) / 1000;
              // v0.0.774 — operator 2026-06-04 "回收派了两次": 6min TTL 太短,
              // recycler 来回 > 6min 就过期触发第二次派. 加 in-flight 检查:
              // 任一 mission=8 (harvest) 到 [g:s:p,debris] 的 fleet 还在
              // outbound, 直接跳, 不靠纯时间 dedup.
              const storeAccess = (window as Window & { __OGAMEX__?: { store?: { state?: { fleets_outbound?: Array<{ mission?: number; destType?: number | string; dest?: number[]; arrival_at?: number | null }> } } } }).__OGAMEX__;
              const outboundFleets = storeAccess?.store?.state?.fleets_outbound ?? [];
              const inFlightRecycler = outboundFleets.some((f) => {
                const isHarvest = Number(f?.mission) === 8;
                const destIsDebris = String(f?.destType) === "2" || Number(f?.destType) === 2;
                const destMatches = Array.isArray(f?.dest)
                  && f.dest[0] === g && f.dest[1] === s && f.dest[2] === planetPos;
                const stillInFlight = (f?.arrival_at ?? 0) === null || (typeof f?.arrival_at === "number" && f.arrival_at * 1000 > Date.now());
                return isHarvest && destIsDebris && destMatches && stillInFlight;
              });
              if (inFlightRecycler) {
                const homeSkip = `home recycler skip (in-flight to ${g}:${s}:${planetPos} debris already)`;
                console.info(`[debris/home] ${homeSkip}`);
              }
              if (homeTotal > 0 && !inFlightRecycler && (homeLast === 0 || homeAge >= HARVEST_DEDUP_TTL_MS / 1000)) {
                // Home planet = always battle debris → recycler (id=209).
                const homeShipKey = "recycler";
                const homeShipsAvail = Number(planet?.ships?.[homeShipKey] ?? 0);
                const homeShipsNeeded = homeReq > 0 ? homeReq : Math.max(1, Math.ceil(homeTotal / 20000));
                const homeInfo = `home G:S:${planetPos}=${g}:${s}:${planetPos} m=${hm} c=${hc} d=${hd} total=${homeTotal} need=${homeShipsNeeded} have=${homeShipsAvail} origin=${origin}`;
                console.info(`[debris/home] ${homeInfo}`);
                void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
                  method: "POST", credentials: "omit",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ tag: "debris-home", text: homeInfo }),
                }).catch(() => { /* */ });
                if (homeShipsAvail > 0) {
                  const homeSend = Math.min(homeShipsNeeded, homeShipsAvail);
                  try {
                    const { sendFleet: sendFleet2 } = await import("../api/fleet_api.js");
                    const homeRes = await sendFleet2({
                      ships: { [homeShipKey]: homeSend } as unknown as import("@ogamex/shared").ShipCount,
                      cargo: { m: 0, c: 0, d: 0 },
                      coords: [g, s, planetPos],
                      destType: 2, // debris field type
                      mission: 8 as import("@ogamex/shared").MissionCode,
                      speed: 10,
                      sourcePlanetId: origin,
                    }, { fetch: window.fetch.bind(window), token: wTokMgr as Parameters<typeof sendFleet2>[1]["token"] });
                    const homeOk = `home recycler dispatched fleetId=${homeRes.fleetId} count=${homeSend} target=${g}:${s}:${planetPos}`;
                    console.info(`[debris/home] ${homeOk}`);
                    recentHarvestDispatch.set(homeDedupKey, Date.now());
                    void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
                      method: "POST", credentials: "omit",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tag: "debris-home-ok", text: homeOk }),
                    }).catch(() => { /* */ });
                  } catch (e) {
                    const errMsg = e instanceof Error ? e.message : String(e);
                    console.error("[debris/home] sendFleet failed:", e);
                    void fetch("https://ogame.anyfq.com/ogamex/v1/debug/log", {
                      method: "POST", credentials: "omit",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tag: "debris-home-fail", text: `home sendFleet error: ${errMsg.slice(0, 300)}` }),
                    }).catch(() => { /* */ });
                  }
                } else {
                  console.warn(`[debris/home] SKIP — origin ${origin} has 0 ${homeShipKey} ships`);
                }
              }
            }
          }
        } catch (e) {
          console.error("[debris/home] threw:", e);
        }
      } catch (e) {
        console.error("[debris] handler threw:", e);
      }
      if (!dispatchedThisAttempt && attempt < 2) {
        console.info(`[debris] attempt ${attempt} no dispatch — retry in 30s`);
        setTimeout(() => { void attemptHarvest(attempt + 1); }, 30_000);
      } else if (!dispatchedThisAttempt) {
        console.warn(`[debris] gave up after ${attempt} attempts for ${dedupKey}`);
      }
    };
    void attemptHarvest(1);
  });

  // save.recall_now — sidecar's SaveCoordinator decided this fleet's recall
  // margin elapsed and instructs the userscript to POST the recall. Cookies +
  // token live in the page world, so the actual ogame API call has to come
  // from here (sidecar can't cookie-auth into ogame). After the recall POST
  // succeeds, report back to /v1/save/recall-confirmed so the backend can
  // close the record.
  const offRecallNow = client.on("save.recall_now", (msg) => {
    const m = msg as { planet_id?: string; fleet_id?: number; reason?: string };
    // Operator 2026-05-27: frontend FSM 自己也會 fire recall (instant on hostile
    // clear). 如果 FSM 已經 RECALLING/RETURNED, backend 的這次 directive 重復,
    // ogame 會 reject success=false. 短路掉避免 console 噪音 + 假告警.
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
      offSectionSettings();
    },
  };
}
