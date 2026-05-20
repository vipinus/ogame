import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { Goal, GoalType } from "@ogamex/shared";
import { GeminiApiError, type GeminiClient } from "../sidecar/gemini_client.js";
import type { GoalsStore } from "../sidecar/goals_store.js";

/**
 * M5.3 — `ogame_add_goal`.
 *
 * Uses `GeminiClient.generateJson` to parse a free-form user instruction
 * (e.g. "母星出引力 6") into a structured Goal, stores it in pending state,
 * and returns a confirmation prompt for the LLM to surface to the user.
 *
 * The returned `pending_action_id` matches the stored goal's `id`; the caller
 * is expected to transition it via `GoalsStore.updateStatus` once the user
 * confirms (handled by a separate tool/path).
 */

export const AddGoalParams = Type.Object({
  natural_language: Type.String({
    description: "User's plain-language goal description, e.g. '母星出引力 6'",
  }),
  priority: Type.Optional(
    Type.Number({ description: "1=low … 10=high; default 5" }),
  ),
});
export type AddGoalParamsT = Static<typeof AddGoalParams>;

export interface AddGoalDeps {
  gemini: GeminiClient;
  store: GoalsStore;
  /** Override the model used for the parse. Default "gemini-2.5-flash". */
  model?: string;
  /**
   * Provider for the player's planet list — used to inject `available planets`
   * context into the Gemini prompt so the model can resolve friendly names
   * ("母星" / "home" / "earth") to canonical "G:S:P" coordinates. Returns an
   * empty array if no state has been received yet; the LLM will then omit
   * planet_coords and let the planner fall back to planets[0].
   */
  listPlanets?: () => Array<{ id: string; name: string; coords: readonly [number, number, number] | number[]; type: string }>;
}

export interface AddGoalResult {
  pending_action_id: string;
  parsed_goal: Goal;
  confirmation_prompt: string;
}

interface ParsedGoalShape {
  type: GoalType;
  /** JSON-encoded; client decodes. See GoalJsonSchema for why. */
  target_json: string;
  /** Coords in canonical "G:S:P" form (e.g. "1:190:6"). LLM is told to
   *  resolve any friendly names ("home", "母星", "earth") to the player's
   *  actual coords via the planets context we inject. */
  planet_coords?: string;
  priority?: number;
  deadline?: number;
}

const GOAL_TYPES: readonly GoalType[] = [
  "research",
  "build",
  "build_universal",
  "colonize",
  "build_ships",
  "build_defense",
  "terraformer_to",
  "pick_lifeform",
  "lifeform_level_to",
  "lifeform_research",
  "lifeform_building",
];

// Gemini's responseSchema (a constrained OpenAPI 3 subset) does NOT support
// `additionalProperties` on object types. Workaround: model emits a
// JSON-encoded string for `target`, which we parse client-side. Same trick is
// documented in M6.3 strategy_analyzer for the same root cause.
const GoalJsonSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [...GOAL_TYPES],
    },
    target_json: { type: "string", description: "JSON-encoded target spec, e.g. {\"tech\":\"gravitonTech\",\"level\":6}" },
    planet_coords: { type: "string", description: "Planet coordinates in G:S:P form, e.g. \"1:190:6\". Resolve friendly names (home/母星/earth/etc.) to actual coords from the planets list." },
    priority: { type: "number" },
    deadline: { type: "number" },
  },
  required: ["type", "target_json"],
} as const;

