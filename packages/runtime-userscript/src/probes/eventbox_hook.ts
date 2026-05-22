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
 *   1 = 普通攻击 (regular attack)
 *   2 = 联合攻击 ACS
 *   9 = 月毁 (moon destruction)
 *   10 = 行星间导弹 (interplanetary missile)
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

function parseEventBoxResponse(text: string, ownPlayerId: number | null): IncomingEvent[] {
  if (!text || typeof text !== "string") return [];
  let data: { events?: OgameEventLike[]; event?: OgameEventLike[]; html?: string; eventBox?: string; eventbox?: string; content?: string; [k: string]: unknown } | null = null;
  try { data = JSON.parse(text); } catch { /* HTML path */ }
  const out: IncomingEvent[] = [];

  // PATH 1: structured events array
  let events: OgameEventLike[] | null = null;
  if (data) {
    if (Array.isArray(data.events)) events = data.events;
    else if (Array.isArray(data.event)) events = data.event;
    else if (data.events && typeof data.events === "object" && Array.isArray((data.events as { list?: OgameEventLike[] }).list)) {
      events = (data.events as { list: OgameEventLike[] }).list;
    }
  }
  if (events) {
    for (const ev of events) {
      const m = parseInt(String(ev.mission ?? ev.missionType ?? ev.type ?? 0), 10);
      if (!Number.isFinite(m)) continue;
      // Skip own returning fleets.
      if (ev.return || ev.isReturn || ev.returnFleet) continue;
      // Skip own fleets by playerId.
      const ownerId = parseInt(String(ev.playerId ?? ev.ownerId ?? ev.owner ?? ev.fromPlayerId ?? 0), 10);
      if (ownPlayerId && ownerId === ownPlayerId) continue;
      // Skip explicitly friendly/neutral/own.
      if (ev.friendly === true || ev.isFriendly === true || ev.own === true) continue;
      const evType = String(ev.type || ev.relation || ev.kind || "").toLowerCase();
      if (evType === "friendly" || evType === "neutral" || evType === "own") continue;
      // Include only threats + spy.
      const isThreat = THREAT_MISSIONS.has(m);
      const isSpy = m === SPY_MISSION;
      if (!isThreat && !isSpy) continue;
      const from = parseCoordsStr(ev.coordsOrigin ?? ev.origin) ?? [0, 0, 0] as const;
      const to = parseCoordsStr(ev.coordsDest ?? ev.dest ?? ev.to) ?? [0, 0, 0] as const;
      const arrives = parseInt(String(ev.arrivalTime ?? ev.arrival_time ?? ev.arrives_at ?? 0), 10);
      const id = String(ev.id ?? `evbox-${m}-${arrives}-${from.join(":")}`);
      out.push({
        id,
        type: MISSION_TYPE_MAP[m] ?? "unknown",
        hostile: isThreat,  // spy → false (no alarm; per reference design)
        from, to,
        arrives_at: arrives,
        ships_count: "?",
      });
    }
  }

  // PATH 2: HTML payload — same parser shape as DOM extractor.
  const html = (data && (data.html || data.eventBox || data.eventbox || data.content)) || text;
  if (typeof html === "string" && out.length === 0) {
    const rowRe = /<(?:li|tr|div)\b[^>]*\bdata-mission-type=["']?(\d+)["']?[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html)) !== null) {
      const mt = parseInt(m[1]!, 10);
      const isThreat = THREAT_MISSIONS.has(mt);
      const isSpy = mt === SPY_MISSION;
      if (!isThreat && !isSpy) continue;
      const tag = m[0];
      if (/\b(?:return|backFleet|countDown)\b/i.test(tag)) continue;
      // For threats, REQUIRE explicit "hostile" class — neutrals/friendlies skip.
      if (isThreat && !/\bhostile\b/i.test(tag)) continue;
      // Pull data-event-id + data-arrival-time + coord attrs if present.
      const idMatch = tag.match(/data-event-id=["']?(\d+)["']?/);
      const arrMatch = tag.match(/data-arrival-time=["']?(\d+)["']?/);
      const fromMatch = tag.match(/data-coords-origin=["']?([\d:]+)["']?/);
      const toMatch = tag.match(/data-coords-dest=["']?([\d:]+)["']?/);
      const from = parseCoordsStr(fromMatch?.[1]) ?? [0, 0, 0] as const;
      const to = parseCoordsStr(toMatch?.[1]) ?? [0, 0, 0] as const;
      const arrives = arrMatch ? parseInt(arrMatch[1]!, 10) : 0;
      out.push({
        id: idMatch?.[1] ?? `htmlrow-${mt}-${arrives}-${from.join(":")}`,
        type: MISSION_TYPE_MAP[mt] ?? "unknown",
        hostile: isThreat,
        from, to,
        arrives_at: arrives,
        ships_count: "?",
      });
    }
  }

  return out;
}

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

  function applyResponse(text: string): void {
    if (stopped) return;
    const events = parseEventBoxResponse(text, ownPlayerId());
    // Only update if we recognized something (avoid wiping live events_incoming
    // with empty on every non-eventList response that slipped through filter).
    if (events.length === 0) return;
    const sig = events.map((e) => `${e.id}:${e.arrives_at}:${e.hostile ? "H" : "S"}`).sort().join(",");
    if (sig === lastSig) return;
    lastSig = sig;
    // MERGE with existing — keep entries from other sources (e.g. mail-poller)
    // by id prefix. Hook-sourced events have stable ogame IDs; mail-poller (when
    // added) should prefix with "mail-".
    const cur = store.state.events_incoming ?? [];
    const otherSourced = cur.filter((e) => e.id.startsWith("mail-") || e.id.startsWith("drill-"));
    store.setPartial({ events_incoming: [...otherSourced, ...events] });
    const hostileCount = events.filter((e) => e.hostile).length;
    const spyCount = events.filter((e) => e.type === "spy").length;
    if (hostileCount > 0 || spyCount > 0) {
      console.warn(`[OgameX/eventbox-hook] ${events.length} events: hostile=${hostileCount} spy=${spyCount}`);
    }
  }

  function isEventBoxURL(url: string): boolean {
    return url.includes("eventList") || url.includes("fetchEventBox") ||
           url.includes("component=eventList") || url.includes("checkEvents");
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
        }
      } catch { /* */ }
      return res;
    };
  }

  // --- watchdog: self-fetch when ogame poll stalls ---
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

  // Cold-start seed — kick off one fetch so the hook starts seeing data.
  setTimeout(() => { void selfFetch(); }, 1500);

  return {
    stop(): void {
      stopped = true;
      clearInterval(watchdogId);
      win.document.removeEventListener("visibilitychange", visHandler);
      // Prototype patches intentionally not reverted (best-effort).
    },
    lastNativeHitAt(): number {
      return lastNativeHit;
    },
  };
}
