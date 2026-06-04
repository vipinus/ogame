/**
 * Parasitic eventbox interceptor — mirrors the reference attack-alarm.user.js
 * v2.9 architecture. We do NOT initiate our own polling; instead we hook
 * XMLHttpRequest + fetch to capture ogame's NATIVE 5s eventbox polls and
 * parse the response for incoming hostile fleets.
 *
 * Why: ogame's own client polls eventList / fetchEventBox every 5s. Active
 * userscript polling was a parallel duplicate — burning bandwidth and
 * sometimes racing the native poll. Hooking is zero extra request, perfect
 * sync with what the client itself sees.
 *
 * Threat missions = ATTACK paths only:
 *   1 = 普通攻擊 (regular attack)
 *   2 = 聯合攻擊 ACS
 *   9 = 月毀 (moon destruction)
 *   10 = 行星間導彈 (interplanetary missile)
 *
 * Spy (mission 6) is INTENTIONALLY NOT a threat — ogame's 0%-detection
 * probes never appear in any client-side API anyway; only post-arrival
 * mail surfaces them. Including spy here would mostly false-alarm on
 * neutral probes from allies / non-detected probes that we DID see.
 *
 * Watchdog: if ogame's poll hasn't fired in 10s (tab backgrounded, network
 * throttled), self-fetch window.ajaxEventboxURI once. Same URL ogame
 * itself uses — exposed as a global by ogame's runtime.
 */
import type { StateStore } from "../state_store.js";
import type { IncomingEvent } from "@ogamex/shared";

const THREAT_MISSIONS = new Set([1, 2, 9, 10]);
const SPY_MISSION = 6;
const MISSION_TYPE_MAP: Record<number, IncomingEvent["type"]> = {
  1: "attack", 2: "attack", 9: "attack", 10: "attack",  // moon-destroy + missile classed as attack
  3: "transport", 4: "deploy", 5: "transport", 6: "spy",
  7: "transport", 8: "transport", 15: "return",
};

interface OgameEventLike {
  id?: string | number;
  mission?: number;
  missionType?: number | string;
  type?: string;
  arrivalTime?: number;
  arrival_time?: number;
  arrives_at?: number;
  playerId?: number | string;
  ownerId?: number | string;
  owner?: number | string;
  fromPlayerId?: number | string;
  return?: boolean;
  isReturn?: boolean;
  returnFleet?: boolean;
  friendly?: boolean;
  isFriendly?: boolean;
  own?: boolean;
  relation?: string;
  kind?: string;
  coordsOrigin?: string | readonly number[];
  coordsDest?: string | readonly number[];
  origin?: readonly number[];
  dest?: readonly number[];
  to?: readonly number[];
  ships?: number | { count?: number };
}

function parseCoordsStr(s: unknown): readonly [number, number, number] | null {
  if (Array.isArray(s) && s.length === 3) {
    const n = s.map((x) => parseInt(String(x), 10));
    if (n.every((x) => Number.isFinite(x))) return [n[0]!, n[1]!, n[2]!] as const;
  }
  if (typeof s !== "string") return null;
  const m = s.match(/(\d+)\s*[:\\-]\s*(\d+)\s*[:\\-]\s*(\d+)/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] as const;
}

// parseEventBoxResponse REMOVED (v0.0.219).
//
// Previous strategy (v0.0.211-218): parse fetchEventBox JSON for hostile/
// neutral/friendly counts + events array + HTML rows. Outcomes:
//   - PATH 0 (counts → synthetic event): faulty signal — counts only ≠
//     row-level hostile, fired false positives, conflicting IDs with
//     evrow-* sourced from real DOM observer.
//   - PATH 1 (events array): never populated by ogame v12 fetchEventBox.
//   - PATH 2 (HTML regex): duplicated #eventContent DOM observer (v0.0.218)
//     which reads truth directly.
//
// All hostile/spy detection now goes through:
//   1. #eventContent MutationObserver (boot.ts → eventbox_hook installer)
//   2. #attack_alert MutationObserver (defensive fallback)
//
// The XHR/fetch hook still tracks lastNativeHit (for the watchdog) and
// surface checkOwnFleetCountDelta (friendly count change → /movement
// refresh trigger). No event injection from JSON anymore.

export interface EventBoxHookHandle {
  /** Stop intervals + restore XHR/fetch. Best-effort — hook callbacks remain
   *  no-ops after stop, but the prototype patches are not unwound. */
  stop(): void;
  /** Telemetry — last time a native eventbox response was observed. */
  lastNativeHitAt(): number;
}

export interface EventBoxHookOptions {
  store: StateStore;
  win: Window;
  /** Force-fetch fallback when ogame's own poll hasn't fired in this many ms.
   *  Default 10000 — same as reference attack-alarm.user.js. */
  watchdogGapMs?: number;
  /** Watchdog scan cadence. Default 5000. */
  watchdogCheckMs?: number;
}

