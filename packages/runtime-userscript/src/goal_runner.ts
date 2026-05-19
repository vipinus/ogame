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
      ack(directive.id, {
        success: false,
        error: `no executor for action ${directive.action}`,
      });
      return;
    }
    try {
      const result = await chosen.execute(directive);
      ack(directive.id, { success: true, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

  const unsubDispatch = client.on("directive.dispatch", (msg) => {
    if (stopped) return;
    const d: unknown = msg.directive;
    if (!isValidDirective(d)) {
      // eslint-disable-next-line no-console
      console.warn("[GoalRunner] dropped invalid directive", d);
      return;
    }
    handleDispatch(d);
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
