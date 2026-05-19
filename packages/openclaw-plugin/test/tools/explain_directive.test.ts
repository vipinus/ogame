import { describe, it, expect, vi } from "vitest";
import type { Directive } from "@ogamex/shared";
import { GeminiClient } from "../../src/sidecar/gemini_client.js";
import { makeExplainDirectiveTool } from "../../src/tools/explain_directive.js";

function makeDirective(overrides: Partial<Directive> = {}): Directive {
  return {
    id: "d-1",
    source: "goal",
    method: "api",
    priority: 5,
    action: "build",
    params: { building: "metal_mine", level: 12 },
    preconds: [],
    expires_at: 9_999_999_999_999,
    reason: "test",
    ...overrides,
  };
}

function makeFakeFetch(textOut: string, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: textOut }], role: "model" }, finishReason: "STOP" }],
        }),
        { status, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

describe("makeExplainDirectiveTool", () => {
  it("happy path: returns explanation from Gemini and includes directive in prompt", async () => {
    const directive = makeDirective({ id: "d-1" });
    const fakeFetch = makeFakeFetch("這個指令會把金屬礦升到 12 級。");
    const gemini = new GeminiClient({ apiKey: "k", fetch: fakeFetch });

    const tool = makeExplainDirectiveTool({
      gemini,
      lookupDirective: (id) => (id === "d-1" ? directive : null),
    });

    const result = await tool.execute({ directive_id: "d-1" });
    if ("error" in result) throw new Error("unexpected error");

    expect(result.id).toBe("d-1");
    expect(result.explanation).toBe("這個指令會把金屬礦升到 12 級。");

    // Verify the prompt embedded the directive JSON.
    const call = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const body = JSON.parse(String(call[1].body));
    const sentText = body.contents[0].parts[0].text as string;
    expect(sentText).toContain("zh-TW");
    expect(sentText).toContain("metal_mine");
  });

  it("returns error envelope when directive is not found", async () => {
    const fakeFetch = makeFakeFetch("unused");
    const gemini = new GeminiClient({ apiKey: "k", fetch: fakeFetch });

    const tool = makeExplainDirectiveTool({
      gemini,
      lookupDirective: () => null,
    });

    const result = await tool.execute({ directive_id: "nope" });
    expect(result).toEqual({ error: "not found" });
    // We must NOT have called Gemini.
    expect((fakeFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(0);
  });

  it("returns error envelope when Gemini call fails (GeminiApiError)", async () => {
    const failingFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          statusText: "Server Error",
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const gemini = new GeminiClient({ apiKey: "k", fetch: failingFetch });

    const tool = makeExplainDirectiveTool({
      gemini,
      lookupDirective: () => makeDirective({ id: "d-1" }),
    });

    const result = await tool.execute({ directive_id: "d-1" });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/gemini api error/);
  });
});
