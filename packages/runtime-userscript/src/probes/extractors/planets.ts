import type { Coords, CelestialType } from "@ogamex/shared";

export interface PlanetIdentity {
  id: string;
  name: string;
  coords: Coords;
  type: CelestialType;
}

function parseCoords(text: string): Coords | null {
  const m = text.match(/\[(\d+):(\d+):(\d+)\]/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] as Coords;
}

export function extractPlanets(doc: Document): PlanetIdentity[] {
  const root = doc.getElementById("planetList");
  if (!root) return [];
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(".smallplanet, .moonlink")
  );
  const out: PlanetIdentity[] = [];
  for (const li of items) {
    const isMoon = li.classList.contains("moonlink");
    const idRaw = isMoon
      ? (li.getAttribute("data-planet-id") || li.id?.replace(/^planet-/, "").replace(/-moon$/, ""))
      : (li.id?.replace(/^planet-/, "") || li.getAttribute("data-planet-id"));
    const name = li.querySelector(".planet-name")?.textContent?.trim();
    const coordsText = li.querySelector(".planet-koords")?.textContent ?? "";
    const coords = parseCoords(coordsText);
    if (!idRaw || !name || !coords) continue;
    out.push({ id: idRaw, name, coords, type: isMoon ? "moon" : "planet" });
  }
  return out;
}
