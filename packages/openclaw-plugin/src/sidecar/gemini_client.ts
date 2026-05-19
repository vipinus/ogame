/**
 * Direct HTTPS client for Google's Gemini API
 * (`generativelanguage.googleapis.com`).
 *
 * Bypasses OpenClaw's agent loop (~23s E2E) for low-latency LLM planning calls.
 * Direct call to `gemini-2.5-flash` is typically 1-3s. Supports plain-text
 * generation and structured-output JSON via `responseMimeType` + `responseSchema`.
 *
 * Note: `timeoutMs` honored via `AbortSignal.timeout` (Node 18+/20+/22+).
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 30000;

export interface GeminiClientOptions {
  apiKey: string;
  /** Default `"gemini-2.5-flash"`. */
  model?: string;
  /** Default `"https://generativelanguage.googleapis.com"`. Test override. */
  baseUrl?: string;
  /** Default 30000. Routed through `AbortSignal.timeout`. */
  timeoutMs?: number;
  /** Injectable fetch — tests inject a `vi.fn`; production uses global fetch. */
  fetch?: typeof fetch;
}

export interface GeminiGenerateOptions {
  systemInstruction?: string;
  temperature?: number;
  responseMimeType?: "application/json" | "text/plain";
  /** JSON-schema-shaped object; passed verbatim into `generationConfig.responseSchema`. */
  responseSchema?: object;
}

export class GeminiApiError extends Error {
  public override readonly name = "GeminiApiError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly raw?: unknown,
  ) {
    super(message);
  }
}

interface GeminiRequestBody {
  contents: Array<{ role: "user"; parts: Array<{ text: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    responseMimeType?: "application/json" | "text/plain";
    responseSchema?: object;
  };
}

interface GeminiResponseShape {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `fetch` may not exist on very old Node — guard with global cast.
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch);
  }

  /** Plain-text generation. Returns the model's text output. */
  async generate(prompt: string, gen?: GeminiGenerateOptions): Promise<string> {
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = this.buildBody(prompt, gen);

    const signal = this.makeSignal();
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    };

    const res = await this.fetchImpl(url, init);

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }

    if (!res.ok) {
      throw new GeminiApiError(`HTTP ${res.status}: ${res.statusText}`, res.status, payload);
    }

    const text = extractText(payload);
    if (text === undefined) {
      throw new GeminiApiError("empty response", res.status, payload);
    }
    return text;
  }

  /**
   * Structured JSON generation. Forces `responseMimeType=application/json` and
   * passes `responseSchema` verbatim. Throws `GeminiApiError` on HTTP failure,
   * or `SyntaxError` if the model returns malformed JSON.
   */
  async generateJson<T = unknown>(
    prompt: string,
    schema: object,
    gen?: Omit<GeminiGenerateOptions, "responseMimeType" | "responseSchema">,
  ): Promise<T> {
    const merged: GeminiGenerateOptions = {
      ...(gen ?? {}),
      responseMimeType: "application/json",
      responseSchema: schema,
    };
    const text = await this.generate(prompt, merged);
    return JSON.parse(text) as T;
  }

  // --- internals ---------------------------------------------------------

  private buildBody(prompt: string, gen?: GeminiGenerateOptions): GeminiRequestBody {
    const body: GeminiRequestBody = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };

    if (gen?.systemInstruction !== undefined) {
      body.systemInstruction = { parts: [{ text: gen.systemInstruction }] };
    }

    const genCfg: NonNullable<GeminiRequestBody["generationConfig"]> = {};
    let hasGenCfg = false;
    if (gen?.temperature !== undefined) {
      genCfg.temperature = gen.temperature;
      hasGenCfg = true;
    }
    if (gen?.responseMimeType !== undefined) {
      genCfg.responseMimeType = gen.responseMimeType;
      hasGenCfg = true;
    }
    if (gen?.responseSchema !== undefined) {
      genCfg.responseSchema = gen.responseSchema;
      hasGenCfg = true;
    }
    if (hasGenCfg) body.generationConfig = genCfg;

    return body;
  }

  private makeSignal(): AbortSignal | undefined {
    // AbortSignal.timeout exists on Node 17.3+. Guard for older runtimes.
    const tos = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
    if (typeof tos === "function") return tos(this.timeoutMs);
    return undefined;
  }
}

function extractText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const shaped = payload as GeminiResponseShape;
  const cand = shaped.candidates?.[0];
  const part = cand?.content?.parts?.[0];
  const text = part?.text;
  return typeof text === "string" ? text : undefined;
}
