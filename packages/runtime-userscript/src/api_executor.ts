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
import { TECH_ID_BY_NAME, storageCapForLevel } from "@ogamex/shared";
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
    // v0.0.623 — operator 2026-06-01 console: "[GoalRunner] no executor for
    // action=lifeform_research". The dispatch table (line ~222) already
    // routes lifeform_research → execSimpleUpgrade("lfresearch") since
    // v0.0.602, but canHandle gate dropped those actions, so goal_runner
    // skipped this executor entirely. Add lf_* and round-trip the wiring.
    return d.method === "ui" && [
      "build", "research", "build_ships",
      "expedition", "colonize", "deploy", "transport", "discover", "jumpgate",
      "lifeform_research",
    ].includes(d.action);
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
    // v0.0.839 — operator 2026-06-06 "还有切 CP 的代码再 audit". 老代码 raw fetch
    // 用 captured URL 含 cp=PID, 0 safe_fetch 保护 → owner 顶栏钉死被 dispatch
    // 的 planet (没 restore). 走 fetchWithCp 提 cp=, 串行 + restore.
    const cpMatch = url.match(/[?&]cp=([^&]+)/);
    const cpPid = cpMatch ? decodeURIComponent(cpMatch[1]!) : "";
    const urlNoCp = url.replace(/([?&])cp=[^&]+(&|$)/, (_, before, after) => (after === "&" ? before : ""));
    const init: RequestInit = {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body
        ? { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" }
        : { "X-Requested-With": "XMLHttpRequest" },
      body: body || undefined,
    };
    let r: Response;
    if (cpPid) {
      const { fetchWithCp } = await import("./api/safe_fetch.js");
      r = await fetchWithCp(urlNoCp, init, cpPid);
    } else {
      r = await this.fetchFn(url, init);
    }
    const txt = await r.text();
    return { status: r.status, body: txt };
  }

  async execute(directive: Directive): Promise<{ action: string; clicked: boolean }> {
    // v0.0.765 — operator 2026-06-04 "前后端都加一个暂停恢复按钮 用于暂停
    // 所有 TM 动作". Master kill-switch: localStorage 'ogamex.global.paused'
    // = "true" → 任何 directive 一律 skip (含 fleet/build/research/lf).
    // sidecar 端也拦 (priority_merger.dispatch), 这里是 belt-and-suspenders
    // 防 race + late-arriving directive 已 dispatch 后 TM 再清.
    try {
      if (this.win.localStorage.getItem("ogamex.global.paused") === "true") {
        return { action: directive.action, clicked: false };
      }
    } catch { /* localStorage unavailable */ }
    // expedition uses source_planet (not planet_id) — accept either.
    const planetId =
      (directive.params as { planet_id?: string }).planet_id
      ?? (directive.params as { source_planet?: string }).source_planet;
    if (!planetId) throw new Error(`api: no planet_id for ${directive.action}`);

    // Operator 2026-05-25: "調用api也必須切星球嗎？" — yes, ogame's cp=
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
    let result: { action: string; clicked: boolean };
    let opSucceeded = false;
    try {
      result = await inner();
      opSucceeded = true;
      return result;
    } finally {
      // v0.0.581 — operator 2026-06-01: JG completion 應 restore 到目標月球
      // 的 cp (而不是 operator 入口時的視角). 跳躍後操作員通常想看 target
      // 落地的艦隊 — 自動 navigate 過去比拉回原視角更符合直覺. JG 失敗時
      // 仍 restore 原 operatorCp (避免操作員被無效導航打擾).
      let restoreTo: string | null = operatorCp;
      if (opSucceeded && directive.action === "jumpgate") {
        const tgt = (directive.params as { target_moon_id?: string }).target_moon_id;
        if (typeof tgt === "string" && tgt) {
          restoreTo = tgt;
          console.info(`[ApiExec] JG success → restore cp to target moon ${tgt} (operator-pre-cp was ${operatorCp})`);
          // v0.0.743 — operator 2026-06-04 "Leg 1 chain prereq: source 6354
          // ship inventory not yet synced ... 已经跳过了怎么卡在这里". JG
          // is instant (no in-flight phase, no eventbox arrival event), so
          // v0.0.728's eventbox arrival hook never fires for JG dest →
          // sidecar's planet.ships[target_moon] stays at pre-JG value (0)
          // → priority_merger chain prereq deadlocks next leg waiting for
          // ship inventory sync. Fix: force-refresh target moon's
          // resources+ships immediately after JG success.
          try {
            const refresh = (window as Window & { __ogamexRefreshPlanetResources?: (pid: string) => Promise<void> }).__ogamexRefreshPlanetResources;
            const pushNow = (window as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow;
            if (typeof refresh === "function") {
              void refresh(tgt).then(() => {
                if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } }
                console.info(`[ApiExec] JG success → ships sync triggered for target moon ${tgt}`);
              });
            }
          } catch (e) { console.warn(`[ApiExec] JG post-success refresh threw:`, e); }
        }
      }
      await this.restoreSessionCp(restoreTo, planetId);
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
    // v0.0.602 — operator 2026-06-01 "生命研究 tab". Same unified endpoint
    // (buildlistactions/scheduleEntry) as building/research; component=lfresearch
    // for token routing. Requires technology_id in directive.params (planner
    // currently doesn't emit one — TODO add LIFEFORM_RESEARCH_IDS to tech_ids;
    // for now ApiExec will throw "no numeric id" with a clear message).
    if (directive.action === "lifeform_research") return this.execSimpleUpgrade("lfresearch", directive, planetId);
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
  // Operator directive: 裝 A — full API化, 刪 DOM 點選 fallback.
  // execute() uses captures-replay (TIER 1) or fetchTechStatus-based
  // execSimpleUpgrade/execShipBuild (TIER 2), both pure HTTP.
  //
  // fetchTechStatus does a background GET /game/index.php?page=ingame&
  // component=X&cp=PID to read status + reason from response HTML.
  // (v0.0.684: token + actionUrl extraction dropped; tokenManager handles
  // token refresh from JSON `newAjaxToken` instead.)

  /**
   * v0.0.684 — was fetchTokenAndStatus; token + actionUrl were dead weight.
   * Token regex (5 fallbacks) extracted but caller void'd it — tokenManager
   * refreshes from JSON `newAjaxToken`. actionUrl computed but caller only
   * used `!!actionUrl` in a log. Now returns only { status, reason }.
   */
  private async fetchTechStatus(
    component: string,
    planetId: string,
    numericId: number,
  ): Promise<{ status: string | null; reason: string | null }> {
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
      skipRestore: false,
    });
    const html = resp.raw;
    // v0.0.684 — token regex shotgun removed (caller didn't use it).
    // Sanity: page must contain the target tech li, else format change/error.
    if (!html.includes(`data-technology="${numericId}"`)) {
      throw new Error(`api: ${component} page missing tech ${numericId} (html=${html.length}B)`);
    }
    // Carve out the <li> block for this tech so we can scan its attrs.
    const liStartIdx = html.indexOf(`data-technology="${numericId}"`);
    let liBlock = "";
    if (liStartIdx > -1) {
      const open = html.lastIndexOf("<li", liStartIdx);
      const close = html.indexOf("</li>", liStartIdx);
      if (open > -1 && close > -1) liBlock = html.slice(open, close + 5);
    }
    const statusMatch = liBlock.match(/data-status="([^"]+)"/i);
    const tooltipMatch = liBlock.match(/data-tooltip-title="([^"]+)"/i);
    return {
      status: statusMatch?.[1] ?? null,
      reason: tooltipMatch?.[1] ?? null,
    };
  }

  private async execSimpleUpgrade(
    component: "research" | "supplies" | "facilities" | "lfbuildings" | "lfresearch",
    directive: Directive,
    planetId: string,
  ): Promise<{ action: string; clicked: boolean }> {
    const targetName = (component === "research" || component === "lfresearch")
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
      skipRestore: false,
    });
    // v0.0.952 — owner 2026-06-08 "手动可以升级": LF build 100001 持续拒, ogame
    // 端无 bug. 抓自动 POST raw 跟手动比 (sniffer 自然抓手动). 仅 LF 路径
    // (component=lfbuildings) forensic, 避免噪.
    if (component === "lfbuildings" || component === "lfresearch") {
      try {
        const ctxWinF = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
        const bridgeF = ctxWinF.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
        const tokFor = ctxWinF.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
        const rawResp = (typeof res.raw === "string" ? res.raw : "").slice(0, 600);
        void fetch(`${bridgeF.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
          method: "POST", credentials: "omit",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tokFor}` },
          body: JSON.stringify({ tag: "LF-AUTO-POST-v0952", text: `component=${component} target=${targetName} techId=${numericId} cp=${planetId} status=${res.status} jsonStr=${JSON.stringify(res.json)} raw=${rawResp}` }),
        }).catch(() => { /* */ });
      } catch { /* */ }
    }
    if (res.json && ((res.json as { success?: boolean }).success === false || (res.json as { status?: string }).status === "failure")) {
      const errs = (res.json as { errors?: unknown; error?: unknown }).errors ?? (res.json as { error?: unknown }).error;
      // v0.0.987 — owner 2026-06-08 "派的任务, 自动生成的tree不对": 120020
      // "條件未滿足" → 自动 fetch ogame technologytree?techId=N 抓真 prereq DOM
      // → forensic 给 sidecar. 一次性 dump 救场, 不依赖 catalog placeholder.
      // 仅 LF 路径 (lfbuildings/lfresearch), 仅 120020, 不污染.
      const errsStr = JSON.stringify(errs);
      if ((component === "lfbuildings" || component === "lfresearch") && /120020/.test(errsStr)) {
        try {
          const { fetchWithCpBypassBusy: ttFetch } = await import("./api/safe_fetch.js");
          const ttUrl = `/game/index.php?page=ajax&component=technologytree&technologyId=${numericId}&ajax=1`;
          const ttRes = await ttFetch(
            ttUrl,
            { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
            planetId,
          );
          const ttHtml = ttRes.status === 200 ? await ttRes.text() : "";
          const ctxWinTT = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
          const bridgeTT = ctxWinTT.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
          const tokTT = ctxWinTT.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
          void fetch(`${bridgeTT.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
            method: "POST", credentials: "omit",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tokTT}` },
            body: JSON.stringify({ tag: "TECHNOLOGYTREE-v0987", text: `techId=${numericId} target=${targetName} planet=${planetId} htmlLen=${ttHtml.length} html=${ttHtml.slice(0, 4500)}` }),
          }).catch(() => { /* */ });
        } catch (e) { console.warn(`[ApiExec/${component}] 120020 technologytree probe threw:`, e); }
      }
      throw new Error(`${component}:${targetName} rejected: ${errsStr}`);
    }
    // v0.0.555 — accept BOTH ogame v12 success shapes:
    //   {success: true, ...}        (older / fleetdispatch endpoint)
    //   {status: "success", ...}    (newer / buildlistactions endpoint;
    //                                operator 2026-05-31 evidence:
    //                                "Jump Gate is under construction.")
    // v0.0.554 only checked the boolean form → real success treated as fail.
    const j = res.json as { success?: boolean; status?: string } | null;
    const okSuccess = j?.success === true || j?.status === "success";
    if (!okSuccess) {
      const snippet = res.raw.slice(0, 240).replace(/\s+/g, " ");
      throw new Error(`${component}:${targetName} rejected (non-success response HTTP ${res.status}): ${snippet}`);
    }
    // v0.0.961 (post-success refreshOnePage 自动 fire) → v0.0.984 撤回.
    // 真态: owner 2026-06-08 "建造的时候没以前流程, 建完一个会卡一会, 以前
    // 都可以连上的". v0.0.961 refresh 抢 cpMutex (cp shift + chunk fetch) →
    // 下一个 directive cp 阻塞 → 串联建造卡. 老 60s backoff + token rotation
    // 已能处理"refresh 没及时" 导致的 1 次 100001 spam, 不需要 refresh.
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
    const { status, reason } = await this.fetchTechStatus("shipyard", planetId, numericId);
    console.info(`[ApiExec] shipyard:${ship}×${amount} status=${status} reason=${(reason ?? "").slice(0,40)}`);
    if (status === "active") return { action: directive.action, clicked: false };
    if (status === "disabled") {
      if (reason && /(造船廠|shipyard).*(升級|upgrad|building)/i.test(reason)) {
        return { action: directive.action, clicked: false };
      }
      throw new Error(`${ship} unavailable: ${reason ?? "disabled"}`);
    }
    // POST via cpPostWithRetry; tokenManager handles per-attempt token refresh
    // from JSON `newAjaxToken`. status/reason gate above is the only HTML scrape.
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
      skipRestore: false,
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

    // EXPEDITION SLOT GATE — operator 2026-05-27: "遠征怎麼會有警告？發船之前
    // 沒有查看是否有可用的slot？". ogame error 140043/140019 = expedition slots
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
      // but operator now: "修好遠征自動發船,不用管發現任務,發現任務會慢慢
      // 讓出空間". Expedition takes the last slot too — emergency FS goes
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

    // BLOCKING preflight — owner explicit requirement: "每次遠征之前從 api
    // 拿最新的艦船數量". v0.0.166 had fire-and-forget pollEmpire (data lands
    // too late). v0.0.167 had fdHtml2 parse (caused 140042). This version
    // calls a focused helper that does (a) ogame empire API fetch, (b) parses
    // ship counts per planet, (c) writes them to store, (d) returns this
    // planet's ships. AWAIT it — block 100-500ms — then compare to template.
    // Step 0: force fresh empire pull BEFORE preflight. operator:
    // "遠征出發之前又沒有同步最新的艦船列表吧". This refreshes store with
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

  // v0.0.560 Phase 4 — deleted ~167 lines of dead expedition 3-stage legacy
  // code (formerly `_execExpeditionLegacy_dead_code_kept_for_reference`).
  // Live `execExpedition` above (delegates to fleetApiSendFleet since v0.0.439)
  // is the only expedition path. The dead method held the last 2 direct
  // fetchWithCpBypassBusy bypasses (ALLOW_LIST 545/635) — nuking it closes
  // the unified-entry audit at 0 directive bypasses.

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
    // v0.0.558 Phase 2 — migrated from handrolled retry loop to
    // cpPostWithRetry with the v0.0.557 hooks (tokenProvider,
    // successCheck, refreshTokenOnInvalid). Old code path (lines
    // 720-833 in v0.0.557) contained inline 4-attempt loop +
    // local TRANSIENT_RACE_RE / TOKEN_INVALID_RE constants that
    // duplicated cpPostWithRetry's defaults. Now: overlay GET +
    // executeJump POST both go through cpPostWithRetry. Mutex,
    // restore, click_intercept, retry, transient handling all
    // inherited from the unified entry.
    const overlayUrl = `/game/index.php?page=ajax&component=jumpgate&overlay=1&ajax=1`;
    const tokenPatterns: RegExp[] = [
      /name=["']token["']\s+value=["']([a-zA-Z0-9_\-]+)["']/i,      // <input name='token' value='...'>
      /value=["']([a-zA-Z0-9_\-]{16,})["']\s+name=["']token["']/i,  // reversed attr order
      /["']token["']\s*[:=]\s*["']([a-zA-Z0-9_\-]+)["']/i,          // js: token: "..."
      /data-token=["']([a-zA-Z0-9_\-]+)["']/i,                       // data-token attr
      /var\s+token\s*=\s*["']([a-zA-Z0-9_\-]+)["']/i,                // var token = "..."
      /ajaxToken\s*=\s*["']([a-zA-Z0-9_\-]+)["']/i,                  // ajaxToken = "..."
      /["']?ajaxToken["']?\s*:\s*["']([a-zA-Z0-9_\-]+)["']/i,        // "ajaxToken": "..."
    ];
    if (!this.tokenManager) throw new Error(`jumpgate: no tokenManager wired`);
    const fetchOverlayToken = async (): Promise<string> => {
      // GET overlay HTML via cpPostWithRetry. Response is HTML (not JSON);
      // cpPostWithRetry returns json=null early → res.raw is the HTML.
      const res = await cpPostWithRetry({
        endpoint: overlayUrl,
        sourcePlanetId: sourceMoonId,
        token: this.tokenManager!,            // satisfies API; overlay GET doesn't actually use it
        action: "jg:overlay",
        method: "GET",
        skipRestore: false,
      });
      if (res.status !== 200) throw new Error(`jumpgate overlay HTTP ${res.status}`);
      const html = res.raw;
      for (const re of tokenPatterns) {
        const m = html.match(re);
        if (m && m[1]) return m[1];
      }
      const idx = html.toLowerCase().indexOf("token");
      const ctx = idx >= 0 ? html.slice(Math.max(0, idx - 60), idx + 160) : "<no 'token' substring>";
      console.warn(`[ApiExec/jumpgate] token regex failed (len=${html.length}). Context around "token":`, ctx);
      throw new Error(`jumpgate: token not found in overlay (len=${html.length})`);
    };
    let cachedToken = await fetchOverlayToken();
    console.info(`[ApiExec/jumpgate] overlay token len=${cachedToken.length} src=${sourceMoonId} tgt=${targetMoonId} ships=${JSON.stringify(ships)}`);
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
    // executeJump via cpPostWithRetry. successCheck folds the v0.0.546
    // ghost-ack defense: status/success flag set BUT errors[] populated →
    // treat as non-success → cpPostWithRetry's retry path kicks in (since
    // ogame's "100001 previously unknown error" matches TRANSIENT_RACE_RE
    // in fleet_api.ts). refreshTokenOnInvalid re-fetches overlay on
    // TOKEN_INVALID_RE.
    const jgRes = await cpPostWithRetry({
      endpoint: `/game/index.php?page=componentOnly&component=jumpgate&action=executeJump&asJson=1`,
      sourcePlanetId: sourceMoonId,
      token: this.tokenManager,
      action: "jg:executeJump",
      method: "POST",
      tokenProvider: async () => cachedToken,
      refreshTokenOnInvalid: async () => {
        cachedToken = await fetchOverlayToken();
        return cachedToken;
      },
      successCheck: (json) => {
        const rawOk = json["status"] === true || json["success"] === true;
        const errs = Array.isArray(json["errors"]) ? (json["errors"] as unknown[]) : [];
        return rawOk && errs.length === 0;
      },
      buildBody: buildJgBody,
      skipRestore: false,
    });
    // Post-retry distillation: cpPostWithRetry's successCheck returning false
    // (after exhausting transient retries) means non-transient failure;
    // res.json is returned for caller to handle.
    const resp = (jgRes.json ?? {}) as { status?: boolean; success?: boolean; cooldown?: number; nextActionAt?: number; errors?: unknown; message?: string };
    const rawOk = resp.status === true || resp.success === true;
    const errsArr = Array.isArray(resp.errors) ? resp.errors : [];
    if (!rawOk) {
      // v0.0.823 — operator 2026-06-06 "JG 不正常". JG 失败时 ogame 返
      // empty errors → 老 throw "jumpgate rejected: \"\"" sidecar 不知 cd
      // 状态 → planner 每 60s 重派 → 5+ 次 spam. 真因 fix: 失败时立刻
      // fetch 同份 overlay HTML 拿 cd, commit 双边 store (planner 后续
      // cd check 真识别), 然后 ack 带准确 reason "JG cd active Xs". sidecar
      // 看 cd in error → planner 下次 cd 真值兜底 跳过.
      let cdFromOverlay: number | null = null;
      try {
        // v0.0.839 — operator 2026-06-06 "还有切 CP 的代码再 audit". v0.0.833 把
        // executeJump skipRestore: false 后, session cp 已 restore 回 owner 本家
        // → raw fetch 命中 owner 本家 overlay (无 JG widget) 拿不到 cd. 改走
        // fetchWithCpBypassBusy(sourceMoonId) safe_fetch 串行, 同时不会让 owner
        // UI 看到 stale shift (mutex 持有期间所有 cp= 串行).
        const { fetchWithCpBypassBusy: fetchOverlayCp } = await import("./api/safe_fetch.js");
        const ovRes = await fetchOverlayCp(
          overlayUrl,
          { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
          sourceMoonId,
        );
        if (ovRes.status === 200) {
          const html = await ovRes.text();
          // ogame v12 overlay 含 'jumpGateNextJumpAt' 或 'cooldown' field
          const m = html.match(/(?:nextJumpAt|cooldown|nextActionAt)["'\s:=]+(\d+)/i);
          if (m && m[1]) {
            const v = Number(m[1]);
            if (Number.isFinite(v) && v > 0) {
              // If absolute timestamp (>1e10) treat as ms-since-epoch, convert to seconds remaining
              cdFromOverlay = v > 1e10 ? Math.max(0, Math.floor((v - Date.now()) / 1000)) : v;
            }
          }
        }
      } catch { /* */ }
      if (cdFromOverlay !== null && cdFromOverlay > 0) {
        try {
          const commit = (this.win as Window & { __ogamexCommitJgCd?: (s: string, t: string, c: number) => void }).__ogamexCommitJgCd;
          if (typeof commit === "function") commit(sourceMoonId, targetMoonId, cdFromOverlay);
        } catch { /* */ }
        throw new Error(`jumpgate rejected: cd_active ${cdFromOverlay}s (sync'd to store)`);
      }
      const errMsg = String(resp.message ?? JSON.stringify(resp.errors ?? "") ?? jgRes.raw.slice(0, 200)).trim();
      // v0.0.920 — owner 2026-06-07 "JG 空错误 = 在 cd 中, 等 cd 结束". 之前 fall
      // through 直接 throw 空字符串 → planner 误判 fatal. 改: 空 errMsg → 默认
      // v0.0.921 — owner 2026-06-07 "v12 数据和以前版本不同, 你的公式可能是错的".
      // 撤掉 v0.0.920 的 `3600/level` 兜底 — 老 ogame 公式 v12 不适用. 不再
      // 瞎猜兜底 cd, 改：fetch overlay 重试一次拿真 cd; 还拿不到 → 抛错让
      // planner 走默认 retry 路径, 而不是写错误 cd 误导决策.
      const errMsgTrimmed = errMsg.replace(/^"+|"+$/g, "").trim();
      if (errMsgTrimmed === "" || errMsgTrimmed === "{}" || errMsgTrimmed === "[]") {
        try {
          const { fetchWithCpBypassBusy: retryOverlay } = await import("./api/safe_fetch.js");
          const retryRes = await retryOverlay(
            overlayUrl,
            { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
            sourceMoonId,
          );
          if (retryRes.status === 200) {
            const html = await retryRes.text();
            // v0.0.955 — forensic POST raw HTML for ghost-reject path too
            try {
              const ctxWin1 = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
              const bridgeBase1 = ctxWin1.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
              const tokG = ctxWin1.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
              void fetch(`${bridgeBase1.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
                method: "POST", credentials: "omit",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tokG}` },
                body: JSON.stringify({ tag: "JG-CD-GHOST-v0955", text: `src=${sourceMoonId} tgt=${targetMoonId} htmlLen=${html.length} snip=${html.slice(0, 3000)}` }),
              }).catch(() => { /* */ });
            } catch { /* */ }
            // v0.0.955 — simpleCountdown 是 ogame UI 自带 countdown init JS,
            // overlay HTML cd-state 段包含 `simpleCountdown(_, N)` (N = 秒).
            // 是 v0.0.946 sniffer DOM scrape `<p id=cooldown>` 的 server-side
            // 真值同源. 优先 match; 兜底旧 field-name regex 保留兼容.
            const mSC = html.match(/simpleCountdown\s*\([^,]+,\s*(\d+)/);
            const mOld = html.match(/(?:nextJumpAt|cooldown|nextActionAt)["'\s:=]+(\d+)/i);
            const rawN = mSC ? mSC[1] : (mOld ? mOld[1] : null);
            if (rawN !== null) {
              const v = Number(rawN);
              if (Number.isFinite(v) && v > 0) {
                const realCd = v > 1e10 ? Math.max(0, Math.floor((v - Date.now()) / 1000)) : v;
                if (realCd > 0) {
                  const commit = (this.win as Window & { __ogamexCommitJgCd?: (s: string, t: string, c: number) => void }).__ogamexCommitJgCd;
                  if (typeof commit === "function") commit(sourceMoonId, targetMoonId, realCd);
                  throw new Error(`jumpgate rejected: empty error → overlay re-fetch gave cd=${realCd}s (sync'd to store, src=${mSC ? "simpleCountdown" : "legacyField"})`);
                }
              }
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("jumpgate")) throw e;
        }
        throw new Error(`jumpgate rejected: empty error and overlay re-fetch yielded no cd — leaving cd unset (sniffer / next state.snapshot will fill if real)`);
      }
      throw new Error(`jumpgate rejected: ${errMsg.slice(0, 200)}`);
    }
    if (errsArr.length > 0) {
      throw new Error(`jumpgate ghost-ack: success flag set but errors=${JSON.stringify(errsArr).slice(0, 200)}`);
    }
    console.info(`[ApiExec/jumpgate] OK src=${sourceMoonId} → tgt=${targetMoonId} cooldown=${resp.cooldown ?? resp.nextActionAt ?? "?"}s`);
    // v0.0.943 — owner 2026-06-07 "拿真实的返回值, 不要猜": v12 response 字段
    // 跟我们认知不同, 之前 multi-field guess 被 owner 撤回. 这里**只 POST
    // raw response** 到 sidecar /debug/log, **不改 field name, 不改 regex**.
    // 下次 JG 命中 → owner ssh europa 看 [debug-log:JG-RESP-v0943] 行,
    // 拿到 v12 真 schema → 写外科手术级 field 解析.
    try {
      const ctxWin0 = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
      const bridgeBase0 = ctxWin0.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
      const tok0 = ctxWin0.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
      const rawStr = JSON.stringify(resp).slice(0, 800);
      void fetch(`${bridgeBase0.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tok0}` },
        body: JSON.stringify({ tag: "JG-RESP-v0943", text: `src=${sourceMoonId} tgt=${targetMoonId} resp=${rawStr}` }),
      }).catch(() => { /* */ });
    } catch { /* */ }
    // v0.0.755 — operator "用 api / 事件驱动 不要扫网页". executeJump JSON
    // 自带 cooldown (or nextActionAt). 直接调 __ogamexCommitJgCd 写双边 store,
    // 0 HTML 扫描 0 race. 取代 v0.0.753 postMessage→CASE B 重抓 overlay regex
    // 死路 + 双边单边写失败 race (v0.0.744 ships refresh stale spread 覆盖).
    const cdFromResp = (resp.cooldown ?? resp.nextActionAt ?? null) as number | null;
    if (cdFromResp !== null && Number.isFinite(cdFromResp) && cdFromResp > 0) {
      // v0.0.1015 — owner 2026-06-09 "4leg 运输任务 拿不到跳跃门CD": resp.cooldown
      // 是 src 侧 cd, 但 ogame 异 level JG 时 src/tgt cd 不同 (src JG L4 / tgt L7).
      // 跟 v0.0.1005 page-world post-ack 修法对齐: parallel fetch 两边 overlay,
      // 各拿 simpleCountdown(_, N) 后 4-arg 双边 commit. 任一失败 helper 退回单值.
      try {
        const { fetchWithCpBypassBusy } = await import("./api/safe_fetch.js");
        const pSrc = fetchWithCpBypassBusy(overlayUrl, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } }, sourceMoonId)
          .then((r) => r.status === 200 ? r.text() : "").catch(() => "");
        const pTgt = fetchWithCpBypassBusy(overlayUrl, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } }, targetMoonId)
          .then((r) => r.status === 200 ? r.text() : "").catch(() => "");
        void Promise.all([pSrc, pTgt]).then(([htmlSrc, htmlTgt]) => {
          const mS = htmlSrc.match(/simpleCountdown\s*\([^,]+,\s*(\d+)/);
          const mT = htmlTgt.match(/simpleCountdown\s*\([^,]+,\s*(\d+)/);
          const srcCd2 = mS ? parseInt(mS[1], 10) : 0;
          const tgtCd2 = mT ? parseInt(mT[1], 10) : 0;
          const effSrc = srcCd2 > 0 ? srcCd2 : cdFromResp;
          const effTgt = tgtCd2 > 0 ? tgtCd2 : cdFromResp;
          const commit = (this.win as Window & { __ogamexCommitJgCd?: (s: string, t: string, c: number, t2?: number) => void }).__ogamexCommitJgCd;
          if (typeof commit === "function") {
            commit(sourceMoonId, targetMoonId, effSrc, effTgt);
            console.info(`[ApiExec/jumpgate/bilateral] resp.cooldown=${cdFromResp}s srcCd=${srcCd2}s tgtCd=${tgtCd2}s → commit(${effSrc},${effTgt})`);
          } else {
            console.warn(`[ApiExec/jumpgate] __ogamexCommitJgCd helper absent — JG cd not written to store`);
          }
        });
      } catch (e) { console.warn(`[ApiExec/jumpgate] bilateral commit threw:`, e); }
    } else {
      // v0.0.954 — owner 2026-06-08 "没拿到cd": chain JG 不开 widget, DOM scrape
      // 不触发 → cd 永远 null. 补 api_executor 程序化 overlay fetch + 解析
      // ogame 自带的 inline JS `simpleCountdown(..., N)` (N = 剩余秒).
      // 这不是猜 — simpleCountdown 是 ogame UI countdown 初始化函数, ogame
      // overlay HTML 在 cd-state 包含此调用, N 就是 server-rendered cd.
      // (跟 v0.0.946 sniffer DOM scrape 同源真值, 只是这里 server-side render
      //  替代 owner UI render — 给 chain JG auto-commit cd.)
      try {
        const { fetchWithCpBypassBusy } = await import("./api/safe_fetch.js");
        // v0.0.982 — owner 2026-06-08 "4leg chain 没拿到 CD" 实证: api_executor
        // 立即 fetch htmlLen=0 (ogame 还没准备好 / cp shift race). 跟 sniffer 路径
        // v0.0.977 同款 3 attempt retry (1s/5s/15s), 任一拿到即 commit.
        const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
        const bridgeBase = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
        const tokF = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
        const tryFetchCd = async (attempt: number, delayMs: number): Promise<boolean> => {
          await new Promise((r) => setTimeout(r, delayMs));
          // v0.0.1015 — owner 2026-06-09 "4leg 运输任务 拿不到跳跃门CD": fallback
          // overlay 抓取也改 parallel 两边 (cp=src + cp=tgt) → 4-arg 双边 commit.
          let srcHtml = "", tgtHtml = "";
          try {
            const [srcRes, tgtRes] = await Promise.all([
              fetchWithCpBypassBusy(overlayUrl, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } }, sourceMoonId).catch(() => null),
              fetchWithCpBypassBusy(overlayUrl, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } }, targetMoonId).catch(() => null),
            ]);
            srcHtml = (srcRes && srcRes.status === 200) ? await srcRes.text() : "";
            tgtHtml = (tgtRes && tgtRes.status === 200) ? await tgtRes.text() : "";
          } catch (e) { console.warn(`[ApiExec/jumpgate] attempt=${attempt} parallel fetch threw:`, e); }
          const mS = srcHtml.match(/simpleCountdown\s*\([^,]+,\s*(\d+)/);
          const mT = tgtHtml.match(/simpleCountdown\s*\([^,]+,\s*(\d+)/);
          const srcCd = mS ? parseInt(mS[1], 10) : 0;
          const tgtCd = mT ? parseInt(mT[1], 10) : 0;
          try {
            void fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
              method: "POST", credentials: "omit",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tokF}` },
              body: JSON.stringify({ tag: "JG-CD-OVERLAY-v1015", text: `attempt=${attempt} src=${sourceMoonId} tgt=${targetMoonId} srcLen=${srcHtml.length} tgtLen=${tgtHtml.length} srcCd=${srcCd} tgtCd=${tgtCd}` }),
            }).catch(() => { /* */ });
          } catch { /* */ }
          if (srcCd > 0 || tgtCd > 0) {
            const commit = (this.win as Window & { __ogamexCommitJgCd?: (s: string, t: string, c: number, t2?: number) => void }).__ogamexCommitJgCd;
            if (typeof commit === "function") {
              const effSrc = srcCd > 0 ? srcCd : tgtCd;
              const effTgt = tgtCd > 0 ? tgtCd : srcCd;
              commit(sourceMoonId, targetMoonId, effSrc, effTgt);
              console.info(`[ApiExec/jumpgate] bilateral cd attempt=${attempt} src=${effSrc}s tgt=${effTgt}s`);
              return true;
            }
          }
          return false;
        };
        // 3 attempts: 1s / 5s / 15s. Fire-and-forget so 父 dispatch ack 不被 block.
        void (async () => {
          if (await tryFetchCd(1, 1000)) return;
          if (await tryFetchCd(2, 4000)) return;
          await tryFetchCd(3, 10000);
        })();
      } catch (e) {
        console.warn(`[ApiExec/jumpgate] overlay retry chain threw:`, e);
      }
    }
    // v0.0.546 — operator 2026-05-31 "跳躍以後要立刻刷新艦隊數量". Old code
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
  private async execColonize(directive: Directive, planetId: string): Promise<{ action: string; clicked: boolean; colonize_result?: { success: boolean; coord?: string; reason?: string } }> {
    // v0.0.438: delegate to fleet_api.sendFleet (mission=7 colonize, type=1
    // planet). v0.0.689: range-scan branch — operator 2026-06-03 "扫描指定
    // 范围内离本星球最近的符合殖民条件的坐标".
    if (!this.tokenManager) throw new Error("colonize: no tokenManager wired");
    const params = directive.params as {
      target_coords?: string;
      ships?: Record<string, number>;
      cargo?: { metal?: number; crystal?: number; deuterium?: number };
      range?: { galaxy_min: number; galaxy_max: number; system_min: number; system_max: number; position_min: number; position_max: number };
      source_planet?: string;
    };
    const ships = params.ships ?? { colonyShip: 1 };
    const cargo = params.cargo ?? { metal: 5000, crystal: 2500, deuterium: 0 };

    let tGalaxy = 0, tSystem = 0, tPos = 0;
    if (params.range) {
      // v0.0.689 — galaxy scan. Find first EMPTY position in range, radial
      // from source planet's home system. Empty = galaxyContent row absent
      // or row.planet === null.
      const scanned = await this.scanColonizeCandidate(params.range, planetId);
      if (!scanned) {
        throw new Error(`colonize: no empty position in g[${params.range.galaxy_min}-${params.range.galaxy_max}] s[${params.range.system_min}-${params.range.system_max}] p[${params.range.position_min}-${params.range.position_max}]`);
      }
      tGalaxy = scanned[0]; tSystem = scanned[1]; tPos = scanned[2];
    } else {
      const [tgStr, tsStr, tpStr] = (params.target_coords ?? "").split(":");
      tGalaxy = parseInt(tgStr ?? "0", 10);
      tSystem = parseInt(tsStr ?? "0", 10);
      tPos = parseInt(tpStr ?? "0", 10);
      if (!tGalaxy || !tSystem || !tPos) throw new Error(`colonize: bad target_coords`);
    }
    const coordStr = `${tGalaxy}:${tSystem}:${tPos}`;
    console.info(`[ApiExec] colonize delegate→fleet_api.sendFleet ${coordStr} mission=7 cp=${planetId}`);
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
      console.info(`[ApiExec] colonize OK fleetId=${res.fleetId} coord=${coordStr}`);
      return { action: "colonize", clicked: true, colonize_result: { success: true, coord: coordStr } };
    } catch (e) {
      throw new Error(`colonize rejected: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }

  /** v0.0.689 — radial galaxy scan for first empty colonize candidate.
   *  Iterates systems from source's home system outward, within range.
   *  For each system: POST fetchGalaxyContent → JSON galaxyContent[] →
   *  empty position = row missing OR row.planet === null in [p_min, p_max].
   *  Returns [galaxy, system, position] of nearest match, or null. */
  private async scanColonizeCandidate(
    range: { galaxy_min: number; galaxy_max: number; system_min: number; system_max: number; position_min: number; position_max: number },
    sourcePlanetId: string,
  ): Promise<[number, number, number] | null> {
    if (!this.tokenManager) return null;
    // Pull source coords from store for radial seed.
    const storeRef = (this.win as Window & { __ogamexStore?: { state: { planets?: Record<string, { id?: string; coords?: number[] }> } } }).__ogamexStore;
    const srcPlanet = storeRef?.state.planets?.[sourcePlanetId];
    const srcCoords = srcPlanet?.coords ?? [range.galaxy_min, range.system_min, 1];
    const srcGalaxy = srcCoords[0] ?? range.galaxy_min;
    const srcSystem = srcCoords[1] ?? range.system_min;
    // Iterate galaxies (typically one) then systems radially from srcSystem.
    for (let g = range.galaxy_min; g <= range.galaxy_max; g++) {
      // Order systems by |s - srcSystem| (nearest first when in source galaxy).
      const systems: number[] = [];
      for (let s = range.system_min; s <= range.system_max; s++) systems.push(s);
      const radialSort = (a: number, b: number): number => {
        if (g !== srcGalaxy) return a - b;  // foreign galaxy: ascending
        return Math.abs(a - srcSystem) - Math.abs(b - srcSystem);
      };
      systems.sort(radialSort);
      for (const s of systems) {
        try {
          const galRes = await cpPostWithRetry({
            endpoint: `/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1`,
            sourcePlanetId,
            token: this.tokenManager,
            action: `colonize:scan:${g}:${s}`,
            method: "POST",
            tokenProvider: async () => "",
            buildBody: () => {
              const b = new URLSearchParams();
              b.set("galaxy", String(g));
              b.set("system", String(s));
              return b;
            },
            successCheck: (j) => !!j["system"],
            maxAttempts: 1,
            skipRestore: false,
          });
          const j = JSON.parse(galRes.raw) as {
            system?: { galaxyContent?: Array<{ position?: number; planet?: unknown }> };
          };
          const content = j.system?.galaxyContent ?? [];
          // Build set of occupied positions in this system.
          const occupied = new Set<number>();
          for (const row of content) {
            const pos = typeof row.position === "number" ? row.position : 0;
            if (pos >= 1 && pos <= 15 && row.planet != null) occupied.add(pos);
          }
          // First empty in range — radial from source position if same system,
          // else ascending. Source pos: srcCoords[2] when same g+s, else mid.
          const positions: number[] = [];
          for (let p = range.position_min; p <= range.position_max; p++) positions.push(p);
          const sameSys = g === srcGalaxy && s === srcSystem;
          const srcPos = sameSys ? (srcCoords[2] ?? 8) : 8;
          positions.sort((a, b) => Math.abs(a - srcPos) - Math.abs(b - srcPos));
          for (const p of positions) {
            if (!occupied.has(p)) {
              console.info(`[ApiExec/colonize-scan] empty at ${g}:${s}:${p} (occupied=${[...occupied].join(",")})`);
              return [g, s, p];
            }
          }
        } catch (e) {
          console.warn(`[ApiExec/colonize-scan] ${g}:${s} fetch failed:`, e);
        }
      }
    }
    return null;
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
      // v0.0.843 — operator 2026-06-06: 第二处 slot gate (deploy/colonize 共享
      // 通道, 单独 gate). 同 goal_runner 一并加 colonize 到 bypassKeepEmpty 列表
      // (max_fleet_slots=1 新号永久 block fix).
      const bypassKeepEmpty = directive.action === "transport" || (directive.action === "deploy" && chainBound) || directive.action === "colonize";
      const ceiling = bypassKeepEmpty ? maxNow : maxNow - 1;
      if (usedNow >= 0 && maxNow > 0 && usedNow >= ceiling) {
        const label = bypassKeepEmpty ? "all slots used" : "keep-1-empty";
        throw new Error(`${directive.action}: fleet slots full ${usedNow}/${maxNow} ${label}`);
      }
    }
    // v0.0.436: delegate to fleet_api.sendFleet — the SAME function FS uses
    // to deploy ships to sibling moon (wire_runtime.ts:103). Operator
    // 2026-05-29: "復用以前成功的代碼,不要每次都調試新代碼". This path is
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
    // v1.0.23 — owner 2026-06-11 选项 B 智能部分装载. 真案 journal 实锤:
    // 13:17:23 deploy 2:75:7 → 3:279:7 m=181,450,578 被 ogame 拒 140028
    // "倉存容量不足" (目标 3:279:7 金属仓 199.5M / cap 203.5M, 真 free 仅 ~4M),
    // fleet_api self-heal 整剥金属成 0 retry → owner "金属没有装载上".
    // 真修: dispatch 前按目标真仓余量 clamp 每种资源 — "能装多少就装多少".
    //   free = storageCapForLevel(dest 仓等级) − dest 当前库存
    //   vanilla 公式是真 cap 下界 (LF bonus 只加不减) → clamp 永不超 ogame
    //   真 free → 不再触发 140028 → 不再整剥.
    // 范围: 仅 destType=1 (自有 planet 在 store) + 对应仓 building level ≥ 1
    // 才 clamp; moon / debris / 外人 planet / 无数据 → 不动 (fleet_api 140028
    // peel 仍是 last-resort 兜底). [[no-silent-destruction]]: clamp 真 console
    // + debug/log 双可见.
    if (destTypeNum === 1 && (_cargo.m > 0 || _cargo.c > 0 || _cargo.d > 0)) {
      try {
        const storeAll = (this.win as Window & { __ogamexStore?: { state?: { planets?: Record<string, { type?: string; coords?: number[]; buildings?: Record<string, number>; resources?: { m?: number; c?: number; d?: number }; storage?: { m_max?: number; c_max?: number; d_max?: number } }> } } }).__ogamexStore;
        const destKey = `${tGalaxy}:${tSystem}:${tPos}`;
        const destPlanet = Object.values(storeAll?.state?.planets ?? {}).find(
          (pl) => pl.type !== "moon" && (pl.coords ?? []).join(":") === destKey,
        );
        if (destPlanet) {
          const STORAGE_KEY = { m: "metalStorage", c: "crystalStorage", d: "deuteriumTank" } as const;
          const STORE_MAX_KEY = { m: "m_max", c: "c_max", d: "d_max" } as const;
          const clamps: string[] = [];
          for (const k of ["m", "c", "d"] as const) {
            if (_cargo[k] <= 0) continue;
            const bank = destPlanet.resources?.[k] ?? 0;
            // cap 真值优先级: store.storage (ogame DOM tooltip 真值, 含 LF bonus)
            // > vanilla storageCapForLevel(等级) 公式下界. store cap 仅当前浏览
            // planet 被 extractStorage 填, 其他 planet 多为 0 → fallback vanilla.
            const storeMax = destPlanet.storage?.[STORE_MAX_KEY[k]] ?? 0;
            const lvl = destPlanet.buildings?.[STORAGE_KEY[k]] ?? 0;
            let cap = 0;
            let capSrc = "";
            if (storeMax > 0) {
              cap = storeMax;
              capSrc = "store-dom";
            } else if (lvl > 0) {
              cap = storageCapForLevel(lvl);
              capSrc = `vanilla-L${lvl}`;
              // guard: bank > vanilla cap = 公式 provably 低估真 cap (LF bonus /
              // 等级 stale) → 0 信心, 跳过该资源 clamp (留 fleet_api peel 兜底).
              if (bank > cap) continue;
            } else {
              continue; // 无任何 cap 数据 → 不 clamp
            }
            const free = Math.max(0, cap - bank);
            if (_cargo[k] > free) {
              clamps.push(`${k}: ${_cargo[k]} → ${free} (cap=${cap} src=${capSrc} bank=${bank})`);
              _cargo[k] = free;
            }
          }
          if (clamps.length > 0) {
            const msg = `[ApiExec/dest-clamp] ${directive.action} → ${destKey}: ${clamps.join("; ")}`;
            console.warn(msg);
            try {
              const ctxWin2 = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
              const bridgeBase2 = ctxWin2.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
              void fetch(`${bridgeBase2.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
                method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tag: "dest-clamp", text: msg }),
              }).catch(() => { /* */ });
            } catch { /* */ }
          }
        }
      } catch (e) {
        console.warn(`[ApiExec/dest-clamp] non-fatal:`, e);
      }
    }
    try {
      const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
      if (ctxWin.localStorage?.getItem("OGAMEX_FORENSIC") === "1") {
        const _postInText = `${directive.action} goal_id=${(directive as { goal_id?: string }).goal_id ?? "?"} dirId=${directive.id} cp=${planetId} → ${tGalaxy}:${tSystem}:${tPos}(type=${destType}) mission=${mission} ships=${JSON.stringify(ships)} cargo=${JSON.stringify(_cargo)}`;
        console.warn(`[ApiExec/POST-IN] ${_postInText}`);
        const bridgeBase = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
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
    // state. Operator: "先從 api 拿到星球是否掃過, 沒掃過的繼續, 掃過的跳過".
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
        // v0.0.559 Phase 3 — galaxy fetch via cpPostWithRetry. Response has
        // no `success` field (returns `{token, system:{...}}`); successCheck
        // gates on system field presence. tokenProvider supplies "" since
        // galaxy fetch body doesn't carry a token.
        if (!this.tokenManager) throw new Error("discover: no tokenManager wired");
        const galRes = await cpPostWithRetry({
          endpoint: `/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1`,
          sourcePlanetId: planetId,
          token: this.tokenManager,
          action: "discover:galaxy",
          method: "POST",
          tokenProvider: async () => "",
          buildBody: () => {
            const b = new URLSearchParams();
            b.set("galaxy", String(galaxy));
            b.set("system", String(system));
            return b;
          },
          successCheck: (j) => !!j["system"],
          maxAttempts: 1,
          skipRestore: false,
        });
        const galTxt = galRes.raw;
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
          // doesn't rely on 10s /movement harvest. Operator: "你的艦隊槽的數量
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
            //     • string non-empty ("您可以在 X 之後再次搜尋…") → cooldown
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
    // return. Operator 2026-05-23: "艦隊:16/16 不要滿 保留一槽".
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

    // Operator 2026-05-25: "種族發現任務是不是在點選網頁，打開以後就會
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

    // v0.0.559 Phase 3 — discover POST via cpPostWithRetry maxAttempts=1.
    // tokenProvider supplies cached galaxy token. successCheck gates on
    // nested `response.success` OR top-level `success` (defensive: ogame
    // sometimes returns nested, sometimes flat). Business retry logic
    // (cooldown/token-race/資源不足) lives below — too branchy for cpPost's
    // single-retry-path semantics.
    if (!this.tokenManager) throw new Error("discover: no tokenManager wired");
    const buildDiscBody = (tk: string): URLSearchParams => {
      const b = new URLSearchParams();
      b.set("galaxy", String(galaxy));
      b.set("system", String(system));
      b.set("position", String(position));
      b.set("token", tk);
      return b;
    };
    console.info(`[ApiExec/discover] POST ${galaxy}:${system}:${position} from planet ${planetId}`);
    const discRes = await cpPostWithRetry({
      endpoint: `/game/index.php?page=ingame&component=fleetdispatch&action=sendDiscoveryFleet&ajax=1&asJson=1`,
      sourcePlanetId: planetId,
      token: this.tokenManager,
      action: "discover:send",
      method: "POST",
      tokenProvider: async () => token,
      buildBody: buildDiscBody,
      // successCheck always true → cpPostWithRetry returns json unconditionally;
      // business logic below classifies. Avoids cpPost auto-retry on the
      // discover-specific failure messages (cooldown / 資源不足 / 在您最後…)
      // that aren't in TRANSIENT_RACE_RE and need bespoke handling.
      successCheck: () => true,
      maxAttempts: 1,
      skipRestore: false,
    });
    const respText = discRes.raw;
    if (discRes.status !== 200) throw new Error(`discover: HTTP ${discRes.status}`);
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
    console.info(`[ApiExec/discover] resp HTTP ${discRes.status} body[0:200]=${respText.slice(0, 200).replace(/\s+/g, " ")}`);
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
      // ogame text contains "再次搜尋" / "再次搜尋生命形式" / "next" / 等待 / cooldown.
      // Treat as "this coord attempted" — append to completed[] via the
      // standard success path so planner moves to next coord. Throwing
      // here flips goal to blocked which stops progress entirely.
      const isCooldown = /再次搜尋|再次搜尋|next.*search|cooldown|wait|#time#/i.test(msg);
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
        const retryTokenRace = parsed?.newAjaxToken ?? token;
        const r2 = await cpPostWithRetry({
          endpoint: `/game/index.php?page=ingame&component=fleetdispatch&action=sendDiscoveryFleet&ajax=1&asJson=1`,
          sourcePlanetId: planetId,
          token: this.tokenManager,
          action: "discover:retry-token-race",
          method: "POST",
          tokenProvider: async () => retryTokenRace,
          buildBody: buildDiscBody,
          successCheck: () => true,
          maxAttempts: 1,
          skipRestore: false,
        });
        const retryText = r2.raw;
        const retryParsed = r2.json as typeof parsed;
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
      const isResShortage = /資源不足|資源不足|insufficient.*resource|resource.*insufficient|not enough/i.test(msg);
      if (isResShortage) {
        const storeRes = (this.win as Window & { __ogamexStore?: { state: { planets: Record<string, { resources?: { m?: number; c?: number; d?: number } }> } } })
          .__ogamexStore?.state?.planets?.[planetId]?.resources;
        const m = storeRes?.m ?? 0, c = storeRes?.c ?? 0, d = storeRes?.d ?? 0;
        const aboveThreshold = m >= 5000 && c >= 1000 && d >= 500;
        if (aboveThreshold) {
          console.warn(`[ApiExec/discover] ${galaxy}:${system}:${position} 資源不足 誤報 (store m=${m} c=${c} d=${d}) — single retry`);
          const retryTokenRes = parsed?.newAjaxToken ?? token;
          const r2 = await cpPostWithRetry({
            endpoint: `/game/index.php?page=ingame&component=fleetdispatch&action=sendDiscoveryFleet&ajax=1&asJson=1`,
            sourcePlanetId: planetId,
            token: this.tokenManager,
            action: "discover:retry-resource",
            method: "POST",
            tokenProvider: async () => retryTokenRes,
            buildBody: buildDiscBody,
            successCheck: () => true,
            maxAttempts: 1,
            skipRestore: false,
          });
          const retryText = r2.raw;
          const retryParsed = r2.json as typeof parsed;
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
   * "發現任務會幹擾前臺操作，其他星球發的艦隊的任務會變到從進行發現的星球上".
   * Background POSTs carry cp= to target a specific source planet, which
   * also SHIFTS the session's active planet — so the operator's next
   * manual click in their tab inherits OUR planet, not theirs. Fix by
   * issuing one cheap ajax GET with cp=<operatorCp> after each
   * cp-targeted POST.
   */
  /**
   * Get a fresh CSRF token for fleet dispatch chains without fetching the
   * heavy /component=fleetdispatch HTML page. Operator 2026-05-25:
   * "用 api 實現 不要點網頁". Sources, in priority:
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
        skipRestore: false,
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