export function installEventBoxHook(opts: EventBoxHookOptions): EventBoxHookHandle {
  const { win, store } = opts;
  const watchdogGapMs = opts.watchdogGapMs ?? 10_000;
  const watchdogCheckMs = opts.watchdogCheckMs ?? 5_000;
  let lastNativeHit = 0;
  let stopped = false;
  let lastSig = "";

  function ownPlayerId(): number | null {
    const w = win as Window & { playerId?: number | string };
    const raw = w.playerId;
    const n = parseInt(String(raw ?? 0), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Track ogame's own outbound (friendly) fleet count from eventbox JSON.
  // When it changes, force harvestSlotsFromMovement → rebuild
  // state.fleets_outbound. Catches fleet-return events that slip past the
  // 10s harvest interval.
  //
  // CRITICAL: only react when the JSON actually contains a `friendly` field
  // (fetchEventBox shape). Other URL-matched endpoints (checkEvents) return
  // different shapes without `friendly` → treating undefined as 0 caused
  // 0↔6 flapping that hammered /movement.
  let lastOwnFleetCount = -1;
  function checkOwnFleetCountDelta(text: string): void {
    try {
      const j = JSON.parse(text) as { friendly?: number | string };
      // Skip responses that lack the field — checkEvents returns minimal
      // payload (just newAjaxToken), should not feed our delta detector.
      if (j === null || typeof j !== "object" || j.friendly === undefined) return;
      const n = parseInt(String(j.friendly), 10);
      if (!Number.isFinite(n)) return;
      // v0.0.681 — operator 2026-06-03 "全事件驱动". First eventbox response
      // after boot is also an event (ogame's native 5s poll = the boot-side
      // signal). Treat seed as delta-from-unknown so refresh fires once at
      // boot too — without timer-based scheduleBurst. Subsequent polls fire
      // only on actual count change.
      const isFirstSeed = lastOwnFleetCount === -1;
      if (!isFirstSeed && n === lastOwnFleetCount) return;
      const before = isFirstSeed ? n : lastOwnFleetCount;
      lastOwnFleetCount = n;
      {
        console.info(`[OgameX/eventbox-hook] friendly fleet count ${isFirstSeed ? "(boot seed)" : before}→${n}, firing galaxy-JSON slot refresh + state push${n < before ? " + pruneFleets (returner → cp-protected fetchResources)" : ""}`);
        // v0.0.716 — operator 2026-06-03 "没必要一直在跑 /movement". /movement
        // chunk harvest REMOVED from this trigger. Slot count truth chain:
        //   • used_fleet_slots / max_fleet_slots ← refreshSlotsViaApi (galaxy)
        //   • used/max_expedition_slots ← sidecar's directive.completed event
        //     counter (3h TTL prune), seeded by ack stream.
        //   • fleet_id for FS recall ← lazy /movement fetched on demand by
        //     save_state_machine.notifyHostileClear just before recall POST.
        // Net: /movement is no longer polled. It runs at boot-burst once and
        // on FS recall (rare). The 2026-06-03 "远征有空槽不飞" phantom-fleet
        // inflation root cause is structurally eliminated.
        const refreshSlots = (win as Window & { __ogamexRefreshSlots?: () => Promise<void> }).__ogamexRefreshSlots;
        const pushNow = (win as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow;
        const triggerImmediatePush = (): void => { if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } } };
        if (typeof refreshSlots === "function") {
          void refreshSlots().finally(triggerImmediatePush);
        } else {
          triggerImmediatePush();
        }
        // v0.0.733 — operator 2026-06-03 "synthetic.return_at = launch+90min
        // 这个没用就删了吧". __ogamexPruneFleets (ttl-based) retired. Per-
        // mission prune now driven by liveOwnMissionCounts delta tracking
        // below — see __ogamexPruneByMission. Source planet refresh happens
        // inside pruneByMission for each dropped synthetic. Symmetric with
        // launch path, no ttl estimate involved.
      }
    } catch { /* HTML response — skip */ }
  }

  function applyResponse(text: string): void {
    if (stopped) return;
    // Only side-channel kept: friendly count change → trigger /movement refresh.
    // Event detection itself moved to #eventContent DOM observer.
    checkOwnFleetCountDelta(text);
  }

  function isEventBoxURL(url: string): boolean {
    return url.includes("eventList") || url.includes("fetchEventBox") ||
           url.includes("component=eventList") || url.includes("checkEvents");
  }
  // ogame's resource bar polls /game/index.php?page=fetchResources&ajax=1
  // every ~5s. Parasitize that — fire the boot.ts pollFetchResources callback
  // (exposed on window) with the same response data instead of duplicating
  // the GET ourselves.
  function isFetchResourcesURL(url: string): boolean {
    return url.includes("page=fetchResources");
  }
  // DIAGNOSTIC URL CAPTURE — enabled when localStorage["OGAMEX_LOG_XHR"]="1".
  // Logs EVERY /game/index.php XHR/fetch URL so operator can identify which
  // endpoint flashes the spy-alert triangle (0%-detect probes don't hit
  // eventList — they trigger via a separate notification endpoint we
  // haven't identified yet). Toggle on, reload, wait for triangle to
  // flash, paste console URLs. Toggle off to silence.
  function isOgameAjaxURL(url: string): boolean {
    return url.includes("/game/index.php?") || url.includes("/game/index.php&");
  }
  function shouldLogUrl(): boolean {
    try { return win.localStorage.getItem("OGAMEX_LOG_XHR") === "1"; } catch { return false; }
  }
  const seenLogged = new Set<string>(); // dedupe — only log new URLs

  // --- XHR hook ---
  const proto = (win as Window & { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest.prototype;
  type PatchedXHR = XMLHttpRequest & { __ogamexAlarmUrl?: string };
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (this: PatchedXHR, method: string, url: string | URL, ...rest: unknown[]): void {
    this.__ogamexAlarmUrl = typeof url === "string" ? url : url.toString();
    return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
  } as typeof proto.open;
  proto.send = function (this: PatchedXHR, ...args: unknown[]): void {
    const url = this.__ogamexAlarmUrl ?? "";
    if (shouldLogUrl() && isOgameAjaxURL(url)) {
      const key = url.replace(/[?&]ajax=1|[?&]asJson=1|[?&]_=\d+/g, ""); // collapse cache-buster
      if (!seenLogged.has(key)) {
        seenLogged.add(key);
        console.info(`[OgameX/xhr-log] new XHR url: ${url.slice(0, 200)}`);
      }
    }
    if (isEventBoxURL(url)) {
      this.addEventListener("load", () => {
        try {
          lastNativeHit = Date.now();
          applyResponse(this.responseText);
        } catch (e) { console.warn("[OgameX/eventbox-hook] xhr inspect error", e); }
      });
    } else if (isFetchResourcesURL(url)) {
      this.addEventListener("load", () => {
        try {
          const cb = (win as Window & { __ogamexApplyFetchResources?: (txt: string) => void }).__ogamexApplyFetchResources;
          if (typeof cb === "function") cb(this.responseText);
        } catch (e) { console.warn("[OgameX/eventbox-hook] fetchResources inspect error", e); }
      });
    }
    return origSend.apply(this, args as Parameters<typeof origSend>);
  } as typeof proto.send;

  // --- fetch hook ---
  const origFetch = win.fetch;
  if (origFetch) {
    win.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const res = await origFetch.call(win, input as RequestInfo, init);
      try {
        const url = typeof input === "string" ? input : (input as Request).url ?? "";
        if (shouldLogUrl() && isOgameAjaxURL(url)) {
          const key = url.replace(/[?&]ajax=1|[?&]asJson=1|[?&]_=\d+/g, "");
          if (!seenLogged.has(key)) {
            seenLogged.add(key);
            console.info(`[OgameX/xhr-log] new fetch url: ${url.slice(0, 200)}`);
          }
        }
        if (isEventBoxURL(url)) {
          const clone = res.clone();
          clone.text().then((t) => {
            lastNativeHit = Date.now();
            applyResponse(t);
          }).catch(() => { /* */ });
        } else if (isFetchResourcesURL(url)) {
          const clone = res.clone();
          clone.text().then((t) => {
            const cb = (win as Window & { __ogamexApplyFetchResources?: (txt: string) => void }).__ogamexApplyFetchResources;
            if (typeof cb === "function") cb(t);
          }).catch(() => { /* */ });
        }
      } catch { /* */ }
      return res;
    };
  }

  // --- Parasitic-only mode ---
  // 3s active self-fetch (v0.0.211) caused server unresponsiveness: stacked
  // 20 req/min on top of ogame's own 12 req/min on the SAME URL → WAF/
  // load issue. Reverted to PARASITIC-ONLY — we ride ogame's native 5s poll.
  // Detection latency ≤ 5s (acceptable; reference attack-alarm v2.9 same).
  // Watchdog below still self-fetches if ogame's poll stalls > 10s
  // (backgrounded tab). MutationObserver on #attack_alert covers DOM-side
  // signal when ogame updates UI off our hook path.
  let pendingSelfFetch = false;
  async function selfFetch(): Promise<void> {
    if (pendingSelfFetch || stopped) return;
    const w = win as Window & { ajaxEventboxURI?: string };
    const uri = w.ajaxEventboxURI;
    if (!uri) return;
    pendingSelfFetch = true;
    try {
      await win.fetch(uri, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
    } catch (e) { console.warn("[OgameX/eventbox-hook] selfFetch failed", e); }
    finally { pendingSelfFetch = false; }
  }
  // Watchdog only — fires self-fetch when ogame's own poll has stalled
  // beyond gap (backgrounded tab → ogame throttles its own poll).
  const watchdogId = setInterval(() => {
    if (stopped) return;
    const gap = Date.now() - lastNativeHit;
    if (gap > watchdogGapMs) {
      void selfFetch();
    }
  }, watchdogCheckMs);

  // Visibility-change → immediate watchdog tick (backgrounded tabs throttle).
  const visHandler = (): void => {
    if (win.document.visibilityState === "visible") {
      const gap = Date.now() - lastNativeHit;
      if (gap > watchdogGapMs) void selfFetch();
    }
  };
  win.document.addEventListener("visibilitychange", visHandler);

  // --- #attack_alert observer ---
  // ogame's overview renders a div#attack_alert that's class="tooltip noAttack"
  // when peaceful. When ANY threat (including 0%-detection spy POST-arrival
  // notification) is active, the class changes (typically drops "noAttack"
  // and gains an attack indicator class). The flashing triangle the operator
  // sees IS this element. Direct watch = catches every state ogame surfaces.
  let lastAttackAlertClass = "";
  function attackAlertEl(): HTMLElement | null {
    return win.document.getElementById("attack_alert");
  }
  function checkAttackAlertState(): void {
    const el = attackAlertEl();
    if (!el) return;
    const cls = el.className || "";
    if (cls === lastAttackAlertClass) return;
    const wasNo = /\bnoAttack\b/.test(lastAttackAlertClass);
    const isNo = /\bnoAttack\b/.test(cls);
    lastAttackAlertClass = cls;
    // Transition: noAttack → something else (threat appeared)
    if (wasNo && !isNo) {
      const title = el.getAttribute("title") || "";
      console.warn(`[OgameX/attack_alert] TRIANGLE FLASHED — class="${cls}" title="${title.slice(0, 200)}"`);
      // Inject a synthetic event so spy_detector / attack_detector / panel
      // alarm all fire. Use class-based heuristic: contains "spy/espion" →
      // spy; otherwise default attack (safer to escalate).
      const isSpy = /\b(?:spy|spying|espion|probe)\b/i.test(cls + " " + title);
      const id = `attack-alert-${Date.now()}`;
      const synthetic = {
        id,
        type: isSpy ? "spy" : "attack" as "spy" | "attack",
        hostile: !isSpy, // attack triggers full alarm; spy logs only (matches reference design)
        from: [0, 0, 0] as readonly [number, number, number],
        to: [0, 0, 0] as readonly [number, number, number],
        arrives_at: Math.floor(Date.now() / 1000),
        ships_count: "?" as const,
      };
      const cur = store.state.events_incoming ?? [];
      // Dedup: don't add if we already have an event with same id-prefix
      const otherSourced = cur.filter((e) => !e.id.startsWith("attack-alert-"));
      store.setPartial({ events_incoming: [...otherSourced, synthetic] });
    }
    // Transition: anything → noAttack (cleared)
    if (!wasNo && isNo) {
      console.info(`[OgameX/attack_alert] cleared`);
      // Remove any synthetic attack-alert events.
      const cur = store.state.events_incoming ?? [];
      const filtered = cur.filter((e) => !e.id.startsWith("attack-alert-"));
      if (filtered.length !== cur.length) {
        store.setPartial({ events_incoming: filtered });
      }
    }
  }
  // Initial snapshot + MutationObserver to react to class changes immediately.
  // Element may not exist at install time (overview not yet rendered) — retry.
  let mo: MutationObserver | null = null;
  function installAttackAlertObserver(): void {
    const el = attackAlertEl();
    if (!el) return;
    lastAttackAlertClass = el.className || "";
    mo = new (win as Window & { MutationObserver: typeof MutationObserver }).MutationObserver(() => checkAttackAlertState());
    mo.observe(el, { attributes: true, attributeFilter: ["class", "title"] });
    console.info(`[OgameX/attack_alert] observer installed, initial class="${lastAttackAlertClass}"`);
  }
  // Try install now; if element absent, retry every 1s until found.
  let installTries = 0;
  const installRetry = setInterval(() => {
    installTries += 1;
    if (attackAlertEl()) {
      installAttackAlertObserver();
      clearInterval(installRetry);
    } else if (installTries > 30) {
      clearInterval(installRetry);
    }
  }, 1000);
  installAttackAlertObserver();

  // ─── API poll: /eventList endpoint ───────────────────────────────────────
  // Operator: "改成 api 輪詢方式" + "Layer 2 不用保留". The previous
  // #eventContent MutationObserver was dropped entirely — API poll is the
  // only hostile detection source. /eventList?ajax=1 returns full HTML of
  // every event regardless of UI state. 3s active poll catches in-progress
  // probes reliably.
  let lastApiEventSig = "";
  // v0.0.728 — operator 2026-06-03 "不用任何评估，舰队到达都会触发事件，全
  // 事件驱动 为什么要有评估？". Track own-fleet event ids that we've already
  // fired arrival-refresh for, so each arrival fires exactly once per event
  // lifecycle. Cleared when the event id stops appearing in poll results
  // (= ogame's eventbox no longer tracking that leg).
  const firedArrivalRefreshes = new Set<string>();
  function parseEventListHTMLAndInject(html: string): void {
    // Parse via DOMParser into detached doc so we don't perturb the page.
    const parser = new (win as Window & { DOMParser: typeof DOMParser }).DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const rows = Array.from(doc.querySelectorAll<HTMLElement>("tr.eventFleet"));
    const hostileEntries: IncomingEvent[] = [];
    const seen: string[] = [];
    const seenOwnIds = new Set<string>();  // v0.0.728 — for prune of firedArrivalRefreshes
    const nowSec = Math.floor(Date.now() / 1000);
    // v0.0.729 — operator 2026-06-03 "回港时没有更新slots 是不是也没有更新
    // 星球资源？" + "后台没有拿到数据 远征没飞". eventbox row data-mission-type
    // is the ogame ground truth for live in-flight fleet mission distribution.
    // v0.0.733 — generalized from mission=15-only to per-mission. Drives
    // both used_expedition_slots refresh (mission=15) AND per-mission
    // synthetic prune (any mission), replacing the retired ttl-based path.
    const liveOwnByMission = new Map<number, number>();
    let liveOwnMission15 = 0;
    // v0.0.747 — operator 2026-06-04 "派了一队船上月球还是没有更新库存".
    // 前 4 轮 fix (v0.0.743-746) 全在 fleets_outbound 反查路径里挣扎,
    // 但 operator 手动 UI 派 fleet 完全绕过 recordFleetLaunch, fleets_outbound
    // 里根本没那条 row, pruneByMission 找不到 dest, ships 永远不刷.
    // FUNDAMENTAL FIX: eventbox row 本身就是 dest 的 ground truth (data-coords
    // & destFleet figure). 每次 poll snapshot {evId: dest meta}, drop 发生时
    // 反查上次还在但这次没的 evId, 用 prev meta 里的 dest 直接 refresh.
    // 完全不依赖 fleets_outbound (它的 dual-source / wipe-replace pathology
    // 都被旁路).
    const currOwnFleetMeta = new Map<string, { destCoords: [number, number, number]; destType: "planet" | "moon" }>();
    for (const tr of rows) {
      const mt = parseInt(tr.getAttribute("data-mission-type") ?? "0", 10);
      const evId = tr.getAttribute("id")?.replace(/^eventRow-/, "") ?? "";
      const cd = tr.querySelector(".countDown span");
      const cls = (cd?.className ?? "").toLowerCase();
      const isHostile = /\bhostile\b/.test(cls);
      seen.push(`${evId}:${mt}:${cls.slice(0, 16)}`);
      if (!isHostile) {
        liveOwnByMission.set(mt, (liveOwnByMission.get(mt) ?? 0) + 1);
        if (mt === 15) liveOwnMission15++;
        // v0.0.747 snapshot own-fleet row dest meta for arrival-by-disappearance.
        if (evId) {
          const dsTxt = tr.querySelector(".destCoords")?.textContent?.trim() ?? "";
          const dsM = dsTxt.match(/\[(\d+):(\d+):(\d+)\]/);
          if (dsM) {
            const dCoords: [number, number, number] = [parseInt(dsM[1]!, 10), parseInt(dsM[2]!, 10), parseInt(dsM[3]!, 10)];
            const destFleetEl = tr.querySelector(".destFleet, td.destFleet");
            const destFigureClass = destFleetEl?.querySelector("figure")?.className ?? "";
            const destHtml = destFleetEl?.innerHTML ?? "";
            const isMoonDest = /\bmoon\b/i.test(destFigureClass) || /planetIcon[^"]*\bmoon\b/i.test(destHtml);
            currOwnFleetMeta.set(evId, { destCoords: dCoords, destType: isMoonDest ? "moon" : "planet" });
          }
        }
      }
      // v0.0.728 — operator "全事件驱动 为什么要有评估？". Own-fleet rows
      // (countdown not hostile) carry data-arrival-time. When that ticks
      // past 'now' we know the fleet arrived at dest. Fire dest planet
      // refresh exactly once per event lifecycle (firedArrivalRefreshes
      // dedup). Replaces the v0.0.727 setTimeout(arrivalEtaMs) heuristic.
      if (!isHostile && evId) {
        seenOwnIds.add(evId);
        const arrAt = parseInt(tr.getAttribute("data-arrival-time") ?? "0", 10);
        if (arrAt > 0 && arrAt <= nowSec && !firedArrivalRefreshes.has(evId)) {
          firedArrivalRefreshes.add(evId);
          const dsTxt = tr.querySelector(".destCoords")?.textContent?.trim() ?? "";
          const dsM = dsTxt.match(/\[(\d+):(\d+):(\d+)\]/);
          if (dsM) {
            const dCoords: [number, number, number] = [parseInt(dsM[1]!, 10), parseInt(dsM[2]!, 10), parseInt(dsM[3]!, 10)];
            const destFleetEl = tr.querySelector(".destFleet, td.destFleet");
            const destFigureClass = destFleetEl?.querySelector("figure")?.className ?? "";
            const destHtml = destFleetEl?.innerHTML ?? "";
            const isMoonDest = /\bmoon\b/i.test(destFigureClass) || /planetIcon[^"]*\bmoon\b/i.test(destHtml);
            const dType: "planet" | "moon" = isMoonDest ? "moon" : "planet";
            // Look up planet id in store by coord + type; if found, fire its refresh.
            const planets = (store.state.planets ?? {}) as Record<string, { id?: string; coords?: readonly number[]; type?: string }>;
            const destPlanet = Object.values(planets).find((p) => {
              const c = p.coords;
              if (!Array.isArray(c) || c.length !== 3) return false;
              return c[0] === dCoords[0] && c[1] === dCoords[1] && c[2] === dCoords[2] && (p.type ?? "planet") === dType;
            });
            const destPlanetId = destPlanet?.id;
            if (destPlanetId) {
              const pushNow = (win as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow;
              const refreshPlanet = (win as Window & {
                __ogamexRefreshPlanetResources?: (pid: string) => Promise<void>;
              }).__ogamexRefreshPlanetResources;
              // v0.0.728 — operator "舰队到达也要刷新 slots". 抵达事件触发
              // dest planet 资源刷新 + galaxy JSON slot 刷新, 跟出发对称。
              const refreshSlots = (win as Window & {
                __ogamexRefreshSlots?: () => Promise<void>;
              }).__ogamexRefreshSlots;
              if (typeof refreshPlanet === "function") {
                console.info(`[OgameX/eventbox-hook] own fleet arrival evId=${evId} → dest planet ${destPlanetId} (${dCoords.join(":")}/${dType}) → firing cp-protected resource + slot refresh`);
                void refreshPlanet(destPlanetId)
                  .then(() => { if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } } });
              } else {
                console.warn(`[OgameX/eventbox-hook] own arrival ${evId} dest ${destPlanetId} — refreshPlanet hook absent`);
              }
              if (typeof refreshSlots === "function") {
                void refreshSlots()
                  .then(() => { if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } } });
              }
            }
          }
        }
      }
      if (!isHostile) continue;
      const isThreat = mt === 1 || mt === 2 || mt === 9 || mt === 10;
      const isSpy = mt === 6;
      if (!isThreat && !isSpy) continue;
      const orCoords = tr.querySelector(".coordsOrigin")?.textContent?.trim() ?? "";
      const dsCoords = tr.querySelector(".destCoords")?.textContent?.trim() ?? "";
      const parse3 = (s: string): readonly [number, number, number] => {
        const m = s.match(/\[(\d+):(\d+):(\d+)\]/);
        return m ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] as const : [0, 0, 0] as const;
      };
      const arr = parseInt(tr.getAttribute("data-arrival-time") ?? "0", 10);
      // Operator 2026-05-25: extract dest body type so emergency orchestrator
      // can pick the right source (planet vs moon at same G:S:P). ogame
      // event row destination column has either a planet or moon figure.
      // Defensive multi-pattern match — first hit wins, default "planet".
      const destFleetEl = tr.querySelector(".destFleet, td.destFleet");
      const destFigureClass = destFleetEl?.querySelector("figure")?.className ?? "";
      const destHtml = destFleetEl?.innerHTML ?? "";
      const isMoonDest =
        /\bmoon\b/i.test(destFigureClass)
        || /planetIcon[^"]*\bmoon\b/i.test(destHtml)
        || /\b(?:tooltipMoon|icon_moon|moon_destination)\b/i.test(destHtml)
        || /<a[^>]*data-fleet-type="3"/i.test(destHtml);
      const to_type: "planet" | "moon" = isMoonDest ? "moon" : "planet";
      hostileEntries.push({
        id: `evrow-${evId}`,
        type: isSpy ? "spy" : "attack",
        hostile: true,
        from: parse3(orCoords),
        to: parse3(dsCoords),
        to_type,
        arrives_at: arr,
        ships_count: "?",
      });
    }
    // v0.0.728 — prune firedArrivalRefreshes: drop ids no longer in poll
    // (ogame deleted that leg from its eventbox → cycle complete, safe to
    // re-fire if the id ever reappears for a new launch).
    for (const id of [...firedArrivalRefreshes]) {
      if (!seenOwnIds.has(id)) firedArrivalRefreshes.delete(id);
    }
    // v0.0.729 — publish live eventbox-derived expedition count + trigger
    // slot refresh whenever it changes. This is the AUTHORITATIVE source
    // for used_expedition_slots — synthetic-fleet count is only a UI
    // hint, not ground truth (synthetics expire via stale ttl estimate).
    // v0.0.733 — operator "synthetic.return_at = launch+90min 这个没用就删了吧":
    // per-mission count tracking. Compare previous poll's per-mission map to
    // current. For each mission whose count DROPPED by N, fire
    // __ogamexPruneByMission(mission, N) to FIFO-remove N oldest synthetics
    // with that mission. Mission=15 also drives refreshSlots (live expedition
    // count = authoritative used_expedition_slots).
    const winT = win as Window & {
      __ogamexLiveExpeditionCount?: number;
      __ogamexLiveOwnByMission?: Map<number, number>;
      __ogamexLiveOwnFleetMeta?: Map<string, { destCoords: [number, number, number]; destType: "planet" | "moon" }>;
      __ogamexRefreshSlots?: () => Promise<void>;
      __ogamexPushNow?: () => void;
      __ogamexPruneByMission?: (mission: number, n: number) => void;
      __ogamexRefreshPlanetResources?: (pid: string) => Promise<void>;
    };
    const prevLiveByMission = winT.__ogamexLiveOwnByMission ?? new Map<number, number>();
    const prevLiveExp = winT.__ogamexLiveExpeditionCount;
    const prevOwnFleetMeta = winT.__ogamexLiveOwnFleetMeta ?? new Map<string, { destCoords: [number, number, number]; destType: "planet" | "moon" }>();
    winT.__ogamexLiveOwnByMission = liveOwnByMission;
    winT.__ogamexLiveExpeditionCount = liveOwnMission15;
    winT.__ogamexLiveOwnFleetMeta = currOwnFleetMeta;
    // Per-mission drop detection — only if we've seen at least one prior poll.
    const drops: Array<{ mission: number; n: number }> = [];
    if (prevLiveByMission.size > 0) {
      for (const [mt, prevN] of prevLiveByMission) {
        const curN = liveOwnByMission.get(mt) ?? 0;
        if (curN < prevN) drops.push({ mission: mt, n: prevN - curN });
      }
    }
    if (drops.length > 0) {
      if (typeof winT.__ogamexPruneByMission === "function") {
        for (const { mission: mt, n } of drops) {
          try { winT.__ogamexPruneByMission(mt, n); } catch (e) { console.warn(`[OgameX/eventbox-hook] pruneByMission(${mt},${n}) threw`, e); }
        }
      }
    }
    // v0.0.747 — arrival-by-disappearance: fleet row 在 ogame eventbox 消失
    // = 抵达目的地. prev poll 见过该 evId, 当前 poll 没见到 → fire dest
    // refresh from prev meta. 不依赖 fleets_outbound, 不依赖 recordFleetLaunch.
    // Handles BOTH: chain dispatch (走 sendFleet) + operator 手动 UI 派 fleet.
    if (prevOwnFleetMeta.size > 0) {
      const disappeared: Array<{ evId: string; destCoords: [number, number, number]; destType: "planet" | "moon" }> = [];
      for (const [evId, meta] of prevOwnFleetMeta) {
        if (!currOwnFleetMeta.has(evId)) disappeared.push({ evId, ...meta });
      }
      if (disappeared.length > 0 && typeof winT.__ogamexRefreshPlanetResources === "function") {
        const planetsMap = (store.state.planets ?? {}) as Record<string, { id?: string; coords?: readonly number[]; type?: string }>;
        const refreshedDestIds = new Set<string>();
        for (const { evId, destCoords, destType } of disappeared) {
          const dest = Object.values(planetsMap).find((p) => {
            const c = p.coords;
            if (!Array.isArray(c) || c.length !== 3) return false;
            return c[0] === destCoords[0] && c[1] === destCoords[1] && c[2] === destCoords[2] && (p.type ?? "planet") === destType;
          });
          if (dest?.id && !refreshedDestIds.has(dest.id)) {
            refreshedDestIds.add(dest.id);
            console.info(`[OgameX/eventbox-hook] arrival-by-disappearance evId=${evId} → dest ${dest.id} (${destCoords.join(":")}/${destType}) → refresh`);
            void winT.__ogamexRefreshPlanetResources(dest.id).then(() => {
              if (typeof winT.__ogamexPushNow === "function") { try { winT.__ogamexPushNow(); } catch { /* */ } }
            });
          } else if (!dest?.id) {
            console.warn(`[OgameX/eventbox-hook] arrival-by-disappearance evId=${evId} dest ${destCoords.join(":")}/${destType} — no planet match in store.planets`);
          }
        }
      }
    }
    // v0.0.734 — operator 2026-06-03 "舰队到港没有刷新slots 导致后台和前台
    // 不同步 让远征飞不起来". v0.0.733 bug: refreshSlots only fired on
    // mission=15 change. But galaxy's used_fleet_slots reflects ALL
    // missions — transport (mission=3) return drops total fleet count,
    // sidecar's used_fleet_slots stays stale high, fleet_slot_gate fails,
    // expedition can't dispatch. Fix: refreshSlots ANY time the total
    // own-fleet count changes (drop OR addition), not just mission=15.
    // Total = sum of liveOwnByMission entries.
    const prevTotal = Array.from(prevLiveByMission.values()).reduce((a, b) => a + b, 0);
    const curTotal = Array.from(liveOwnByMission.values()).reduce((a, b) => a + b, 0);
    if (prevTotal !== curTotal) {
      // v0.0.735 — operator "不能用api获取吗 不要扫网页". DOM scrape
      // (harvestSlots) RETIRED. refreshSlots = galaxy JSON ajax, owns
      // both fleet AND expedition slot fields (probes for native API
      // fields in sys.usedExpeditionSlots; falls back to synthetic
      // mission=15 count capped at expMax). No DOM access.
      if (typeof winT.__ogamexRefreshSlots === "function") {
        void winT.__ogamexRefreshSlots().finally(() => { if (typeof winT.__ogamexPushNow === "function") { try { winT.__ogamexPushNow(); } catch { /* */ } } });
      }
      const perMissionTag = Array.from(liveOwnByMission.entries()).map(([m, n]) => `m${m}=${n}`).join(",");
      console.info(`[OgameX/eventbox-hook] total own-fleet ${prevTotal}→${curTotal} (${perMissionTag}) → refreshSlots(galaxy api)${drops.length > 0 ? ` + prune ${drops.map((d) => `m${d.mission}=-${d.n}`).join(",")}` : ""}`);
    } else if (drops.length > 0) {
      // Should be impossible (drop without total change means addition+drop
      // cancel out, exotic), but log for diagnosis.
      console.info(`[OgameX/eventbox-hook] per-mission drops without total change: ${drops.map((d) => `m${d.mission}=-${d.n}`).join(",")}`);
    }
    const sig = seen.sort().join("|");
    if (sig === lastApiEventSig) return;
    lastApiEventSig = sig;
    if (hostileEntries.length > 0) {
      console.warn(`[OgameX/eventlist-api] ${hostileEntries.length} hostile row(s): ${hostileEntries.map(e => {
        const eta = e.arrives_at - nowSec;
        return `${e.type}@${e.from.join(":")}→${e.to.join(":")} ETA=${eta}s ${eta > 0 ? "(IN-PROGRESS)" : "(ARRIVED)"}`;
      }).join(", ")}`);
    }
    // Merge into events_incoming — same logic as DOM observer.
    const cur = store.state.events_incoming ?? [];
    const fromOther = cur.filter((e) => !e.id.startsWith("evrow-"));
    const stillPending = cur.filter((e) =>
      e.id.startsWith("evrow-") && e.arrives_at > nowSec
    );
    const byId = new Map<string, typeof stillPending[number]>();
    for (const e of stillPending) byId.set(e.id, e);
    for (const e of hostileEntries) byId.set(e.id, e);
    const merged = [...fromOther, ...Array.from(byId.values())];
    if (JSON.stringify(merged.map((e) => e.id).sort()) !== JSON.stringify(cur.map((e) => e.id).sort())) {
      store.setPartial({ events_incoming: merged });
    }
  }
  async function pollEventListAPI(): Promise<void> {
    try {
      const url = "/game/index.php?page=componentOnly&component=eventList&ajax=1";
      const r = await win.fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!r.ok) return;
      const html = await r.text();
      parseEventListHTMLAndInject(html);
    } catch (e) {
      console.warn(`[OgameX/eventlist-api] poll failed:`, e);
    }
  }
  // 3s active poll — catches probes during their typical 5-30s in-flight
  // window. ogame's own native fetchEventBox poll is 5s; using a separate
  // endpoint (eventList vs fetchEventBox) so we don't pile requests on the
  // same URL that WAF watches.
  setTimeout(() => { void pollEventListAPI(); }, 800); // boot seed
  const apiPollId = setInterval(() => { void pollEventListAPI(); }, 3000);

  // Cold-start seed — kick off one fetch so the hook starts seeing data.
  setTimeout(() => { void selfFetch(); }, 1500);

  return {
    stop(): void {
      stopped = true;
      clearInterval(watchdogId);
      clearInterval(installRetry);
      clearInterval(apiPollId);
      if (mo) { mo.disconnect(); mo = null; }
      win.document.removeEventListener("visibilitychange", visHandler);
      // Prototype patches intentionally not reverted (best-effort).
    },
    lastNativeHitAt(): number {
      return lastNativeHit;
    },
  };
}