/** Parse "G:S:P" → [g, s, p] or null. Tolerates whitespace; rejects bad shapes. */
function parseCoords(coordStr: string | undefined): [number, number, number] | null {
  if (!coordStr) return null;
  const m = coordStr.trim().match(/^(\d+)\s*:\s*(\d+)\s*:\s*(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Look up the planet whose coords match parsed.planet_coords. Returns the
 * planet.id (which the planner uses to find buildings/queues), or undefined
 * if no match (so the planner falls back to state.planets[0]).
 */
function resolvePlanet(
  coordStr: string | undefined,
  planets: ReadonlyArray<{ id: string; coords: readonly [number, number, number] | number[] }>,
): string | undefined {
  const c = parseCoords(coordStr);
  if (!c) return undefined;
  const match = planets.find((p) =>
    p.coords[0] === c[0] && p.coords[1] === c[1] && p.coords[2] === c[2]
  );
  return match?.id;
}

function buildPrompt(
  naturalLanguage: string,
  planets: ReadonlyArray<{ name: string; coords: readonly [number, number, number] | number[]; type: string }>,
): string {
  const planetLines = planets.length === 0
    ? "- (no planet data available — leave planet_coords empty and the planner will default to the first planet)"
    : planets
        .map((p) => {
          const c = p.coords;
          return `- "${c[0]}:${c[1]}:${c[2]}" (${p.type} "${p.name}")`;
        })
        .join("\n");
  return [
    "Parse this user instruction into a structured Goal.",
    "",
    "Available planets (use the coords string verbatim for planet_coords; resolve friendly names like 'home' / '母星' / 'earth' to the correct row):",
    planetLines,
    "",
    "Extract these fields:",
    "- type (research|build|build_universal|colonize|build_ships|build_defense|terraformer_to|pick_lifeform|lifeform_level_to|lifeform_research|lifeform_building)",
    "- target_json (JSON-encoded string — research: \"{\\\"tech\\\":\\\"gravitonTech\\\",\\\"level\\\":6}\"; build: \"{\\\"building\\\":\\\"naniteFactory\\\",\\\"level\\\":3}\")",
    "- planet_coords (canonical \"G:S:P\" coords from the list above, e.g. \"1:190:6\"; OMIT entirely if user did not specify a planet or there is only one)",
    "- priority (1-10, default 5)",
    "- deadline (optional ms epoch — leave undefined if not stated)",
    "",
    `Instruction: ${naturalLanguage}`,
  ].join("\n");
}

export interface AddGoalDefinition {
  name: "ogame_add_goal";
  description: string;
  parameters: typeof AddGoalParams;
  execute: (params: AddGoalParamsT) => Promise<AddGoalResult | { error: string }>;
}

export function makeAddGoalTool(deps: AddGoalDeps): AddGoalDefinition {
  return {
    name: "ogame_add_goal",
    description:
      "Parse a natural-language goal description into a structured Goal, store as pending, and return a confirmation prompt.",
    parameters: AddGoalParams,
    execute: async (params) => {
      const planets = deps.listPlanets ? deps.listPlanets() : [];
      const prompt = buildPrompt(params.natural_language, planets);

      let parsed: ParsedGoalShape;
      try {
        parsed = await deps.gemini.generateJson<ParsedGoalShape>(
          prompt,
          GoalJsonSchema,
        );
      } catch (err) {
        if (err instanceof GeminiApiError) {
          return { error: `gemini api error: ${err.message}` };
        }
        if (err instanceof SyntaxError) {
          return { error: `gemini returned malformed JSON: ${err.message}` };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `add_goal failed: ${msg}` };
      }

      if (!GOAL_TYPES.includes(parsed.type)) {
        return { error: `unsupported goal type: ${String(parsed.type)}` };
      }

      let target: Record<string, unknown>;
      try {
        const decoded = JSON.parse(parsed.target_json) as unknown;
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
          return { error: `target_json did not parse to an object: ${parsed.target_json.slice(0, 80)}` };
        }
        target = decoded as Record<string, unknown>;
      } catch (err) {
        return { error: `target_json malformed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const priority = params.priority ?? parsed.priority ?? 5;

      // Resolve planet_coords ("G:S:P") to a real planet.id by matching
      // against the player's known planets. If no match (or LLM omitted
      // coords), leave the field absent so the planner falls back to its
      // own default (state.planets[0]).
      const resolvedPlanetId = resolvePlanet(parsed.planet_coords, planets);

      const goal: Goal = {
        id: randomUUID(),
        type: parsed.type,
        target,
        priority,
        status: "pending",
        created_at: Date.now(),
        progress_pct: 0,
        current_step: "awaiting confirmation",
        eta_at: null,
        ...(resolvedPlanetId !== undefined ? { planet: resolvedPlanetId } : {}),
        ...(parsed.deadline !== undefined ? { deadline: parsed.deadline } : {}),
      };

      deps.store.add(goal);

      return {
        pending_action_id: goal.id,
        parsed_goal: goal,
        confirmation_prompt: `Confirm adding goal: ${goal.type} ${JSON.stringify(goal.target)} priority=${goal.priority}`,
      };
    },
  };
}
