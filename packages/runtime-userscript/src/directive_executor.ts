import type { Directive } from "@ogamex/shared";
import type { DirectiveExecutor } from "./directive_executor_iface.js";

/**
 * Dependencies for the UI-clicking DirectiveExecutor. All collaborators are
 * injectable so the implementation is jsdom-testable without touching
 * globalThis.
 */
export interface UiExecutorDeps {
  /** Window object (injectable for jsdom tests). */
  win: Window;
  /** Document object (injectable). */
  doc: Document;
  /** Optional click delay generator (ms). Default: 200 + random(400) ms. */
  clickDelay?: () => number;
  /** Sleep helper — injectable so tests can stub. */
  sleep?: (ms: number) => Promise<void>;
}

/** Actions this executor understands. Fleet actions go via fleet_api directly. */
const SUPPORTED_ACTIONS = new Set(["build", "research", "build_ships", "expedition"]);

/**
 * Ogame's DOM uses NUMERIC data-technology ids (1=metalMine, 31=researchLab,
 * 199=gravitonTech, ...) but our TECH_TREE / Goal uses string ids. Map the
 * ones we support to keep the executor self-contained.
 *
 * Verified against live ogame DOM on s274-en (2026-05-19 smoke):
 *   `<button class="upgrade" data-technology="<numericId>">`.
 *
 * Sources: spec §3 + in-game data-technology values for buildings (1..44)
 * and research (106..199).
 */
const OGAME_NUMERIC_ID: Record<string, string> = {
  // Resource buildings
  metalMine: "1",
  crystalMine: "2",
  deuteriumSynth: "3",
  solarPlant: "4",
  fusionReactor: "12",
  metalStorage: "22",
  crystalStorage: "23",
  deuteriumTank: "24",
  // Facilities
  roboticsFactory: "14",
  shipyard: "21",
  researchLab: "31",
  alliance_depot: "34",
  missile_silo: "44",
  naniteFactory: "15",
  terraformer: "33",
  // Research
  energyTech: "113",
  laserTech: "120",
  ionTech: "121",
  hyperspaceTech: "114",
  plasmaTech: "122",
  combustion: "115",
  impulseDrive: "117",
  hyperspaceDrive: "118",
  espionageTech: "106",
  computerTech: "108",
  astrophysics: "124",
  intergalactic: "123",
  gravitonTech: "199",
  weapons: "109",
  shielding: "110",
  armor: "111",
  // Ships (shipyard data-technology values)
  smallCargo: "202",
  largeCargo: "203",
  lightFighter: "204",
  heavyFighter: "205",
  cruiser: "206",
  battleship: "207",
  colonyShip: "208",
  recycler: "209",
  espionageProbe: "210",
  bomber: "211",
  solarSatellite: "212",
  destroyer: "213",
  deathstar: "214",
  battlecruiser: "215",
  reaper: "218",
  explorer: "219",
};

/**
 * Build a selector for the upgrade button. Tries three patterns in order:
 *   1. Real ogame DOM: `button.upgrade[data-technology="<numericId>"]`.
 *   2. Synthetic fallback: `[data-ogamex-upgrade="<action>:<stringId>"]`
 *      (kept for unit tests + future DOM-augmenter use).
 *   3. Broader real fallback: any `[data-technology="<numericId>"]` element
 *      with a clickable upgrade child (catches skin variants).
 */
