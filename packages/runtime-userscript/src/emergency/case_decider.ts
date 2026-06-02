import { Mission } from "@ogamex/shared";
import type { WorldState, Coords, ShipCount, MissionCode } from "@ogamex/shared";

export type CaseLetter = "A" | "B" | "C";

export interface CaseDecision {
  case: CaseLetter;
  sourcePlanetId: string;
  destCoords: Coords;
  destType: 1 | 2 | 3;       // 1=planet, 2=debris, 3=moon
  mission: MissionCode;
  speed: number;             // 1..10 (1=10%, 10=100%)
  ships: ShipCount;
  cargo: { m: number; c: number; d: number };
  reason: string;
}

function sameCoords(a: Coords, b: Coords): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function totalShips(ships: ShipCount): number {
  let n = 0;
  for (const v of Object.values(ships)) n += v ?? 0;
  return n;
}

/**
 * Given a hostile attack inbound to `sourcePlanetId`, decide which save case applies
 * and produce the SendFleet parameters.
 *
 * Always uses the source's full ship roster and full m/c/d resources.
 * Always requires at least 1 recycler — throws otherwise (caller handles degradation).
 */
export function decideCase(state: WorldState, sourcePlanetId: string): CaseDecision {
  const source = Object.values(state.planets ?? {}).find(p => p.id === sourcePlanetId);
  if (!source) {
    throw new Error(`source planet ${sourcePlanetId} not found in state.planets`);
  }

  if (totalShips(source.ships) === 0) {
    throw new Error(`no ships available at ${source.name}`);
  }
  // recycler check moved into Case C branch — operator 2026-05-24:
  // "沒有 recycler 的時候是 FS 星球或者月球嗎?" Yes — Case A (moon→planet)
  // and Case B (planet→moon) are TRANSPORT missions, no recycler needed.
  // Only Case C (recycle to local debris) actually requires recycler ≥ 1.

  const ships: ShipCount = { ...source.ships };

  // Operator 2026-05-24: ogame rejected sendFleet with 140028 "倉存容量不足!"
  // when we passed full planet resources as cargo. Cargo capacity scales
  // with hyperspace tech, class, lifeform bonuses — the only authoritative
  // source is ogame's own `shipsData[id].cargoCapacity`. We cache that on
  // every expedition's checkTarget step in store.server.ship_cargo_capacity.
  // (DEST-side 140028 — when cargo ≤ fleet capacity but > dest storage cap —
  // is handled in fleet_api.ts sendFleet's reverse-priority peel retry,
  // v0.0.397. Two-layer defense: source-side here, dest-side there.)
  //
  // CARGO_BASE is the cold-boot fallback (server.ship_cargo_capacity empty
  // before first expedition harvest). Safe lower bound — under-loads but
  // never over-loads. Operator: "定期用api拉最新容量".
  const CARGO_BASE: Record<string, number> = {
    smallCargo: 5000, largeCargo: 25000, recycler: 20000, explorer: 10000,
    colonyShip: 7500, reaper: 7000, destroyer: 2000, battleship: 1500,
    deathstar: 1_000_000, cruiser: 800, battlecruiser: 750, bomber: 500,
    heavyFighter: 100, lightFighter: 50, espionageProbe: 5,
  };
  const srv = (state.server ?? {}) as { ship_cargo_capacity?: Record<string, number> };
  const cargoMap = srv.ship_cargo_capacity ?? {};
  let capacity = 0;
  for (const [k, n] of Object.entries(ships)) {
    const perShip = cargoMap[k] ?? CARGO_BASE[k] ?? 0;
    capacity += perShip * (n ?? 0);
  }
  // Operator 2026-05-24 priority: 重氫 → 晶體 → 金屬. When cargo doesn't
  // fit everything, fill deuterium first (also the fleet fuel — keep it
  // off the planet for the attacker), then crystal, finally metal.
  // Moon source reserves 50K deut on the moon for jump-gate fuel before
  // the priority fill.
  const MOON_DEUT_RESERVE = 50_000;
  const dReserve = source.type === "moon" ? MOON_DEUT_RESERVE : 0;
  const requested = {
    m: source.resources.m,
    c: source.resources.c,
    d: Math.max(0, source.resources.d - dReserve),
  };
  // Greedy fill in priority order. Each resource gets min(requested, remaining).
  let remaining = Math.max(0, capacity);
  const dLoad = Math.min(requested.d, remaining); remaining -= dLoad;
  const cLoad = Math.min(requested.c, remaining); remaining -= cLoad;
  const mLoad = Math.min(requested.m, remaining); remaining -= mLoad;
  const cargo = { m: mLoad, c: cLoad, d: dLoad };

  // Operator 2026-05-24 strategy update:
  //   1. 從星球FS → 同坐標月球 @ 10% (transport)   ← Case B
  //   2. 從月球FS → 同坐標星球 @ 10% (transport)   ← Case A
  //   3. 沒有月球    → 同坐標 debris @ 10% (recycle) ← Case C
  // All cases share the same 10% phalanx-avoidance flight pattern: short
  // path (same-coord), long flight time, recall before arrival.

  // Case A: source IS a moon → deploy to same-coord planet @ 10%
  // Operator 2026-05-25: "FS 用部署替換運輸". mission=4 DEPLOY ≠ mission=3
  // TRANSPORT. DEPLOY permanently relocates the fleet to own planet/moon;
  // TRANSPORT has different recall/holding semantics. For FS purposes the
  // fleet is a long-term move, not a courier round-trip.
  if (source.type === "moon") {
    const sameCoordPlanet = Object.values(state.planets ?? {}).find(
      p => p.type === "planet" && sameCoords(p.coords, source.coords),
    );
    if (sameCoordPlanet) {
      return {
        case: "A",
        sourcePlanetId: source.id,
        destCoords: sameCoordPlanet.coords,
        destType: 1,
        mission: Mission.DEPLOY,
        speed: 1,
        ships,
        cargo,
        reason: `Case A: fleet on moon ${source.name} → DEPLOY to same-coord planet ${sameCoordPlanet.name} @ 10% speed`,
      };
    }
    // Edge: moon with no co-located planet (impossible in stock ogame
    // but defensive). Fall through to Case C local-debris recycle.
  }

  // source.type === "planet" — check for same-coord moon
  const sameCoordMoon = Object.values(state.planets ?? {}).find(
    p => p.type === "moon" && sameCoords(p.coords, source.coords),
  );

  if (sameCoordMoon) {
    return {
      case: "B",
      sourcePlanetId: source.id,
      destCoords: sameCoordMoon.coords,
      destType: 3,
      mission: Mission.DEPLOY,
      speed: 1,
      ships,
      cargo,
      reason: `Case B: planet ${source.name} has same-coord moon → DEPLOY to moon @ 10% speed`,
    };
  }

  // Case C: planet, no co-located moon → same-coord debris recycle @ 10%.
  // RECYCLE mission strictly needs a recycler. Without one, save is
  // impossible from this planet — caller must downgrade (fsm catches
  // and silent-skips per save_state_machine pattern detection).
  const recyclerCount = source.ships.recycler ?? 0;
  if (recyclerCount === 0) {
    throw new Error(`no recycler at ${source.name} for Case C recycle mission — caller should skip`);
  }
  return {
    case: "C",
    sourcePlanetId: source.id,
    destCoords: source.coords,
    destType: 2,
    mission: Mission.RECYCLE,
    speed: 1,
    ships,
    cargo,
    reason: `Case C: planet ${source.name} (no moon) → recycle to local debris @ 10% speed`,
  };
}
