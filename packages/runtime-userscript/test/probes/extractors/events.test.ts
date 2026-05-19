// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { extractIncomingEvents } from "../../../src/probes/extractors/events.js";

const fixture = readFileSync(
  resolve(
    process.cwd(),
    "packages/runtime-userscript/test/fixtures/ogame_html/events.html"
  ),
  "utf8"
);
const dom = new JSDOM(fixture);

describe("extractIncomingEvents", () => {
  it("extracts 3 events from fixture", () => {
    const evs = extractIncomingEvents(dom.window.document);
    expect(evs).toHaveLength(3);
  });

  it("flags hostile attack event", () => {
    const evs = extractIncomingEvents(dom.window.document);
    expect(evs[0]).toMatchObject({
      id: "3142",
      type: "attack",
      hostile: true,
      from: [3, 42, 7],
      to: [1, 42, 8],
      arrives_at: 1716200000,
      ships_count: "?",
    });
  });

  it("identifies expedition return as type=return, not hostile", () => {
    const evs = extractIncomingEvents(dom.window.document);
    expect(evs[1]).toMatchObject({
      id: "3143", type: "return", hostile: false, ships_count: 50,
    });
  });

  it("identifies transport as type=transport, not hostile", () => {
    const evs = extractIncomingEvents(dom.window.document);
    expect(evs[2]).toMatchObject({
      id: "3144", type: "transport", hostile: false, ships_count: 200,
    });
  });

  it("returns empty array when #eventContent missing", () => {
    const local = new JSDOM(`<html></html>`);
    expect(extractIncomingEvents(local.window.document)).toEqual([]);
  });

  it("skips rows with missing required attributes", () => {
    const local = new JSDOM(`
      <table id="eventContent">
        <tr class="eventFleet" data-mission-type="1"></tr>
        <tr class="eventFleet hostile" data-event-id="ok" data-mission-type="1" data-arrival-time="123" data-coords-origin="[1:1:1]" data-coords-dest="[2:2:2]">
          <td class="ships">10</td>
        </tr>
      </table>`);
    const evs = extractIncomingEvents(local.window.document);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.id).toBe("ok");
  });

  it("uses '?' ships_count when ships text is not numeric", () => {
    const local = new JSDOM(`
      <table id="eventContent">
        <tr class="eventFleet hostile" data-event-id="x" data-mission-type="1" data-arrival-time="100" data-coords-origin="[1:1:1]" data-coords-dest="[2:2:2]">
          <td class="ships">?</td>
        </tr>
      </table>`);
    const evs = extractIncomingEvents(local.window.document);
    expect(evs[0]!.ships_count).toBe("?");
  });
});
