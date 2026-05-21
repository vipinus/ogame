import { Type, type Static } from "@sinclair/typebox";
import type { WorldState, Planet } from "@ogamex/shared";

/** Ref-cell holding the latest WorldState mirror (populated by sidecar's state.snapshot handler). */
export interface WorldStateRef {
  current: WorldState | null;
}

export const QueryStateParams = Type.Object({
  planet: Type.Optional(
    Type.String({ description: "Specific planet name. Omit for all." }),
  ),
});
export type QueryStateParamsT = Static<typeof QueryStateParams>;

/** Result is either the full WorldState, a single Planet, or an error envelope. */
export type QueryStateResult =
  | WorldState
  | Planet
  | { error: string };

/** Definition object — wrapped with `tool(...)` at plugin entry point. */
export interface QueryStateDefinition {
  name: "ogame_query_state";
  description: string;
  parameters: typeof QueryStateParams;
  execute: (params: QueryStateParamsT) => QueryStateResult;
}

/** Factory: capture a WorldStateRef in closure and return the definition. */
export function makeQueryStateTool(ref: WorldStateRef): QueryStateDefinition {
  return {
    name: "ogame_query_state",
    description:
      "Query the current Ogame world state (resources, planets, fleets, events).",
    parameters: QueryStateParams,
    execute: ({ planet }) => {
      if (ref.current === null) {
        return { error: "state not yet received" };
      }
      if (planet === undefined || planet === "") {
        return ref.current;
      }
      const found = Object.values(ref.current.planets ?? {}).find((p) => p.name === planet);
      if (found !== undefined) {
        return found;
      }
      return { error: `unknown planet ${planet}` };
    },
  };
}
