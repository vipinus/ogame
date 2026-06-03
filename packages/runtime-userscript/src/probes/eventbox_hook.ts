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
        console.info(`[OgameX/eventbox-hook] friendly fleet count ${isFirstSeed ? "(boot seed)" : before}→${n}, firing official-API slot refresh + /movement scrape${n < before ? " + empire pollEmpire + state push (fleet finished)" : ""}`);
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
        // Operator 2026-05-25: "有船到達事件發生，就刷新艦隊庫存".
        if (n < before) {
          const pollEmp = (win as Window & { __ogamexPollEmpire?: (opts?: { force?: boolean }) => Promise<void> }).__ogamexPollEmpire;
          if (typeof pollEmp === "function") void pollEmp({ force: true }).then(triggerImmediatePush).catch(() => { /* */ });
        }
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
  function parseEventListHTMLAndInject(html: string): void {
    // Parse via DOMParser into detached doc so we don't perturb the page.
    const parser = new (win as Window & { DOMParser: typeof DOMParser }).DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const rows = Array.from(doc.querySelectorAll<HTMLElement>("tr.eventFleet"));
    const hostileEntries: IncomingEvent[] = [];
    const seen: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    for (const tr of rows) {
      const mt = parseInt(tr.getAttribute("data-mission-type") ?? "0", 10);
      const evId = tr.getAttribute("id")?.replace(/^eventRow-/, "") ?? "";
      const cd = tr.querySelector(".countDown span");
      const cls = (cd?.className ?? "").toLowerCase();
      const isHostile = /\bhostile\b/.test(cls);
      seen.push(`${evId}:${mt}:${cls.slice(0, 16)}`);
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
