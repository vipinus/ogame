import { describe, it, expect } from "vitest";
import type { FleetTemplate } from "@ogamex/shared";
import {
  evalUsedWhen,
  pickTemplate,
  type TemplatePickStats,
} from "../../../src/daily/expedition/template_picker.js";

function makeStats(overrides: Partial<TemplatePickStats> = {}): TemplatePickStats {
  return {
    black_hole_rate_24h: 0,
    loss_rate_24h: 0,
    avg_yield_24h: 0,
    ...overrides,
  };
}

function makeTemplate(used_when: string): FleetTemplate {
  return { fleet: {}, used_when };
}

describe("evalUsedWhen", () => {
  it("'default' evaluates true regardless of stats", () => {
    expect(evalUsedWhen("default", makeStats())).toBe(true);
    expect(
      evalUsedWhen(
        "default",
        makeStats({ black_hole_rate_24h: 0.9, loss_rate_24h: 0.9 }),
      ),
    ).toBe(true);
  });

  it("simple comparison: black_hole_rate_24h > 0.05", () => {
    const expr = "black_hole_rate_24h > 0.05";
    expect(evalUsedWhen(expr, makeStats({ black_hole_rate_24h: 0.1 }))).toBe(true);
    expect(evalUsedWhen(expr, makeStats({ black_hole_rate_24h: 0.03 }))).toBe(false);
  });

  it("&& combines two truthy comparisons", () => {
    const expr = "loss_rate_24h >= 0.1 && black_hole_rate_24h < 0.05";
    expect(
      evalUsedWhen(
        expr,
        makeStats({ loss_rate_24h: 0.1, black_hole_rate_24h: 0.01 }),
      ),
    ).toBe(true);
    expect(
      evalUsedWhen(
        expr,
        makeStats({ loss_rate_24h: 0.1, black_hole_rate_24h: 0.5 }),
      ),
    ).toBe(false);
  });

  it("|| returns true if either branch is true", () => {
    const expr = "loss_rate_24h > 0.5 || avg_yield_24h > 1000";
    expect(
      evalUsedWhen(expr, makeStats({ loss_rate_24h: 0.0, avg_yield_24h: 2000 })),
    ).toBe(true);
    expect(
      evalUsedWhen(expr, makeStats({ loss_rate_24h: 0.6, avg_yield_24h: 0 })),
    ).toBe(true);
    expect(
      evalUsedWhen(expr, makeStats({ loss_rate_24h: 0.0, avg_yield_24h: 0 })),
    ).toBe(false);
  });

  it("parens are respected", () => {
    const expr = "(black_hole_rate_24h > 0.05) || (loss_rate_24h > 0.2)";
    expect(
      evalUsedWhen(expr, makeStats({ black_hole_rate_24h: 0.1 })),
    ).toBe(true);
    expect(
      evalUsedWhen(expr, makeStats({ loss_rate_24h: 0.3 })),
    ).toBe(true);
    expect(evalUsedWhen(expr, makeStats())).toBe(false);
  });

  it("throws on unknown identifier", () => {
    expect(() => evalUsedWhen("unknown_id > 0", makeStats())).toThrow(
      /unknown identifier: unknown_id/,
    );
  });

  it("throws on malformed expression", () => {
    expect(() => evalUsedWhen("black_hole_rate_24h ??? 0", makeStats())).toThrow(
      /parse error/,
    );
  });
});

describe("pickTemplate", () => {
  it("returns first template whose used_when evaluates true", () => {
    const templates: Record<string, FleetTemplate> = {
      aggressive: makeTemplate("black_hole_rate_24h < 0.05"),
      standard: makeTemplate("default"),
    };
    const result = pickTemplate({
      templates,
      stats: makeStats({ black_hole_rate_24h: 0.01 }),
    });
    expect(result.id).toBe("aggressive");
    expect(result.template).toBe(templates["aggressive"]);
  });

  it("falls back to default when first template's expr is false", () => {
    const templates: Record<string, FleetTemplate> = {
      aggressive: makeTemplate("black_hole_rate_24h < 0.05"),
      standard: makeTemplate("default"),
    };
    const result = pickTemplate({
      templates,
      stats: makeStats({ black_hole_rate_24h: 0.2 }),
    });
    expect(result.id).toBe("standard");
  });

  it("throws when no match and no default", () => {
    const templates: Record<string, FleetTemplate> = {
      aggressive: makeTemplate("black_hole_rate_24h < 0.05"),
    };
    expect(() =>
      pickTemplate({
        templates,
        stats: makeStats({ black_hole_rate_24h: 0.2 }),
      }),
    ).toThrow(/no matching template/);
  });
});
