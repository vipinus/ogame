import { describe, it, expect, vi } from "vitest";
import { GeminiClient, GeminiApiError } from "../../src/sidecar/gemini_client.js";

type FetchFn = typeof fetch;

interface StubResponseInit {
  status?: number;
  statusText?: string;
  body: unknown;
}

function stubResponse(init: StubResponseInit): Response {
  const status = init.status ?? 200;
  const statusText = init.statusText ?? (status === 200 ? "OK" : "Error");
  const text = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  // Build a minimal Response-like with json()/text()/ok/status/statusText.
  return new Response(text, {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function geminiOkBody(text: string): object {
  return {
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
}

describe("GeminiClient.generate", () => {
  it("happy path: returns extracted text and hits the right URL", async () => {
    const fakeFetch = vi.fn(async () => stubResponse({ body: geminiOkBody("hello world") })) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "test-key", fetch: fakeFetch });

    const out = await client.generate("ping");
    expect(out).toBe("hello world");

    expect((fakeFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
    const call = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const url = call[0];
    expect(url).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(url).toContain("key=test-key");
    expect(url.startsWith("https://generativelanguage.googleapis.com")).toBe(true);
  });

  it("custom model is reflected in URL", async () => {
    const fakeFetch = vi.fn(async () => stubResponse({ body: geminiOkBody("x") })) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "k", model: "gemini-2.5-pro", fetch: fakeFetch });
    await client.generate("p");
    const url = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![0];
    expect(url).toContain("/v1beta/models/gemini-2.5-pro:generateContent");
  });

  it("custom baseUrl is honored", async () => {
    const fakeFetch = vi.fn(async () => stubResponse({ body: geminiOkBody("x") })) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "k", baseUrl: "https://example.test", fetch: fakeFetch });
    await client.generate("p");
    const url = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![0];
    expect(url.startsWith("https://example.test/v1beta/models/")).toBe(true);
  });

  it("omits optional fields when not provided", async () => {
    const fakeFetch = vi.fn(async () => stubResponse({ body: geminiOkBody("x") })) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "k", fetch: fakeFetch });
    await client.generate("hi");

    const call = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const init = call[1];
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect("generationConfig" in body).toBe(false);
    expect("systemInstruction" in body).toBe(false);
  });

  it("passes through all gen options when provided", async () => {
    const fakeFetch = vi.fn(async () => stubResponse({ body: geminiOkBody("x") })) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "k", fetch: fakeFetch });
    const schema = { type: "object", properties: { a: { type: "string" } } } as const;
    await client.generate("hi", {
      temperature: 0.7,
      systemInstruction: "be terse",
      responseMimeType: "application/json",
      responseSchema: schema,
    });

    const call = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const body = JSON.parse(String(call[1].body));
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(body.generationConfig.temperature).toBe(0.7);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(schema);
  });

  it("throws GeminiApiError on non-2xx", async () => {
    const fakeFetch = vi.fn(async () =>
      stubResponse({
        status: 400,
        statusText: "Bad Request",
        body: { error: { message: "bad request" } },
      }),
    ) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "k", fetch: fakeFetch });

    await expect(client.generate("hi")).rejects.toMatchObject({
      name: "GeminiApiError",
      status: 400,
    });
    await expect(client.generate("hi")).rejects.toBeInstanceOf(GeminiApiError);
  });
});

describe("GeminiClient.generateJson", () => {
  it("happy path: parses JSON, sets responseMimeType + responseSchema in body", async () => {
    const fakeFetch = vi.fn(async () =>
      stubResponse({ body: geminiOkBody('{"goal":"research","target":"gravity"}') }),
    ) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "k", fetch: fakeFetch });

    const schema = {
      type: "object",
      properties: { goal: { type: "string" }, target: { type: "string" } },
      required: ["goal", "target"],
    };

    const out = await client.generateJson<{ goal: string; target: string }>("plan it", schema);
    expect(out).toEqual({ goal: "research", target: "gravity" });

    const call = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const body = JSON.parse(String(call[1].body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(schema);
  });

  it("throws SyntaxError when model returns malformed JSON", async () => {
    const fakeFetch = vi.fn(async () => stubResponse({ body: geminiOkBody("not json") })) as unknown as FetchFn;
    const client = new GeminiClient({ apiKey: "k", fetch: fakeFetch });

    await expect(client.generateJson("p", { type: "object" })).rejects.toBeInstanceOf(SyntaxError);
  });
});
