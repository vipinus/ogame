// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Coords, ShipCount } from "@ogamex/shared";
import { parseExpeditionReport } from "../../../src/probes/extractors/expedition_report.js";

function loadFixture(name: string): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "packages/runtime-userscript/test/fixtures/expedition_reports",
      name
    ),
    "utf-8"
  );
}

const baseContext = {
  expedition_id: "exp-001",
  source_planet_id: "p-1",
  source_coords: [1, 100, 8] as Coords,
  template_id: "tpl-light-explorer",
  fleet_sent: { lightFighter: 100, smallCargo: 20 } as ShipCount,
  launched_at: 1_700_000_000_000,
};

describe("parseExpeditionReport", () => {
  it("parses a resources_medium report into outcome_type + resources_gained", () => {
    const html = loadFixture("report_resources_medium.html");
    const outcome = parseExpeditionReport(html, baseContext);
    expect(outcome.outcome_type).toBe("resources_medium");
    expect(outcome.resources_gained).toEqual({
      m: 12345,
      c: 6789,
      d: 234,
      e: 0,
    });
    // Carry context through unchanged.
    expect(outcome.expedition_id).toBe("exp-001");
    expect(outcome.source_planet_id).toBe("p-1");
    expect(outcome.source_coords).toEqual([1, 100, 8]);
    expect(outcome.template_id).toBe("tpl-light-explorer");
    expect(outcome.fleet_sent).toEqual(baseContext.fleet_sent);
    expect(outcome.launched_at).toBe(1_700_000_000_000);
    // No ship gains/losses for pure resource pickup.
    expect(outcome.ships_gained).toEqual({});
    expect(outcome.ships_lost).toEqual({});
  });

  it("parses a black_hole report: outcome_type === black_hole + entire fleet lost", () => {
    const html = loadFixture("report_black_hole.html");
    const outcome = parseExpeditionReport(html, baseContext);
    expect(outcome.outcome_type).toBe("black_hole");
    // Design choice: on black_hole we mirror fleet_sent into ships_lost,
    // because the entire dispatched fleet is destroyed. Resources zero.
    expect(outcome.ships_lost).toEqual(baseContext.fleet_sent);
    expect(outcome.ships_gained).toEqual({});
    expect(outcome.resources_gained).toEqual({ m: 0, c: 0, d: 0, e: 0 });
  });

  it("parses a nothing report: outcome_type === nothing + zero resources/ships", () => {
    const html = loadFixture("report_nothing.html");
    const outcome = parseExpeditionReport(html, baseContext);
    expect(outcome.outcome_type).toBe("nothing");
    expect(outcome.resources_gained).toEqual({ m: 0, c: 0, d: 0, e: 0 });
    expect(outcome.ships_gained).toEqual({});
    expect(outcome.ships_lost).toEqual({});
  });

  it("parses a ships_gained_small report: outcome_type + ships_gained map", () => {
    const html = loadFixture("report_ships_gained_small.html");
    const outcome = parseExpeditionReport(html, baseContext);
    expect(outcome.outcome_type).toBe("ships_gained_small");
    expect(outcome.ships_gained).toEqual({
      lightFighter: 12,
      smallCargo: 3,
    });
    expect(outcome.ships_lost).toEqual({});
    expect(outcome.resources_gained).toEqual({ m: 0, c: 0, d: 0, e: 0 });
  });

  describe("unknown variant fallback", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("falls back to 'nothing' and logs a console.warn for unknown report HTML", () => {
      const html = `<div class="msg expedition_report"><p>未知變體：海盜抓住了我們</p></div>`;
      const outcome = parseExpeditionReport(html, baseContext);
      expect(outcome.outcome_type).toBe("nothing");
      expect(outcome.resources_gained).toEqual({ m: 0, c: 0, d: 0, e: 0 });
      expect(outcome.ships_gained).toEqual({});
      expect(outcome.ships_lost).toEqual({});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/expedition/i);
    });
  });

  it("accepts an HTMLElement input (not just a string)", () => {
    const html = loadFixture("report_nothing.html");
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const el = tmp.querySelector<HTMLElement>(".msg.expedition_report");
    expect(el).not.toBeNull();
    const outcome = parseExpeditionReport(el!, baseContext);
    expect(outcome.outcome_type).toBe("nothing");
  });

  it("always sets returned_at >= launched_at and duration_actual_seconds >= 0", () => {
    const html = loadFixture("report_nothing.html");
    const outcome = parseExpeditionReport(html, baseContext);
    expect(outcome.returned_at).toBeGreaterThanOrEqual(outcome.launched_at);
    expect(outcome.duration_actual_seconds).toBeGreaterThanOrEqual(0);
  });

  it("populates LifeForm extras as empty defaults (no LifeForm signals in M3.5)", () => {
    const html = loadFixture("report_nothing.html");
    const outcome = parseExpeditionReport(html, baseContext);
    expect(outcome.artifacts_gained).toEqual({});
    expect(outcome.lifeform_xp_gained).toBeNull();
  });
});
