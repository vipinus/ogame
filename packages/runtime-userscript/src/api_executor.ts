/**
 * ApiDirectiveExecutor — fetch-POST to ogame's AJAX endpoints directly.
 *
 * Replaces the iframe + DOM-click pipeline (UiDirectiveExecutor) which
 * was brittle against ogame DOM variants. This one talks to ogame's
 * own AJAX URLs with same-origin cookies, no UI required.
 *
 * Endpoint map (ogame v12):
 *   research   POST ?page=ingame&component=research&modus=1&type=<id>     body: token
 *   supplies   POST ?page=ingame&component=supplies&modus=1&type=<id>     body: token
 *   facilities POST ?page=ingame&component=facilities&modus=1&type=<id>   body: token
 *   shipyard   POST ?page=ingame&component=shipyard&modus=1&type=<id>     body: token, menge
 *   fleetdispatch  POST ?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1
 *                  body: token, mission=15, speed=10, galaxy, system, position=16,
 *                        type=1, am<shipId>=<n>..., metal=0, crystal=0, deuterium=0
 *
 * Token strategy: fetch the target component's HTML once before each
 * operation to scrape the page's fresh `<input name="token" value="...">`.
 * ogame rotates tokens per page load; reusing main-page token usually
 * fails with "token invalid".
 */
import type { Directive } from "@ogamex/shared";
import { TECH_ID_BY_NAME } from "@ogamex/shared";
import type { DirectiveExecutor } from "./directive_executor_iface.js";
import { cacheShipsData } from "./api/ship_cargo_cache.js";
import { fetchWithCpBypassBusy, restoreSessionCp } from "./api/safe_fetch.js";

export interface ApiExecutorDeps {
  win: Window;
  doc: Document;
  fetch?: typeof fetch;
}

// Sourced from shared/tech_ids.ts — single source of truth for tech IDs.
const OGAME_NUMERIC_ID: Record<string, number> = TECH_ID_BY_NAME;

const FACILITY_NAMES = new Set([
  "shipyard", "researchLab", "roboticsFactory", "naniteFactory",
  "allianceDepot", "missileSilo",
]);

export class ApiDirectiveExecutor implements DirectiveExecutor {
  private readonly win: Window;
  private readonly doc: Document;
  private readonly fetchFn: typeof fetch;
  private lastUserActivityTs = 0;
  private lastNavTs = 0;

  constructor(deps: ApiExecutorDeps) {
    this.win = deps.win;
    this.doc = deps.doc;
    this.fetchFn = deps.fetch ?? deps.win.fetch.bind(deps.win);
    const onAct = (e: Event): void => {
      if (!e.isTrusted) return; // ignore synthetic clicks we fire ourselves
      this.lastUserActivityTs = Date.now();
    };
    deps.doc.addEventListener("mousedown", onAct, true);
    deps.doc.addEventListener("keydown", onAct, true);
    // Operator 2026-05-27: expose discover-cooldown lookup so GoalRunner
    // can early-skip cooldown coords BEFORE entering exec queue.
    (this.win as Window & { __ogamexCheckDiscoverCooldown?: (g: number, s: number, p: number) => "available" | "cooldown" | "unavailable" | "unknown" })
      .__ogamexCheckDiscoverCooldown = (galaxy, system, position) => {
        const w = this.win as Window & { __ogamexGalaxyDiscovery?: Map<string, { ts: number; states: Map<number, string> }> };
        const cache = w.__ogamexGalaxyDiscovery?.get(`${galaxy}:${system}`);
        if (!cache || Date.now() - cache.ts > 30 * 60 * 1000) return "unknown";
        const st = cache.states.get(position);
        if (st === "available") return "available";
        if (st === "cooldown") return "cooldown";
        if (st === "unavailable") return "unavailable";
        return "unknown";
      };
  }

  canHandle(d: Directive): boolean {
    return d.method === "ui" && ["build", "research", "build_ships", "expedition", "colonize", "deploy", "transport", "discover"].includes(d.action);
  }

