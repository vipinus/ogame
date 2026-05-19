import { describe, it, expect } from "vitest";
import { DebugBuffer } from "../../src/sidecar/debug_buffer.js";
import type { Directive, UpstreamMsg } from "@ogamex/shared";

/**
 * M8.5 — DebugBuffer is a pair of ring buffers backing the operator-facing
 * /ogamex/v1/debug HTML page. These tests pin the eviction policy, the
 * dispatched→completed state transition, and the newest-first snapshot order.
 */

function makeDirective(id: string, reason = "test"): Directive {
  return {
    id,
    source: "goal",
    method: "api",
    priority: 50,
    action: "build",
    params: {},
    preconds: [],
    expires_at: Date.now() + 60_000,
    reason,
  };
}

function makeEvent(directive_id: string): UpstreamMsg {
  return { type: "event.directive_completed", directive_id, result: { ok: true } };
}

describe("DebugBuffer", () => {
  it("recordDispatch adds an entry with state=dispatched", () => {
    const buf = new DebugBuffer();
    const d = makeDirective("d-1");
    buf.recordDispatch(d);
    const snap = buf.snapshot();
    expect(snap.directives).toHaveLength(1);
    const entry = snap.directives[0]!;
    expect(entry.directive.id).toBe("d-1");
    expect(entry.state).toBe("dispatched");
    expect(entry.result).toBeUndefined();
    expect(typeof entry.ts).toBe("number");
  });

  it("recordComplete updates the matching entry's state and result", () => {
    const buf = new DebugBuffer();
    buf.recordDispatch(makeDirective("d-1"));
    buf.recordComplete("d-1", { ok: true, gained: 42 });
    const snap = buf.snapshot();
    expect(snap.directives).toHaveLength(1);
    const entry = snap.directives[0]!;
    expect(entry.state).toBe("completed");
    expect(entry.result).toEqual({ ok: true, gained: 42 });
  });

  it("recordComplete is a no-op when the id is unknown", () => {
    const buf = new DebugBuffer();
    buf.recordDispatch(makeDirective("d-1"));
    expect(() => buf.recordComplete("missing", { ok: false })).not.toThrow();
    const snap = buf.snapshot();
    expect(snap.directives).toHaveLength(1);
    expect(snap.directives[0]!.state).toBe("dispatched");
  });

  it("maxPerCategory evicts the oldest entries when overflowing", () => {
    const buf = new DebugBuffer({ maxPerCategory: 3 });
    for (let i = 0; i < 5; i++) buf.recordEvent(makeEvent(`d-${i}`));
    const snap = buf.snapshot();
    expect(snap.events).toHaveLength(3);
    // Newest-first; d-0 and d-1 were evicted.
    const ids = snap.events.map((e) => (e.msg as { directive_id: string }).directive_id);
    expect(ids).toEqual(["d-4", "d-3", "d-2"]);
  });

  it("snapshot returns directives newest-first", () => {
    const buf = new DebugBuffer();
    buf.recordDispatch(makeDirective("d-1"));
    buf.recordDispatch(makeDirective("d-2"));
    buf.recordDispatch(makeDirective("d-3"));
    const ids = buf.snapshot().directives.map((e) => e.directive.id);
    expect(ids).toEqual(["d-3", "d-2", "d-1"]);
  });

  it("recordEvent stores the message verbatim", () => {
    const buf = new DebugBuffer();
    const msg: UpstreamMsg = { type: "pong", ts: 1234 };
    buf.recordEvent(msg);
    const snap = buf.snapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0]!.msg).toBe(msg);
  });
});
