import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GoalsStore } from "../../src/sidecar/goals_store.js";
import { GeminiApiError, GeminiClient } from "../../src/sidecar/gemini_client.js";
import { makeAddGoalTool } from "../../src/tools/add_goal.js";

/**
 * GeminiClient is mocked by injecting a stub `fetch` that returns the desired
 * model output (a JSON string inside the `candidates[0].content.parts[0].text`
 * field). For one error path we instead build a client whose `generateJson`
 * is replaced with a vi.fn rejection.
 */

function makeFakeFetch(jsonText: string, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: jsonText }], role: "model" }, finishReason: "STOP" }],
        }),
        { status, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

describe("makeAddGoalTool", () => {
  let store: GoalsStore;

  beforeEach(() => {
    store = new GoalsStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  it("happy path: parses NL, stores pending Goal, returns confirmation prompt", async () => {
    const fakeFetch = makeFakeFetch(
      JSON.stringify({ type: "research", target_json: JSON.stringify({ tech: "gravitation", level: 6 }), priority: 7 }),
    );
    const gemini = new GeminiClient({ apiKey: "k", fetch: fakeFetch });
    const tool = makeAddGoalTool({ gemini, store });

    const result = await tool.execute({ natural_language: "母星出引力 6" });

    expect("error" in result).toBe(false);
    if ("error" in result) return; // type guard

    expect(result.parsed_goal.type).toBe("research");
    expect(result.parsed_goal.target).toEqual({ tech: "gravitation", level: 6 });
    expect(result.parsed_goal.status).toBe("pending");
    expect(result.parsed_goal.progress_pct).toBe(0);
    expect(result.parsed_goal.current_step).toBe("awaiting confirmation");
    expect(result.parsed_goal.eta_at).toBeNull();
    expect(result.parsed_goal.priority).toBe(7); // from parsed
    expect(result.pending_action_id).toBe(result.parsed_goal.id);
    expect(result.confirmation_prompt).toContain("research");
    expect(result.confirmation_prompt).toContain("priority=7");

    // Verify it was actually stored.
    const stored = store.get(result.pending_action_id);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("pending");
    expect(stored!.goal.type).toBe("research");
  });

  it("explicit params.priority overrides parsed priority", async () => {
    const fakeFetch = makeFakeFetch(
      JSON.stringify({ type: "research", target_json: JSON.stringify({ tech: "gravitation", level: 6 }), priority: 3 }),
    );
    const gemini = new GeminiClient({ apiKey: "k", fetch: fakeFetch });
    const tool = makeAddGoalTool({ gemini, store });

    const result = await tool.execute({ natural_language: "x", priority: 9 });
    if ("error" in result) throw new Error("unexpected error");

    expect(result.parsed_goal.priority).toBe(9);
  });

  it("falls back to priority=5 when neither caller nor model supply one", async () => {
    const fakeFetch = makeFakeFetch(
      JSON.stringify({ type: "research", target_json: JSON.stringify({ tech: "gravitation", level: 6 }) }),
    );
    const gemini = new GeminiClient({ apiKey: "k", fetch: fakeFetch });
    const tool = makeAddGoalTool({ gemini, store });

    const result = await tool.execute({ natural_language: "x" });
    if ("error" in result) throw new Error("unexpected error");

    expect(result.parsed_goal.priority).toBe(5);
  });

  it("returns error envelope on malformed JSON from model (SyntaxError path)", async () => {
    const fakeFetch = makeFakeFetch("not-json-at-all");
    const gemini = new GeminiClient({ apiKey: "k", fetch: fakeFetch });
    const tool = makeAddGoalTool({ gemini, store });

    const result = await tool.execute({ natural_language: "garbage" });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/malformed JSON/);

    // Nothing should have been stored.
    expect(store.list()).toHaveLength(0);
  });

  it("returns error envelope on GeminiApiError", async () => {
    const failingFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const gemini = new GeminiClient({ apiKey: "k", fetch: failingFetch });
    const tool = makeAddGoalTool({ gemini, store });

    const result = await tool.execute({ natural_language: "x" });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/gemini api error/);
    expect(store.list()).toHaveLength(0);
    // Sanity: GeminiApiError is the type the prod code branches on.
    expect(new GeminiApiError("e", 500)).toBeInstanceOf(GeminiApiError);
  });

  it("rejects unsupported goal type from the model", async () => {
    const fakeFetch = makeFakeFetch(
      JSON.stringify({ type: "definitely_not_a_goal_type", target_json: "{}" }),
    );
    const gemini = new GeminiClient({ apiKey: "k", fetch: fakeFetch });
    const tool = makeAddGoalTool({ gemini, store });

    const result = await tool.execute({ natural_language: "x" });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/unsupported goal type/);
    expect(store.list()).toHaveLength(0);
  });
});
