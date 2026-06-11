/**
 * ogame v12 storage capacity formula — single source of truth.
 *
 * v1.0.18 P1 #5 — audit critical 真 root: planner.ts:99 修对了 (v1.0.18),
 * 真 growth_daemon.ts:69 + index.ts simulate path 仍用 `floor(5000 * 2.5^L)`
 * 真 4× 高估 (L8: 7.63M vs ogame 真 1.59M). 真 3 处 sync.
 *
 * Formula verified against ogame v12 in-game values:
 *   L0 →  10,000
 *   L4 → 140,000
 *   L7 → 865,000
 *   L8 → 1,590,000
 */
export function storageCapForLevel(level: number): number {
  if (level <= 0) return 10_000;
  return Math.floor(2.5 * Math.exp(20 * level / 33)) * 5000;
}
