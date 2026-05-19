/**
 * M8.5 — DebugBuffer.
 *
 * A pair of in-memory ring buffers retaining the most recent dispatched
 * directives (with their completion state) and the most recent upstream
 * messages. Backs the operator-facing `/ogamex/v1/debug` HTML page; nothing
 * else should mutate it. Bounded so a long-running sidecar can't leak
 * unbounded memory through this debugging facility.
 */
import type { Directive, UpstreamMsg } from "@ogamex/shared";

export interface DebugBufferOptions {
  /** Max retained items per category. Default 100. */
  maxPerCategory?: number;
}

export interface DebugDirectiveEntry {
  ts: number;
  directive: Directive;
  /** "dispatched" when emitted; "completed" once the matching ack arrives. */
  state: "dispatched" | "completed";
  /** Populated when state="completed". */
  result?: unknown;
}

export interface DebugEventEntry {
  ts: number;
  msg: UpstreamMsg;
}

/**
 * Internally we keep the arrays in insertion order (oldest first) so eviction
 * is a cheap `shift()` and `recordComplete` can find by id with one linear
 * pass. `snapshot()` reverses on the way out to give callers newest-first.
 */
export class DebugBuffer {
  private readonly maxPerCategory: number;
  private readonly directives: DebugDirectiveEntry[] = [];
  private readonly events: DebugEventEntry[] = [];

  constructor(opts?: DebugBufferOptions) {
    this.maxPerCategory = opts?.maxPerCategory ?? 100;
  }

  recordDispatch(directive: Directive): void {
    this.directives.push({
      ts: Date.now(),
      directive,
      state: "dispatched",
    });
    while (this.directives.length > this.maxPerCategory) {
      this.directives.shift();
    }
  }

  recordComplete(directive_id: string, result: unknown): void {
    // Walk from newest to oldest — completions almost always match a recently
    // dispatched directive, and this keeps the common-case work small.
    for (let i = this.directives.length - 1; i >= 0; i--) {
      const entry = this.directives[i];
      if (entry !== undefined && entry.directive.id === directive_id) {
        entry.state = "completed";
        entry.result = result;
        return;
      }
    }
    // No match — the entry was evicted before completion arrived. Silent no-op
    // by design: the buffer is a debugging convenience, not an audit log.
  }

  recordEvent(msg: UpstreamMsg): void {
    this.events.push({ ts: Date.now(), msg });
    while (this.events.length > this.maxPerCategory) {
      this.events.shift();
    }
  }

  snapshot(): { directives: DebugDirectiveEntry[]; events: DebugEventEntry[] } {
    return {
      directives: [...this.directives].reverse(),
      events: [...this.events].reverse(),
    };
  }
}
