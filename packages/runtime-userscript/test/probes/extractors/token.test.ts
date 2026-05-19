// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractToken, type OgameWindow } from "../../../src/probes/extractors/token.js";

describe("extractToken", () => {
  it("reads from input[name=token]", () => {
    const dom = new JSDOM(`<form><input name="token" value="abc123"></form>`);
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBe("abc123");
  });

  it("falls back to window.ogameMeta.token", () => {
    const dom = new JSDOM(`<html></html>`);
    (dom.window as unknown as OgameWindow).ogameMeta = { token: "from-meta" };
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBe("from-meta");
  });

  it("falls back to window.token", () => {
    const dom = new JSDOM(`<html></html>`);
    (dom.window as unknown as OgameWindow).token = "from-window";
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBe("from-window");
  });

  it("falls back to window.csrfToken", () => {
    const dom = new JSDOM(`<html></html>`);
    (dom.window as unknown as OgameWindow).csrfToken = "from-csrf";
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBe("from-csrf");
  });

  it("falls back to meta[name=ogame-token]", () => {
    const dom = new JSDOM(`<html><head><meta name="ogame-token" content="from-meta-tag"></head></html>`);
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBe("from-meta-tag");
  });

  it("returns null when not found anywhere", () => {
    const dom = new JSDOM(`<html></html>`);
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBeNull();
  });

  it("prefers DOM input over window globals when both present", () => {
    const dom = new JSDOM(`<form><input name="token" value="dom-wins"></form>`);
    (dom.window as unknown as OgameWindow).ogameMeta = { token: "should-be-ignored" };
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBe("dom-wins");
  });

  it("ignores empty input value", () => {
    const dom = new JSDOM(`<form><input name="token" value=""></form>`);
    (dom.window as unknown as OgameWindow).ogameMeta = { token: "fallback" };
    expect(extractToken(dom.window.document, dom.window as unknown as OgameWindow)).toBe("fallback");
  });
});
