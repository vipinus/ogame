import type { Resources, Storage, Production } from "@ogamex/shared";

function readNumberById(doc: Document, id: string): number | null {
  const el = doc.getElementById(id);
  if (!el) return null;
  const raw = el.getAttribute("data-raw");
  if (raw && !isNaN(Number(raw))) return Math.floor(Number(raw));
  const text = el.textContent ?? "";
  const stripped = text.replace(/[^0-9]/g, "");
  return stripped ? parseInt(stripped, 10) : null;
}

interface TitleParts {
  max?: number;
  perHour?: number;
}

/**
 * Parse a resource_box title that can be either:
 *  - Legacy English plain-text format: "Capacity: 5000000 / Production per hour: 80000"
 *  - Real ogame HTML table format with localized labels (zh-TW seen, others similar)
 *
 * Returns extracted max + perHour (either may be undefined).
 */
function parseTitle(title: string, doc: Document): TitleParts {
  if (!title) return {};

  // Branch 1: legacy plain-text format
  const englishMax = title.match(/Capacity:\s*([\d,.]+)/i)?.[1];
  const englishPerH = title.match(/Production per hour:\s*([\d,.]+)/i)?.[1];
  const out: TitleParts = {};
  if (englishMax) out.max = parseInt(englishMax.replace(/\D/g, ""), 10);
  if (englishPerH) out.perHour = parseInt(englishPerH.replace(/\D/g, ""), 10);
  if (out.max !== undefined || out.perHour !== undefined) return out;

  // Branch 2: HTML table format (zh-TW labels)
  // Extract the inner table by finding '|' separator
  const pipeIdx = title.indexOf("|");
  const inner = pipeIdx >= 0 ? title.slice(pipeIdx + 1) : title;

  const labels: Record<"max" | "perHour", RegExp> = {
    max: /(儲存容量|Capacity)\s*:?/i,
    perHour: /(當前產量|Production per hour)\s*:?/i,
  };

  // Use DOMParser (available in jsdom and browsers)
  try {
    const win = (doc as unknown as { defaultView?: unknown }).defaultView ?? globalThis;
    const Parser = (win as { DOMParser?: typeof DOMParser }).DOMParser;
    if (Parser) {
      const parsed = new Parser().parseFromString(`<root>${inner}</root>`, "text/html");
      for (const row of Array.from(parsed.querySelectorAll("tr"))) {
        const th = row.querySelector("th")?.textContent ?? "";
        const valText = row.querySelector("td")?.textContent ?? "";
        const val = parseInt(valText.replace(/\D/g, ""), 10);
        if (!Number.isFinite(val)) continue;
        if (labels.max.test(th)) out.max = val;
        else if (labels.perHour.test(th)) out.perHour = val;
      }
      return out;
    }
  } catch {
    // fall through to regex fallback
  }

  // Final fallback: regex against raw text
  const rowRe = /<tr[^>]*>\s*<th[^>]*>([^<]+)<\/th>\s*<td[^>]*>(?:<[^>]+>)*([\d,.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(inner)) !== null) {
    const label = m[1]!;
    const val = parseInt(m[2]!.replace(/\D/g, ""), 10);
    if (!Number.isFinite(val)) continue;
    if (labels.max.test(label)) out.max = val;
    else if (labels.perHour.test(label)) out.perHour = val;
  }
  return out;
}

function getTitle(doc: Document, id: string): string {
  return doc.getElementById(id)?.getAttribute("title") ?? "";
}

export function extractResources(doc: Document): Resources | null {
  const m = readNumberById(doc, "resources_metal");
  const c = readNumberById(doc, "resources_crystal");
  const d = readNumberById(doc, "resources_deuterium");
  const e = readNumberById(doc, "resources_energy");
  if (m === null || c === null || d === null) return null;
  return { m, c, d, e: e ?? 0 };
}

export function extractStorage(doc: Document): Storage | null {
  const m = parseTitle(getTitle(doc, "metal_box"), doc);
  const c = parseTitle(getTitle(doc, "crystal_box"), doc);
  const d = parseTitle(getTitle(doc, "deuterium_box"), doc);
  if (m.max === undefined || c.max === undefined || d.max === undefined) return null;
  return { m_max: m.max, c_max: c.max, d_max: d.max };
}

export function extractProduction(doc: Document): Production | null {
  const m = parseTitle(getTitle(doc, "metal_box"), doc);
  const c = parseTitle(getTitle(doc, "crystal_box"), doc);
  const d = parseTitle(getTitle(doc, "deuterium_box"), doc);
  if (m.perHour === undefined || c.perHour === undefined || d.perHour === undefined) return null;
  return { m_h: m.perHour, c_h: c.perHour, d_h: d.perHour };
}

/** LifeForm 2026 resources — population/food/darkmatter. */
export interface LifeformResourceState {
  population: number;
  food: number;
  darkmatter: number;
}

export function extractLifeformResources(doc: Document): LifeformResourceState | null {
  const pop = readNumberById(doc, "resources_population");
  const food = readNumberById(doc, "resources_food");
  const dm = readNumberById(doc, "resources_darkmatter");
  if (pop === null || food === null || dm === null) return null;
  return { population: pop, food, darkmatter: dm };
}