function candidateSelectors(action: string, stringId: string): string[] {
  const numericId = OGAME_NUMERIC_ID[stringId];
  const selectors: string[] = [];
  if (numericId) {
    // ogame DOM varies across skins/versions. Cast a wide net — first
    // match wins. Order: most specific → least specific.
    selectors.push(`button.upgrade[data-technology="${numericId}"]`);
    selectors.push(`a.upgrade[data-technology="${numericId}"]`);
    selectors.push(`li.technology[data-technology="${numericId}"] button.upgrade`);
    selectors.push(`li.technology[data-technology="${numericId}"] a.upgrade`);
    selectors.push(`li.technology[data-technology="${numericId}"] .upgrade`);
    selectors.push(`li.technology[data-technology="${numericId}"] button.build-it`);
    selectors.push(`li.technology[data-technology="${numericId}"] button[type="submit"]`);
    selectors.push(`[data-technology="${numericId}"] .upgrade`);
    selectors.push(`[data-technology="${numericId}"] button`);
    selectors.push(`[data-technology="${numericId}"] a`);
    // For build_ships: the row itself may need to be clicked first to
    // open the build dialog. Including it lets us at least show the
    // panel; the amount-set step uses this as a base too.
    if (action === "build_ships") {
      selectors.push(`li.technology[data-technology="${numericId}"]`);
    }
  }
  selectors.push(`[data-ogamex-upgrade="${action}:${stringId}"]`);
  return selectors;
}

/** Build a navigation URL for an ogame ingame page. */
function navUrl(component: string, planetId: string | undefined): string {
  const cp = planetId ? `&cp=${encodeURIComponent(planetId)}` : "";
  return `?page=ingame&component=${component}${cp}`;
}

