import { describe, it, expect } from "vitest";
import { renderDebugHtml, escapeHtml } from "../../src/sidecar/debug_render.js";
import type {
  DebugDirectiveEntry,
  DebugEventEntry,
} from "../../src/sidecar/debug_buffer.js";
import type { Directive, UpstreamMsg } from "@ogamex/shared";

/**
 * M8.5 — renderDebugHtml emits a self-contained HTML5 document. These tests
 * pin the document structure (so the page actually loads), the row count, and
 * — most importantly — that user-controlled fields like directive.reason are
 * HTML-escaped so a malicious strategy patch can't XSS the operator page.
 */

function makeDirectiveEntry(id: string, reason: string): DebugDirectiveEntry {
  const directive: Directive = {
    id,
    source: "goal",
    method: "api",
    priority: 50,
    action: "build",
    params: {},
    preconds: [],
    expires_at: 0,
    reason,
  };
  return { ts: 1_700_000_000_000, directive, state: "dispatched" };
}

function makeEventEntry(msg: UpstreamMsg): DebugEventEntry {
  return { ts: 1_700_000_000_000, msg };
}

describe("renderDebugHtml", () => {
  it("returns a valid HTML5 document", () => {
    const html = renderDebugHtml({ directives: [], events: [] });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>OgameX debug</title>");
    expect(html).toContain("</html>");
  });

  it("renders the directives table with the correct row count", () => {
    const directives = [
      makeDirectiveEntry("d-1", "first"),
      makeDirectiveEntry("d-2", "second"),
      makeDirectiveEntry("d-3", "third"),
    ];
    const html = renderDebugHtml({ directives, events: [] });
    expect(html).toContain("Recent directives (3)");
    // Reason column carries each entry's reason text.
    expect(html).toContain("first");
    expect(html).toContain("second");
    expect(html).toContain("third");
    // Two <tr> headers (directives + events tables) + 3 directive rows ≥ 5.
    const rowCount = (html.match(/<tr>/g) ?? []).length;
    expect(rowCount).toBeGreaterThanOrEqual(5);
  });

  it("escapes HTML in directive.reason so a <script> payload is neutralised", () => {
    const directives = [makeDirectiveEntry("d-1", "<script>alert(1)</script>")];
    const html = renderDebugHtml({ directives, events: [] });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders an empty snapshot without throwing", () => {
    const html = renderDebugHtml({ directives: [], events: [] });
    expect(html).toContain("Recent directives (0)");
    expect(html).toContain("Recent events (0)");
  });
});

describe("escapeHtml", () => {
  it("escapes & < > \" '", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("returns input untouched when no special chars present", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });
});
