import type { Directive } from "@ogamex/shared";

/**
 * Executor for a single Directive. M5.5 GoalRunner depends on this interface;
 * M5.6 provides the concrete UI-clicking implementation. Fleet directives may
 * be routed to fleet_api directly instead of this executor (caller's choice).
 */
export interface DirectiveExecutor {
  /**
   * Execute the directive. Resolves with whatever the action produced (e.g.
   * a fleet id, a tech queue position, or void). Rejects on unrecoverable
   * failure — the caller decides whether to retry or mark the directive
   * `event.directive_completed` with success=false.
   */
  execute(directive: Directive): Promise<unknown>;

  /**
   * Returns true if this executor knows how to handle the directive (by
   * `action` and shape). Caller uses this to route between executors.
   */
  canHandle(directive: Directive): boolean;
}
