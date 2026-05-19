import { Type, type Static } from "@sinclair/typebox";
import type { GoalsStore } from "../sidecar/goals_store.js";

/**
 * M5.3 — `ogame_cancel_goal`.
 *
 * Marks a stored goal as cancelled (terminal state). Returns an error envelope
 * when the id is unknown.
 */

export const CancelGoalParams = Type.Object({
  id: Type.String({ description: "Goal id to cancel." }),
});
export type CancelGoalParamsT = Static<typeof CancelGoalParams>;

export interface CancelGoalDeps {
  store: GoalsStore;
}

export interface CancelGoalSuccess {
  id: string;
  status: "cancelled";
}

export interface CancelGoalDefinition {
  name: "ogame_cancel_goal";
  description: string;
  parameters: typeof CancelGoalParams;
  execute: (params: CancelGoalParamsT) => CancelGoalSuccess | { error: string };
}

export function makeCancelGoalTool(deps: CancelGoalDeps): CancelGoalDefinition {
  return {
    name: "ogame_cancel_goal",
    description: "Cancel a stored goal by id.",
    parameters: CancelGoalParams,
    execute: ({ id }) => {
      if (deps.store.get(id) === null) {
        return { error: "not found" };
      }
      deps.store.updateStatus(id, "cancelled");
      return { id, status: "cancelled" };
    },
  };
}
