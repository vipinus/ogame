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
}

export interface AddGoalResult {
  pending_action_id: string;
  parsed_goal: Goal;
  confirmation_prompt: string;
}

interface ParsedGoalShape {
  type: GoalType;
  target: Record<string, unknown>;
  planet?: string;
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

const GoalJsonSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [...GOAL_TYPES],
    },
    target: { type: "object", additionalProperties: true },
    planet: { type: "string" },
    priority: { type: "number" },
    deadline: { type: "number" },
  },
  required: ["type", "target"],
} as const;

function buildPrompt(naturalLanguage: string): string {
  return [
    "Parse this user instruction into a structured Goal. Extract:",
    "- type (research|build|build_universal|colonize|build_ships|build_defense|terraformer_to|pick_lifeform|lifeform_level_to|lifeform_research|lifeform_building)",
    "- target (object — for research: {tech, level}; for build: {building, level, planet}; etc.)",
    "- planet (optional planet id or name)",
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
      const prompt = buildPrompt(params.natural_language);

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

      const priority = params.priority ?? parsed.priority ?? 5;

      const goal: Goal = {
        id: randomUUID(),
        type: parsed.type,
        target: parsed.target,
        priority,
        status: "pending",
        created_at: Date.now(),
        progress_pct: 0,
        current_step: "awaiting confirmation",
        eta_at: null,
        ...(parsed.planet !== undefined ? { planet: parsed.planet } : {}),
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
