import type {
  ExpeditionOutcome,
  ExpeditionOutcomeType,
  Coords,
  ShipCount,
  ShipKey,
  Resources,
} from "@ogamex/shared";
import { SHIP_IDS } from "@ogamex/shared";

/**
 * Parse one ogame expedition report (typically the message body JSON or HTML fragment
 * loaded via getAsJsonUrl) into a structured ExpeditionOutcome.
 *
 * Handles 4 most common outcome types in M3.5 (zh-TW client signals):
 *   - resources_medium  → metal+crystal(+deut) gained
 *   - black_hole        → "黑洞" / "black hole" — entire fleet lost
 *   - nothing           → "毫無所獲" / "什麼都沒" / "nothing found"
 *   - ships_gained_small → "獲得了" + ship counts
 *
 * Unknown variants fall back to "nothing" + a console.warn (so we notice
 * during M3.7 smoke and add new fixtures).
 *
 * Synthetic fixtures back the unit tests; the real ogame report HTML will be
 * hardened in M3.7.
 *
 * @param report  Either an HTMLElement (when parsing inline DOM) OR a string of HTML.
 * @param context Caller-supplied fields not derivable from the report itself.
 */
export function parseExpeditionReport(
  report: HTMLElement | string,
  context: {
    expedition_id: string;
    source_planet_id: string;
    source_coords: Coords;
    template_id: string;
    fleet_sent: ShipCount;
    launched_at: number;
  }
): ExpeditionOutcome {
  const root = toRootElement(report);
  const text = (root.textContent ?? "").trim();

  const detected = detectOutcomeType(text);
  let outcome_type: ExpeditionOutcomeType;
  let resources_gained: Resources = { m: 0, c: 0, d: 0, e: 0 };
  let ships_gained: ShipCount = {};
  let ships_lost: ShipCount = {};

  if (detected === "resources_medium") {
    outcome_type = "resources_medium";
    resources_gained = extractResourceGains(root);
  } else if (detected === "black_hole") {
    outcome_type = "black_hole";
    // Design choice: mirror fleet_sent into ships_lost — black_hole annihilates
    // the entire dispatched fleet. Documented in test.
    ships_lost = { ...context.fleet_sent };
  } else if (detected === "nothing") {
    outcome_type = "nothing";
  } else if (detected === "ships_gained_small") {
    outcome_type = "ships_gained_small";
    ships_gained = extractShipGains(root);
  } else {
    // Unknown variant — fall back gracefully and surface for M3.7 hardening.
    console.warn(
      "[expedition_report] unknown report variant — falling back to outcome_type='nothing'. " +
        "HTML sample: " +
        text.slice(0, 200)
    );
    outcome_type = "nothing";
  }

  const returned_at = Date.now();
  const duration_actual_seconds = Math.max(
    0,
    Math.floor((returned_at - context.launched_at) / 1000)
  );

  return {
    expedition_id: context.expedition_id,
    source_planet_id: context.source_planet_id,
    source_coords: context.source_coords,
    target_galaxy: 0,
    target_system: 0,
    target_position: 16,
    template_id: context.template_id,
    fleet_sent: context.fleet_sent,
    launched_at: context.launched_at,
    returned_at,
    duration_actual_seconds,
    outcome_type,
    resources_gained,
    ships_gained,
    ships_lost,
    raw_report_id: context.expedition_id,
    // LifeForm extras — not parsed in M3.5.
    artifacts_gained: {},
    lifeform_xp_gained: null,
  };
}

// --- helpers -----------------------------------------------------------------

function toRootElement(report: HTMLElement | string): HTMLElement {
  if (typeof report !== "string") return report;
  // Use jsdom-provided DOMParser (also available in browser).
  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div id="__root">${report}</div>`, "text/html");
  const root = parsed.getElementById("__root");
  if (root) return root;
  // Fallback: take <body>.
  return parsed.body;
}

function detectOutcomeType(text: string): ExpeditionOutcomeType | null {
  // Order matters: check "黑洞" / "毫無所獲" before resource/ship heuristics,
  // because a black_hole/nothing report might (theoretically) mention numbers.
  if (/黑洞|black\s*hole/i.test(text)) return "black_hole";
  if (/毫無所獲|什麼都沒|什么都没|nothing\s+found/i.test(text)) return "nothing";
  if (/獲得了|获得了/.test(text)) return "ships_gained_small";
  // Resource-table heuristic: any of the three resource classes appearing.
  // (Kept last so ship-gain text doesn't get misclassified.)
  if (/金屬|晶體|重氫|metal|crystal|deuterium/i.test(text)) {
    return "resources_medium";
  }
  return null;
}

function extractResourceGains(root: HTMLElement): Resources {
  const m = readResourceNumber(root, "metal");
  const c = readResourceNumber(root, "crystal");
  const d = readResourceNumber(root, "deuterium");
  return { m, c, d, e: 0 };
}

function readResourceNumber(root: HTMLElement, kind: string): number {
  const el = root.querySelector<HTMLElement>(`.resource.${kind}`);
  if (!el) return 0;
  const raw = el.getAttribute("data-raw");
  if (raw && !Number.isNaN(Number(raw))) return Math.floor(Number(raw));
  const txt = el.textContent ?? "";
  const stripped = txt.replace(/[^0-9]/g, "");
  return stripped ? parseInt(stripped, 10) : 0;
}

const SHIP_KEYS = Object.keys(SHIP_IDS) as ShipKey[];

function extractShipGains(root: HTMLElement): ShipCount {
  const ships: ShipCount = {};
  // Prefer explicit data-ship markers (matches our fixture pattern).
  const tagged = root.querySelectorAll<HTMLElement>("[data-ship]");
  for (const node of Array.from(tagged)) {
    const key = node.getAttribute("data-ship") as ShipKey | null;
    if (!key || !SHIP_KEYS.includes(key)) continue;
    // Count is the sibling .count inside the same parent (<li>/row).
    const parent = node.parentElement;
    const countEl = parent?.querySelector<HTMLElement>(".count");
    const txt = countEl?.textContent ?? parent?.textContent ?? "";
    const match = txt.match(/(\d[\d,.\s]*)/);
    if (!match) continue;
    const n = parseInt(match[1]!.replace(/\D/g, ""), 10);
    if (Number.isFinite(n) && n > 0) {
      ships[key] = n;
    }
  }
  return ships;
}
