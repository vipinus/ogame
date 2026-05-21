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
  const cargo = {
    m: source.resources.m,
    c: source.resources.c,
    d: source.resources.d,
  };

  // Case A: source IS a moon → recycle to local debris @ 10%
  if (source.type === "moon") {
    return {
      case: "A",
      sourcePlanetId: source.id,
      destCoords: source.coords,
      destType: 2,
      mission: Mission.RECYCLE,
      speed: 1,
      ships,
      cargo,
      reason: `Case A: fleet on moon ${source.name} → recycle to local debris @ 10% speed`,
    };
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
      speed: 10,
      ships,
      cargo,
      reason: `Case B: planet ${source.name} has same-coord moon → transport to moon @ 100% speed`,
    };
  }

  // Case C: planet, no co-located moon
  return {
    case: "C",
    sourcePlanetId: source.id,
    destCoords: source.coords,
    destType: 2,
    mission: Mission.RECYCLE,
    speed: 1,
    ships,
    cargo,
    reason: `Case C: planet ${source.name} (no moon) → recycle to local debris @ 10% speed (2026 allows empty-debris recycle)`,
  };
}
