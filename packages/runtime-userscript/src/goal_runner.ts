import type { BridgeClient } from "./bridge/ws_client.js";
import type { PriorityGate } from "./emergency/priority_gate.js";
import type { DirectiveExecutor } from "./directive_executor_iface.js";
import type { Directive } from "@ogamex/shared";

/**
 * M5.5 GoalRunner — userscript-side consumer of `directive.dispatch`.
 *
 * Receives directives from the plugin bridge, validates them, yields to the
 * emergency PriorityGate when active, and routes execution to the first
 * registered DirectiveExecutor whose `canHandle()` returns true. Every
 * dispatched directive produces exactly one `event.directive_completed` ack —
 * unless validation fails, in which case the directive is silently dropped
 * with a console.warn (the upstream scheduler will reissue if needed).
 */
export interface GoalRunnerDeps {
  client: BridgeClient;
  gate: PriorityGate;
  /** One or more executors; first whose `canHandle(directive)===true` wins. */
  executors: DirectiveExecutor[];
}

export interface GoalRunnerHandle {
  stop(): void;
  /** Test/inspection accessor — internal pending queue size. */
  pendingCount(): number;
}

type AckResult =
  | { success: true; result: unknown }
  | { success: false; error: string };

const REQUIRED_FIELDS: readonly (keyof Directive)[] = [
  "id",
  "source",
  "method",
  "priority",
  "action",
  "params",
  "preconds",
  "expires_at",
  "reason",
];

function isValidDirective(d: unknown): d is Directive {
  if (!d || typeof d !== "object") return false;
  const rec = d as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in rec)) return false;
  }
  if (typeof rec["id"] !== "string") return false;
  if (typeof rec["source"] !== "string") return false;
  if (typeof rec["method"] !== "string") return false;
  if (typeof rec["priority"] !== "number") return false;
  if (typeof rec["action"] !== "string") return false;
  if (!rec["params"] || typeof rec["params"] !== "object") return false;
  if (!Array.isArray(rec["preconds"])) return false;
  if (typeof rec["expires_at"] !== "number") return false;
  if (typeof rec["reason"] !== "string") return false;
  return true;
}

