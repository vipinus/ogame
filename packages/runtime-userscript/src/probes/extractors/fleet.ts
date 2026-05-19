import type { FleetMovement, Coords, CelestialType, ShipCount, ShipKey } from "@ogamex/shared";

function parseCoords(s: string): Coords | null {
  const m = s.match(/\[(\d+):(\d+):(\d+)\]/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] as Coords;
}

function parseIntStrict(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s.replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function readDestType(s: string | null): 1 | 2 | 3 | null {
  if (s === "1") return 1;
  if (s === "2") return 2;
  if (s === "3") return 3;
  return null;
}

function readOriginType(s: string | null): CelestialType {
  return s === "moon" ? "moon" : "planet";
}

export function extractFleetMovements(doc: Document): FleetMovement[] {
  const root = doc.getElementById("movement");
  if (!root) return [];
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".fleetDetails"));
  const out: FleetMovement[] = [];
  for (const b of blocks) {
    const id = b.getAttribute("data-fleet-id");
    const missionStr = b.getAttribute("data-mission-type");
    const arrivalStr = b.getAttribute("data-arrival-time");
    if (!id || !missionStr || !arrivalStr) continue;
    const arrival_at = parseInt(arrivalStr, 10);
    if (!arrival_at) continue;
    const mission = parseInt(missionStr, 10);
    if (!Number.isFinite(mission)) continue;

    const origin = parseCoords(b.getAttribute("data-coords-origin") ?? "");
    const dest = parseCoords(b.getAttribute("data-coords-dest") ?? "");
    const destType = readDestType(b.getAttribute("data-dest-type"));
    if (!origin || !dest || destType === null) continue;

    const origin_type = readOriginType(b.getAttribute("data-origin-type"));
    const returnAttr = b.getAttribute("data-return-time");
    const return_at = returnAttr ? parseInt(returnAttr, 10) || null : null;

    const ships: ShipCount = {};
    for (const sc of b.querySelectorAll<HTMLElement>(".ship-count")) {
      const ship = sc.getAttribute("data-ship") as ShipKey | null;
      const count = parseIntStrict(sc.textContent);
      if (ship && count !== null && count > 0) {
        ships[ship] = count;
      }
    }

    const m = parseIntStrict(b.querySelector(".cargo-metal")?.textContent) ?? 0;
    const c = parseIntStrict(b.querySelector(".cargo-crystal")?.textContent) ?? 0;
    const d = parseIntStrict(b.querySelector(".cargo-deuterium")?.textContent) ?? 0;

    out.push({
      id,
      mission,
      origin,
      origin_type,
      dest,
      dest_type: destType,
      arrival_at,
      return_at,
      ships,
      cargo: { m, c, d },
    });
  }
  return out;
}
