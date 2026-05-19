// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { UiDirectiveExecutor } from "../src/directive_executor.js";
import type { Directive } from "@ogamex/shared";

function makeDirective(overrides: Partial<Directive>): Directive {
  return {
    id: "d1",
    source: "goal",
    method: "ui",
    priority: 1,
    action: "build",
    params: {},
    preconds: [],
    expires_at: Date.now() + 60_000,
    reason: "test",
    ...overrides,
  };
}

function makeExec(opts: { ajaxNav?: ReturnType<typeof vi.fn> } = {}) {
  const sleep = vi.fn().mockResolvedValue(undefined);
  if (opts.ajaxNav) {
    (window as any).ogame = { ajaxNavigation: { navigate: opts.ajaxNav } };
  } else {
    delete (window as any).ogame;
  }
  const exec = new UiDirectiveExecutor({
    win: window,
    doc: document,
    sleep,
    clickDelay: () => 0,
  });
  return { exec, sleep };
}

describe("UiDirectiveExecutor.canHandle", () => {
  it("accepts a build directive (method=ui, action=build)", () => {
    const { exec } = makeExec();
    expect(
      exec.canHandle(makeDirective({ method: "ui", action: "build" })),
    ).toBe(true);
  });

  it("accepts a research directive", () => {
    const { exec } = makeExec();
    expect(
      exec.canHandle(makeDirective({ method: "ui", action: "research" })),
    ).toBe(true);
  });

  it("rejects fleet directives (method=api or action=send_fleet)", () => {
    const { exec } = makeExec();
    expect(
      exec.canHandle(makeDirective({ method: "api", action: "send_fleet" })),
    ).toBe(false);
    // Even with method=ui, send_fleet is not a build/research action.
    expect(
      exec.canHandle(makeDirective({ method: "ui", action: "send_fleet" })),
    ).toBe(false);
  });

  it("rejects unknown actions", () => {
    const { exec } = makeExec();
    expect(
      exec.canHandle(makeDirective({ method: "ui", action: "foo" })),
    ).toBe(false);
  });
});

describe("UiDirectiveExecutor.execute", () => {
  it("clicks the upgrade button for a build directive", async () => {
    document.body.innerHTML =
      '<button data-ogamex-upgrade="build:nanofactory" id="b1"></button>';
    const { exec } = makeExec();
    const btn = document.getElementById("b1") as HTMLButtonElement;
    const clickSpy = vi.spyOn(btn, "click");

    const result = await exec.execute(
      makeDirective({
        action: "build",
        params: { building: "nanofactory", planet_id: "33000001" },
      }),
    );

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ action: "build", clicked: true });
  });

  it("clicks the upgrade button for a research directive", async () => {
    document.body.innerHTML =
      '<button data-ogamex-upgrade="research:gravity" id="r1"></button>';
    const { exec } = makeExec();
    const btn = document.getElementById("r1") as HTMLButtonElement;
    const clickSpy = vi.spyOn(btn, "click");

    const result = await exec.execute(
      makeDirective({
        action: "research",
        params: { tech: "gravity", planet_id: "33000001" },
      }),
    );

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ action: "research", clicked: true });
  });

  it("throws when the upgrade button is missing", async () => {
    document.body.innerHTML = "<div>no button here</div>";
    const { exec } = makeExec();

    await expect(
      exec.execute(
        makeDirective({
          action: "build",
          params: { building: "metal_mine" },
        }),
      ),
    ).rejects.toThrow(/upgrade button not found/);
  });

  it("uses ogame.ajaxNavigation when available with planet cp param", async () => {
    document.body.innerHTML =
      '<button data-ogamex-upgrade="build:metal_mine"></button>';
    const navSpy = vi.fn();
    const { exec } = makeExec({ ajaxNav: navSpy });

    await exec.execute(
      makeDirective({
        action: "build",
        params: { building: "metal_mine", planet_id: "33000001" },
      }),
    );

    expect(navSpy).toHaveBeenCalledTimes(1);
    const url = navSpy.mock.calls[0]![0] as string;
    expect(url).toContain("component=supplies");
    expect(url).toContain("cp=33000001");
  });
});
