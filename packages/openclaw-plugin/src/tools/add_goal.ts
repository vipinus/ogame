import type { GoalType } from "@ogamex/shared";
import { GeminiApiError, type GeminiClient } from "../sidecar/gemini_client.js";

/**
 * Phase 7d (v0.0.784) — `makeAddGoalTool` 跟 store-coupled add_goal helpers
 * 全部 dead code 删除. 只剩 `parseGoalFromNL` (panel "自然语言描述" 入口),
 * 它的写入由 ogame-next /api/me/goals POST 走 PG 主路径, 不再经 GoalsStore.
 */

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
  "expedition",
  "deploy",
  "transport",
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
 * if no match (so the planner falls back to Object.values(state.planets ?? {})[0]).
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
    "- type (research|build|build_universal|colonize|build_ships|build_defense|terraformer_to|expedition|deploy|transport|pick_lifeform|lifeform_level_to|lifeform_research|lifeform_building)",
    "- target_json (JSON-encoded string — research: \"{\\\"tech\\\":\\\"gravitonTech\\\",\\\"level\\\":6}\"; build: \"{\\\"building\\\":\\\"naniteFactory\\\",\\\"level\\\":3}\")",
    "- planet_coords (canonical \"G:S:P\" coords from the list above, e.g. \"1:190:6\"; OMIT entirely if user did not specify a planet or there is only one)",
    "- priority (1-10, default 5)",
    "- deadline (optional ms epoch — leave undefined if not stated)",
    "",
    `Instruction: ${naturalLanguage}`,
  ].join("\n");
}

/**
 * M4 — bare NL → goal-shape parse without storing. Reused by the panel's
 * "自然语言描述" entry point (POST /v1/goals/parse). Returns the same fields
 * the modal form takes (type / target object / planet id / priority) so the
 * modal can pre-fill the form for operator review before final submit.
 */
export interface ParseGoalFromNLDeps {
  gemini: GeminiClient;
  listPlanets?: () => Array<{ id: string; name: string; coords: readonly [number, number, number] | number[]; type: string }>;
}
export interface ParseGoalResult {
  type: GoalType;
  target: Record<string, unknown>;
  planet?: string;
  priority?: number;
}
export async function parseGoalFromNL(
  description: string,
  deps: ParseGoalFromNLDeps,
): Promise<ParseGoalResult | { error: string }> {
  const planets = deps.listPlanets ? deps.listPlanets() : [];
  const prompt = buildPrompt(description, planets);
  let parsed: ParsedGoalShape;
  try {
    parsed = await deps.gemini.generateJson<ParsedGoalShape>(prompt, GoalJsonSchema);
  } catch (err) {
    if (err instanceof GeminiApiError) return { error: `gemini api error: ${err.message}` };
    if (err instanceof SyntaxError) return { error: `gemini returned malformed JSON: ${err.message}` };
    return { error: `nl parse failed: ${err instanceof Error ? err.message : String(err)}` };
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
  const planetId = resolvePlanet(parsed.planet_coords, planets);
  return {
    type: parsed.type,
    target,
    ...(planetId !== undefined ? { planet: planetId } : {}),
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
  };
}

// Phase 7d — makeAddGoalTool dead code 已删. parseGoalFromNL 之上 export.
