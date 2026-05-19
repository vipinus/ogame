import { Type, type Static } from "@sinclair/typebox";
import type { Directive } from "@ogamex/shared";
import { GeminiApiError, type GeminiClient } from "../sidecar/gemini_client.js";

/**
 * M5.3 — `ogame_explain_directive`.
 *
 * Asks the model for a short (2-3 sentence) plain-language explanation of a
 * stored Directive, in zh-TW. The caller injects a `lookupDirective` resolver
 * so this module stays decoupled from any specific directive store.
 */

export const ExplainDirectiveParams = Type.Object({
  directive_id: Type.String({ description: "Directive id to explain." }),
  context: Type.Optional(
    Type.Object({}, { additionalProperties: true, description: "Optional extra context for the explanation." }),
  ),
});
export type ExplainDirectiveParamsT = Static<typeof ExplainDirectiveParams>;

export interface ExplainDirectiveDeps {
  gemini: GeminiClient;
  lookupDirective: (id: string) => Directive | null;
}

export interface ExplainDirectiveResult {
  id: string;
  explanation: string;
}

export interface ExplainDirectiveDefinition {
  name: "ogame_explain_directive";
  description: string;
  parameters: typeof ExplainDirectiveParams;
  execute: (
    params: ExplainDirectiveParamsT,
  ) => Promise<ExplainDirectiveResult | { error: string }>;
}

export function makeExplainDirectiveTool(
  deps: ExplainDirectiveDeps,
): ExplainDirectiveDefinition {
  return {
    name: "ogame_explain_directive",
    description: "Produce a short zh-TW explanation of an Ogame directive.",
    parameters: ExplainDirectiveParams,
    execute: async ({ directive_id }) => {
      const directive = deps.lookupDirective(directive_id);
      if (directive === null) {
        return { error: "not found" };
      }

      const prompt = `Explain this Ogame directive in 2-3 sentences in zh-TW: ${JSON.stringify(directive)}`;

      try {
        const explanation = await deps.gemini.generate(prompt);
        return { id: directive_id, explanation };
      } catch (err) {
        if (err instanceof GeminiApiError) {
          return { error: `gemini api error: ${err.message}` };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `explain_directive failed: ${msg}` };
      }
    },
  };
}
