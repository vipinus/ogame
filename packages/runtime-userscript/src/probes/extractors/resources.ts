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

export function extractResources(doc: Document): Resources | null {
  const m = readNumberById(doc, "resources_metal");
  const c = readNumberById(doc, "resources_crystal");
  const d = readNumberById(doc, "resources_deuterium");
  const e = readNumberById(doc, "resources_energy");
  if (m === null || c === null || d === null) return null;
  return { m, c, d, e: e ?? 0 };
}

interface TitleParts {
  max?: number;
  perHour?: number;
}

function parseTitle(text: string): TitleParts {
  const max = text.match(/Capacity:\s*([\d,.]+)/i)?.[1];
  const perH = text.match(/Production per hour:\s*([\d,.]+)/i)?.[1];
  const out: TitleParts = {};
  if (max) out.max = parseInt(max.replace(/\D/g, ""), 10);
  if (perH) out.perHour = parseInt(perH.replace(/\D/g, ""), 10);
  return out;
}

function getTitle(doc: Document, id: string): string {
  return doc.getElementById(id)?.getAttribute("title") ?? "";
}

export function extractStorage(doc: Document): Storage | null {
  const m = parseTitle(getTitle(doc, "metal_box"));
  const c = parseTitle(getTitle(doc, "crystal_box"));
  const d = parseTitle(getTitle(doc, "deuterium_box"));
  if (m.max === undefined || c.max === undefined || d.max === undefined) return null;
  return { m_max: m.max, c_max: c.max, d_max: d.max };
}

export function extractProduction(doc: Document): Production | null {
  const m = parseTitle(getTitle(doc, "metal_box"));
  const c = parseTitle(getTitle(doc, "crystal_box"));
  const d = parseTitle(getTitle(doc, "deuterium_box"));
  if (m.perHour === undefined || c.perHour === undefined || d.perHour === undefined) return null;
  return { m_h: m.perHour, c_h: c.perHour, d_h: d.perHour };
}