export function startGoalRunner(deps: GoalRunnerDeps): GoalRunnerHandle {
  const { client, gate, executors } = deps;

  const pending: Directive[] = [];
  let stopped = false;

  function ack(directiveId: string, result: AckResult): void {
    if (stopped) return;
    client.send({
      type: "event.directive_completed",
      directive_id: directiveId,
      result,
    });
  }

  async function run(directive: Directive): Promise<void> {
    if (stopped) return;
    // Expiry check: directive's deadline may have passed while it sat in the
    // queue (or arrived already-stale from sidecar). Ack expired without
    // running the executor — saves wasted ogame POSTs.
    if (typeof directive.expires_at === "number" && Date.now() > directive.expires_at) {
      ack(directive.id, { success: false, error: "expired" });
      return;
    }
    let chosen: DirectiveExecutor | null = null;
    for (const ex of executors) {
      let handles = false;
      try {
        handles = ex.canHandle(directive);
      } catch (e) {
        // Defensive: a misbehaving executor shouldn't crash the runner.
        // eslint-disable-next-line no-console
        console.warn("[GoalRunner] executor.canHandle threw", e);
        handles = false;
      }
      if (handles) {
        chosen = ex;
        break;
      }
    }
    if (!chosen) {
      // eslint-disable-next-line no-console
      console.warn(`[GoalRunner] no executor for action=${directive.action}`);
      ack(directive.id, {
        success: false,
        error: `no executor for action ${directive.action}`,
      });
      return;
    }
    // Defer ALL autonomous POSTs while operator is actively using ogame UI.
    // Without this, sidecar's per-tick directives keep firing into the same
    // session ogame is processing user clicks for → "server not responding"
    // anti-bot trip. Boot.ts sets window.__ogamexUserBusyUntil on mousedown
    // / keydown. Defer the directive (NACK with a retry-soon signal).
    const busyUntil = (globalThis as { window?: { __ogamexUserBusyUntil?: number } }).window?.__ogamexUserBusyUntil ?? 0;
    if (busyUntil > Date.now()) {
      const waitMs = Math.min(busyUntil - Date.now(), 60_000);
      console.log(`[GoalRunner] DEFER ${directive.action} — operator active, retry in ${(waitMs / 1000).toFixed(0)}s`);
      ack(directive.id, { success: false, error: `deferred: operator active, retry after ${waitMs}ms` });
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[GoalRunner] executing ${directive.action} via ${chosen.constructor.name}`);
    try {
      const result = await chosen.execute(directive);
      // eslint-disable-next-line no-console
      console.log(`[GoalRunner] execute OK`, result);
      ack(directive.id, { success: true, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.warn(`[GoalRunner] execute FAILED for ${directive.action}:`, msg);
      ack(directive.id, { success: false, error: msg });
    }
  }

  function handleDispatch(directive: Directive): void {
    if (Date.now() > directive.expires_at) {
      ack(directive.id, { success: false, error: "expired" });
      return;
    }
    if (gate.isActive()) {
      pending.push(directive);
      return;
    }
    // Fire and forget — errors are caught inside run().
    void run(directive);
  }

  // Serialize directive execution + dedupe recent ids. Without this,
  // sidecar's per-tick dispatch (3 directives at once for research +
  // build + build_ships) triggers 3 parallel navigates → reload storm.
  // Dedupe window matches the push interval so the SAME directive id
  // arriving on consecutive ticks doesn't re-execute.
  // Dedupe by EXACT id only — the merger generates a fresh id per tick,
  // so signature dedupe (action+params) blocked legitimate retries after
  // resources arrived. Id dedupe is essentially a no-op for fresh ids
  // but protects against accidental same-id replay within the WS layer.
  const RECENT_IDS_TTL_MS = 5_000;
  const recentIds = new Map<string, number>(); // id → expiresAt
  let executing = false;
  const execQueue: Directive[] = [];
  const gcRecent = (): void => {
    const now = Date.now();
    for (const [id, exp] of recentIds) if (exp < now) recentIds.delete(id);
  };
  async function pumpQueue(): Promise<void> {
    if (executing) return;
    while (execQueue.length > 0) {
      const d = execQueue.shift()!;
      executing = true;
      try {
        await run(d);
      } finally {
        executing = false;
      }
    }
  }

  const unsubDispatch = client.on("directive.dispatch", (msg) => {
    if (stopped) return;
    const d: unknown = msg.directive;
    if (!isValidDirective(d)) {
      console.warn("[GoalRunner] dropped invalid directive", d);
      return;
    }
    const dr = d as Directive;
    gcRecent();
    if (recentIds.has(dr.id)) {
      // Exact id replay — only happens on rare WS retry. Skip.
      return;
    }
    recentIds.set(dr.id, Date.now() + RECENT_IDS_TTL_MS);
    console.log(`[GoalRunner] received ${dr.action} ${JSON.stringify(dr.params).slice(0,80)} id=${dr.id.slice(0,8)}`);
    // PriorityGate is held by an in-progress emergency response (fleet save,
    // anomaly halt). While active, queue directives in `pending` to drain
    // when gate flips inactive.
    if (gate.isActive()) {
      pending.push(dr);
      return;
    }
    execQueue.push(dr);
    void pumpQueue();
  });

  const unsubGate = gate.onChange((active) => {
    if (stopped) return;
    if (active) return;
    // Gate transitioned to inactive — drain pending queue (oldest first).
    // We splice into a local list so re-entrant pushes during the drain
    // (e.g. gate flipping again mid-drain) end up in the new `pending`.
    const drained = pending.splice(0, pending.length);
    for (const d of drained) {
      // Re-check expiry at drain time; emergency may have lasted long enough
      // for the directive to expire while it sat in the queue.
      if (Date.now() > d.expires_at) {
        ack(d.id, { success: false, error: "expired" });
        continue;
      }
      // If the gate flipped back on mid-drain, push remaining items back.
      if (gate.isActive()) {
        pending.push(d);
        continue;
      }
      void run(d);
    }
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubDispatch();
      unsubGate();
      pending.length = 0;
    },
    pendingCount(): number {
      return pending.length;
    },
  };
}
