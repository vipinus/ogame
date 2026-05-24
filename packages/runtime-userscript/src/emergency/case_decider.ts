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

  const recyclerCount = source.ships.recycler ?? 0;
  if (totalShips(source.ships) === 0) {
    throw new Error(`no ships available at ${source.name}`);
  }
  if (recyclerCount === 0) {
    throw new Error(`no recycler at ${source.name} (recycler required for all emergency saves; caller should degrade)`);
  }

  const ships: ShipCount = { ...source.ships };

  // Operator 2026-05-24: ogame rejected sendFleet with 140028 "倉存容量不足!"
  // when we passed full planet resources as cargo. Cargo capacity scales
  // with hyperspace tech, class, lifeform bonuses — the only authoritative
  // source is ogame's own `shipsData[id].cargoCapacity`. We cache that on
  // every expedition's checkTarget step in store.server.ship_cargo_capacity.
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
  // Cap cargo at capacity, priority: deuterium (fuel headroom), then metal, then crystal.
  // Allocate proportionally if total > capacity.
  // Operator 2026-05-24: "月球保留50K重氢" — when FS source is a moon,
  // leave 50_000 deut on the moon (jump gate fuel reserve). Applies
  // before capacity-cap so the proportional scale doesn't accidentally
  // try to load the reserved amount.
  const MOON_DEUT_RESERVE = 50_000;
  const dReserve = source.type === "moon" ? MOON_DEUT_RESERVE : 0;
  const requested = {
    m: source.resources.m,
    c: source.resources.c,
    d: Math.max(0, source.resources.d - dReserve),
  };
  const want = requested.m + requested.c + requested.d;
  let cargo: { m: number; c: number; d: number };
  if (want <= capacity) {
    cargo = requested;
  } else if (capacity <= 0) {
    cargo = { m: 0, c: 0, d: 0 };
  } else {
    // Proportional scale-down, then floor to integers (ogame rejects floats).
    const ratio = capacity / want;
    cargo = {
      m: Math.floor(requested.m * ratio),
      c: Math.floor(requested.c * ratio),
      d: Math.floor(requested.d * ratio),
    };
  }

  // Operator 2026-05-24 strategy update:
  //   1. 从星球FS → 同坐标月球 @ 10% (transport)   ← Case B
  //   2. 从月球FS → 同坐标星球 @ 10% (transport)   ← Case A
  //   3. 没有月球    → 同坐标 debris @ 10% (recycle) ← Case C
  // All cases share the same 10% phalanx-avoidance flight pattern: short
  // path (same-coord), long flight time, recall before arrival.

  // Case A: source IS a moon → transport to same-coord planet @ 10%
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
        mission: Mission.TRANSPORT,
        speed: 1,
        ships,
        cargo,
        reason: `Case A: fleet on moon ${source.name} → transport to same-coord planet ${sameCoordPlanet.name} @ 10% speed`,
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
      mission: Mission.TRANSPORT,
      speed: 1,
      ships,
      cargo,
      reason: `Case B: planet ${source.name} has same-coord moon → transport to moon @ 10% speed`,
    };
  }

  // Case C: planet, no co-located moon → same-coord debris recycle @ 10%.
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
