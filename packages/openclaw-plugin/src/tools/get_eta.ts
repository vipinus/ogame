import { Type, type Static } from "@sinclair/typebox";
import type { GoalsStore } from "../sidecar/goals_store.js";

/**
 * M5.3 — `ogame_get_eta`.
 *
 * Returns the projected completion timestamp (`eta_at`) for a stored goal.
 * `eta_at` may be null when the planner has not yet estimated one.
 */

export const GetEtaParams = Type.Object({
  id: Type.String({ description: "Goal id." }),
});
export type GetEtaParamsT = Static<typeof GetEtaParams>;

export interface GetEtaDeps {
  store: GoalsStore;
}

export interface GetEtaResult {
  id: string;
  eta_at: number | null;
}

export interface GetEtaDefinition {
  name: "ogame_get_eta";
  description: string;
  parameters: typeof GetEtaParams;
  execute: (params: GetEtaParamsT) => GetEtaResult | { error: string };
}

export function makeGetEtaTool(deps: GetEtaDeps): GetEtaDefinition {
  return {
    name: "ogame_get_eta",
    description: "Get the projected completion timestamp (eta_at) for a stored goal.",
    parameters: GetEtaParams,
    execute: ({ id }) => {
      const row = deps.store.get(id);
      if (row === null) {
        return { error: "not found" };
      }
      return { id, eta_at: row.goal.eta_at };
    },
  };
}
