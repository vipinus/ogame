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
import { sendFleet as fleetApiSendFleet, cpPostWithRetry } from "./api/fleet_api.js";
import type { TokenManager } from "./api/token_manager.js";

export interface ApiExecutorDeps {
  win: Window;
  doc: Document;
  fetch?: typeof fetch;
  /** v0.0.436: pass through the wire_runtime tokenManager so execFleetSend
   *  can delegate to fleet_api.sendFleet (the validated FS path) instead of
   *  reinventing the 3-stage chain. Optional for back-compat / tests. */
  tokenManager?: TokenManager;
  /** Same fetch reference used for FS — also passed to fleet_api.sendFleet. */
  fetchFn?: typeof fetch;
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
  private readonly tokenManager?: TokenManager;
  private lastUserActivityTs = 0;
  private lastNavTs = 0;

  constructor(deps: ApiExecutorDeps) {
    this.win = deps.win;
    this.doc = deps.doc;
    this.fetchFn = deps.fetchFn ?? deps.fetch ?? deps.win.fetch.bind(deps.win);
    this.tokenManager = deps.tokenManager;
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
    return d.method === "ui" && ["build", "research", "build_ships", "expedition", "colonize", "deploy", "transport", "discover", "jumpgate"].includes(d.action);
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
      if (directive.action === "jumpgate") return this.execJumpgate(directive, planetId);
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
    // v0.0.441: route through fleet_api.cpPostWithRetry (method=GET) so this
    // token-page fetch picks up the same cp-shift + transient handling as
    // every other dispatcher. Returns raw HTML in result.raw (json is null
    // for non-JSON responses by design).
    if (!this.tokenManager) throw new Error(`${component}: no tokenManager wired`);
    const resp = await cpPostWithRetry({
      endpoint: `/game/index.php?page=ingame&component=${component}`,
      sourcePlanetId: planetId,
      token: this.tokenManager,
      action: `${component}:tokenpage`,
      method: "GET",
      maxAttempts: 2,
      skipRestore: true,
    });
    const html = resp.raw;
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
    // v0.0.442: route through fleet_api.cpPostWithRetry — built-in 4-attempt
    // + TOKEN_INVALID_RE refresh + TRANSIENT_RACE_RE backoff replaces the
    // hand-rolled retry block below. tokenManager fallback chain (dataset →
    // input[name=token] → meta → localStorage) lives inside TokenManager's
    // extractor callback, no duplication needed here.
    if (!this.tokenManager) throw new Error(`${component}: no tokenManager wired`);
    const res = await cpPostWithRetry({
      endpoint: `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1`,
      sourcePlanetId: planetId,
      token: this.tokenManager,
      action: `${component}:${targetName}:scheduleEntry`,
      method: "POST",
      buildBody: (tk) => new URLSearchParams({
        technologyId: String(numericId),
        amount: "1",
        mode: "1",
        token: tk,
      }),
      maxAttempts: 4,
      skipRestore: true,
    });
    if (res.json && ((res.json as { success?: boolean }).success === false || (res.json as { status?: string }).status === "failure")) {
      const errs = (res.json as { errors?: unknown; error?: unknown }).errors ?? (res.json as { error?: unknown }).error;
      throw new Error(`${component}:${targetName} rejected: ${JSON.stringify(errs)}`);
    }
    // v0.0.554 — operator 2026-05-31 "资源够了为什么不建": build jumpgate L2 @
    // moon 33642959 dispatched every 30s for hours; ogame never accepted but
    // userscript treated each non-JSON HTML response as success → ack success
    // → goal stayed "active" → planner re-dispatched indefinitely. Real ogame
    // success returns JSON {success:true,...} with newAjaxToken. If json is
    // null (HTML overlay = "missing prereq / not enough resources / wrong
    // page") OR success flag missing/false, treat as failure so the goal
    // gets the real reason from raw body instead of fake-completing.
    if (!res.json || (res.json as { success?: boolean }).success !== true) {
      const snippet = res.raw.slice(0, 240).replace(/\s+/g, " ");
      throw new Error(`${component}:${targetName} rejected (non-success response HTTP ${res.status}): ${snippet}`);
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
    void token;  // legacy local fallback; tokenManager handles refresh now
    // v0.0.443: route through fleet_api.cpPostWithRetry — same retry / token
    // refresh pattern as the simpleUpgrade path. Caller-side token kept only
    // for the status/disabled check above; the POST uses tokenManager's
    // managed token per attempt.
    if (!this.tokenManager) throw new Error(`shipyard: no tokenManager wired`);
    const res = await cpPostWithRetry({
      endpoint: `/game/index.php?page=componentOnly&component=buildlistactions&action=scheduleEntry&asJson=1`,
      sourcePlanetId: planetId,
      token: this.tokenManager,
      action: `shipyard:${ship}×${amount}:scheduleEntry`,
      method: "POST",
      buildBody: (tk) => new URLSearchParams({
        technologyId: String(numericId),
        amount: String(amount),
        mode: "1",
        token: tk,
      }),
      maxAttempts: 4,
      skipRestore: true,
    });
    if (res.json && ((res.json as { success?: boolean }).success === false || (res.json as { status?: string }).status === "failure")) {
      const errs = (res.json as { errors?: unknown; error?: unknown }).errors ?? (res.json as { error?: unknown }).error;
      throw new Error(`shipyard build rejected: ${JSON.stringify(errs)}`);
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

    // v0.0.439: delegate to fleet_api.sendFleet (mission=15 expedition,
    // type=1, position=16, holdingtime=1). Operator 2026-05-29 "全改".
    // Trade-off acknowledged: lose shipsData/cargo capacity harvest that
    // the old 3-stage checkTarget exposed — capacity will go stale. Worth
    // it for unified retry + transient detection across all fleet POSTs.
    if (!this.tokenManager) throw new Error("expedition: no tokenManager wired");
    console.info(`[ApiExec] expedition delegate→fleet_api.sendFleet ${galaxy}:${system}:16 mission=15 cp=${planetId}`);
    try {
      const res = await fleetApiSendFleet(
        {
          ships: ships as unknown as import("@ogamex/shared").ShipCount,
          cargo: { m: 0, c: 0, d: 0 },
          coords: [galaxy, system, 16],
          destType: 1,
          mission: 15 as import("@ogamex/shared").MissionCode,
          speed: 10,
          holdingTime: 1,
          sourcePlanetId: planetId,
        },
        { fetch: this.fetchFn, token: this.tokenManager },
      );
      console.info(`[ApiExec] expedition OK fleetId=${res.fleetId}`);
      try {
        const shipsData = (res.raw as { shipsData?: unknown }).shipsData;
        if (shipsData) cacheShipsData(shipsData, this.win);
      } catch (e) {
        console.warn("[ApiExec/expedition] shipsData cache failed:", e);
      }
    } catch (e) {
      throw new Error(`expedition rejected: ${(e instanceof Error ? e.message : String(e)).slice(0, 250)}`);
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
      if (typeof w.__ogamexHarvestMovement === "function") void w.__ogamexHarvestMovement().catch(() => { /* */ });
      if (typeof w.__ogamexPollEmpire === "function") void w.__ogamexPollEmpire({ force: true }).catch(() => { /* */ });
    } catch { /* */ }
    return { action: "expedition", clicked: true };
  }

  /* ─── BELOW IS LEGACY 3-stage IMPL kept for reference; unreachable. ─── */
  private async _execExpeditionLegacy_dead_code_kept_for_reference(
    directive: Directive,
    planetId: string,
  ): Promise<{ action: string; clicked: boolean }> {
    void directive; void planetId;
    const ships: Record<string, number> = {};
    const galaxy = 0, system = 0;
    void galaxy; void system; void ships;
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

  /**
   * Jumpgate dispatch (operator 2026-05-29 Phase 2b). Real ogame v12 endpoint
   * sniffed by boot.ts:670+:
   *   POST /game/index.php?page=componentOnly&component=jumpgate&action=executeJump&asJson=1
   *   body: token + targetSpaceObjectId + ship_<id> counts
   *   resp: { status:true, cooldown:<sec>, ... }
   * The overlay GET (page=ajax&component=jumpgate&overlay=1&ajax=1) is hit
   * first to harvest the token from the HTML form. session-cp must point at
   * the source moon (cp=<moonId>).
   */
  private async execJumpgate(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean }> {
    const params = directive.params as {
      source_moon_id?: string;
      target_moon_id?: string;
      ships?: Record<string, number>;
    };
    const sourceMoonId = params.source_moon_id ?? planetId;
    const targetMoonId = params.target_moon_id;
    if (!targetMoonId) throw new Error("jumpgate: missing target_moon_id");
    const ships = params.ships ?? {};
    if (Object.values(ships).every((n) => !n)) {
      throw new Error("jumpgate: empty ships payload");
    }
    // v0.0.437: mirror fleet_api.sendFleet 流程 — 4-attempt retry +
    // TRANSIENT race detection (140043 / 請稍後再試) + loud raw-body log
    // + token refresh on TOKEN_INVALID. operator 2026-05-29: "跳跃也走流程".
    const TRANSIENT_RACE_RE = /140043|請稍後再試|请稍后再试|稍後再試|try again later|cannot dispatch fleet/i;
    const TOKEN_INVALID_RE = /invalid token|csrf|session expired/i;
    const overlayUrl = `/game/index.php?page=ajax&component=jumpgate&overlay=1&ajax=1`;
    const fetchOverlayToken = async (): Promise<string> => {
      const overlayResp = await fetchWithCpBypassBusy(
        overlayUrl,
        { method: "GET", credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
        sourceMoonId,
        { skipRestore: true },
      );
      if (!overlayResp.ok) throw new Error(`jumpgate overlay HTTP ${overlayResp.status}`);
      const overlayHtml = await overlayResp.text();
      // v0.0.445: ogame v12 uses SINGLE quotes —
      //   <input type='hidden' name='token' value='4dad2571...' />
      // verified from operator's console context dump 2026-05-29.
      // Patterns now accept both ' and " via ["'].
      const tokenPatterns: RegExp[] = [
        /name=["']token["']\s+value=["']([a-zA-Z0-9_\-]+)["']/i,      // <input name='token' value='...'>
        /value=["']([a-zA-Z0-9_\-]{16,})["']\s+name=["']token["']/i,  // reversed attr order
        /["']token["']\s*[:=]\s*["']([a-zA-Z0-9_\-]+)["']/i,          // js: token: "..."
        /data-token=["']([a-zA-Z0-9_\-]+)["']/i,                       // data-token attr
        /var\s+token\s*=\s*["']([a-zA-Z0-9_\-]+)["']/i,                // var token = "..."
        /ajaxToken\s*=\s*["']([a-zA-Z0-9_\-]+)["']/i,                  // ajaxToken = "..."
        /["']?ajaxToken["']?\s*:\s*["']([a-zA-Z0-9_\-]+)["']/i,        // "ajaxToken": "..."
      ];
      for (const re of tokenPatterns) {
        const m = overlayHtml.match(re);
        if (m && m[1]) return m[1];
      }
      // No match — dump context around the FIRST occurrence of "token" so
      // operator can paste the real format and we add a pattern.
      const idx = overlayHtml.toLowerCase().indexOf("token");
      const ctx = idx >= 0 ? overlayHtml.slice(Math.max(0, idx - 60), idx + 160) : "<no 'token' substring>";
      console.warn(`[ApiExec/jumpgate] token regex failed (len=${overlayHtml.length}). Context around "token":`, ctx);
      throw new Error(`jumpgate: token not found in overlay (len=${overlayHtml.length}) — see console "Context around token" log`);
    };
    let token = await fetchOverlayToken();
    console.info(`[ApiExec/jumpgate] overlay token len=${token.length} src=${sourceMoonId} tgt=${targetMoonId} ships=${JSON.stringify(ships)}`);
    const buildJgBody = (tk: string): URLSearchParams => {
      const b = new URLSearchParams();
      b.append("token", tk);
      b.append("targetSpaceObjectId", targetMoonId);
      for (const [shipName, n] of Object.entries(ships)) {
        const numId = OGAME_NUMERIC_ID[shipName];
        if (!numId || n <= 0) continue;
        b.append(`ship_${numId}`, String(n));
      }
      return b;
    };
    let resp: { status?: boolean; success?: boolean; cooldown?: number; nextActionAt?: number; errors?: unknown; message?: string } = {};
    for (let attempt = 1; attempt <= 4; attempt++) {
      const body = buildJgBody(token);
      console.log(`[ApiExec/jumpgate] attempt=${attempt} POST cp=${sourceMoonId} body=${body.toString().replace(/token=[^&]+/, "token=***")}`);
      const r = await fetchWithCpBypassBusy(
        `/game/index.php?page=componentOnly&component=jumpgate&action=executeJump&asJson=1`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body,
        },
        sourceMoonId,
        { skipRestore: true },
      );
      const txt = await r.text();
      try { resp = JSON.parse(txt); } catch {
        throw new Error(`jumpgate non-JSON response (HTTP ${r.status}): ${txt.slice(0, 200)}`);
      }
      console.log(`[ApiExec/jumpgate] attempt=${attempt} resp status=${resp.status} success=${resp.success} message=${resp.message ?? "<none>"} errors=${JSON.stringify(resp.errors ?? null)} raw[0:300]=${txt.slice(0, 300)}`);
      // v0.0.546 forensic — mirror full JG response to sidecar journal.
      // Operator 2026-05-31 "JG 没有跳" → ghost ack suspected: ogame says
      // success but JG didn't fire. Full response often has a discriminator
      // (errors array, cooldown=0, message text) we need to see to fix.
      try {
        const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
        if (ctxWin.localStorage?.getItem("OGAMEX_FORENSIC") === "1") {
          const bridgeBase = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com";
          void fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
            method: "POST", credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tag: "JG-RESP",
              text: `attempt=${attempt} src=${sourceMoonId} → tgt=${targetMoonId} status=${resp.status} success=${resp.success} cooldown=${resp.cooldown ?? "<none>"} keys=[${Object.keys(resp).join(",")}] raw=${txt.slice(0, 1500)}`,
            }),
          }).catch(() => { /* */ });
        }
      } catch { /* */ }
      // v0.0.546 — ghost-ack defense (operator 2026-05-31 "JG 没有跳"):
      // ogame can return success=true while errors[] is populated. Don't
      // trust success flag alone; require errors[] to be empty too.
      // (We do NOT also require cooldown — that field's presence varies by
      // skin/version; can't safely use as a discriminator without ground
      // truth from journal forensic.)
      const rawOk = resp.status === true || resp.success === true;
      const errsArr = Array.isArray(resp.errors) ? resp.errors : [];
      const ok = rawOk && errsArr.length === 0;
      if (ok) break;
      if (rawOk && errsArr.length > 0) {
        throw new Error(`jumpgate ghost-ack: success flag set but errors=${JSON.stringify(errsArr).slice(0, 200)}`);
      }
      const errMsg = String(resp.message ?? JSON.stringify(resp.errors ?? "") ?? txt.slice(0, 200));
      if (attempt === 1 && TOKEN_INVALID_RE.test(errMsg)) {
        token = await fetchOverlayToken();
        continue;
      }
      if (TRANSIENT_RACE_RE.test(errMsg) && attempt < 4) {
        const backoffMs = 200 * attempt;
        console.warn(`[ApiExec/jumpgate] attempt=${attempt} transient race — backoff ${backoffMs}ms + token refresh`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        token = await fetchOverlayToken();
        continue;
      }
      throw new Error(`jumpgate rejected: ${errMsg.slice(0, 200)}`);
    }
    console.info(`[ApiExec/jumpgate] OK src=${sourceMoonId} → tgt=${targetMoonId} cooldown=${resp.cooldown ?? resp.nextActionAt ?? "?"}s`);
    // v0.0.546 — operator 2026-05-31 "跳跃以后要立刻刷新舰队数量". Old code
    // fired one pollEmpire force, but ogame's empire endpoint can return
    // pre-JG ship counts if the server-side state hasn't committed yet
    // (observed: src moon 4:299:8 LC=195 still shown after JG, dest moon
    // 4:242:8 LC=0). Fix: fire IMMEDIATE poll + retry after 3s safety net,
    // and mirror the trigger to sidecar journal for forensic.
    try {
      const w = (this.win as Window & { __ogamexPollEmpire?: (opts: { force?: boolean }) => Promise<void> });
      if (typeof w.__ogamexPollEmpire === "function") {
        void w.__ogamexPollEmpire({ force: true }).catch(() => { /* */ });
        setTimeout(() => {
          void w.__ogamexPollEmpire!({ force: true }).catch(() => { /* */ });
        }, 3000);
      }
    } catch { /* */ }
    // v0.0.553 — JG-OK forensic mirror removed; JG infrequent enough that
    // sidecar journal [merger] DISPATCH + goal status transitions are
    // sufficient to trace.
    return { action: "jumpgate", clicked: true };
  }

  /** Colonize fleet dispatch — mirrors execExpedition's 3-step token chain
   *  but with mission=7 (colonization), holdingtime=0, and user-specified
   *  target coords (not position=16). On success ogame plants colony at the
   *  target slot. WARNING: best-guess body shape — capture real click for
   *  accuracy if first attempt fails. */
  private async execColonize(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean }> {
    // v0.0.438: delegate to fleet_api.sendFleet (mission=7 colonize, type=1
    // planet). Fixes pre-existing ReferenceError on line 883 (`destType`
    // undefined in execColonize scope) introduced when execFleetSend was
    // refactored. Operator 2026-05-29: "需要切cp的都改成 fleet_api.sendFleet
    // 模式".
    if (!this.tokenManager) throw new Error("colonize: no tokenManager wired");
    const params = directive.params as { target_coords?: string; ships?: Record<string, number>; cargo?: { metal?: number; crystal?: number; deuterium?: number } };
    const ships = params.ships ?? { colonyShip: 1 };
    const cargo = params.cargo ?? { metal: 5000, crystal: 2500, deuterium: 0 };
    const [tgStr, tsStr, tpStr] = (params.target_coords ?? "").split(":");
    const tGalaxy = parseInt(tgStr ?? "0", 10);
    const tSystem = parseInt(tsStr ?? "0", 10);
    const tPos = parseInt(tpStr ?? "0", 10);
    if (!tGalaxy || !tSystem || !tPos) throw new Error(`colonize: bad target_coords`);
    console.info(`[ApiExec] colonize delegate→fleet_api.sendFleet ${tGalaxy}:${tSystem}:${tPos} mission=7 cp=${planetId}`);
    try {
      const res = await fleetApiSendFleet(
        {
          ships: ships as unknown as import("@ogamex/shared").ShipCount,
          cargo: { m: cargo.metal ?? 0, c: cargo.crystal ?? 0, d: cargo.deuterium ?? 0 },
          coords: [tGalaxy, tSystem, tPos],
          destType: 1,           // colonize always targets uninhabited planet slot
          mission: 7 as import("@ogamex/shared").MissionCode,
          speed: 10,
          sourcePlanetId: planetId,
        },
        { fetch: this.fetchFn, token: this.tokenManager },
      );
      console.info(`[ApiExec] colonize OK fleetId=${res.fleetId}`);
      return { action: "colonize", clicked: true };
    } catch (e) {
      throw new Error(`colonize rejected: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }

  /** Deploy (mission=4, one-way) or Transport (mission=3, round-trip). Same
   *  3-stage token chain as colonize/expedition. type=1 for planet targets,
   *  type=3 for debris field, type=2 for moon — we default to type=1 since
   *  deploy/transport targets are your own colonies. */
  private async execFleetSend(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean }> {
    const params = directive.params as { target_coords?: string; target_type?: string; ships?: Record<string, number>; resources?: Record<string, number>; mission?: number };
    const ships = params.ships ?? {};
    const resources = params.resources ?? {};
    const mission = params.mission ?? (directive.action === "deploy" ? 4 : 3);
    const [tgStr, tsStr, tpStr] = (params.target_coords ?? "").split(":");
    const tGalaxy = parseInt(tgStr ?? "0", 10);
    const tSystem = parseInt(tsStr ?? "0", 10);
    const tPos = parseInt(tpStr ?? "0", 10);
    if (!tGalaxy || !tSystem || !tPos) throw new Error(`${directive.action}: bad target_coords`);
    if (Object.keys(ships).length === 0) throw new Error(`${directive.action}: no ships`);
    // v0.0.430: ogame fleet target type — 1=planet, 2=debris, 3=moon
    // (ground truth from fleet_api.ts:15 SendFleetParams.destType annotation
    // and wire_runtime.ts:96 FS sibling-moon deploy which is the validated
    // working path. v0.0.429 incorrectly trusted execFleetSend's stale
    // comment that swapped 2 and 3 — reverted.) The "出發地和目的地相同"
    // operator saw was from a goal dispatched by v0.0.427 still hardcoded
    // type=1 before the v0.0.428 bundle reached the browser.
    const destTypeStr = (params.target_type ?? "planet").toLowerCase();
    const destType = destTypeStr === "moon" ? "3" : destTypeStr === "debris" ? "2" : "1";
    // FLEET SLOT GATE — v0.0.431: aligned with goal_runner.ts gate.
    // transport AND chain-bound deploy bypass keep-1-empty (operator chain,
    // intentionally last-slot OK). Standalone colonize/deploy still reserve
    // 1 slot for emergency FS recall. Throw wording matches TRANSIENT_RE
    // ("slots full") so sidecar marks blocked → retries next tick.
    {
      const srv = (this.win as Window & { __ogamexStore?: { state: { server?: { used_fleet_slots?: number; max_fleet_slots?: number } } } })
        .__ogamexStore?.state.server;
      const usedNow = srv?.used_fleet_slots ?? -1;
      const maxNow = srv?.max_fleet_slots ?? -1;
      const chainBound = typeof (params as { chain_id?: string }).chain_id === "string" && (params as { chain_id: string }).chain_id !== "";
      const bypassKeepEmpty = directive.action === "transport" || (directive.action === "deploy" && chainBound);
      const ceiling = bypassKeepEmpty ? maxNow : maxNow - 1;
      if (usedNow >= 0 && maxNow > 0 && usedNow >= ceiling) {
        const label = bypassKeepEmpty ? "all slots used" : "keep-1-empty";
        throw new Error(`${directive.action}: fleet slots full ${usedNow}/${maxNow} ${label}`);
      }
    }
    // v0.0.436: delegate to fleet_api.sendFleet — the SAME function FS uses
    // to deploy ships to sibling moon (wire_runtime.ts:103). Operator
    // 2026-05-29: "复用以前成功的代码,不要每次都调试新代码". This path is
    // proven on s274-en/ogame v12 (FS works), so it must work for our
    // chain ferry too. Includes 4-attempt transient retry, storage overflow
    // self-heal, module-level mutex against concurrent fleet POSTs.
    if (!this.tokenManager) {
      throw new Error(`${directive.action}: no tokenManager wired (v0.0.436 delegation needs it)`);
    }
    const destTypeNum = destType === "3" ? 3 : destType === "2" ? 2 : 1;
    // v0.0.553 — POST-IN forensic gated behind localStorage flag. Was always
    // on, sidecar journal grew + browser fetch queue + console spam. Default
    // off; turn on for debugging: localStorage.setItem("OGAMEX_FORENSIC","1").
    const _cargo = { m: resources["m"] ?? 0, c: resources["c"] ?? 0, d: resources["d"] ?? 0 };
    try {
      const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
      if (ctxWin.localStorage?.getItem("OGAMEX_FORENSIC") === "1") {
        const _postInText = `${directive.action} goal_id=${(directive as { goal_id?: string }).goal_id ?? "?"} dirId=${directive.id} cp=${planetId} → ${tGalaxy}:${tSystem}:${tPos}(type=${destType}) mission=${mission} ships=${JSON.stringify(ships)} cargo=${JSON.stringify(_cargo)}`;
        console.warn(`[ApiExec/POST-IN] ${_postInText}`);
        const bridgeBase = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com";
        void fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
          method: "POST", credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag: "POST-IN", text: _postInText }),
        }).catch(() => { /* */ });
      }
    } catch { /* */ }
    console.info(`[ApiExec] ${directive.action} delegate→fleet_api.sendFleet ${tGalaxy}:${tSystem}:${tPos} type=${destType} mission=${mission} cp=${planetId}`);
    try {
      const res = await fleetApiSendFleet(
        {
          ships: ships as unknown as import("@ogamex/shared").ShipCount,
          cargo: _cargo,
          coords: [tGalaxy, tSystem, tPos],
          destType: destTypeNum as 1 | 2 | 3,
          mission: mission as 3 | 4,
          speed: 10,
          sourcePlanetId: planetId,
        },
        { fetch: this.fetchFn, token: this.tokenManager },
      );
      console.info(`[ApiExec] ${directive.action} OK fleetId=${res.fleetId}`);
      return { action: directive.action, clicked: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${directive.action} rejected: ${msg.slice(0, 200)}`);
    }
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
    // Operator 2026-05-28: every return path attaches system_states so sidecar
    // batch-completes ALL cooldown coords in this system per ack — without
    // this, sidecar adds 1 coord per dispatch (10s per-goal cooldown ×
    // ~14 cooldown coords/system = ~140s/system to scan). Batch shaves it
    // to ~10s per system.
    const buildSystemStates = (): Record<string, "cooldown" | "unavailable"> | undefined => {
      if (!cache || cache.states.size === 0) return undefined;
      const ss: Record<string, "cooldown" | "unavailable"> = {};
      for (const [pos, st] of cache.states) {
        if (st !== "available") ss[`${galaxy}:${system}:${pos}`] = st as "cooldown" | "unavailable";
      }
      return Object.keys(ss).length > 0 ? ss : undefined;
    };
    const ackOk = (label: string): { action: string; clicked: boolean } => {
      const ss = buildSystemStates();
      if (ss) console.info(`[ApiExec/discover] ${galaxy}:${system}:${position} ${label} — batch ${Object.keys(ss).length} cooldown coords`);
      return ss
        ? ({ action: directive.action, clicked: true, system_states: ss } as unknown as { action: string; clicked: boolean })
        : { action: directive.action, clicked: true };
    };
    if (cache && cache.states.size > 0 && positionState !== "available") {
      console.info(`[ApiExec/discover] ${galaxy}:${system}:${position} pre-check SKIP (state=${positionState || "unknown"}) — no POST`);
      return ackOk("pre-check skip");
    }

    // Slot-gate defense in depth. Galaxy fetch above wrote authoritative
    // usedFleetSlots/maximumFleetSlots into the store. Read them back here
    // — if used >= max - 1 (would consume the last empty slot), refuse POST.
    // Planner has the same gate, but it operates on snapshots and may be
    // stale within a burst of dispatches; this is the actual point of no
    // return. Operator 2026-05-23: "艦隊:16/16 不要满 保留一槽".
    try {
      const storeRef = (this.win as Window & { __ogamexStore?: { state: { server?: { used_fleet_slots?: number; max_fleet_slots?: number; used_expedition_slots?: number; max_expedition_slots?: number } } } }).__ogamexStore;
      const srv = storeRef?.state.server;
      const usedNow = srv?.used_fleet_slots ?? -1;
      const maxNow = srv?.max_fleet_slots ?? -1;
      // Operator 2026-05-28: mirror planner's dynamic reserve — keep enough
      // fleet slots open for every still-available expedition slot, plus 1
      // for emergency FS. Without this, discover wins the fleet-slot race
      // against expedition even when expedition slot is open.
      const usedExp = srv?.used_expedition_slots ?? 0;
      const maxExp = srv?.max_expedition_slots ?? 0;
      const freeExp = Math.max(0, maxExp - usedExp);
      const reserve = freeExp + 1;
      if (usedNow >= 0 && maxNow > 0 && usedNow >= maxNow - reserve) {
        console.warn(`[ApiExec/discover] ${galaxy}:${system}:${position} SLOT GATE HOLD — used=${usedNow}/${maxNow} reserve=${reserve} (freeExp=${freeExp}+1 emergency), ack skipped:slot_full`);
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
        return ackOk("server-cooldown");
      }
      // Operator 2026-05-28: ogame "在您最後一個動作時,發生錯誤" = stale ajax
      // token. discover shares the global token with galaxy/eventbox/resource
      // polls; a concurrent background fetch can rotate the token between
      // ApiExec's discover dispatches. Self-heal: invalidate cache+token,
      // refetch fresh on next call, single retry NOW with the freshly-issued
      // newAjaxToken from THIS failure response.
      const isTokenRace = /在您最後一個動作時|最後一個動作|您最後一次|last.*action/i.test(msg);
      if (isTokenRace) {
        console.warn(`[ApiExec/discover] ${galaxy}:${system}:${position} TOKEN RACE — invalidating cache + single retry with fresh token`);
        const cacheStoreInv = (this.win as Window & { __ogamexGalaxyDiscovery?: Map<string, { ts: number; states: Map<number, string> }> }).__ogamexGalaxyDiscovery;
        cacheStoreInv?.delete(cacheKey);
        (this.win as Window & { __ogamexLastGalaxyToken?: string }).__ogamexLastGalaxyToken = undefined;
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
        console.info(`[ApiExec/discover] token-race retry ${galaxy}:${system}:${position} resp[0:200]=${retryText.slice(0, 200).replace(/\s+/g, " ")}`);
        if (retryParsed?.newAjaxToken) {
          (this.doc.documentElement as HTMLElement).dataset["ogamexToken"] = retryParsed.newAjaxToken;
          try { this.win.localStorage.setItem("OGAMEX_TOKEN", retryParsed.newAjaxToken); } catch { /* */ }
          (this.win as Window & { __ogamexLastGalaxyToken?: string }).__ogamexLastGalaxyToken = retryParsed.newAjaxToken;
        }
        const retrySuccess = retryParsed?.response?.success !== false && retryParsed?.success !== false;
        if (retrySuccess) {
          console.info(`[ApiExec/discover] retry SUCCESS after token race for ${galaxy}:${system}:${position}`);
          try {
            const incFn = (this.win as Window & { __ogamexIncrementUsedSlot?: () => void }).__ogamexIncrementUsedSlot;
            if (incFn) incFn();
          } catch { /* */ }
          return ackOk("retry-success-token-race");
        }
        const retryMsg = retryParsed?.response?.message ?? retryParsed?.message ?? "unknown";
        throw new Error(`discover ${galaxy}:${system}:${position} rejected after token-race retry: ${retryMsg}`);
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
            return ackOk("retry-success");
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
    return ackOk("POST success");
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
    // v0.0.440: route through fleet_api.cpPostWithRetry (method=GET) so the
    // overlay-token fetch picks up the same retry / transient handling as
    // every other cp-shift POST. Token comes from json.newAjaxToken (no
    // success flag in fetchEventBox); 1-attempt since caller wraps retry.
    if (!this.tokenManager) {
      throw new Error(`${action}: no tokenManager wired (bootstrap needs it)`);
    }
    try {
      const res = await cpPostWithRetry({
        endpoint: `/game/index.php?page=componentOnly&component=eventList&action=fetchEventBox&ajax=1&asJson=1`,
        sourcePlanetId: planetId,
        token: this.tokenManager,
        action: `${action}:bootstrap`,
        method: "GET",
        maxAttempts: 1,
        skipRestore: true,
      });
      const newToken = (res.json as { newAjaxToken?: unknown } | null)?.newAjaxToken;
      if (typeof newToken === "string" && newToken.length >= 16) {
        token = newToken;
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
