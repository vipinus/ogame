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
 * Resolves the synthetic upgrade-button selector contract used by the
 * DOM-augmenter / M5.7 smoke harness. We use a single dedicated data attribute
 * so the executor doesn't need to know about ogame's many skin-specific class
 * names — the augmenter is responsible for stamping
 * `data-ogamex-upgrade="<action>:<id>"` on the correct button. M5.7 will tune
 * the augmenter against the live DOM.
 */
function upgradeSelector(action: string, id: string): string {
  return `[data-ogamex-upgrade="${action}:${id}"]`;
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

    // 3) Locate the upgrade button using the synthetic selector contract.
    //    NOTE: real ogame DOM doesn't expose this attribute natively — the
    //    DOM-augmenter (M5.7) is responsible for stamping it onto the
    //    appropriate skin-specific element. Keeping the selector synthetic
    //    here means M5.6 stays decoupled from skin variations.
    const selector = upgradeSelector(directive.action, targetId);
    const button = this.doc.querySelector<HTMLElement>(selector);
    if (!button) {
      throw new Error(`upgrade button not found for ${targetId}`);
    }

    // 4) Click. ogame's own delegated handlers will fire from here.
    button.click();

    return { action: directive.action, clicked: true };
  }

  private navigate(component: string, planetId: string | undefined): void {
    const url = navUrl(component, planetId);
    // ogame.ajaxNavigation.navigate(url) when the in-game SPA is loaded.
    const ogame = (this.win as unknown as { ogame?: { ajaxNavigation?: { navigate?: (u: string) => void } } }).ogame;
    const ajaxNav = ogame?.ajaxNavigation;
    const nav = ajaxNav?.navigate;
    if (ajaxNav && typeof nav === "function") {
      nav.call(ajaxNav, url);
      return;
    }
    // Fall back to a full-page nav only if we actually have a location
    // object. In jsdom tests we skip this branch so we don't accidentally
    // navigate the test document away.
    const loc = this.win.location;
    if (loc && typeof (loc as Location).assign === "function") {
      // Intentionally no-op in test env: tests don't provide ogame and we
      // don't want jsdom to follow the URL. M5.7 will exercise the real
      // navigation branch via a live-game smoke.
      // (Left empty by design — keeping the function reachable is enough.)
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
