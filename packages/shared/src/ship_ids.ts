// ogame v12 renamed `pathfinder` → `explorer`. Both keys map to id 219;
// case_decider + store extractor use `explorer`, legacy code may use
// `pathfinder`. fleet_api buildBody iterates p.ships which can carry
// either key.
export const SHIP_IDS = {
  smallCargo: 202,
  largeCargo: 203,
  lightFighter: 204,
  heavyFighter: 205,
  cruiser: 206,
  battleship: 207,
  colonyShip: 208,
  recycler: 209,
  espionageProbe: 210,
  bomber: 211,
  solarSatellite: 212,
  destroyer: 213,
  deathstar: 214,
  battlecruiser: 215,
  crawler: 217,
  reaper: 218,
  pathfinder: 219,
  explorer: 219,
} as const;

export type ShipKey = keyof typeof SHIP_IDS;
export type ShipCount = Partial<Record<ShipKey, number>>;
