import type { IncomingEvent, Coords } from "@ogamex/shared";

const MISSION_TYPE_MAP: Record<string, IncomingEvent["type"]> = {
  "1": "attack",
  "2": "attack",   // ACS attack
  "3": "transport",
  "4": "deploy",
  "5": "transport",
  "6": "spy",
  "7": "transport",   // colonize (treated as transport from defender's perspective)
  "8": "transport",   // recycle
  "15": "return",     // expedition events appearing in list are returns
};

function parseCoords(s: string): Coords | null {
  const m = s.match(/\[(\d+):(\d+):(\d+)\]/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] as Coords;
}

export function extractIncomingEvents(doc: Document): IncomingEvent[] {
  const rows = Array.from(
    doc.querySelectorAll<HTMLElement>("#eventContent tr.eventFleet")
  );
  const out: IncomingEvent[] = [];
  for (const row of rows) {
    const id = row.getAttribute("data-event-id");
    const mtype = row.getAttribute("data-mission-type");
    const tsAttr = row.getAttribute("data-arrival-time");
    if (!id || !mtype || !tsAttr) continue;
    const ts = parseInt(tsAttr, 10);
    if (!ts) continue;

    const from = parseCoords(row.getAttribute("data-coords-origin") ?? "");
    const to = parseCoords(row.getAttribute("data-coords-dest") ?? "");
    if (!from || !to) continue;

    const hostile = row.classList.contains("hostile");
    const shipsText = row.querySelector(".ships")?.textContent?.trim() ?? "?";
    const shipsNum = shipsText === "?" ? null : parseInt(shipsText.replace(/\D/g, ""), 10);
    const ships_count: number | "?" =
      shipsNum !== null && !Number.isNaN(shipsNum) ? shipsNum : "?";

    out.push({
      id,
      type: MISSION_TYPE_MAP[mtype] ?? "unknown",
      hostile,
      from, to,
      arrives_at: ts,
      ships_count,
    });
  }
  return out;
}
