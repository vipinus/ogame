/**
 * `t(key, params?)` — userscript panel translation helper.
 *
 * Lookup precedence:
 *   1. STRINGS[currentLocale][key]   — if present, use it
 *   2. STRINGS["en"][key]            — English fallback
 *   3. key itself                    — last resort (UI never blanks)
 *
 * The current locale is resolved by `getOgameLocaleWithOverride()` —
 * we DON'T cache it across calls. Render path is cheap (one map lookup
 * + a getattr on document.documentElement.lang), and not caching means
 * the panel auto-updates when the user changes ogame's language in
 * settings WITHOUT a page reload.
 *
 * `params` does simple `{name}` placeholder substitution. No plural /
 * ICU formatting — userscript panel doesn't need it today.
 */

import { STRINGS } from "./strings.js";
import { getOgameLocaleWithOverride } from "./locale.js";

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const v = params[name];
    return v === undefined ? match : String(v);
  });
}

/** Translate `key` using the current ogame locale. Falls back to en, then key. */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = getOgameLocaleWithOverride();
  const tableForLocale = STRINGS[locale];
  const fromLocale = tableForLocale?.[key];
  if (fromLocale !== undefined) return interpolate(fromLocale, params);
  const fromEn = STRINGS.en?.[key];
  if (fromEn !== undefined) return interpolate(fromEn, params);
  return key;
}

/** Like `t()` but accepts an explicit locale — for places where the
 *  detected locale needs an override (e.g. test harnesses). */
export function tForLocale(
  locale: string,
  key: string,
  params?: Record<string, string | number>,
): string {
  const fromLocale = STRINGS[locale]?.[key];
  if (fromLocale !== undefined) return interpolate(fromLocale, params);
  const fromEn = STRINGS.en?.[key];
  if (fromEn !== undefined) return interpolate(fromEn, params);
  return key;
}
