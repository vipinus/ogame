// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { startMutationObserver, type Emitter } from "../../src/probes/mutation_observer.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("startMutationObserver", () => {
  it("emits dom.changed when watched element mutates", async () => {
    const dom = new JSDOM(`<div id="eventContent"></div>`);
    const emitter: Emitter = { emit: vi.fn() };
    const stop = startMutationObserver(dom.window.document, emitter, dom.window as unknown as Window);

    const ec = dom.window.document.getElementById("eventContent")!;
    // Note: jsdom's HTML5 parser foster-parents `<tr>` out of a `<div>` context
    // ("in body" insertion mode ignores the token), producing no child mutation.
    // Use a `<span>` instead so the innerHTML assignment actually changes children.
    ec.innerHTML = "<span class='eventFleet'></span>";
    await sleep(50);

    expect(emitter.emit).toHaveBeenCalledWith(
      "dom.changed",
      expect.objectContaining({ targetId: "eventContent" })
    );
    stop();
  });

  it("emits for multiple watched elements independently", async () => {
    const dom = new JSDOM(`
      <div id="eventContent"></div>
      <div id="resources_metal" data-raw="100">100</div>
    `);
    const emitter: Emitter = { emit: vi.fn() };
    const stop = startMutationObserver(dom.window.document, emitter, dom.window as unknown as Window);

    dom.window.document.getElementById("eventContent")!.appendChild(dom.window.document.createElement("tr"));
    dom.window.document.getElementById("resources_metal")!.setAttribute("data-raw", "200");
    await sleep(50);

    const calls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
    const targets = new Set(calls.filter(c => c[0] === "dom.changed").map(c => (c[1] as any).targetId));
    expect(targets.has("eventContent")).toBe(true);
    expect(targets.has("resources_metal")).toBe(true);
    stop();
  });

  it("skips watched IDs that don't exist on the page", async () => {
    const dom = new JSDOM(`<div id="eventContent"></div>`);
    const emitter: Emitter = { emit: vi.fn() };
    const stop = startMutationObserver(dom.window.document, emitter, dom.window as unknown as Window);
    // resources_metal etc. don't exist; should not error
    await sleep(20);
    // No emissions yet because nothing mutated
    expect(emitter.emit).not.toHaveBeenCalled();
    stop();
  });

  it("stop() disconnects observers", async () => {
    const dom = new JSDOM(`<div id="eventContent"></div>`);
    const emitter: Emitter = { emit: vi.fn() };
    const stop = startMutationObserver(dom.window.document, emitter, dom.window as unknown as Window);
    stop();

    dom.window.document.getElementById("eventContent")!.innerHTML = "x";
    await sleep(50);
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
