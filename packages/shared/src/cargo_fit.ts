/**
 * v1.0.22 — owner 2026-06-11 "这个装载逻辑复用在所有需要装载的地方，比如自动FS".
 *
 * 真态 cargo 装载逻辑 single source of truth.
 *
 * 顶层逻辑: 当 requested.m + c + d > capacity 时, "装载空间不够，就能装多少装多少，
 * 不要空着" — 真 cap 100% 利用, 按 priority d → c → m 真 greedy fill.
 *
 * Priority 真态 (owner 2026-05-24 directive in case_decider.ts:76-78):
 *   1. 重氫 d (fleet fuel, attacker raid 优先弃)
 *   2. 晶體 c
 *   3. 金屬 m (overflow 时最后 trim — owner 2026-06-11 复盘: ogame 端真行为也是
 *      m 装最后, 真态 match)
 *
 * 不空着: requested ≥ capacity 时, 返回的 m+c+d 必 = capacity (100% 满载).
 * requested < capacity 时, 返回 = requested (船多空间也无所谓, 真 load 多少算多少).
 *
 * 复用点 (v1.0.22):
 *   - emergency/case_decider.ts (Auto FS, 已有 inline 实现 — refactor)
 *   - overlay/goals_panel.ts transport panel dispatch (新接入)
 *   - 未来任何 fleet POST cargo build path (api_executor / wire / etc)
 */

export interface FitCargoInput {
  /** Total ship cargo capacity (bytes). 真态 = ships × per_ship_cap. */
  capacity: number;
  /** Requested cargo m/c/d. May exceed capacity — caller 不必预 trim. */
  requested: { m: number; c: number; d: number };
  /**
   * Per-resource reserve to subtract from requested (e.g. moon 50K deut
   * reserve for jump-gate fuel). Default 0. Reserve applied BEFORE greedy
   * fill, so capacity is fully used among the (requested - reserve).
   */
  reserve?: { m?: number; c?: number; d?: number };
}

export interface FitCargoOutput {
  m: number;
  c: number;
  d: number;
}

/**
 * Greedy fit cargo into ship capacity per priority d → c → m.
 * 不空着 — 当 requested 超 cap 时, 真 fill capacity 100% (m 最后, 可能减或 0).
 * 当 requested 不足 cap 时, 真 fill requested (船 cap 富余无所谓, 不强 fill).
 *
 * @returns m, c, d ≥ 0 且 m + c + d ≤ capacity 且 ≤ (requested - reserve).
 */
export function fitCargoToCap(input: FitCargoInput): FitCargoOutput {
  const r = input.requested;
  const reserve = input.reserve ?? {};
  const effective = {
    m: Math.max(0, r.m - (reserve.m ?? 0)),
    c: Math.max(0, r.c - (reserve.c ?? 0)),
    d: Math.max(0, r.d - (reserve.d ?? 0)),
  };
  let remaining = Math.max(0, input.capacity);
  const dLoad = Math.min(effective.d, remaining); remaining -= dLoad;
  const cLoad = Math.min(effective.c, remaining); remaining -= cLoad;
  const mLoad = Math.min(effective.m, remaining); remaining -= mLoad;
  return { m: mLoad, c: cLoad, d: dLoad };
}
