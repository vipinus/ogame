import { OGAME_DATA_TECHNOLOGY_REVERSE } from "@ogamex/shared";

/**
 * Extract building / research levels from the current ogame page DOM.
 *
 * Real DOM shape (verified on s274-en 2026-05-20):
 *   `<li class="technology metalMine ..." data-technology="1">
 *      <span class="level" data-value="11">11</span>
 *      …
 *   </li>`
 *
 * data-technology is numeric (1=metalMine, 31=researchLab, 199=gravitonTech).
 * The level element exposes the integer via `data-value` (cleanest) or text.
 *
 * Returns a `{stringTechId: level}` record. Unknown numeric ids are skipped.
 * Buildings AND research show up here on their respective pages
 * (supplies / facilities / research) — the caller decides which planet /
 * player-wide store the result merges into.
 */
export function extractTechLevels(doc: Document): Record<string, number> {
  const out: Record<string, number> = {};
  const items = doc.querySelectorAll<HTMLElement>("li.technology[data-technology], [data-technology]");
  for (const li of items) {
    const numericId = li.getAttribute("data-technology");
    if (!numericId) continue;
    const levelEl = li.querySelector<HTMLElement>(".level");
    if (!levelEl) continue;
    const dv = levelEl.getAttribute("data-value");
    const txt = levelEl.textContent?.trim();
    const raw = dv ?? txt ?? "";
    const lvl = Number.parseInt(raw, 10);
    if (!Number.isFinite(lvl)) continue;
    const stringId = OGAME_DATA_TECHNOLOGY_REVERSE[numericId];
    if (stringId) {
      out[stringId] = lvl;
      continue;
    }
    // v0.0.609 — operator 2026-06-01 "别猜了". LIFEFORM_RESEARCH_IDS now
    // imported from alaingilbert/ogame protocol library, so reverse-map
    // hits on all 72 entries. Drop the raw `id_<num>` fallback — unknown
    // IDs at this point are genuine unknowns (skip).
  }
  return out;
}
