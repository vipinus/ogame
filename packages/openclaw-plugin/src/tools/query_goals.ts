import { Type, type Static } from "@sinclair/typebox";
import type { GoalsStore, GoalRow, GoalStatus } from "../sidecar/goals_store.js";

/**
 * M5.3 — `ogame_query_goals`.
 *
 * Lists stored goals, optionally filtered by status. Default: all goals.
 */

export const QueryGoalsParams = Type.Object({
  status: Type.Optional(
    Type.String({ description: "Optional status filter: pending|active|blocked|completed|cancelled." }),
  ),
});
export type QueryGoalsParamsT = Static<typeof QueryGoalsParams>;

export interface QueryGoalsDeps {
  store: GoalsStore;
}

export interface QueryGoalsResult {
  goals: GoalRow[];
}

export interface QueryGoalsDefinition {
  name: "ogame_query_goals";
  description: string;
  parameters: typeof QueryGoalsParams;
  execute: (params: QueryGoalsParamsT) => QueryGoalsResult | { error: string };
}

const VALID_STATUSES: readonly GoalStatus[] = [
  "pending",
  "active",
  "blocked",
  "completed",
  "cancelled",
];

export function makeQueryGoalsTool(deps: QueryGoalsDeps): QueryGoalsDefinition {
  return {
    name: "ogame_query_goals",
    description: "List stored goals, optionally filtered by status.",
    parameters: QueryGoalsParams,
    execute: ({ status }) => {
      if (status === undefined || status === "") {
        return { goals: deps.store.list() };
      }
      if (!VALID_STATUSES.includes(status as GoalStatus)) {
        return { error: `invalid status: ${status}` };
      }
      return { goals: deps.store.listByStatus(status as GoalStatus) };
    },
  };
}
