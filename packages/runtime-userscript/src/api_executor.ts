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
  }

  canHandle(d: Directive): boolean {
    return d.method === "ui" && ["build", "research", "build_ships", "expedition", "colonize", "deploy", "transport"].includes(d.action);
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

    if (directive.action === "expedition") return this.execExpedition(directive, planetId);
    if (directive.action === "colonize") return this.execColonize(directive, planetId);
    if (directive.action === "deploy" || directive.action === "transport") {
      return this.execFleetSend(directive, planetId);
    }

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

  /**
   * Live-DOM click: when the user happens to be on the target component
   * page, find the upgrade button in document and click it. ogame's own
   * onclick handler fires — that handler knows the exact endpoint, token
   * chain, modus, etc. Returns null if not applicable.
   */
  /** Click ogame's left-nav menu button to SPA-navigate to a component
   *  without full page reload. Returns true if a nav was kicked off.
   *
   *  Operator gate: if userBusy is active, refuse to nav — operator is
   *  manually using a page and the click would yank them off it. The
   *  caller treats false as "couldn't prepare page, defer the directive". */
  private kickMenuNav(component: string): boolean {
    const busyUntil = (this.win as Window & { __ogamexUserBusyUntil?: number }).__ogamexUserBusyUntil ?? 0;
    if (busyUntil > Date.now()) {
      console.info(`[ApiExec/nav] refused -> ${component} (operator active, +${Math.round((busyUntil - Date.now()) / 1000)}s)`);
      return false;
    }
    const link = this.doc.querySelector<HTMLAnchorElement>(
      `a.menubutton[href*="component=${component}"]`,
    );
    if (!link) return false;
    console.info(`[ApiExec/nav] clicking menubutton -> ${component}`);
    link.click();
    return true;
  }

  /** Wait up to `ms` for window.location.href to contain the component param. */
  private async waitForUrl(component: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const href = this.win.location?.href ?? "";
      if (href.includes(`component=${component}`)) {
        // Give ogame's content-swap a moment to render the upgrade buttons.
        await new Promise((r) => setTimeout(r, 1200));
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  private async tryLivePageClickAsync(directive: Directive): Promise<{ action: string; clicked: boolean } | null> {
    const sync = this.tryLivePageClick(directive);
    if (sync) return sync;
    // Not on right page. Decide if auto-nav is permitted.
    const NAV_COOLDOWN_MS = 10_000;
    const IDLE_MS = 10_000;
    const userBusy = Date.now() - this.lastUserActivityTs < IDLE_MS;
    const navCooldown = Date.now() - this.lastNavTs < NAV_COOLDOWN_MS;
    if (userBusy || navCooldown) {
      console.info(`[ApiExec/nav] skip auto-nav (userBusy=${userBusy} cooldown=${navCooldown})`);
      return null;
    }
    let component = "";
    if (directive.action === "research") component = "research";
    else if (directive.action === "build_ships") component = "shipyard";
    else if (directive.action === "build") {
      const b = (directive.params as { building?: string }).building ?? "";
      const FAC = new Set(["shipyard", "researchLab", "roboticsFactory", "naniteFactory", "allianceDepot", "missileSilo"]);
      component = FAC.has(b) ? "facilities" : "supplies";
    }
    if (!component) return null;
    if (!this.kickMenuNav(component)) return null;
    this.lastNavTs = Date.now();
    const arrived = await this.waitForUrl(component, 6000);
    if (!arrived) {
      console.warn(`[ApiExec/nav] component=${component} not loaded in time`);
      return null;
    }
    // Retry live click after SPA settle.
    return this.tryLivePageClick(directive);
  }

  private tryLivePageClick(directive: Directive): { action: string; clicked: boolean } | null {
    const href = this.win.location?.href ?? "";
    let component = "";
    let numericId = 0;
    if (directive.action === "research") {
      component = "research";
      const tech = (directive.params as { tech?: string }).tech ?? "";
      numericId = OGAME_NUMERIC_ID[tech] ?? 0;
    } else if (directive.action === "build_ships") {
      component = "shipyard";
      const ship = (directive.params as { ship?: string }).ship ?? "";
      numericId = OGAME_NUMERIC_ID[ship] ?? 0;
    } else if (directive.action === "build") {
      const building = (directive.params as { building?: string }).building ?? "";
      const FAC = new Set(["shipyard", "researchLab", "roboticsFactory", "naniteFactory", "allianceDepot", "missileSilo"]);
      component = FAC.has(building) ? "facilities" : "supplies";
      numericId = OGAME_NUMERIC_ID[building] ?? 0;
    }
    if (!component || !numericId) return null;
    if (!href.includes(`component=${component}`)) return null;
    const sels = [
      `li.technology[data-technology="${numericId}"] button.upgrade`,
      `li.technology[data-technology="${numericId}"] a.upgrade`,
      `li.technology[data-technology="${numericId}"] .upgrade`,
      `li.technology[data-technology="${numericId}"] button[type="submit"]`,
      `li.technology[data-technology="${numericId}"]`,
      `button.upgrade[data-technology="${numericId}"]`,
      `a.upgrade[data-technology="${numericId}"]`,
    ];
    let hit: HTMLElement | null = null;
    let matched = "";
    for (const s of sels) {
      const e = this.doc.querySelector<HTMLElement>(s);
      if (e) { hit = e; matched = s; break; }
    }
    if (!hit) {
      console.info(`[ApiExec/live] no button in live DOM for ${component}:${numericId}`);
      return null;
    }
    if (directive.action === "build_ships") {
      const amount = ((): number => {
        const a = (directive.params as { amount?: unknown }).amount;
        return typeof a === "number" && a > 0 ? Math.floor(a) : 1;
      })();
      const amtSels = [
        `li.technology[data-technology="${numericId}"] input[name="menge[${numericId}]"]`,
        `li.technology[data-technology="${numericId}"] input[name="menge"]`,
        `li.technology[data-technology="${numericId}"] input[type="number"]`,
        `input.maxbuildable`,
      ];
      for (const s of amtSels) {
        const inp = this.doc.querySelector<HTMLInputElement>(s);
        if (inp) {
          inp.value = String(amount);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }
    }
    console.info(`[ApiExec/live] CLICK ${matched} for ${directive.action}:${numericId}`);
    hit.click();
    return { action: directive.action, clicked: true };
  }

  /** Fetch a fresh CSRF token + check ogame status for the target tech. */
  private async fetchTokenAndStatus(
    component: string,
    planetId: string,
    numericId: number,
  ): Promise<{ token: string; status: string | null; reason: string | null }> {
    const url = `/game/index.php?page=ingame&component=${component}&cp=${planetId}`;
    const resp = await this.fetchFn(url, { credentials: "same-origin" });
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
    const postUrl = `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1&cp=${planetId}`;
    const body = new URLSearchParams({
      technologyId: String(numericId),
      amount: "1",
      mode: "1",
      token,
    });
    const r = await this.fetchFn(postUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    if (!r.ok) throw new Error(`api: ${component} upgrade HTTP ${r.status}`);
    const respText = await r.text();
    let parsed: { success?: boolean; errors?: Array<{ message?: string }>; error?: string; newAjaxToken?: string } | null = null;
    try { parsed = JSON.parse(respText); } catch { /* HTML */ }
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
    if (isGenericRetry) {
      const retryBody = new URLSearchParams({ ...Object.fromEntries(body), token: parsed.newAjaxToken });
      console.info(`[ApiExec] ${component}:${targetName} RETRY with rotated token`);
      const r2 = await this.fetchFn(postUrl, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body: retryBody,
      });
      const r2Text = await r2.text();
      let parsed2: { success?: boolean; status?: string; errors?: unknown; newAjaxToken?: string } | null = null;
      try { parsed2 = JSON.parse(r2Text); } catch { /* */ }
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
    const postUrl = `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1&cp=${planetId}`;
    const body = new URLSearchParams({
      technologyId: String(numericId),
      amount: String(amount),
      mode: "1",
      token,
    });
    const r = await this.fetchFn(postUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    if (!r.ok) throw new Error(`api: shipyard build HTTP ${r.status}`);
    const respText = await r.text();
    let parsed: { success?: boolean; errors?: Array<{ message?: string }>; error?: string; newAjaxToken?: string } | null = null;
    try { parsed = JSON.parse(respText); } catch { /* HTML response */ }
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
      const r2 = await this.fetchFn(postUrl, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body: retryBody,
      });
      const r2Text = await r2.text();
      let parsed2: { success?: boolean; status?: string; errors?: unknown; newAjaxToken?: string } | null = null;
      try { parsed2 = JSON.parse(r2Text); } catch { /* */ }
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
    // BLOCKING preflight — owner explicit requirement: "每次远征之前从 api
    // 拿最新的舰船数量". v0.0.166 had fire-and-forget pollEmpire (data lands
    // too late). v0.0.167 had fdHtml2 parse (caused 140042). This version
    // calls a focused helper that does (a) ogame empire API fetch, (b) parses
    // ship counts per planet, (c) writes them to store, (d) returns this
    // planet's ships. AWAIT it — block 100-500ms — then compare to template.
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
    const fdUrl = `/game/index.php?page=ingame&component=fleetdispatch&cp=${planetId}`;
    const fdResp = await this.fetchFn(fdUrl, { credentials: "same-origin" });
    const fdHtml = await fdResp.text();
    const tokenMatch =
      fdHtml.match(/<input[^>]*name="token"[^>]*value="([^"]+)"/i)
      ?? fdHtml.match(/<meta[^>]*name="ogame-token"[^>]*content="([^"]+)"/i);
    let token: string | null = tokenMatch ? tokenMatch[1]! : null;
    // Try live DOM token if fetched HTML doesn't have it. ogame pages
    // bury tokens in inline JS / hidden fields late in HTML.
    if (!token) {
      const liveInput = this.doc.querySelector<HTMLInputElement>('input[name="token"]');
      token = liveInput?.value ?? null;
      if (token) console.info(`[ApiExec] expedition: token from LIVE DOM (len=${token.length})`);
    }
    // Search more aggressively. ogame v12 stores the fleet-dispatch
    // token as `var token = "abc..."` in inline JS, NOT in any <input>.
    if (!token) {
      const m2 =
        fdHtml.match(/var\s+token\s*=\s*['"]([a-zA-Z0-9]{16,})['"]/)
        ?? fdHtml.match(/['"]token['"]\s*:\s*['"]([a-zA-Z0-9]{16,})['"]/)
        ?? fdHtml.match(/\btoken\s*=\s*['"]([a-zA-Z0-9]{16,})['"]/);
      if (m2) token = m2[1]!;
    }
    if (!token) {
      // Dump WHERE in HTML token-like strings appear so we can pin format.
      const tokenLines = fdHtml.split("\n").filter((l) => /token/i.test(l)).slice(0, 5).map((l) => l.trim().slice(0, 200));
      console.warn(`[ApiExec] expedition: no token. fdHtml=${fdHtml.length}B. token-mention lines:\n${tokenLines.join("\n  -- ")}`);
      throw new Error("expedition: no token on fleetdispatch page");
    }
    console.info(`[ApiExec] expedition step1: GOT token len=${token.length}`);

    const POST = async (action: string, body: URLSearchParams): Promise<{ token: string; raw: string; json: { newAjaxToken?: string; success?: boolean; message?: string; errors?: Array<{ message?: string; error?: number }> } }> => {
      // cp=<planetId> routes to the specific source planet. Without it
      // ogame's session uses the currently-active cp cookie (whatever
      // planet the operator was last viewing) — and the fleet POSTs land
      // on that planet, not the goal's planet.
      const url = `/game/index.php?page=ingame&component=fleetdispatch&action=${action}&ajax=1&asJson=1&cp=${planetId}`;
      const r = await this.fetchFn(url, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
      });
      const txt = await r.text();
      let j: ReturnType<typeof POST> extends Promise<infer T> ? T["json"] : never;
      try { j = JSON.parse(txt); } catch { j = {}; }
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
    const stage3Url = `/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1&cp=${planetId}`;
    console.info(`[ApiExec] expedition step4: sendFleet target=${galaxy}:${system}:16 ships=${JSON.stringify(ships)}`);
    const r = await this.fetchFn(stage3Url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: stage3Body,
    });
    const txt = await r.text();
    console.info(`[ApiExec] expedition step5: resp HTTP ${r.status} body=${txt.slice(0,300)}`);
    if (!r.ok) throw new Error(`expedition: HTTP ${r.status}`);
    // ogame returns JSON {success:true} or {success:false, errors:[...]}.
    // Parse OUTSIDE a swallowing catch so failures actually propagate.
    let parsed: { success?: boolean; errors?: Array<{ message?: string; error?: number }> } | null = null;
    try { parsed = JSON.parse(txt); } catch { /* not JSON — accept HTTP 200 as opaque success */ }
    if (parsed && (parsed.success === false || parsed.status === "failure")) {
      const msg = parsed.errors?.[0]?.message ?? "unknown error";
      const code = parsed.errors?.[0]?.error ?? -1;
      const reqBodyStr = stage3Body.toString();
      try {
        (this.win as Window & { __ogamexLastExpFailure?: unknown }).__ogamexLastExpFailure = {
          ts: Date.now(), url: stage3Url, reqBody: reqBodyStr,
          respBody: txt.slice(0, 800), sentShips: ships,
          targetCoords: `${galaxy}:${system}:16`, planetId,
        };
      } catch { /* ignore */ }
      // Include REQUEST body in error so /v1/goals reason shows exactly what
      // we sent — operator can verify am202, am203, etc. counts vs planet.
      throw new Error(`expedition rejected by ogame (${code}): ${msg} | req: ${reqBodyStr.slice(0, 250)} | resp: ${txt.slice(0, 200).replace(/\s+/g, " ")}`);
    }
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
    // Token chain (same 3-step pattern as expedition).
    const fdUrl = `/game/index.php?page=ingame&component=fleetdispatch&cp=${planetId}`;
    const fdResp = await this.fetchFn(fdUrl, { credentials: "same-origin" });
    const fdHtml = await fdResp.text();
    let token: string | null = null;
    const m1 = fdHtml.match(/var\s+token\s*=\s*['"]([a-zA-Z0-9]{16,})['"]/);
    if (m1) token = m1[1]!;
    if (!token) {
      const datasetTok = (this.doc.documentElement as HTMLElement).dataset["ogamexToken"];
      token = datasetTok ?? null;
    }
    if (!token) throw new Error("colonize: no token");
    console.info(`[ApiExec] colonize step1: token len=${token.length}`);

    const POST = async (action: string, body: URLSearchParams): Promise<{ token: string; raw: string; json: { newAjaxToken?: string; success?: boolean; message?: string; errors?: Array<{ message?: string; error?: number }> } }> => {
      const url = `/game/index.php?page=ingame&component=fleetdispatch&action=${action}&ajax=1&asJson=1&cp=${planetId}`;
      const r = await this.fetchFn(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body,
      });
      const txt = await r.text();
      let j: { newAjaxToken?: string; success?: boolean; message?: string; errors?: Array<{ message?: string; error?: number }> } = {};
      try { j = JSON.parse(txt); } catch { /* */ }
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
    const stage3Url = `/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1&cp=${planetId}`;
    console.info(`[ApiExec] colonize step4: sendFleet target=${tGalaxy}:${tSystem}:${tPos} mission=7`);
    const r = await this.fetchFn(stage3Url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body: stage3Body,
    });
    const txt = await r.text();
    console.info(`[ApiExec] colonize step5: HTTP ${r.status} body=${txt.slice(0,300)}`);
    if (!r.ok) throw new Error(`colonize HTTP ${r.status}`);
    let parsed: { success?: boolean; errors?: Array<{ message?: string; error?: number }> } | null = null;
    try { parsed = JSON.parse(txt); } catch { /* */ }
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
    const fdUrl = `/game/index.php?page=ingame&component=fleetdispatch&cp=${planetId}`;
    const fdResp = await this.fetchFn(fdUrl, { credentials: "same-origin" });
    const fdHtml = await fdResp.text();
    let token: string | null = null;
    const m1 = fdHtml.match(/var\s+token\s*=\s*['"]([a-zA-Z0-9]{16,})['"]/);
    if (m1) token = m1[1]!;
    if (!token) {
      const datasetTok = (this.doc.documentElement as HTMLElement).dataset["ogamexToken"];
      token = datasetTok ?? null;
    }
    if (!token) throw new Error(`${directive.action}: no token`);
    console.info(`[ApiExec] ${directive.action} step1: token len=${token.length}`);

    const POST = async (action: string, body: URLSearchParams): Promise<{ token: string; raw: string; json: { newAjaxToken?: string; success?: boolean; errors?: Array<{ message?: string; error?: number }> } }> => {
      const url = `/game/index.php?page=ingame&component=fleetdispatch&action=${action}&ajax=1&asJson=1&cp=${planetId}`;
      const r = await this.fetchFn(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body,
      });
      const txt = await r.text();
      let j: { newAjaxToken?: string; success?: boolean; errors?: Array<{ message?: string; error?: number }> } = {};
      try { j = JSON.parse(txt); } catch { /* */ }
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
    const stage3Url = `/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1&cp=${planetId}`;
    console.info(`[ApiExec] ${directive.action} step4: sendFleet ${tGalaxy}:${tSystem}:${tPos} mission=${mission}`);
    const r = await this.fetchFn(stage3Url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body: stage3Body,
    });
    const txt = await r.text();
    console.info(`[ApiExec] ${directive.action} step5: HTTP ${r.status} body=${txt.slice(0,300)}`);
    if (!r.ok) throw new Error(`${directive.action} HTTP ${r.status}`);
    let parsed: { success?: boolean; errors?: Array<{ message?: string; error?: number }> } | null = null;
    try { parsed = JSON.parse(txt); } catch { /* */ }
    if (parsed && (parsed.success === false || parsed.status === "failure")) {
      const msg = parsed.errors?.[0]?.message ?? "unknown";
      throw new Error(`${directive.action} rejected: ${msg}`);
    }
    return { action: directive.action, clicked: true };
  }
}
