/**
 * Userscript runtime locale detection — anchored to ogame's own
 * 24-locale set (matches ogame-next's `OGAME_LOCALES`).
 *
 * Detection priority:
 *   1. ogame page `<html lang>` attribute — the ground truth, set by
 *      gameforge per user's account language preference. Examples:
 *        s274-en running with TW account UI → `<html lang="zh">`
 *        s274-en running with EN account UI → `<html lang="en">`
 *      The 2-letter prefix maps onto ogame's slug set.
 *   2. Hostname server slug — falls back when `<html lang>` is absent
 *      (lobby pages, settings page, etc).
 *   3. Hard fallback `"en"` — never throw on missing data.
 *
 * Operator directive 2026-06-02: userscript UI language follows ogame's
 * own UI language. Hostname slug alone isn't sufficient: a user playing
 * on s274-en with account language set to Traditional Chinese sees ogame
 * in 繁體 — the panel should match.
 */

const OGAME_LOCALES = new Set([
  "ar", "br", "cz", "de", "dk", "en", "es", "fr", "gr", "hr",
  "hu", "it", "jp", "mx", "nl", "pl", "pt", "ro", "ru", "si",
  "sk", "tr", "tw", "us",
]);

/** Map browser `<html lang>` value to an ogame locale slug. */
function htmlLangToOgame(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  // Chinese: ogame ships ONLY Traditional Chinese (`tw`) — there's no
  // Simplified Chinese ogame server. So ANY `zh*` (zh, zh-CN, zh-Hans,
  // zh-TW, zh-Hant, …) maps to `tw`. A mainland user with `zh-CN`
  // browser setting will see Traditional, which is closer to their
  // expectation than English. Operator 2026-06-02 confirmed: gameforge
  // sets `<html lang="zh">` for accounts whose UI language is set to
  // 繁體 — bare "zh" without a TW/Hant suffix.
  if (lower.startsWith("zh")) return "tw";
  // Japanese: standard ISO `ja` → ogame slug `jp`.
  if (lower.startsWith("ja")) return "jp";
  // Korean: ISO `ko` → ogame doesn't ship a Korean server today; fall
  // through (no slug match → caller uses default).
  // Danish: ISO `da` → ogame slug `dk`.
  if (lower.startsWith("da")) return "dk";
  // Slovenian: ISO `sl` → ogame slug `si`.
  if (lower.startsWith("sl")) return "si";
  // General 2-letter prefix match against ogame's slug set.
  const prefix = lower.slice(0, 2);
  return OGAME_LOCALES.has(prefix) ? prefix : null;
}

/** Extract ogame locale from a `sNNN-XX.ogame.gameforge.com` hostname. */
function hostnameToOgame(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  const first = hostname.split(".")[0] ?? "";
  const m = first.match(/^s\d+-([a-z]{2,3})$/i);
  if (!m) return null;
  const slug = m[1]!.toLowerCase();
  return OGAME_LOCALES.has(slug) ? slug : null;
}

/**
 * Resolve current ogame UI locale at panel-render time. Reads
 * synchronously from `document`/`window`; cheap enough to call every
 * render without caching.
 *
 * `documentForTest` / `windowForTest` are TM-sandbox escape hatches —
 * the panel runs inside `env.doc` / `env.win` which may not equal the
 * page-world globals when iframes are involved.
 */
export function getOgameLocale(
  documentForTest?: Document | null,
  windowForTest?: Window | null,
): string {
  const doc = documentForTest ?? (typeof document !== "undefined" ? document : null);
  const win = windowForTest ?? (typeof window !== "undefined" ? window : null);
  const fromHtml = htmlLangToOgame(doc?.documentElement?.lang);
  if (fromHtml) return fromHtml;
  const fromHost = hostnameToOgame(win?.location?.hostname);
  if (fromHost) return fromHost;
  return "en";
}

/** Programmatic override (operator: `localStorage.OGAMEX_LOCALE = "tw"`). */
export function getOgameLocaleWithOverride(
  documentForTest?: Document | null,
  windowForTest?: Window | null,
): string {
  const win = windowForTest ?? (typeof window !== "undefined" ? window : null);
  try {
    const override = win?.localStorage?.getItem("OGAMEX_LOCALE");
    if (override && OGAME_LOCALES.has(override)) return override;
  } catch { /* localStorage unavailable */ }
  return getOgameLocale(documentForTest, windowForTest);
}
