/**
 * Section-settings allowed-keys + Zod shape — single source of truth.
 *
 * v1.0.18 P2 #25 — audit critical (medium): Next route ALLOWED_KEYS 5 keys vs
 * sidecar ALLOWED set 10 keys 真 mismatch → 网页勾选 auto_build_mine 真
 * 400 no_allowed_keys (half-feature). Shared schema 真 拉通 Next + sidecar.
 *
 * Two key types:
 *   - flag keys: "true" / "false" strings (legacy boolean toggle)
 *   - alarm keys: "on" / "off" strings (legacy alarm toggle)
 *   - jsonb keys: object/array values (expedition_config / expedition_state)
 *   - bool jsonb keys: boolean (growth_daemon_disabled)
 *
 * Adding a new key? Add it here ONCE. Next route + sidecar ALLOWED import this.
 */

export const SECTION_SETTING_KEYS = [
  // flag toggles (string "true" / "false")
  "ogamex.emergency.paused",
  "ogamex.expedition.paused",
  "ogamex.global.paused",
  "ogamex.auto_build_mine",
  "ogamex.auto_build_storage",
  // alarm toggles (string "on" / "off")
  "OGAMEX_SPY_TRIGGERS_SAVE",
  "OGAMEX_EMERGENCY_SOUND_ALARM",
  // jsonb-valued (object/array)
  "ogamex.expedition_config",
  "ogamex.expedition_state",
  // bool jsonb-valued
  "ogamex.growth_daemon_disabled",
] as const;

export type SectionSettingKey = typeof SECTION_SETTING_KEYS[number];

export const SECTION_SETTING_KEY_SET: ReadonlySet<string> = new Set(SECTION_SETTING_KEYS);

/**
 * Validate value shape per key. Returns true if shape is allowed.
 * Reject function/symbol values; jsonb keys accept object|array; flag keys
 * accept string|boolean; bool jsonb accepts boolean only.
 */
export function isValidSectionSettingValue(key: string, value: unknown): boolean {
  if (!SECTION_SETTING_KEY_SET.has(key)) return false;
  const t = typeof value;
  if (t === "function" || t === "symbol") return false;
  if (key === "ogamex.expedition_config" || key === "ogamex.expedition_state") {
    return t === "object" && value !== null;
  }
  if (key === "ogamex.growth_daemon_disabled") {
    return t === "boolean" || (t === "string" && (value === "true" || value === "false"));
  }
  // flag + alarm: string|boolean
  return t === "string" || t === "boolean";
}

/** Filter a patch dict to only allowed keys + valid value shapes. */
export function filterSectionSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (isValidSectionSettingValue(k, v)) out[k] = v;
  }
  return out;
}
