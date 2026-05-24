/**
 * ShipCargoCache — harvest authoritative ship cargo capacity (post-bonuses)
 * from ogame responses and stash in store.server.ship_cargo_capacity.
 *
 * Operator 2026-05-24: "现在有各种科技和LF的加成要定期用api拉最新容量".
 * Hyperspace tech (+5% per level), discoverer/collector class bonus,
 * lifeform tech multipliers — all apply to cargo. Hardcoded CARGO_BASE
 * is a safe lower bound but loads suboptimally. Real `cargoCapacity`
 * is returned in every fleetdispatch checkTarget response under
 * `shipsData[<numericId>]`. We harvest it opportunistically.
 *
 * Source endpoint: `/game/index.php?...component=fleetdispatch&action=checkTarget`.
 * Response includes:
 *   { shipsData: { "204": { id, name, cargoCapacity, baseCargoCapacity, ... } } }
 * The `cargoCapacity` field already includes ALL bonuses (researched
 * hyperspace tech + class + lifeform). `baseCargoCapacity` is the
 * pre-bonus value — only use as fallback.
 */

import { SHIP_IDS_BY_NAME } from "@ogamex/shared";

const SHIP_NAME_BY_ID: Record<number, string> = Object.fromEntries(
  Object.entries(SHIP_IDS_BY_NAME).map(([name, id]) => [id, name]),
);

interface ShipDataEntry {
  id?: number;
  name?: string;
  cargoCapacity?: number;
  baseCargoCapacity?: number;
}

/**
 * Parse a checkTarget response's `shipsData` block and write the per-ship
 * cargo capacity map into store.server.ship_cargo_capacity. Idempotent
 * — overwrites cache with each successful harvest.
 *
 * `win` arg is the (sandboxed) userscript window; we access __ogamexStore
 * exposed there in boot.ts.
 */
export function cacheShipsData(shipsData: unknown, win: Window): void {
  if (!shipsData || typeof shipsData !== "object") return;
  const byName: Record<string, number> = {};
  for (const [idStr, info] of Object.entries(shipsData as Record<string, ShipDataEntry>)) {
    const id = parseInt(idStr, 10);
    if (Number.isNaN(id)) continue;
    const name = SHIP_NAME_BY_ID[id];
    if (!name) continue;
    const cap = info.cargoCapacity ?? info.baseCargoCapacity ?? 0;
    if (cap > 0) byName[name] = cap;
  }
  if (Object.keys(byName).length === 0) return;
  type StoreLike = {
    state: { server?: Record<string, unknown> };
    setPartial: (patch: { server: Record<string, unknown> }) => void;
  };
  const store = (win as Window & { __ogamexStore?: StoreLike }).__ogamexStore;
  if (!store) return;
  const cur = store.state.server ?? {};
  store.setPartial({ server: { ...cur, ship_cargo_capacity: byName } });
  console.log(`[ship_cargo_cache] updated ${Object.keys(byName).length} ships: ${Object.entries(byName).map(([n, c]) => `${n}=${c}`).join(", ")}`);
}