  /** Read persisted ogame API captures from sniffer (cross-context via
   *  document.documentElement.dataset). Returns most recent matching call. */
  private findCapturedApiCall(predicate: (rec: { url: string; body: string }) => boolean): { url: string; body: string } | null {
    try {
      const raw = (this.doc.documentElement as HTMLElement).dataset["ogamexCaptures"];
      if (!raw) return null;
      const arr = JSON.parse(raw) as Array<{ url: string; body: string; ts: number }>;
      // newest first
      for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i]!)) return arr[i]!;
      }
    } catch { /* malformed */ }
    return null;
  }

  /** Replay a captured ogame API call with token + numeric substitution. */
  private async replayCapture(captured: { url: string; body: string }, substitutions: Record<string, string>): Promise<{ status: number; body: string }> {
    let url = captured.url;
    let body = captured.body;
    // Substitute keys like type=X, menge=Y, am202=N etc.
    for (const [k, v] of Object.entries(substitutions)) {
      const reUrl = new RegExp(`(${k}=)[^&]*`, "g");
      url = url.replace(reUrl, `$1${v}`);
      const reBody = new RegExp(`(${k}=)[^&]*`, "g");
      body = body.replace(reBody, `$1${v}`);
    }
    // Always refresh token from latest dataset if present.
    const r = await this.fetchFn(url, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body
        ? { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" }
        : { "X-Requested-With": "XMLHttpRequest" },
      body: body || undefined,
    });
    const txt = await r.text();
    return { status: r.status, body: txt };
  }

  async execute(directive: Directive): Promise<{ action: string; clicked: boolean }> {
    // expedition uses source_planet (not planet_id) — accept either.
    const planetId =
      (directive.params as { planet_id?: string }).planet_id
      ?? (directive.params as { source_planet?: string }).source_planet;
    if (!planetId) throw new Error(`api: no planet_id for ${directive.action}`);

    // Operator 2026-05-25: "调用api也必须切星球吗？" — yes, ogame's cp=
    // in URL switches session-cp regardless of ajax/HTML. ALL action
    // handlers below carry cp=<sourcePlanet> in their POSTs, which
    // shifts the operator's tab too. Capture original session-cp here
    // (operator's view) and restore via try/finally so every action,
    // not just discover, leaves the operator on their planet.
    const operatorCp = this.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? null;
    const inner = async (): Promise<{ action: string; clicked: boolean }> => {
      if (directive.action === "expedition") return this.execExpedition(directive, planetId);
      if (directive.action === "colonize") return this.execColonize(directive, planetId);
      if (directive.action === "deploy" || directive.action === "transport") {
        return this.execFleetSend(directive, planetId);
      }
      if (directive.action === "discover") return this.execDiscover(directive, planetId);
      return this.execLegacy(directive, planetId);
    };
    try {
      return await inner();
    } finally {
      await this.restoreSessionCp(operatorCp, planetId);
    }
  }

  /** Old replay/capture path for non-fleet actions (build/research/etc).
   *  Wrapped out of execute() so the outer try/finally can restore cp. */
  private async execLegacy(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean }> {

    // TIER 1 — replay sniffer-captured ogame URL if seen. ogame's own
    // click triggers the REAL endpoint with EXACT format; we just copy.
    const captured = this.findCapturedApiCall((rec) => {
      const u = rec.url;
      if (directive.action === "research") return /component=research/.test(u) && /modus|action=upgrade|action=build/.test(u);
      if (directive.action === "build_ships") return /component=shipyard/.test(u) && (/menge/.test(u + rec.body) || /am\d+/.test(rec.body));
      if (directive.action === "build") {
        const b = (directive.params as { building?: string }).building ?? "";
        const FAC = new Set(["shipyard", "researchLab", "roboticsFactory", "naniteFactory", "allianceDepot", "missileSilo"]);
        const comp = FAC.has(b) ? "facilities" : "supplies";
        return new RegExp(`component=${comp}`).test(u) && /modus|action=upgrade|action=build/.test(u);
      }
      if (directive.action === "expedition") return /component=fleetdispatch/.test(u) && /action=sendFleet|am\d+/.test(rec.body + u);
      return false;
    });
    if (captured) {
      const subs: Record<string, string> = {};
      if (directive.action === "build_ships") {
        const ship = (directive.params as { ship?: string }).ship ?? "";
        const amount = ((): number => {
          const a = (directive.params as { amount?: unknown }).amount;
          return typeof a === "number" && a > 0 ? Math.floor(a) : 1;
        })();
        subs["type"] = String(OGAME_NUMERIC_ID[ship] ?? "");
        subs["menge"] = String(amount);
      } else if (directive.action === "research") {
        const tech = (directive.params as { tech?: string }).tech ?? "";
        subs["type"] = String(OGAME_NUMERIC_ID[tech] ?? "");
      } else if (directive.action === "build") {
        const building = (directive.params as { building?: string }).building ?? "";
        subs["type"] = String(OGAME_NUMERIC_ID[building] ?? "");
      }
      console.info(`[ApiExec/replay] tier1 hit ${captured.url.slice(0,100)} subs=${JSON.stringify(subs)}`);
      const result = await this.replayCapture(captured, subs);
      console.info(`[ApiExec/replay] resp HTTP ${result.status} body[0:200]=${result.body.slice(0,200).replace(/\s+/g," ")}`);
      return { action: directive.action, clicked: true };
    }
    // TIER 2 — fall through to inline handlers (GET-based guesses).
    if (directive.action === "research")    return this.execSimpleUpgrade("research", directive, planetId);
    if (directive.action === "build_ships") return this.execShipBuild(directive, planetId);
    if (directive.action === "build") {
      const building = (directive.params as { building?: string }).building ?? "";
      const techId = (directive.params as { technology_id?: number }).technology_id ?? 0;
      // Lifeform buildings (111xx-141xx range) need component=lfbuildings
      // for token validation. Regular buildings split supplies/facilities.
      const isLifeform = techId >= 11000 && techId <= 15000;
      const component = isLifeform ? "lfbuildings"
                      : FACILITY_NAMES.has(building) ? "facilities"
                      : "supplies";
      return this.execSimpleUpgrade(component as "research" | "supplies" | "facilities", directive, planetId);
    }
    throw new Error(`api: unsupported ${directive.action}`);
  }

  // Live-DOM click + menu nav + URL wait paths REMOVED (v0.0.222).
  // Operator directive: 装 A — full API化, 删 DOM 点击 fallback.
  // Audit found these methods (tryLivePageClick / tryLivePageClickAsync /
  // kickMenuNav / waitForUrl) were never called by execute() — execute()
  // already uses captures-replay (TIER 1) or fetchTokenAndStatus-based
  // execSimpleUpgrade/execShipBuild (TIER 2), both pure HTTP. Dead code.
  //
  // For fresh CSRF token without a SPA nav, fetchTokenAndStatus does a
  // background GET /game/index.php?page=ingame&component=X&cp=PID and
  // extracts the token from response HTML. No page change.

  /** Fetch a fresh CSRF token + check ogame status for the target tech. */
  private async fetchTokenAndStatus(
    component: string,
    planetId: string,
    numericId: number,
  ): Promise<{ token: string; status: string | null; reason: string | null }> {
    const resp = await fetchWithCpBypassBusy(
      `/game/index.php?page=ingame&component=${component}`,
      { credentials: "same-origin" },
      planetId,
      { skipRestore: true },  // outer execute() does single restore
    );
    const html = await resp.text();
    // Token can be in: hidden input, meta tag, or inline JS var. Try all.
    const tokenMatch =
      html.match(/<input[^>]*name="token"[^>]*value="([^"]+)"/i)
      ?? html.match(/<input[^>]*value="([^"]+)"[^>]*name="token"/i)
      ?? html.match(/<meta[^>]*name="ogame-token"[^>]*content="([^"]+)"/i)
      ?? html.match(/['"]?token['"]?\s*[:=]\s*['"]([a-zA-Z0-9]{16,})['"]/i)
      ?? html.match(/ajaxToken\s*=\s*['"]([^'"]+)['"]/i);
    if (!tokenMatch) {
      console.warn(`[ApiExec] token not found in ${component} page HTML (${html.length}B). First 500 chars: ${html.slice(0, 500)}`);
      throw new Error(`api: token not found on ${component} page`);
    }
    const token = tokenMatch[1]!;
    // Carve out the <li> block for this tech so we can scan its attrs
    // AND its inner upgrade button's href (which contains the EXACT
    // server-side action URL — no guessing modus / param order).
    const liStartIdx = html.indexOf(`data-technology="${numericId}"`);
    let liBlock = "";
    if (liStartIdx > -1) {
      const open = html.lastIndexOf("<li", liStartIdx);
      const close = html.indexOf("</li>", liStartIdx);
      if (open > -1 && close > -1) liBlock = html.slice(open, close + 5);
    }
    const statusMatch = liBlock.match(/data-status="([^"]+)"/i);
    const tooltipMatch = liBlock.match(/data-tooltip-title="([^"]+)"/i);
    const hrefMatch =
      liBlock.match(/href="([^"]*(?:modus=|action=upgrade|action=build)[^"]*)"/i)
      ?? liBlock.match(/data-action="([^"]+)"/i);
    let actionUrl: string | null = null;
    if (hrefMatch) {
      actionUrl = hrefMatch[1]!.replace(/&amp;/g, "&");
      // Strip absolute origin if present so we POST same-origin.
      actionUrl = actionUrl.replace(/^https?:\/\/[^/]+/, "");
      if (!actionUrl.startsWith("/")) actionUrl = "/game/" + actionUrl.replace(/^\.?\//, "");
      console.info(`[ApiExec] ${component}:${numericId} action URL from page DOM: ${actionUrl.slice(0, 140)}`);
    }
    return {
      token,
      status: statusMatch?.[1] ?? null,
      reason: tooltipMatch?.[1] ?? null,
      actionUrl,
    };
  }

  private async execSimpleUpgrade(
    component: "research" | "supplies" | "facilities" | "lfbuildings",
    directive: Directive,
    planetId: string,
  ): Promise<{ action: string; clicked: boolean }> {
    const targetName = component === "research"
      ? ((directive.params as { tech?: string }).tech ?? "")
      : ((directive.params as { building?: string }).building ?? "");
    // Prefer numeric ID from directive (Pass 2: emitted by planner) over
    // name-lookup — robust across renames / aliases.
    const numericId = (directive.params as { technology_id?: number }).technology_id
      ?? OGAME_NUMERIC_ID[targetName];
    if (!numericId) throw new Error(`api: no numeric id for ${targetName}`);
    // PURE API — no page fetch. Token sources in order:
    //   1. dataset.ogamexToken (sniffer writes window.token here every 2s)
    //   2. live <input name="token">  (some pages have it)
    //   3. <meta name="ogame-token">
    //   4. localStorage OGAMEX_TOKEN (last-known good)
    const datasetTok = (this.doc.documentElement as HTMLElement).dataset["ogamexToken"];
    const liveInput = this.doc.querySelector<HTMLInputElement>('input[name="token"]');
    const liveMeta = this.doc.querySelector<HTMLMetaElement>('meta[name="ogame-token"]');
    let token = datasetTok ?? liveInput?.value ?? liveMeta?.content ?? "";
    if (!token) {
      try { token = this.win.localStorage.getItem("OGAMEX_TOKEN") ?? ""; } catch { /* */ }
    }
    if (!token) throw new Error(`api: no live token (sniffer hasn't captured window.token yet)`);
    console.info(`[ApiExec] ${component}:${targetName} POST scheduleEntry token len=${token.length}`);
    // ogame v12 scheduleEntry — captured from real user click:
    //   body: technologyId=N&amount=1&mode=1&token=X
    // cp=<planetId> targets the SPECIFIC planet. Without it ogame defaults
    // to the user's currently-active planet (whatever browser cp cookie is
    // on) — causes multi-planet builds to land on home planet by mistake.
    const body = new URLSearchParams({
      technologyId: String(numericId),
      amount: "1",
      mode: "1",
      token,
    });
    const r = await fetchWithCpBypassBusy(
      `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1`,
      { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body },
      planetId,
      { skipRestore: true },
    );
    if (!r.ok) throw new Error(`api: ${component} upgrade HTTP ${r.status}`);
    const respText = await r.text();
    let parsed: { success?: boolean; errors?: Array<{ message?: string }>; error?: string; newAjaxToken?: string } | null = null;
    try { parsed = JSON.parse(respText); }
    catch {
      // Operator 2026-05-25 (discover same-source check): explicit error
      // pages MUST not be silently treated as success. Legacy ogame
      // sometimes returns HTML redirect on scheduleEntry success, so
      // only throw when the body actually mentions an error.
      if (/error|錯誤|错误|failed/i.test(respText.slice(0, 500))) {
        throw new Error(`${component} upgrade non-JSON error response: ${respText.slice(0, 200)}`);
      }
    }
    console.info(`[ApiExec] ${component}:${targetName} POST resp HTTP ${r.status} json=${parsed ? "yes" : "no(html)"} body[0:200]=${respText.slice(0, 200).replace(/\s+/g, " ")}`);
    // Rotate token: ogame single-use tokens. Refresh dataset + localStorage
    // with response's newAjaxToken so next POST has a fresh one.
    if (parsed?.newAjaxToken) {
      (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = parsed.newAjaxToken;
      try { this.win.localStorage.setItem("OGAMEX_TOKEN", parsed.newAjaxToken); } catch { /* */ }
    }
    // Generic "unknown error" usually means token came from wrong page
    // (e.g. user is on fleetdispatch but scheduleEntry needs supplies-scope
    // token). Retry ONCE with the freshly-rotated token. Subsequent
    // directives get specific errors (120016 resource-short etc.).
    const errMsg = JSON.stringify(parsed?.errors ?? parsed?.error ?? "");
    const isGenericRetry = parsed?.status === "failure"
      && /unknown\s+error|未知|未知錯誤/i.test(errMsg)
      && parsed.newAjaxToken;
    if (isGenericRetry && parsed?.newAjaxToken) {
      const retryBody = new URLSearchParams({ ...Object.fromEntries(body), token: parsed.newAjaxToken });
      console.info(`[ApiExec] ${component}:${targetName} RETRY with rotated token`);
      const r2 = await fetchWithCpBypassBusy(
        `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1`,
        { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: retryBody },
        planetId,
        { skipRestore: true },
      );
      const r2Text = await r2.text();
      let parsed2: { success?: boolean; status?: string; errors?: unknown; newAjaxToken?: string } | null = null;
      try { parsed2 = JSON.parse(r2Text); }
      catch {
        if (/error|錯誤|错误|failed/i.test(r2Text.slice(0, 500))) {
          throw new Error(`retry non-JSON error response: ${r2Text.slice(0, 200)}`);
        }
      }
      console.info(`[ApiExec] ${component}:${targetName} retry resp body[0:200]=${r2Text.slice(0,200).replace(/\s+/g," ")}`);
      if (parsed2?.newAjaxToken) {
        (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = parsed2.newAjaxToken;
        try { this.win.localStorage.setItem("OGAMEX_TOKEN", parsed2.newAjaxToken); } catch { /* */ }
      }
      if (parsed2 && parsed2.success === false) {
        throw new Error(`${component}:${targetName} rejected (after retry): ${JSON.stringify(parsed2.errors)}`);
      }
      return { action: directive.action, clicked: true };
    }
    if (parsed && (parsed.success === false || parsed.status === "failure")) {
      throw new Error(`${component}:${targetName} rejected: ${JSON.stringify(parsed.errors ?? parsed.error)}`);
    }
    return { action: directive.action, clicked: true };
  }

  private async execShipBuild(
    directive: Directive,
    planetId: string,
  ): Promise<{ action: string; clicked: boolean }> {
    const ship = (directive.params as { ship?: string }).ship ?? "";
    const amount = ((): number => {
      const a = (directive.params as { amount?: unknown }).amount;
      return typeof a === "number" && a > 0 ? Math.floor(a) : 1;
    })();
    const numericId = (directive.params as { technology_id?: number }).technology_id
      ?? OGAME_NUMERIC_ID[ship];
    if (!numericId) throw new Error(`api: no numeric id for ship ${ship}`);
    const { token, status, reason, actionUrl } = await this.fetchTokenAndStatus("shipyard", planetId, numericId);
    console.info(`[ApiExec] shipyard:${ship}×${amount} status=${status} reason=${(reason ?? "").slice(0,40)} hasActionUrl=${!!actionUrl}`);
    if (status === "active") return { action: directive.action, clicked: false };
    if (status === "disabled") {
      if (reason && /(造船廠|shipyard).*(升級|upgrad|building)/i.test(reason)) {
        return { action: directive.action, clicked: false };
      }
      throw new Error(`${ship} unavailable: ${reason ?? "disabled"}`);
    }
    const body = new URLSearchParams({
      technologyId: String(numericId),
      amount: String(amount),
      mode: "1",
      token,
    });
    const r = await fetchWithCpBypassBusy(
      `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1`,
      { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body },
      planetId,
      { skipRestore: true },
    );
    if (!r.ok) throw new Error(`api: shipyard build HTTP ${r.status}`);
    const respText = await r.text();
    let parsed: { success?: boolean; errors?: Array<{ message?: string }>; error?: string; newAjaxToken?: string } | null = null;
    try { parsed = JSON.parse(respText); }
    catch {
      if (/error|錯誤|错误|failed/i.test(respText.slice(0, 500))) {
        throw new Error(`shipyard build non-JSON error response: ${respText.slice(0, 200)}`);
      }
    }
    console.info(`[ApiExec] shipyard:${ship}×${amount} POST resp HTTP ${r.status} json=${parsed ? "yes" : "no(html)"} body[0:200]=${respText.slice(0, 200).replace(/\s+/g, " ")}`);
    // Rotate token from response (ogame single-use anti-replay).
    if (parsed?.newAjaxToken) {
      (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = parsed.newAjaxToken;
      try { this.win.localStorage.setItem("OGAMEX_TOKEN", parsed.newAjaxToken); } catch { /* */ }
    }
    // Same retry-on-generic-token-error pattern as execSimpleUpgrade.
    const errMsg = JSON.stringify(parsed?.errors ?? parsed?.error ?? "");
    const pStatus = (parsed as { status?: string } | null)?.status;
    if (pStatus === "failure" && /unknown\s+error|未知|未知錯誤/i.test(errMsg) && parsed?.newAjaxToken) {
      const retryBody = new URLSearchParams({ ...Object.fromEntries(body), token: parsed.newAjaxToken });
      console.info(`[ApiExec] shipyard:${ship}×${amount} RETRY with rotated token`);
      const r2 = await fetchWithCpBypassBusy(
        `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1`,
        { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: retryBody },
        planetId,
        { skipRestore: true },
      );
      const r2Text = await r2.text();
      let parsed2: { success?: boolean; status?: string; errors?: unknown; newAjaxToken?: string } | null = null;
      try { parsed2 = JSON.parse(r2Text); }
      catch {
        if (/error|錯誤|错误|failed/i.test(r2Text.slice(0, 500))) {
          throw new Error(`retry non-JSON error response: ${r2Text.slice(0, 200)}`);
        }
      }
      console.info(`[ApiExec] shipyard:${ship}×${amount} retry resp body[0:200]=${r2Text.slice(0,200).replace(/\s+/g," ")}`);
      if (parsed2?.newAjaxToken) {
        (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = parsed2.newAjaxToken;
        try { this.win.localStorage.setItem("OGAMEX_TOKEN", parsed2.newAjaxToken); } catch { /* */ }
      }
      if (parsed2 && parsed2.success === false) {
        throw new Error(`shipyard:${ship} rejected (after retry): ${JSON.stringify(parsed2.errors)}`);
      }
      return { action: directive.action, clicked: true };
    }
    if (parsed && (parsed.success === false || parsed.status === "failure")) {
      throw new Error(`shipyard build rejected: ${JSON.stringify(parsed.errors ?? parsed.error)}`);
    }
    return { action: directive.action, clicked: true };
  }

  private async execExpedition(
    directive: Directive,
    planetId: string,
  ): Promise<{ action: string; clicked: boolean }> {
    const params = directive.params as {
      source_coords?: string;
      ships?: Record<string, number>;
    };
    const ships = params.ships ?? { smallCargo: 1, espionageProbe: 1 };

    // EXPEDITION SLOT GATE — operator 2026-05-27: "远征怎么会有警告？发船之前
    // 没有查看是否有可用的slot？". ogame error 140043/140019 = expedition slots
    // exhausted; 140029 = TOTAL fleet slot exhausted (expedition fleet ALSO
    // occupies 1 fleet slot on top of 1 expedition slot). Both checks needed.
    // store.server.* is updated by /movement harvest + galaxy fetch.
    try {
      const srv = (this.win as Window & { __ogamexStore?: { state: { server?: { used_expedition_slots?: number; max_expedition_slots?: number; used_fleet_slots?: number; max_fleet_slots?: number } } } })
        .__ogamexStore?.state.server;
      const usedExp = srv?.used_expedition_slots ?? -1;
      const maxExp = srv?.max_expedition_slots ?? -1;
      if (usedExp >= 0 && maxExp > 0 && usedExp >= maxExp) {
        throw new Error(`expedition aborted (exp slot gate): used_expedition_slots=${usedExp} >= max_expedition_slots=${maxExp}, no POST`);
      }
      // Operator 2026-05-28: expedition occupies BOTH expedition slot AND
      // fleet slot. Originally kept 1 fleet slot reserved for emergency FS,
      // but operator now: "修好远征自动发船,不用管发现任务,发现任务会慢慢
      // 让出空间". Expedition takes the last slot too — emergency FS goes
      // through FSM bypass (memory: fleet_slot_gate_invariant says FSM
      // ignores slot gate to save fleet at all costs).
      const usedFleet = srv?.used_fleet_slots ?? -1;
      const maxFleet = srv?.max_fleet_slots ?? -1;
      if (usedFleet >= 0 && maxFleet > 0 && usedFleet >= maxFleet) {
        throw new Error(`expedition aborted (fleet slot gate): used_fleet_slots=${usedFleet} >= max=${maxFleet} (all slots occupied, FSM bypass still works for emergency FS)`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("expedition aborted (")) throw e;
      // missing store = skip gate, fall through
    }

    // BLOCKING preflight — owner explicit requirement: "每次远征之前从 api
    // 拿最新的舰船数量". v0.0.166 had fire-and-forget pollEmpire (data lands
    // too late). v0.0.167 had fdHtml2 parse (caused 140042). This version
    // calls a focused helper that does (a) ogame empire API fetch, (b) parses
    // ship counts per planet, (c) writes them to store, (d) returns this
    // planet's ships. AWAIT it — block 100-500ms — then compare to template.
    // Step 0: force fresh empire pull BEFORE preflight. operator:
    // "远征出发之前又没有同步最新的舰船列表吧". This refreshes store with
    // current ogame ship counts for ALL planets. fetchPlanetShips can then
    // fall back to store.ships safely (was stale data before).
    const pollEmpireFn = (this.win as Window & {
      __ogamexPollEmpire?: (opts?: { force?: boolean }) => Promise<void>;
    }).__ogamexPollEmpire;
    if (typeof pollEmpireFn === "function") {
      try { await pollEmpireFn({ force: true }); }
      catch (e) { console.warn(`[ApiExec] pre-expedition empire refresh failed:`, e); }
    }
    const fetchPlanetShips = (this.win as Window & {
      __ogamexFetchPlanetShips?: (pid: string) => Promise<Record<string, number>>;
    }).__ogamexFetchPlanetShips;
    if (typeof fetchPlanetShips === "function") {
      try {
        const liveShips = await fetchPlanetShips(planetId);
        const shortages: string[] = [];
        for (const [shipName, n] of Object.entries(ships)) {
          if (n <= 0) continue;
          const have = liveShips[shipName] ?? 0;
          if (have < n) shortages.push(`${shipName} have=${have} need=${n}`);
        }
        if (shortages.length > 0) {
          throw new Error(`expedition aborted (preflight): ${shortages.join("; ")} on ${planetId} — empire fetched ${Date.now()}`);
        }
      } catch (e) {
        // Re-throw preflight aborts (they're informative); swallow only
        // fetch errors so we don't block on transient ogame hiccups.
        if (e instanceof Error && e.message.startsWith("expedition aborted (preflight)")) throw e;
        console.warn(`[ApiExec] preflight fetch failed, proceeding with daemon's state:`, e);
      }
    }
    const [gStr, sStr] = (params.source_coords ?? "").split(":");
    const galaxy = parseInt(gStr ?? "0", 10);
    const system = parseInt(sStr ?? "0", 10);
    if (!galaxy || !system) throw new Error(`expedition: bad source_coords`);

    // ogame v12 fleet dispatch is a 3-stage AJAX flow. Each stage returns
    // a `newAjaxToken` that MUST be used for the next stage — single-use,
    // single-stage tokens. Reusing the page-1 token for sendFleet returns
    // error 140043 ("无法派遣艦隊"). We chain through all 3.
    // `let` — token is reassigned at each stage's newAjaxToken
    // (single-use chain; reusing prior stage token returns 140043).
    let token: string = await this.bootstrapFleetToken(planetId, "expedition");
    console.info(`[ApiExec] expedition step1: GOT token (ajax-only) len=${token.length}`);

    const POST = async (action: string, body: URLSearchParams): Promise<{ token: string; raw: string; json: { newAjaxToken?: string; success?: boolean; message?: string; errors?: Array<{ message?: string; error?: number }> } }> => {
      const r = await fetchWithCpBypassBusy(
        `/game/index.php?page=ingame&component=fleetdispatch&action=${action}&ajax=1&asJson=1`,
        { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body },
        planetId,
        { skipRestore: true },
      );
      const txt = await r.text();
      let j: ReturnType<typeof POST> extends Promise<infer T> ? T["json"] : never;
      try { j = JSON.parse(txt); }
      catch {
        throw new Error(`expedition ${action} non-JSON response: ${txt.slice(0, 200)}`);
      }
      const newToken = j.newAjaxToken ?? token;
      return { token: newToken, raw: txt, json: j };
    };

    // Stage 1: ship selection — get token B
    const stage1Body = new URLSearchParams({ token });
    for (const [shipName, n] of Object.entries(ships)) {
      const numId = OGAME_NUMERIC_ID[shipName];
      if (!numId || n <= 0) continue;
      stage1Body.append(`am${numId}`, String(n));
    }
    const stage1 = await POST("fleetSelectionAjax", stage1Body);
    console.info(`[ApiExec] expedition step2: fleetSelectionAjax -> success=${stage1.json.success} body=${stage1.raw.slice(0, 200)}`);
    if (stage1.json.success === false) {
      throw new Error(`expedition stage1 rejected: ${JSON.stringify(stage1.json.errors ?? stage1.json.message)}`);
    }
    token = stage1.token;

    // Stage 2: target selection (coords) — get token C
    const stage2Body = new URLSearchParams({
      token,
      galaxy: String(galaxy),
      system: String(system),
      position: "16",
      type: "1",
    });
    const stage2 = await POST("checkTarget", stage2Body);
    console.info(`[ApiExec] expedition step3: checkTarget -> success=${stage2.json.success} body=${stage2.raw.slice(0, 200)}`);
    if (stage2.json.success === false) {
      throw new Error(`expedition stage2 rejected: ${JSON.stringify(stage2.json.errors ?? stage2.json.message)}`);
    }
    // Harvest authoritative cargo capacity from shipsData (post-bonus).
    // Operator 2026-05-24: hyperspace tech / class / lifeform all scale
    // cargo; the only reliable source is ogame's own response. Free
    // hitch ride on every expedition's checkTarget.
    try {
      const shipsData = (stage2.json as { shipsData?: unknown }).shipsData;
      if (shipsData) cacheShipsData(shipsData, this.win);
    } catch (e) {
      console.warn("[ApiExec/expedition] shipsData cache failed:", e);
    }
    token = stage2.token;

    // Stage 3 — NO re-anchor fetch of fdUrl. v0.0.167 had one (with preflight
    // ship verification) but it caused ogame to reset the fleet form between
    // stage2 (checkTarget) and stage3 (sendFleet) → 140042 "沒有選擇艦船"
    // even when body had am203=1500 etc. Stage2's token stayed valid but the
    // server-side form lost the ship-selection context.
    //
    // Preflight ship verification moved EARLIER (before stage1) — uses local
    // boot store state which is refreshed every 5s via pollEmpire. Race window
    // ≤ 5-10s, much smaller than the v0.0.167-induced 100% failure mode.
    //
    // Pollers that could change session-cp during the chain: pollEmpire uses
    // page=standalone (separate namespace) — does NOT change session-cp.
    // fetchResources rotation was disabled (current-planet only) in boot.ts.
    // So no concurrent fetch should break stage2→stage3 atomicity.
    const stage3Body = new URLSearchParams({
      token,
      mission: "15",
      speed: "10",
      galaxy: String(galaxy),
      system: String(system),
      position: "16",
      type: "1",
      metal: "0",
      crystal: "0",
      deuterium: "0",
      holdingtime: "1",
    });
    for (const [shipName, n] of Object.entries(ships)) {
      const numId = OGAME_NUMERIC_ID[shipName];
      if (!numId || n <= 0) continue;
      stage3Body.append(`am${numId}`, String(n));
    }
    console.info(`[ApiExec] expedition step4: sendFleet target=${galaxy}:${system}:16 ships=${JSON.stringify(ships)}`);
    const r = await fetchWithCpBypassBusy(
      `/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1`,
      { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body: stage3Body },
      planetId,
      { skipRestore: true },
    );
    const txt = await r.text();
    console.info(`[ApiExec] expedition step5: resp HTTP ${r.status} body=${txt.slice(0,300)}`);
    if (!r.ok) throw new Error(`expedition: HTTP ${r.status}`);
    // ogame returns JSON {success:true} or {success:false, errors:[...]}.
    // Parse OUTSIDE a swallowing catch so failures actually propagate.
    let parsed: { success?: boolean; errors?: Array<{ message?: string; error?: number }> } | null = null;
    try { parsed = JSON.parse(txt); }
    catch {
      // Operator 2026-05-25: non-JSON response = real error (e.g.
      // "An error has occured!" plain text). Do NOT accept as opaque
      // success — that hides token-rotation failures.
      throw new Error(`expedition sendFleet non-JSON response: ${txt.slice(0, 200)}`);
    }
    if (parsed && (parsed.success === false || parsed.status === "failure")) {
      const msg = parsed.errors?.[0]?.message ?? "unknown error";
      const code = parsed.errors?.[0]?.error ?? -1;
      const reqBodyStr = stage3Body.toString();
      try {
        (this.win as Window & { __ogamexLastExpFailure?: unknown }).__ogamexLastExpFailure = {
          ts: Date.now(), url: `sendFleet (cp=${planetId})`, reqBody: reqBodyStr,
          respBody: txt.slice(0, 800), sentShips: ships,
          targetCoords: `${galaxy}:${system}:16`, planetId,
        };
      } catch { /* ignore */ }
      // Include REQUEST body in error so /v1/goals reason shows exactly what
      // we sent — operator can verify am202, am203, etc. counts vs planet.
      throw new Error(`expedition rejected by ogame (${code}): ${msg} | req: ${reqBodyStr.slice(0, 250)} | resp: ${txt.slice(0, 200).replace(/\s+/g, " ")}`);
    }
    // Track successful launch in __ogamexInflightLaunches so the NEXT
    // preflight for this planet subtracts these ships from empire's
    // owned-count.
    try {
      const w = this.win as Window & {
        __ogamexInflightLaunches?: Map<string, Array<{ ships: Record<string, number>; ts: number }>>;
        __ogamexHarvestMovement?: () => Promise<void>;
        __ogamexPollEmpire?: (opts?: { force?: boolean }) => Promise<void>;
      };
      if (!w.__ogamexInflightLaunches) w.__ogamexInflightLaunches = new Map();
      const arr = w.__ogamexInflightLaunches.get(planetId) ?? [];
      arr.push({ ships: { ...ships }, ts: Date.now() });
      w.__ogamexInflightLaunches.set(planetId, arr);
      console.log(`[ApiExec] expedition tracked inflight for ${planetId}: ${JSON.stringify(ships)} (total entries: ${arr.length})`);
      // Operator 2026-05-25 "不要用倒计时，都用事件驱动": successful
      // sendFleet IS the event. Trigger /movement + empire refresh so
      // fleets_outbound + ship counts catch up immediately (no 5min
      // setInterval poll needed). Fire-and-forget — don't block return.
      if (typeof w.__ogamexHarvestMovement === "function") void w.__ogamexHarvestMovement().catch(() => { /* */ });
      if (typeof w.__ogamexPollEmpire === "function") void w.__ogamexPollEmpire({ force: true }).catch(() => { /* */ });
    } catch { /* */ }
    return { action: "expedition", clicked: true };
  }

  /** Colonize fleet dispatch — mirrors execExpedition's 3-step token chain
   *  but with mission=7 (colonization), holdingtime=0, and user-specified
   *  target coords (not position=16). On success ogame plants colony at the
   *  target slot. WARNING: best-guess body shape — capture real click for
   *  accuracy if first attempt fails. */
  private async execColonize(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean }> {
    const params = directive.params as { target_coords?: string; ships?: Record<string, number>; cargo?: { metal?: number; crystal?: number; deuterium?: number } };
    const ships = params.ships ?? { colonyShip: 1 };
    const cargo = params.cargo ?? { metal: 5000, crystal: 2500, deuterium: 0 };
    const [tgStr, tsStr, tpStr] = (params.target_coords ?? "").split(":");
    const tGalaxy = parseInt(tgStr ?? "0", 10);
    const tSystem = parseInt(tsStr ?? "0", 10);
    const tPos = parseInt(tpStr ?? "0", 10);
    if (!tGalaxy || !tSystem || !tPos) throw new Error(`colonize: bad target_coords`);
    // FLEET SLOT GATE — operator 2026-05-27 同族 review: 任何 fleet POST 都
    // 必经 slot gate. keep-1-empty 跟 discover 同 (留个槽给紧急 FS).
    {
      const srv = (this.win as Window & { __ogamexStore?: { state: { server?: { used_fleet_slots?: number; max_fleet_slots?: number } } } })
        .__ogamexStore?.state.server;
      const usedNow = srv?.used_fleet_slots ?? -1;
      const maxNow = srv?.max_fleet_slots ?? -1;
      if (usedNow >= 0 && maxNow > 0 && usedNow >= maxNow - 1) {
        throw new Error(`colonize aborted (slot gate): used=${usedNow} max=${maxNow} keep-1-empty for emergency FS`);
      }
    }
    // Operator 2026-05-25: "用 api 实现 不要点网页" — ajax-only token chain.
    let token: string = await this.bootstrapFleetToken(planetId, "colonize");
    console.info(`[ApiExec] colonize step1: token len=${token.length}`);

    const POST = async (action: string, body: URLSearchParams): Promise<{ token: string; raw: string; json: { newAjaxToken?: string; success?: boolean; message?: string; errors?: Array<{ message?: string; error?: number }> } }> => {
      const r = await fetchWithCpBypassBusy(
        `/game/index.php?page=ingame&component=fleetdispatch&action=${action}&ajax=1&asJson=1`,
        { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body },
        planetId,
        { skipRestore: true },
      );
      const txt = await r.text();
      let j: { newAjaxToken?: string; success?: boolean; message?: string; errors?: Array<{ message?: string; error?: number }> } = {};
      try { j = JSON.parse(txt); }
      catch { throw new Error(`colonize ${action} non-JSON response: ${txt.slice(0, 200)}`); }
      return { token: j.newAjaxToken ?? token!, raw: txt, json: j };
    };

    // Stage 1: ships
    const stage1Body = new URLSearchParams({ token });
    for (const [shipName, n] of Object.entries(ships)) {
      const numId = OGAME_NUMERIC_ID[shipName];
      if (!numId || n <= 0) continue;
      stage1Body.append(`am${numId}`, String(n));
    }
    const stage1 = await POST("fleetSelectionAjax", stage1Body);
    console.info(`[ApiExec] colonize step2 fleetSel: success=${stage1.json.success}`);
    if (stage1.json.success === false) throw new Error(`colonize stage1: ${JSON.stringify(stage1.json.errors)}`);
    token = stage1.token;
    // Stage 2: target = G:S:P type=1 (planet)
    const stage2Body = new URLSearchParams({
      token, galaxy: String(tGalaxy), system: String(tSystem), position: String(tPos), type: "1",
    });
    const stage2 = await POST("checkTarget", stage2Body);
    console.info(`[ApiExec] colonize step3 checkTarget: success=${stage2.json.success}`);
    if (stage2.json.success === false) throw new Error(`colonize stage2: ${JSON.stringify(stage2.json.errors)}`);
    token = stage2.token;
    // Stage 3: send with mission=7 (colonize)
    const stage3Body = new URLSearchParams({
      token, mission: "7", speed: "10",
      galaxy: String(tGalaxy), system: String(tSystem), position: String(tPos), type: "1",
      metal: String(cargo.metal ?? 0),
      crystal: String(cargo.crystal ?? 0),
      deuterium: String(cargo.deuterium ?? 0),
      holdingtime: "0",
    });
    for (const [shipName, n] of Object.entries(ships)) {
      const numId = OGAME_NUMERIC_ID[shipName];
      if (!numId || n <= 0) continue;
      stage3Body.append(`am${numId}`, String(n));
    }
    console.info(`[ApiExec] colonize step4: sendFleet target=${tGalaxy}:${tSystem}:${tPos} mission=7`);
    const r = await fetchWithCpBypassBusy(
      `/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1`,
      { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body: stage3Body },
      planetId,
      { skipRestore: true },
    );
    const txt = await r.text();
    console.info(`[ApiExec] colonize step5: HTTP ${r.status} body=${txt.slice(0,300)}`);
    if (!r.ok) throw new Error(`colonize HTTP ${r.status}`);
    let parsed: { success?: boolean; errors?: Array<{ message?: string; error?: number }> } | null = null;
    try { parsed = JSON.parse(txt); }
    catch { throw new Error(`colonize sendFleet non-JSON response: ${txt.slice(0, 200)}`); }
    if (parsed && (parsed.success === false || parsed.status === "failure")) {
      const msg = parsed.errors?.[0]?.message ?? "unknown";
      throw new Error(`colonize rejected: ${msg}`);
    }
    return { action: "colonize", clicked: true };
  }

  /** Deploy (mission=4, one-way) or Transport (mission=3, round-trip). Same
   *  3-stage token chain as colonize/expedition. type=1 for planet targets,
   *  type=3 for debris field, type=2 for moon — we default to type=1 since
   *  deploy/transport targets are your own colonies. */
  private async execFleetSend(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean }> {
    const params = directive.params as { target_coords?: string; ships?: Record<string, number>; resources?: Record<string, number>; mission?: number };
    const ships = params.ships ?? {};
    const resources = params.resources ?? {};
    const mission = params.mission ?? (directive.action === "deploy" ? 4 : 3);
    const [tgStr, tsStr, tpStr] = (params.target_coords ?? "").split(":");
    const tGalaxy = parseInt(tgStr ?? "0", 10);
    const tSystem = parseInt(tsStr ?? "0", 10);
    const tPos = parseInt(tpStr ?? "0", 10);
    if (!tGalaxy || !tSystem || !tPos) throw new Error(`${directive.action}: bad target_coords`);
    if (Object.keys(ships).length === 0) throw new Error(`${directive.action}: no ships`);
    // FLEET SLOT GATE — operator 2026-05-27 同族 review: deploy/transport
    // 也是 fleet POST, 同 keep-1-empty 模式.
    {
      const srv = (this.win as Window & { __ogamexStore?: { state: { server?: { used_fleet_slots?: number; max_fleet_slots?: number } } } })
        .__ogamexStore?.state.server;
      const usedNow = srv?.used_fleet_slots ?? -1;
      const maxNow = srv?.max_fleet_slots ?? -1;
      if (usedNow >= 0 && maxNow > 0 && usedNow >= maxNow - 1) {
        throw new Error(`${directive.action} aborted (slot gate): used=${usedNow} max=${maxNow} keep-1-empty for emergency FS`);
      }
    }
    // Operator 2026-05-25: ajax-only token bootstrap (no fdHtml).
    let token: string = await this.bootstrapFleetToken(planetId, directive.action);
    console.info(`[ApiExec] ${directive.action} step1: token len=${token.length}`);

    const POST = async (action: string, body: URLSearchParams): Promise<{ token: string; raw: string; json: { newAjaxToken?: string; success?: boolean; errors?: Array<{ message?: string; error?: number }> } }> => {
      const r = await fetchWithCpBypassBusy(
        `/game/index.php?page=ingame&component=fleetdispatch&action=${action}&ajax=1&asJson=1`,
        { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body },
        planetId,
        { skipRestore: true },
      );
      const txt = await r.text();
      let j: { newAjaxToken?: string; success?: boolean; errors?: Array<{ message?: string; error?: number }> } = {};
      try { j = JSON.parse(txt); }
      catch { throw new Error(`${directive.action} ${action} non-JSON response: ${txt.slice(0, 200)}`); }
      return { token: j.newAjaxToken ?? token!, raw: txt, json: j };
    };

    // Stage 1: select ships
    const stage1Body = new URLSearchParams({ token });
    for (const [shipName, n] of Object.entries(ships)) {
      const numId = OGAME_NUMERIC_ID[shipName];
      if (!numId || n <= 0) continue;
      stage1Body.append(`am${numId}`, String(n));
    }
    const stage1 = await POST("fleetSelectionAjax", stage1Body);
    console.info(`[ApiExec] ${directive.action} step2 fleetSel: success=${stage1.json.success}`);
    if (stage1.json.success === false) throw new Error(`${directive.action} stage1: ${JSON.stringify(stage1.json.errors)}`);
    token = stage1.token;
    // Stage 2: checkTarget — type=1 (planet)
    const stage2Body = new URLSearchParams({
      token, galaxy: String(tGalaxy), system: String(tSystem), position: String(tPos), type: "1",
    });
    const stage2 = await POST("checkTarget", stage2Body);
    console.info(`[ApiExec] ${directive.action} step3 checkTarget: success=${stage2.json.success}`);
    if (stage2.json.success === false) throw new Error(`${directive.action} stage2: ${JSON.stringify(stage2.json.errors)}`);
    token = stage2.token;
    // Stage 3: sendFleet with mission=4 (deploy) or 3 (transport)
    const stage3Body = new URLSearchParams({
      token, mission: String(mission), speed: "10",
      galaxy: String(tGalaxy), system: String(tSystem), position: String(tPos), type: "1",
      metal: String(resources["m"] ?? 0),
      crystal: String(resources["c"] ?? 0),
      deuterium: String(resources["d"] ?? 0),
      holdingtime: "0",
    });
    for (const [shipName, n] of Object.entries(ships)) {
      const numId = OGAME_NUMERIC_ID[shipName];
      if (!numId || n <= 0) continue;
      stage3Body.append(`am${numId}`, String(n));
    }
    console.info(`[ApiExec] ${directive.action} step4: sendFleet ${tGalaxy}:${tSystem}:${tPos} mission=${mission}`);
    const r = await fetchWithCpBypassBusy(
      `/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1`,
      { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body: stage3Body },
      planetId,
      { skipRestore: true },
    );
    const txt = await r.text();
    console.info(`[ApiExec] ${directive.action} step5: HTTP ${r.status} body=${txt.slice(0,300)}`);
    if (!r.ok) throw new Error(`${directive.action} HTTP ${r.status}`);
    let parsed: { success?: boolean; errors?: Array<{ message?: string; error?: number }> } | null = null;
    try { parsed = JSON.parse(txt); }
    catch { throw new Error(`${directive.action} sendFleet non-JSON response: ${txt.slice(0, 200)}`); }
    if (parsed && (parsed.success === false || parsed.status === "failure")) {
      const msg = parsed.errors?.[0]?.message ?? "unknown";
      throw new Error(`${directive.action} rejected: ${msg}`);
    }
    return { action: directive.action, clicked: true };
  }

  /** Species discovery — Galaxy view DNA icon → sendDiscoveryFleet POST.
   *  Endpoint (verified from operator's DOM paste 2026-05-23):
   *    POST /game/index.php?page=ingame&component=fleetdispatch&action=sendDiscoveryFleet&ajax=1&asJson=1
   *    body: galaxy=N&system=N&position=N&token=...
   *  Cost: Metal 5000 / Crystal 1000 / Deuterium 500 per shot, 7-day per-coord cooldown.
   *  Uses 1 fleet slot until exploration fleet returns. */
  // execute() at top wraps EVERY action in try/finally that restores
  // session-cp — no per-action restore needed here.
  private async execDiscover(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean }> {
    const p = directive.params as { galaxy?: number; system?: number; position?: number; goal_id?: string };
    const galaxy = p.galaxy ?? 0;
    const system = p.system ?? 0;
    const position = p.position ?? 0;
    if (!galaxy || !system || !position) {
      throw new Error(`discover: missing galaxy/system/position (got ${galaxy}:${system}:${position})`);
    }

    // Pre-check: fetch galaxy system content + classify position's discovery
    // state. Operator: "先从 api 拿到星球是否扫过, 没扫过的继续, 扫过的跳过".
    // Cached 5min per "G:S" so 15 positions in same system reuse one fetch.
    const cacheKey = `${galaxy}:${system}`;
    type Cache = { ts: number; states: Map<number, string> };
    const w = this.win as Window & { __ogamexGalaxyDiscovery?: Map<string, Cache> };
    if (!w.__ogamexGalaxyDiscovery) w.__ogamexGalaxyDiscovery = new Map();
    const cacheStore = w.__ogamexGalaxyDiscovery;
    let cache = cacheStore.get(cacheKey);
    const CACHE_TTL = 30 * 60 * 1000;  // operator 2026-05-27: 5min → 30min (batch sweep)
    if (!cache || Date.now() - cache.ts > CACHE_TTL) {
      try {
        const galResp = await fetchWithCpBypassBusy(
          `/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
            body: `galaxy=${galaxy}&system=${system}`,
          },
          planetId,
          { skipRestore: true },
        );
        const galTxt = await galResp.text();
        // Response is JSON. Verified shape from operator sniff:
        //   { reservedPositions, token, filterSettings,
        //     system: {
        //       availableProbes, ...
        //       galaxyContent: [
        //         { galaxy, system, position, planets, player,
        //           availableMissions: [{missionType, ...}, ...] },
        //         ...
        //       ]
        //     } }
        // missionType=18 = sendDiscoveryFleet (per page const "discover":18).
        // If missionType 18 IS in availableMissions → position can be
        // discovered NOW. If not present → cooldown OR not-discoverable.
        const states = new Map<number, string>();
        try {
          const j = JSON.parse(galTxt) as {
            token?: string;
            system?: {
              usedFleetSlots?: number;
              maximumFleetSlots?: number;
              galaxyContent?: Array<{
                position?: number;
                availableMissions?: Array<{ missionType?: number; canSend?: unknown }>;
              }>;
            };
          };
          // Stash the galaxy-fetched token so the next sendDiscoveryFleet POST
          // doesn't need a second HTTP GET to /component=galaxy (operator
          // 2026-05-25: that GET switches session-cp + causes UI lag).
          if (typeof j.token === "string" && j.token.length >= 16) {
            (this.win as Window & { __ogamexLastGalaxyToken?: string }).__ogamexLastGalaxyToken = j.token;
          }
          // Authoritative slot data from ogame — push immediately so planner
          // doesn't rely on 10s /movement harvest. Operator: "你的舰队槽的数量
          // 是不是又是猜的？" — answer is now no, we read it from ogame's own
          // response on every galaxy fetch.
          const usedFs = j.system?.usedFleetSlots;
          const maxFs = j.system?.maximumFleetSlots;
          if (typeof usedFs === "number" && typeof maxFs === "number" && maxFs > 0) {
            const updateFn = (this.win as Window & { __ogamexUpdateSlots?: (u: number, m: number) => void }).__ogamexUpdateSlots;
            if (updateFn) {
              updateFn(usedFs, maxFs);
              console.info(`[ApiExec/discover] galaxy[${cacheKey}] slots from ogame: ${usedFs}/${maxFs} → pushed to store`);
            }
          }
          const content = j.system?.galaxyContent ?? [];
          for (const row of content) {
            const pos = row.position ?? 0;
            if (pos < 1 || pos > 15) continue;
            const missions = Array.isArray(row.availableMissions) ? row.availableMissions : [];
            const m18 = missions.find((m) => m.missionType === 18);
            // ogame canSend semantic (verified from operator sniff 2026-05-23):
            //   missionType 18 entry present in availableMissions → discovery
            //     mechanically possible for this coord (planet+lifeform tech).
            //   canSend is union-typed across galaxies:
            //     • string non-empty ("您可以在 X 之後再次搜索…") → cooldown
            //     • string empty / undefined → available
            //     • boolean true → available
            //     • boolean false → cooldown / blocked
            //   Earlier code did `(canSend ?? "").trim()` which threw
            //   "trim is not a function" when canSend was boolean.
            const cs: unknown = m18?.canSend;
            let stateForPos: "available" | "cooldown" | "unavailable";
            if (!m18) {
              stateForPos = "unavailable";
            } else if (typeof cs === "string") {
              stateForPos = cs.trim().length > 0 ? "cooldown" : "available";
            } else if (typeof cs === "boolean") {
              stateForPos = cs ? "available" : "cooldown";
            } else {
              stateForPos = "available";
            }
            states.set(pos, stateForPos);
          }
        } catch (e) {
          console.warn(`[ApiExec/discover] galaxy[${cacheKey}] JSON parse failed:`, e);
        }
        if (states.size === 0) {
          console.warn(`[ApiExec/discover] galaxy[${cacheKey}] 0 positions parsed. Resp len=${galTxt.length}. First 400 chars:`, galTxt.slice(0, 400));
        }
        cache = { ts: Date.now(), states };
        cacheStore.set(cacheKey, cache);
        console.info(`[ApiExec/discover] galaxy[${cacheKey}] scanned ${states.size} positions: ${Array.from(states.entries()).map(([p, c]) => `${p}=${c.replace("planetDiscover", "")}`).join(", ")}`);
      } catch (e) {
        console.warn(`[ApiExec/discover] galaxy scan failed for ${cacheKey}:`, e);
      }
    }
    const positionState = cache?.states.get(position) ?? "";
    if (cache && cache.states.size > 0 && positionState !== "available") {
      // Operator 2026-05-27: dump entire system's state into result so
      // sidecar planner can mark ALL cooled coords done in one ack —
      // avoid dispatching the remaining 14 cooldown coords this tick.
      const systemStates: Record<string, "cooldown" | "unavailable"> = {};
      for (const [pos, st] of cache.states) {
        if (st !== "available") systemStates[`${galaxy}:${system}:${pos}`] = st as "cooldown" | "unavailable";
      }
      console.info(`[ApiExec/discover] ${galaxy}:${system}:${position} pre-check SKIP (state=${positionState || "unknown"}) — no POST. system batch-skip ${Object.keys(systemStates).length} coords`);
      return { action: directive.action, clicked: true, system_states: systemStates } as unknown as { action: string; clicked: boolean };
    }

    // Slot-gate defense in depth. Galaxy fetch above wrote authoritative
    // usedFleetSlots/maximumFleetSlots into the store. Read them back here
    // — if used >= max - 1 (would consume the last empty slot), refuse POST.
    // Planner has the same gate, but it operates on snapshots and may be
    // stale within a burst of dispatches; this is the actual point of no
    // return. Operator 2026-05-23: "艦隊:16/16 不要满 保留一槽".
    try {
      const storeRef = (this.win as Window & { __ogamexStore?: { state: { server?: { used_fleet_slots?: number; max_fleet_slots?: number } } } }).__ogamexStore;
      const srv = storeRef?.state.server;
      const usedNow = srv?.used_fleet_slots ?? -1;
      const maxNow = srv?.max_fleet_slots ?? -1;
      if (usedNow >= 0 && maxNow > 0 && usedNow >= maxNow - 1) {
        // Operator 2026-05-27: "pending it dont drop". Signal HOLD to sidecar
        // via skipped:"slot_full" — sidecar reverts optimistic completed[]
        // add so planner re-selects this coord next tick. Without skipped
        // signal, ack-success leaves coord in completed[] = silent drop.
        console.warn(`[ApiExec/discover] ${galaxy}:${system}:${position} SLOT GATE HOLD — used=${usedNow}/${maxNow} keep-1, ack skipped:slot_full (sidecar will revert + retry)`);
        return { action: directive.action, clicked: false, skipped: "slot_full" } as unknown as { action: string; clicked: boolean };
      }
    } catch (e) { void e; /* missing store = skip the gate, fall through */ }

    // Operator 2026-05-25: "种族发现任务是不是在点击网页，打开以后就会
    // 很卡，改成api方式". Previously we did a second HTTP GET to
    // /component=galaxy&cp=PID just to extract a CSRF token from the
    // HTML page. That GET carries cp= which SWITCHES ogame's session-cp
    // — if operator has the ogame tab open, the session shifts and
    // their UI silently re-renders the source planet's galaxy view,
    // hammering the page and causing visible lag.
    //
    // The fetchGalaxyContent JSON response above already returns
    // `token` at top-level. Use that — no second HTTP call, no
    // session-cp switch, no UI lag. dataset cache fallback if the
    // galaxy fetch failed earlier.
    let token: string | null = null;
    if (cache && cache.states.size > 0) {
      // We just fetched fetchGalaxyContent — token is in galaxyJsonTok
      const w = this.win as Window & { __ogamexLastGalaxyToken?: string };
      token = w.__ogamexLastGalaxyToken ?? null;
    }
    if (!token) {
      const cached = (this.doc.documentElement as HTMLElement).dataset["ogamexToken"];
      if (!cached) throw new Error("discover: no token in galaxy json nor dataset cache");
      console.warn(`[ApiExec/discover] using dataset.ogamexToken cache (no fresh galaxy token)`);
      token = cached;
    }

    // outer execute() owns the single restoreSessionCp call.
    const body = new URLSearchParams({
      galaxy: String(galaxy),
      system: String(system),
      position: String(position),
      token,
    });
    console.info(`[ApiExec/discover] POST ${galaxy}:${system}:${position} from planet ${planetId}`);
    const r = await fetchWithCpBypassBusy(
      `/game/index.php?page=ingame&component=fleetdispatch&action=sendDiscoveryFleet&ajax=1&asJson=1`,
      { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body },
      planetId,
      { skipRestore: true },
    );
    if (!r.ok) throw new Error(`discover: HTTP ${r.status}`);
    const respText = await r.text();
    // ogame v12 sendDiscoveryFleet response shape (verified from real POST):
    //   { "response": { "success": boolean, "message": "..." },
    //     "components": [], "newAjaxToken": "..." }
    // success is NESTED inside "response", NOT at top level.
    let parsed: {
      response?: { success?: boolean; message?: string };
      success?: boolean; status?: string; // top-level fallback
      errors?: Array<{ message?: string; error?: number }>;
      newAjaxToken?: string;
      message?: string;
    } | null = null;
    try { parsed = JSON.parse(respText); } catch { /* HTML */ }
    console.info(`[ApiExec/discover] resp HTTP ${r.status} body[0:200]=${respText.slice(0, 200).replace(/\s+/g, " ")}`);
    // Operator 2026-05-25: ogame sometimes returns plain text like
    // "An error has occured!" with HTTP 200 but no JSON. Without
    // detecting this, we treat it as "success", don't rotate token,
    // and the NEXT POST fails with "在您最後一個動作時,發生錯誤"
    // because we re-use a stale token. Invalidate the stash so the
    // next call refetches a fresh galaxy token.
    const nonJson = parsed === null;
    if (nonJson) {
      console.warn(`[ApiExec/discover] non-JSON response (likely error page) — invalidating token, next POST will refetch galaxy`);
      (this.win as Window & { __ogamexLastGalaxyToken?: string }).__ogamexLastGalaxyToken = undefined;
      // Also drop cached galaxy state so the next discover re-fetches
      // fresh fetchGalaxyContent → fresh token.
      const cacheStore = (this.win as Window & { __ogamexGalaxyDiscovery?: Map<string, { ts: number; states: Map<number, string> }> }).__ogamexGalaxyDiscovery;
      cacheStore?.delete(cacheKey);
      throw new Error(`discover ${galaxy}:${system}:${position} returned non-JSON: ${respText.slice(0, 100)}`);
    }
    if (parsed?.newAjaxToken) {
      (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = parsed.newAjaxToken;
      try { this.win.localStorage.setItem("OGAMEX_TOKEN", parsed.newAjaxToken); } catch { /* */ }
      // Operator 2026-05-25 console: subsequent sendDiscoveryFleet POSTs
      // failed with "在您最後一個動作時,發生錯誤" because we kept reusing
      // the OLD galaxy token. ogame rotates a fresh token on every
      // sendDiscoveryFleet response (success OR failure). Use it for
      // the NEXT POST.
      (this.win as Window & { __ogamexLastGalaxyToken?: string }).__ogamexLastGalaxyToken = parsed.newAjaxToken;
    }
    // Check BOTH nested + top-level (defensive).
    const innerSuccess = parsed?.response?.success;
    const outerSuccess = parsed?.success;
    const failed = innerSuccess === false || outerSuccess === false || parsed?.status === "failure";
    if (failed) {
      const msg = parsed?.response?.message ?? parsed?.errors?.[0]?.message ?? parsed?.message ?? "unknown";
      // Cooldown rejection (system-level rate limit OR per-coord 7d):
      // ogame text contains "再次搜索" / "再次搜索生命形式" / "next" / 等待 / cooldown.
      // Treat as "this coord attempted" — append to completed[] via the
      // standard success path so planner moves to next coord. Throwing
      // here flips goal to blocked which stops progress entirely.
      const isCooldown = /再次搜索|再次搜尋|next.*search|cooldown|wait|#time#/i.test(msg);
      if (isCooldown) {
        console.warn(`[ApiExec/discover] ${galaxy}:${system}:${position} COOLDOWN — marking attempted, moving to next`);
        return { action: directive.action, clicked: true };
      }
      // Operator 2026-05-25 verify: ogame intermittently returns "資源不足/
      // resources insufficient" even when store + ogame top-bar both show
      // resources WELL ABOVE the threshold (5000 metal / 1000 crystal /
      // 500 deuterium). Re-POST same payload immediately succeeds. Likely
      // backend race / lock contention during burst discovery. Self-heal:
      // when our state shows resources >= threshold, retry once. Persistent
      // failure → throw.
      const isResShortage = /資源不足|资源不足|insufficient.*resource|resource.*insufficient|not enough/i.test(msg);
      if (isResShortage) {
        const storeRes = (this.win as Window & { __ogamexStore?: { state: { planets: Record<string, { resources?: { m?: number; c?: number; d?: number } }> } } })
          .__ogamexStore?.state?.planets?.[planetId]?.resources;
        const m = storeRes?.m ?? 0, c = storeRes?.c ?? 0, d = storeRes?.d ?? 0;
        const aboveThreshold = m >= 5000 && c >= 1000 && d >= 500;
        if (aboveThreshold) {
          console.warn(`[ApiExec/discover] ${galaxy}:${system}:${position} 資源不足 误报 (store m=${m} c=${c} d=${d}) — single retry`);
          const retryToken = parsed?.newAjaxToken ?? token;
          const retryBody = new URLSearchParams({ galaxy: String(galaxy), system: String(system), position: String(position), token: retryToken });
          const r2 = await fetchWithCpBypassBusy(
            `/game/index.php?page=ingame&component=fleetdispatch&action=sendDiscoveryFleet&ajax=1&asJson=1`,
            { method: "POST", credentials: "same-origin",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
              body: retryBody },
            planetId,
            { skipRestore: true },
          );
          const retryText = await r2.text();
          let retryParsed: typeof parsed = null;
          try { retryParsed = JSON.parse(retryText); } catch { /* */ }
          console.info(`[ApiExec/discover] retry ${galaxy}:${system}:${position} resp[0:200]=${retryText.slice(0, 200).replace(/\s+/g, " ")}`);
          if (retryParsed?.newAjaxToken) {
            (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = retryParsed.newAjaxToken;
            try { this.win.localStorage.setItem("OGAMEX_TOKEN", retryParsed.newAjaxToken); } catch { /* */ }
            (this.win as Window & { __ogamexLastGalaxyToken?: string }).__ogamexLastGalaxyToken = retryParsed.newAjaxToken;
          }
          const retrySuccess = retryParsed?.response?.success !== false && retryParsed?.success !== false;
          if (retrySuccess) {
            console.info(`[ApiExec/discover] retry SUCCESS for ${galaxy}:${system}:${position}`);
            try {
              const incFn = (this.win as Window & { __ogamexIncrementUsedSlot?: () => void }).__ogamexIncrementUsedSlot;
              if (incFn) incFn();
            } catch { /* */ }
            return { action: directive.action, clicked: true };
          }
          const retryMsg = retryParsed?.response?.message ?? retryParsed?.message ?? "unknown";
          throw new Error(`discover ${galaxy}:${system}:${position} rejected after retry: ${retryMsg}`);
        }
        console.warn(`[ApiExec/discover] ${galaxy}:${system}:${position} 資源不足 — store actually low (m=${m} c=${c} d=${d}) — no retry`);
      }
      throw new Error(`discover ${galaxy}:${system}:${position} rejected: ${msg}`);
    }
    // Optimistic local slot increment — the new fleet is in flight. Next
    // planner tick will re-read this and gate correctly even before the
    // next galaxy fetch refreshes the authoritative count. The 10s
    // /movement harvest will overwrite this with truth.
    try {
      const incFn = (this.win as Window & { __ogamexIncrementUsedSlot?: () => void }).__ogamexIncrementUsedSlot;
      if (incFn) incFn();
    } catch (e) { void e; }
    return { action: directive.action, clicked: true };
  }

  /**
   * Restore ogame session-cp back to the operator's view planet after a
   * background POST that used cp=<otherPlanet>. Operator 2026-05-25:
   * "发现任务会干扰前台操作，其他星球发的舰队的任务会变到从进行发现的星球上".
   * Background POSTs carry cp= to target a specific source planet, which
   * also SHIFTS the session's active planet — so the operator's next
   * manual click in their tab inherits OUR planet, not theirs. Fix by
   * issuing one cheap ajax GET with cp=<operatorCp> after each
   * cp-targeted POST.
   */
  /**
   * Get a fresh CSRF token for fleet dispatch chains without fetching the
   * heavy /component=fleetdispatch HTML page. Operator 2026-05-25:
   * "用 api 实现 不要点网页". Sources, in priority:
   *   1. document.documentElement.dataset.ogamexToken — sniffer-cached
   *      from operator's recent ogame interactions or our prior successful
   *      POSTs. Zero HTTP if present.
   *   2. fetchEventBox ajax JSON — tiny ~200B payload, returns
   *      newAjaxToken at top-level. Same session as operator.
   * Shared by execExpedition / execColonize / execFleetSend.
   */
  private async bootstrapFleetToken(planetId: string, action: string): Promise<string> {
    let token: string | null = (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] ?? null;
    if (token && token.length >= 16) return token;
    try {
      const ebResp = await fetchWithCpBypassBusy(
        `/game/index.php?page=componentOnly&component=eventList&action=fetchEventBox&ajax=1&asJson=1`,
        { method: "GET", credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
        planetId,
        { skipRestore: true },
      );
      const ebJson = await ebResp.json() as { newAjaxToken?: string };
      if (ebJson.newAjaxToken && ebJson.newAjaxToken.length >= 16) {
        token = ebJson.newAjaxToken;
        (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = token;
      }
    } catch (e) {
      console.warn(`[ApiExec/${action}] fetchEventBox token bootstrap failed:`, e);
    }
    if (!token) throw new Error(`${action}: no token (dataset empty + fetchEventBox failed)`);
    return token;
  }

  private async restoreSessionCp(operatorCp: string | null, wePostedCp: string): Promise<void> {
    if (!operatorCp || operatorCp === wePostedCp) return;
    await restoreSessionCp(operatorCp);
  }
}
