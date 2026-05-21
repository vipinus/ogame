/**
 * M6.3 — LLM-backed strategy analyzer.
 *
 * Receives a failing daily task's history + current strategy + world state and
 * asks Gemini for a strategy patch (with reason) OR an abstain message.
 *
 * Defensive: garbage output → abstain; SyntaxError from `generateJson` →
 * abstain; `GeminiApiError` re-thrown so the caller can handle backoff/log.
 */

import type { GeminiClient } from "../sidecar/gemini_client.js";
import { GeminiApiError } from "../sidecar/gemini_client.js";
import type { Strategy, WorldState } from "@ogamex/shared";

export interface FailureRecord {
  ts: number;
  error: string;
  context: unknown;
}

export interface AnalyzeInput {
  task: string;
  recentFailures: FailureRecord[];
  currentStrategy: Strategy;
  worldState: WorldState;
}

export type AnalyzeResult =
  | { patch: Record<string, unknown>; reason: string }
  | { abstain: string };

// -----------------------------------------------------------------------------
// Response schema.
//
// Gemini's `responseSchema` field rejects `oneOf` in many cases (the API surface
// is a constrained subset of JSON Schema, modeled on OpenAPI 3.0). To stay
// portable we use a flat schema with all fields optional and do a runtime
// post-parse check that exactly one of `(patch+reason)` or `abstain` is present.
// -----------------------------------------------------------------------------
const ResponseSchema: object = {
  type: "object",
  properties: {
    patch: { type: "object" },
    reason: { type: "string" },
    abstain: { type: "string" },
  },
};

interface RawResponse {
  patch?: Record<string, unknown>;
  reason?: string;
  abstain?: string;
}

export async function analyzeFailure(
  input: AnalyzeInput,
  llm: GeminiClient,
  opts?: { model?: string },
): Promise<AnalyzeResult> {
  const prompt = buildPrompt(input);

  let raw: RawResponse;
  try {
    const genOpts: { model?: string } = {};
    if (opts?.model !== undefined) genOpts.model = opts.model;
    // `model` is set on the client at construction; the per-call override is
    // not part of `GeminiGenerateOptions`, so we ignore opts.model silently
    // unless tests later wire it. Keep the signature for future extension.
    void genOpts;
    raw = await llm.generateJson<RawResponse>(prompt, ResponseSchema);
  } catch (err) {
    if (err instanceof GeminiApiError) throw err;
    if (err instanceof SyntaxError) {
      return { abstain: "model output was not parseable JSON" };
    }
    throw err;
  }

  // Post-parse normalization.
  if (
    raw &&
    typeof raw === "object" &&
    raw.patch !== undefined &&
    typeof raw.reason === "string"
  ) {
    return { patch: raw.patch, reason: raw.reason };
  }
  if (raw && typeof raw.abstain === "string") {
    return { abstain: raw.abstain };
  }
  return { abstain: "model did not produce a valid response shape" };
}

// -----------------------------------------------------------------------------
// Prompt builder
// -----------------------------------------------------------------------------

function buildPrompt(input: AnalyzeInput): string {
  const { task, recentFailures, currentStrategy, worldState } = input;

  const top3 = recentFailures.slice(0, 3).map((f, i) => {
    const ctx = safeJson(f.context);
    return `  ${i + 1}. ts=${f.ts} error="${f.error}" context=${ctx}`;
  }).join("\n");

  // Key strategy fields the LLM is most likely to adjust.
  const expedition = currentStrategy.daily.expedition;
  const stratSummary = safeJson({
    daily: {
      expedition: {
        enabled: expedition.enabled,
        auto_fill_slots: expedition.auto_fill_slots,
        source_planet: expedition.source_planet,
        duration: expedition.duration,
        target_position: expedition.target_position,
        galaxy_strategy: expedition.galaxy_strategy,
        cargo_load: expedition.cargo_load,
      },
      resource_balance: currentStrategy.daily.resource_balance,
      defense_replenish: currentStrategy.daily.defense_replenish,
      default_build: currentStrategy.daily.default_build,
    },
  });

  // Key world-state numbers.
  const sourcePlanet =
    Object.values(worldState.planets ?? {}).find((p) => p.id === expedition.source_planet) ?? Object.values(worldState.planets ?? {})[0];
  const sourceSummary = sourcePlanet
    ? {
        id: sourcePlanet.id,
        name: sourcePlanet.name,
        coords: sourcePlanet.coords,
        resources: sourcePlanet.resources,
        production: sourcePlanet.production,
      }
    : null;
  const astro = worldState.research.levels["astrophysics"] ?? 0;
  const worldSummary = safeJson({
    source_planet: sourceSummary,
    fleets_outbound_count: worldState.fleets_outbound.length,
    astrophysics_level: astro,
    discovery_slots: worldState.discovery_slots,
  });

  return [
    "You are a strategy adjuster for an Ogame automation system.",
    "A daily task is failing repeatedly. Suggest a strategy patch to fix it,",
    "OR abstain if you do not have enough information to act safely.",
    "",
    `Failing task: ${task}`,
    "",
    "Recent failures (top 3):",
    top3 || "  (none)",
    "",
    "Current strategy (changeable fields):",
    stratSummary,
    "",
    "World state (key numbers):",
    worldSummary,
    "",
    "Respond with JSON in EXACTLY one of these two shapes:",
    '  1) {"patch": { ...JSON-merge-patch into Strategy... }, "reason": "<short why>"}',
    '  2) {"abstain": "<short reason why no patch>"}',
    "Do not include both. The patch should be a minimal JSON merge-patch.",
  ].join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserializable>"';
  }
}