function defaultClickDelay(): number {
  return 200 + Math.floor(Math.random() * 400);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UiDirectiveExecutor implements DirectiveExecutor {
  private readonly win: Window;
  private readonly doc: Document;
  private readonly clickDelay: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastNavTs = 0;
  private lastUserActivityTs = 0;

  constructor(deps: UiExecutorDeps) {
    this.win = deps.win;
    this.doc = deps.doc;
    this.clickDelay = deps.clickDelay ?? defaultClickDelay;
    this.sleep = deps.sleep ?? defaultSleep;
    // Track real mouse activity (mousedown only — keydown includes F5 /
    // Ctrl+R reload, which trips the busy-flag and blocks auto-execute
    // right after a refresh). Only genuine user mouse clicks count.
    const onAct = (e: Event): void => {
      if (!e.isTrusted) return;
      this.lastUserActivityTs = Date.now();
    };
    deps.doc.addEventListener("mousedown", onAct, true);
  }

  /**
   * Has the operator clicked something in the last 10s? If yes, skip
   * auto-nav (don't yank their view). 10s is short enough that reload
   * doesn't pin it permanently, but long enough that an active click
   * sequence finishes before the bot intervenes.
   */
  private operatorIsBusy(): boolean {
    const IDLE_MS = 10_000;
    return Date.now() - this.lastUserActivityTs < IDLE_MS;
  }

  canHandle(directive: Directive): boolean {
    return directive.method === "ui" && SUPPORTED_ACTIONS.has(directive.action);
  }

  async execute(
    directive: Directive,
  ): Promise<{ action: string; clicked: boolean }> {
    if (!this.canHandle(directive)) {
      throw new Error(
        `UiDirectiveExecutor cannot handle ${directive.action}`,
      );
    }

    // Operator gate — this executor performs raw DOM clicks + iframe nav,
    // which fully takes over the foreground. Refuse while userBusy.
    // GoalRunner also gates at dispatch, but this is belt+braces — if a
    // directive sneaks through (e.g. existing in-flight execution), bail
    // before touching the page.
    const win = (typeof window !== "undefined") ? window as Window & { __ogamexUserBusyUntil?: number } : null;
    const busyUntil = win?.__ogamexUserBusyUntil ?? 0;
    if (busyUntil > Date.now()) {
      throw new Error(`UiDirectiveExecutor refused: operator active (+${Math.round((busyUntil - Date.now()) / 1000)}s)`);
    }

    // Expedition is a fundamentally different flow (3-step fleetdispatch)
    // so it lives in its own method — it doesn't share the
    // single-iframe-click model used by build/research/build_ships.
    if (directive.action === "expedition") {
      return this.executeExpedition(directive);
    }

    const planetId = readStringParam(directive.params, "planet_id");
    let component: string;
    let targetId: string;

    if (directive.action === "build") {
      targetId = readStringParam(directive.params, "building") ?? "";
      // ogame v12 split: mines/storage live on `supplies`, shipyard/lab/
      // robotics/nanite on `facilities`. The old "supplies for everything"
      // url returned an empty li for facility ids → button not found.
      const FACILITIES = new Set([
        "shipyard", "researchLab", "roboticsFactory", "naniteFactory",
        "allianceDepot", "missileSilo",
      ]);
      component = FACILITIES.has(targetId) ? "facilities" : "supplies";
    } else if (directive.action === "build_ships") {
      component = "shipyard";
      targetId = readStringParam(directive.params, "ship") ?? "";
    } else {
      // action === "research"
      component = "research";
      targetId = readStringParam(directive.params, "tech") ?? "";
    }

    if (!targetId) {
      throw new Error(
        `UiDirectiveExecutor: missing target id for ${directive.action}`,
      );
    }

    // Look up candidate selectors once — used for both direct-click and
    // post-nav button discovery.
    const directSelectors = candidateSelectors(directive.action, targetId);

    // If host ogame exposes its SPA navigator, USE IT — production path —
    // then locate the button in the (now-current) doc and click. This
    // matches ogame's own behavior where ajaxNavigation rerenders the
    // component DOM into the same document.
    const ajaxNav = (this.win as { ogame?: { ajaxNavigation?: { navigate?: (url: string) => void } } }).ogame?.ajaxNavigation?.navigate;
    if (typeof ajaxNav === "function") {
      ajaxNav(navUrl(component, planetId));
      // After SPA nav the upgrade button should be present; query and click.
      for (const sel of directSelectors) {
        const btn = this.doc.querySelector<HTMLElement>(sel);
        if (btn) {
          btn.click();
          return { action: directive.action, clicked: true };
        }
      }
      throw new Error(`upgrade button not found for ${directive.action}:${targetId}`);
    }

    // Fast path — button already in main document? Click direct.
    for (const sel of directSelectors) {
      const btn = this.doc.querySelector<HTMLElement>(sel);
      if (btn) {
        btn.click();
        return { action: directive.action, clicked: true };
      }
    }

    // Non-ogame env (test fixture, about:blank, no ajaxNav, no real URL):
    // iframe path won't progress. Throw canonical not-found.
    const hrefLooksLikeOgame = (this.win.location?.href ?? "").includes("/game/index.php");
    if (!hrefLooksLikeOgame) {
      throw new Error(`upgrade button not found for ${directive.action}:${targetId}`);
    }

    // 2) Already on target page? Click directly.
    //    Not on target? Inject SPA ajaxNavigation (page-world) and WAIT
    //    in this same tick for the new component DOM to render, then
    //    continue to find selector + click. Single-tick automation.
    const currentHref = this.win.location?.href ?? "";
    const onTargetComponent = currentHref.includes(`component=${component}`);
    const cpOk = !planetId || currentHref.includes(`cp=${planetId}`) || !currentHref.includes("cp=");
    if (!onTargetComponent || !cpOk) {
      // Background execute via hidden iframe — load target component in
      // an off-screen frame, click inside its document, close. Same
      // origin so cookies/session shared; user's main page never moves.
      const relUrl = navUrl(component, planetId);
      console.info(`[UiDirectiveExecutor] background iframe step1: creating -> ${relUrl}`);
      const iframe = this.doc.createElement("iframe");
      iframe.style.cssText = "position:fixed; left:-9999px; top:-9999px; width:1px; height:1px; border:0;";
      iframe.src = relUrl;
      this.doc.body.appendChild(iframe);
      console.info(`[UiDirectiveExecutor] iframe step2: appended, waiting for load…`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { console.warn("[UiDirectiveExecutor] iframe load TIMEOUT after 10s"); resolve(); }, 10000);
        iframe.addEventListener("load", () => { console.info("[UiDirectiveExecutor] iframe step3: load event fired"); clearTimeout(timer); resolve(); }, { once: true });
      });
      const ifDoc = iframe.contentDocument;
      if (!ifDoc) {
        iframe.remove();
        console.warn("[UiDirectiveExecutor] iframe contentDocument is NULL — likely X-Frame-Options denial");
        throw new Error("iframe contentDocument not accessible (X-Frame-Options block?)");
      }
      console.info(`[UiDirectiveExecutor] iframe step4: contentDocument OK, href=${ifDoc.location?.href}, body children=${ifDoc.body?.children?.length}`);
      await this.sleep(1500);
      console.info(`[UiDirectiveExecutor] iframe step5: after 1.5s settle, href=${ifDoc.location?.href}, technologies=${ifDoc.querySelectorAll('li.technology').length}`);
      const numericIdI = OGAME_NUMERIC_ID[targetId];
      if (numericIdI) {
        const liI = ifDoc.querySelector<HTMLElement>(`li.technology[data-technology="${numericIdI}"]`);
        const statusI = liI?.getAttribute("data-status");
        console.info(`[UiDirectiveExecutor] iframe step6: probe li[data-technology="${numericIdI}"] -> found=${!!liI} status=${statusI}`);
        // status="active" = ogame is currently upgrading/building this
        // item RIGHT NOW. Don't try to click — there's no button. Treat
        // as "in flight" and ack success (the merger sees the next push
        // and marks goal active correctly via in-flight detection).
        if (statusI === "active") {
          iframe.remove();
          console.info(`[UiDirectiveExecutor] ${targetId} already in flight (status=active) — no-op success`);
          return { action: directive.action, clicked: false };
        }
        if (statusI === "disabled") {
          const reason = liI?.getAttribute("data-tooltip-title") ?? "disabled in iframe";
          iframe.remove();
          // Soft-block: shipyard/lab/etc currently upgrading — can't queue
          // ships/research during. Don't error-spam; ack as success-deferred.
          if (/造船廠|shipyard|實驗室|lab/i.test(reason) && /升級|upgrad|building/i.test(reason)) {
            console.info(`[UiDirectiveExecutor] ${targetId} soft-blocked (prereq upgrading): ${reason}`);
            return { action: directive.action, clicked: false };
          }
          throw new Error(`${targetId} unavailable in iframe: ${reason}`);
        }
      }
      if (directive.action === "build_ships") {
        const amount = (() => {
          const a = (directive.params as { amount?: unknown }).amount;
          return typeof a === "number" && a > 0 ? Math.floor(a) : 1;
        })();
        // 2-stage: click ship's row first to open detail panel where the
        // amount input + submit button live. ogame v12 hides those until
        // you click the ship tile.
        const rowSel = [
          `li.technology[data-technology="${numericIdI}"] .technologyName`,
          `li.technology[data-technology="${numericIdI}"] .header`,
          `li.technology[data-technology="${numericIdI}"] a`,
          `li.technology[data-technology="${numericIdI}"]`,
        ];
        let rowEl: HTMLElement | null = null;
        for (const s of rowSel) {
          const e = ifDoc.querySelector<HTMLElement>(s);
          if (e) { rowEl = e; break; }
        }
        console.info(`[UiDirectiveExecutor] iframe step7a: ship row click ${!!rowEl}`);
        if (rowEl) rowEl.click();
        await this.sleep(800);
        // After click, detail panel should reveal. Probe inputs again.
        const inputSel = [
          `input[name="menge[${numericIdI}]"]`,
          `input[name="menge"]`,
          `input.amount[type="number"]`,
          `input.maxbuildable`,
          `#build_amount`,
          `li.technology[data-technology="${numericIdI}"] input[type="number"]`,
        ];
        let amountInput: HTMLInputElement | null = null;
        let matchedSel = "";
        for (const s of inputSel) {
          const e = ifDoc.querySelector<HTMLInputElement>(s);
          if (e) { amountInput = e; matchedSel = s; break; }
        }
        console.info(`[UiDirectiveExecutor] iframe step7b: amount input matched="${matchedSel}" found=${!!amountInput}`);
        if (!amountInput) {
          // Dump all inputs in iframe to help identify the real selector.
          const allInputs = Array.from(ifDoc.querySelectorAll("input"))
            .slice(0, 20)
            .map((e) => `name="${e.name}" type="${e.type}" class="${e.className.slice(0,30)}"`);
          console.warn(`[UiDirectiveExecutor] iframe inputs available: ${JSON.stringify(allInputs)}`);
          // Last-resort: try inline form submit on the ship's form element.
          const liForForm = ifDoc.querySelector<HTMLElement>(`li.technology[data-technology="${numericIdI}"]`);
          const form = liForForm?.querySelector<HTMLFormElement>("form")
            ?? ifDoc.querySelector<HTMLFormElement>(`form[action*="shipyard"]`);
          if (form) {
            console.info(`[UiDirectiveExecutor] iframe step7c: form found, action=${form.action.slice(0,80)} — submitting directly with amount=${amount}`);
            const hiddenAmt = form.querySelector<HTMLInputElement>('input[name="menge"]') ?? null;
            if (hiddenAmt) hiddenAmt.value = String(amount);
            // Inject type field if missing.
            if (!form.querySelector('input[name="type"]')) {
              const t = ifDoc.createElement("input"); t.type="hidden"; t.name="type"; t.value=String(numericIdI);
              form.appendChild(t);
            }
            form.submit();
            await this.sleep(2000);
            iframe.remove();
            return { action: directive.action, clicked: true };
          }
          iframe.remove();
          throw new Error(`ship amount input not found after row-click for ${targetId}; ogame DOM unexpected (see iframe inputs log)`);
        }
        amountInput.value = String(amount);
        amountInput.dispatchEvent(new Event("input", { bubbles: true }));
        amountInput.dispatchEvent(new Event("change", { bubbles: true }));
        console.info(`[UiDirectiveExecutor] iframe step8: set amount=${amount}`);
        // Find the build submit button in the detail panel.
        const submitSel = [
          `button.build_submit`,
          `a.build_submit`,
          `button.upgrade`,
          `button[type="submit"]`,
          `.build-it`,
          `.build_btn`,
          `#build`,
        ];
        let submitBtn: HTMLElement | null = null;
        let submitMatched = "";
        for (const s of submitSel) {
          const e = ifDoc.querySelector<HTMLElement>(s);
          if (e) { submitBtn = e; submitMatched = s; break; }
        }
        console.info(`[UiDirectiveExecutor] iframe step9: build submit matched="${submitMatched}" found=${!!submitBtn}`);
        if (!submitBtn) {
          iframe.remove();
          throw new Error(`build submit button not found for ${targetId}`);
        }
        console.info(`[UiDirectiveExecutor] iframe step10: CLICKING submit ${submitMatched}`);
        submitBtn.click();
        await this.sleep(2000);
        console.info(`[UiDirectiveExecutor] iframe step11: post-submit href=${ifDoc.location?.href}, removing iframe`);
      } else {
        // research / build (non-ship): single click on upgrade button.
        const selsI = candidateSelectors(directive.action, targetId);
        let hitI: HTMLElement | null = null;
        let matchedClickSel = "";
        for (const s of selsI) {
          const e = ifDoc.querySelector<HTMLElement>(s);
          if (e) { hitI = e; matchedClickSel = s; break; }
        }
        console.info(`[UiDirectiveExecutor] iframe step9: upgrade button matched="${matchedClickSel}" tried=${selsI.length} found=${!!hitI}`);
        if (!hitI) {
          iframe.remove();
          throw new Error(`button not found in iframe for ${targetId} (tried: ${selsI.slice(0,3).join(" | ")})`);
        }
        console.info(`[UiDirectiveExecutor] iframe step10: CLICKING ${matchedClickSel}`);
        hitI.click();
        await this.sleep(2000);
        console.info(`[UiDirectiveExecutor] iframe step11: post-click href=${ifDoc.location?.href}, removing iframe`);
      }
      iframe.remove();
      return { action: directive.action, clicked: true };
    }

    // 2) Humanized delay so the click doesn't look bot-like.
    await this.sleep(this.clickDelay());

    // 3a) Preflight: if the tech's <li> exists with data-status="disabled"
    //     (ogame sets this when the build queue is full, prerequisites unmet,
    //     or resources insufficient), short-circuit with a clear error.
    //     Saves 5s of polling for a button that ogame will never render.
    const numericId = OGAME_NUMERIC_ID[targetId];
    if (numericId) {
      const li = this.doc.querySelector<HTMLElement>(`li.technology[data-technology="${numericId}"]`);
      const status = li?.getAttribute("data-status");
      if (status === "disabled") {
        const reason = li?.getAttribute("data-tooltip-title") ?? "tech is disabled";
        throw new Error(`${targetId} unavailable: ${reason}`);
      }
    }

    // 3) Locate the upgrade button. Try real ogame selectors first (numeric
    //    data-technology), then the synthetic data-ogamex-upgrade contract.
    //    ogame SPA renders the target page async, so poll for the button to
    //    appear (up to 5s total at 100ms intervals) before giving up.
    const selectors = candidateSelectors(directive.action, targetId);
    const probeBtn = (): { el: HTMLElement; sel: string } | null => {
      for (const sel of selectors) {
        const el = this.doc.querySelector<HTMLElement>(sel);
        if (el) return { el, sel };
      }
      return null;
    };
    let hit = probeBtn();
    if (!hit) {
      const deadline = Date.now() + 5000;
      while (!hit && Date.now() < deadline) {
        await this.sleep(100);
        hit = probeBtn();
      }
    }
    if (!hit) {
      throw new Error(
        `upgrade button not found for ${targetId} after 5s (tried: ${selectors.join(" | ")})`,
      );
    }

    // 4a) Ships: type the amount into the shipyard input before clicking
    //     build. ogame's shipyard puts an <input> per ship row that takes a
    //     numeric quantity; the build button reads it on click. Without
    //     setting it explicitly the queue would attempt 0 ships and silently
    //     no-op. We dispatch a synthetic 'input' event so ogame's listeners
    //     update the running cost preview.
    if (directive.action === "build_ships") {
      const amount = (() => {
        const a = (directive.params as { amount?: unknown }).amount;
        return typeof a === "number" && a > 0 ? Math.floor(a) : 1;
      })();
      const numericId = OGAME_NUMERIC_ID[targetId];
      // ogame shipyard input is typically `input.amount[name="${stringId}"]`
      // but skins vary. Try several patterns.
      const inputSelectors = [
        `input.amount[name="${targetId}"]`,
        numericId ? `input[name="${targetId}"]` : null,
        `li.technology[data-technology="${numericId}"] input`,
        `[data-technology="${numericId}"] input[type="number"]`,
      ].filter((s): s is string => typeof s === "string");
      let amountInput: HTMLInputElement | null = null;
      for (const sel of inputSelectors) {
        const el = this.doc.querySelector<HTMLInputElement>(sel);
        if (el) { amountInput = el; break; }
      }
      if (amountInput) {
        amountInput.value = String(amount);
        amountInput.dispatchEvent(new Event("input", { bubbles: true }));
        amountInput.dispatchEvent(new Event("change", { bubbles: true }));
        console.info(`[UiDirectiveExecutor] set ${targetId} amount=${amount}`);
      } else {
        console.warn(`[UiDirectiveExecutor] no amount input found for ${targetId}; clicking with default amount`);
      }
    }

    // 4b) Click. ogame's own delegated handlers will fire from here.
    console.info(`[UiDirectiveExecutor] clicking ${hit.sel} for ${directive.action}:${targetId}`);
    hit.el.click();

    return { action: directive.action, clicked: true };
  }

  /**
   * Launch a single expedition fleet via ogame's fleetdispatch flow.
   * Loads fleetdispatch component in a hidden iframe, fills ship counts
   * (from directive.params.ships OR a sane default), sets target coords
   * to <source_galaxy>:<source_system>:16, mission=15, deuterium=1, send.
   * Returns clicked:true on submit; the planner re-checks fleets_outbound
   * next tick and increments count_remaining toward zero.
   */
  private async executeExpedition(
    directive: Directive,
  ): Promise<{ action: string; clicked: boolean }> {
    const params = directive.params as {
      source_planet?: string;
      source_coords?: string;
      count_remaining?: number;
      ships?: Record<string, number>;
    };
    const sourcePlanet = params.source_planet ?? "";
    const sourceCoords = params.source_coords ?? "";
    const [gStr, sStr] = sourceCoords.split(":");
    const galaxy = parseInt(gStr ?? "0", 10);
    const system = parseInt(sStr ?? "0", 10);
    if (!galaxy || !system) {
      throw new Error(`expedition: bad source_coords "${sourceCoords}"`);
    }
    // Default ship template: 1 espionage probe + 1 small cargo. Used
    // only when goal.target didn't specify; bridge `fleet` cmd writes
    // strategy.daily.expedition.fleet_templates which we should read,
    // but the sidecar exposes that via /v1/strategy GET — TODO wire.
    const ships: Record<string, number> = params.ships && Object.keys(params.ships).length > 0
      ? params.ships
      : { smallCargo: 1, espionageProbe: 1 };

    // Build fleetdispatch iframe.
    const relUrl = `?page=ingame&component=fleetdispatch&cp=${sourcePlanet}`;
    console.info(`[Expedition] step1: iframe -> ${relUrl}  ships=${JSON.stringify(ships)}  target=${galaxy}:${system}:16`);
    const iframe = this.doc.createElement("iframe");
    iframe.style.cssText = "position:fixed; left:-9999px; top:-9999px; width:1px; height:1px; border:0;";
    iframe.src = relUrl;
    this.doc.body.appendChild(iframe);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { console.warn("[Expedition] load TIMEOUT"); resolve(); }, 12000);
      iframe.addEventListener("load", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    const ifDoc = iframe.contentDocument;
    if (!ifDoc) { iframe.remove(); throw new Error("Expedition: contentDocument null"); }
    await this.sleep(2000); // fleet dispatch UI mounts late
    console.info(`[Expedition] step2: contentDocument OK technologies=${ifDoc.querySelectorAll("li.technology, li[data-technology]").length}`);

    // ── Fleet step 1: enter ship counts ─────────────────────────────────
    // ogame v12 fleet dispatch has ship rows with `data-technology` ids;
    // each row's <input name="am<id>"> takes the count. Setting input +
    // dispatching input/change events advances ogame's internal state.
    let filled = 0;
    const SHIP_ID: Record<string, string> = {
      smallCargo: "202", largeCargo: "203", lightFighter: "204",
      heavyFighter: "205", cruiser: "206", battleship: "207",
      colonyShip: "208", recycler: "209", espionageProbe: "210",
      bomber: "211", solarSatellite: "212", destroyer: "213",
      deathstar: "214", battlecruiser: "215", crawler: "217",
      reaper: "218", explorer: "219",
    };
    for (const [shipName, n] of Object.entries(ships)) {
      const numId = SHIP_ID[shipName];
      if (!numId || n <= 0) continue;
      const sel = [
        `input[name="am${numId}"]`,
        `input.amount[name="am${numId}"]`,
        `li[data-technology="${numId}"] input[name^="am"]`,
      ];
      let input: HTMLInputElement | null = null;
      for (const s of sel) { const e = ifDoc.querySelector<HTMLInputElement>(s); if (e) { input = e; break; } }
      if (!input) {
        console.warn(`[Expedition] ship ${shipName} (am${numId}) input not found`);
        continue;
      }
      input.value = String(n);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      filled += 1;
      console.info(`[Expedition] step3: set ${shipName}=${n}`);
    }
    if (filled === 0) {
      iframe.remove();
      throw new Error(`Expedition: no ship inputs filled (ogame DOM mismatch?)`);
    }

    // Click "continue" / 下一步 to advance to fleet step 2.
    const nextBtn = ifDoc.querySelector<HTMLElement>(
      "#continueToFleet2, a#continueToFleet2, button.fleet_submit, button[type=submit].btn_blue, .fleet_2",
    );
    if (!nextBtn) {
      iframe.remove();
      throw new Error(`Expedition: continueToFleet2 button not found`);
    }
    console.info(`[Expedition] step4: continue to step 2`);
    nextBtn.click();
    await this.sleep(1500);

    // ── Fleet step 2: target coords + mission ──────────────────────────
    const setVal = (sel: string, val: string): boolean => {
      const e = ifDoc.querySelector<HTMLInputElement>(sel);
      if (!e) return false;
      e.value = val;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const gOk = setVal("#galaxy, input[name=galaxy]", String(galaxy));
    const sOk = setVal("#system, input[name=system]", String(system));
    const pOk = setVal("#position, input[name=position]", "16");
    console.info(`[Expedition] step5: target g=${gOk} s=${sOk} p=${pOk}`);
    if (!gOk || !sOk || !pOk) {
      iframe.remove();
      throw new Error(`Expedition: coord inputs missing (g/s/p)`);
    }
    // Continue to step 3.
    const nextBtn2 = ifDoc.querySelector<HTMLElement>(
      "#continueToFleet3, a#continueToFleet3, button[type=submit].btn_blue",
    );
    if (!nextBtn2) { iframe.remove(); throw new Error(`Expedition: continueToFleet3 not found`); }
    console.info(`[Expedition] step6: continue to step 3`);
    nextBtn2.click();
    await this.sleep(1500);

    // ── Fleet step 3: mission=15 (expedition) + send ────────────────────
    const missionBtn = ifDoc.querySelector<HTMLElement>(
      'a.mission_15, button[data-mission="15"], input[name=mission][value="15"]',
    );
    if (missionBtn) {
      console.info(`[Expedition] step7: mission=15 click`);
      missionBtn.click();
      await this.sleep(500);
    } else {
      console.warn(`[Expedition] mission_15 button not found; trying form-only path`);
    }
    const sendBtn = ifDoc.querySelector<HTMLElement>(
      "#sendFleet, a#sendFleet, button#sendFleet, button.fleetSendBtn",
    );
    if (!sendBtn) { iframe.remove(); throw new Error(`Expedition: sendFleet button not found`); }
    console.info(`[Expedition] step8: SENDING fleet`);
    sendBtn.click();
    await this.sleep(2500);
    iframe.remove();
    return { action: "expedition", clicked: true };
  }

  private navigate(component: string, planetId: string | undefined): void {
    const relUrl = navUrl(component, planetId);
    // 1) Prefer SPA navigation via ogame.ajaxNavigation when the in-game SPA
    //    exposes it. Real ogame DOES populate window.ogame but does NOT
    //    expose ajaxNavigation in page main world for many skins — so this
    //    branch is usually skipped on the live game and we fall through.
    const ogame = (this.win as unknown as { ogame?: { ajaxNavigation?: { navigate?: (u: string) => void } } }).ogame;
    const ajaxNav = ogame?.ajaxNavigation;
    const nav = ajaxNav?.navigate;
    if (ajaxNav && typeof nav === "function") {
      nav.call(ajaxNav, relUrl);
      return;
    }
    // 2) Already on the target page? Skip navigation to avoid useless reloads.
    //    Check BOTH the component AND the cp= planet param — switching
    //    planet while staying on same component still needs navigation,
    //    but staying on identical page+planet must be a no-op (otherwise
    //    every directive triggers a full reload + boot + push + dispatch
    //    → infinite loop).
    const currentHref = this.win.location?.href ?? "";
    const samePage = currentHref.includes(`component=${component}`);
    const cpMatch = !planetId || currentHref.includes(`cp=${planetId}`) || !currentHref.includes("cp=");
    if (samePage && cpMatch) return;
    // 3) Full-page nav fallback. In tests jsdom doesn't follow, so this is
    //    effectively a no-op there. The real Chrome will navigate properly.
    const loc = this.win.location;
    if (loc && typeof (loc as Location).assign === "function") {
      try {
        // Use a relative URL so it joins against the current origin (the
        // ogame server). All test fixtures set jsdom origin to about:blank
        // so this no-ops cleanly.
        (loc as Location).assign(relUrl);
      } catch {
        /* swallow — jsdom may throw on cross-origin navigation in tests */
      }
    }
  }
}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = params[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
