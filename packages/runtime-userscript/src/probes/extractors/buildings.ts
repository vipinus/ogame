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
  // v0.0.621 — restrict to LI (was matching the inner upgrade button too;
  // the button has no .level child so it was silently skipped, but the
  // broad selector is brittle to ogame UI changes).
  const items = doc.querySelectorAll<HTMLElement>("li.technology[data-technology], li[data-technology]");
  for (const li of items) {
    if (li.tagName !== "LI") continue;
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
    // v0.0.609 — operator 2026-06-01 "別猜了". LIFEFORM_RESEARCH_IDS now
    // imported from alaingilbert/ogame protocol library, so reverse-map
    // hits on all 72 entries. Drop the raw `id_<num>` fallback — unknown
    // IDs at this point are genuine unknowns (skip).
  }
  return out;
}

/**
 * Extract localized tech labels from the current ogame page DOM.
 *
 * Operator 2026-06-01 directive: "不要兜底，網頁上有名字" — server-rendered
 * `title` / `aria-label` attributes carry the player's locale (zh / en /
 * etc.). Use those as the SOLE source of truth for display names. No
 * hardcoded catalog translations.
 *
 * Real DOM (s274-en kaelesh lfresearch page):
 *   `<li class="technology lifeformTech14201"
 *      data-technology="14201"
 *      aria-label="熱量回收"
 *      title="熱量回收">`
 *
 * Returns `{canonical: label}` map. Numeric IDs that don't resolve to a
 * canonical name are skipped (caller's store keys are all canonical).
 */
export function extractTechLabels(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  // v0.0.621 — operator 2026-06-01 "研究 1 級 熱量回收 L5 不應該出現".
  // The lfresearch DOM has BOTH <li data-technology="14201"
  // aria-label="熱量回收"> AND <button data-technology="14201"
  // aria-label="研究 1 級 熱量回收"> (= upgrade button's tooltip, not tech
  // name). Previous selector `[data-technology]` matched the button too
  // and overwrote the LI's clean label. Tighten to LI-only.
  const items = doc.querySelectorAll<HTMLElement>("li.technology[data-technology], li[data-technology]");
  for (const li of items) {
    if (li.tagName !== "LI") continue;
    const numericId = li.getAttribute("data-technology");
    if (!numericId) continue;
    const canonical = OGAME_DATA_TECHNOLOGY_REVERSE[numericId];
    if (!canonical) continue;
    // Prefer aria-label (a11y-stable), fall back to title. Strip ogame's
    // trailing whitespace/newlines. Skip if empty.
    const raw = (li.getAttribute("aria-label") ?? li.getAttribute("title") ?? "").trim();
    if (!raw) continue;
    out[canonical] = raw;
  }
  return out;
}
