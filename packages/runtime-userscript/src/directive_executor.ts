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
const SUPPORTED_ACTIONS = new Set(["build", "research"]);

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
    selectors.push(`button.upgrade[data-technology="${numericId}"]`);
    selectors.push(`[data-technology="${numericId}"] .upgrade`);
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

  constructor(deps: UiExecutorDeps) {
    this.win = deps.win;
    this.doc = deps.doc;
    this.clickDelay = deps.clickDelay ?? defaultClickDelay;
    this.sleep = deps.sleep ?? defaultSleep;
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

    const planetId = readStringParam(directive.params, "planet_id");
    let component: string;
    let targetId: string;

    if (directive.action === "build") {
      component = "supplies";
      targetId = readStringParam(directive.params, "building") ?? "";
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

    // 1) Navigate. Prefer ogame.ajaxNavigation when present (real game env);
    //    fall back to no-op in test env where ogame globals aren't injected.
    this.navigate(component, planetId);

    // 2) Humanized delay so the click doesn't look bot-like.
    await this.sleep(this.clickDelay());

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

    // 4) Click. ogame's own delegated handlers will fire from here.
    console.info(`[UiDirectiveExecutor] clicking ${hit.sel} for ${directive.action}:${targetId}`);
    hit.el.click();

    return { action: directive.action, clicked: true };
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
    //    Check both via location.search and location.href substring (defensive
    //    for jsdom + real Chrome variants).
    const currentHref = this.win.location?.href ?? "";
    if (currentHref.includes(`component=${component}`)) {
      return;
    }
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
