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
  private readonly apiKeys: string[];      // v0.0.448: rotate on 429
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiClientOptions) {
    // v0.0.448: accept comma-separated keys OR pick up siblings from env.
    // Operator 2026-05-29 "gemini 有多个key" — env has GEMINI_API_KEY,
    // GOOGLE_AI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY. Pool them all so
    // one key's quota exhaustion rotates to the next.
    const primary = (opts.apiKey ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const envSiblings = [
      process.env["GEMINI_API_KEY"],
      process.env["GOOGLE_AI_API_KEY"],
      process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
    ].filter((k): k is string => typeof k === "string" && k.length > 0);
    // de-dupe (preserve order: explicit primary first, then env)
    const seen = new Set<string>();
    this.apiKeys = [...primary, ...envSiblings].filter((k) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (this.apiKeys.length === 0) this.apiKeys = [""];  // surfaces as 401 later
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `fetch` may not exist on very old Node — guard with global cast.
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch);
  }

  /** Plain-text generation. Returns the model's text output. */
  async generate(prompt: string, gen?: GeminiGenerateOptions): Promise<string> {
    const body = this.buildBody(prompt, gen);

    // v0.0.448: per-key retry (3 attempts w/ 2s/4s/8s backoff for 429/5xx),
    // then rotate to next key in pool when this key's quota is exhausted.
    // Per-key: 2s+4s+8s = ~14s, covers per-minute burst limit.
    // Across keys: each one's daily quota is independent → 3× budget.
    const maxAttemptsPerKey = 3;
    let lastErr: GeminiApiError | undefined;
    for (let keyIdx = 0; keyIdx < this.apiKeys.length; keyIdx++) {
      const apiKey = this.apiKeys[keyIdx]!;
      const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      for (let attempt = 1; attempt <= maxAttemptsPerKey; attempt++) {
        const signal = this.makeSignal();
        const init: RequestInit = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(signal !== undefined ? { signal } : {}),
        };
        const res = await this.fetchImpl(url, init);
        let payload: unknown;
        try { payload = await res.json(); } catch { payload = undefined; }
        if (res.ok) {
          const text = extractText(payload);
          if (text === undefined) throw new GeminiApiError("empty response", res.status, payload);
          if (keyIdx > 0) console.info(`[gemini] key#${keyIdx + 1}/${this.apiKeys.length} succeeded after rotation`);
          return text;
        }
        const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        lastErr = new GeminiApiError(`HTTP ${res.status}: ${res.statusText}`, res.status, payload);
        if (!isRetryable) throw lastErr;       // 4xx (auth, bad prompt) — bail
        if (attempt === maxAttemptsPerKey) break;   // per-key exhausted → rotate
        const backoffMs = 2000 * Math.pow(2, attempt - 1);
        console.warn(`[gemini] key#${keyIdx + 1} HTTP ${res.status} attempt=${attempt} — backoff ${backoffMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
      if (keyIdx + 1 < this.apiKeys.length) {
        console.warn(`[gemini] key#${keyIdx + 1}/${this.apiKeys.length} exhausted (${lastErr?.status ?? "?"}) — rotating to next key`);
      }
    }
    throw lastErr ?? new GeminiApiError("all keys exhausted", 0);
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
    try {
      const text = await this.generate(prompt, merged);
      return JSON.parse(text) as T;
    } catch (e) {
      // v0.0.448: Gemini terminal 429 / 5xx → fallback to NVIDIA NIM
      // (OpenAI-compatible, much higher free-tier limits). Operator 2026-05-29
      // hit Gemini daily quota — retry exhausted, surface to backup model.
      const nvidiaKey = process.env["NVIDIA_API_KEY"];
      const shouldFallback = e instanceof GeminiApiError
        && (e.status === 429 || (e.status >= 500 && e.status < 600))
        && typeof nvidiaKey === "string" && nvidiaKey.length > 0;
      if (!shouldFallback) throw e;
      console.warn(`[gemini] terminal ${e instanceof GeminiApiError ? e.status : "?"} — fallback to NVIDIA NIM`);
      const text = await callNvidiaJson(nvidiaKey, prompt, schema, gen?.temperature, gen?.systemInstruction);
      return JSON.parse(text) as T;
    }
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

// v0.0.448: NVIDIA NIM is OpenAI-compatible. Free tier ~40 req/min, plenty
// for operator's NL goal parsing burst. JSON-mode via response_format.
async function callNvidiaJson(
  apiKey: string,
  prompt: string,
  schema: object,
  temperature?: number,
  systemInstruction?: string,
): Promise<string> {
  const url = "https://integrate.api.nvidia.com/v1/chat/completions";
  const messages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) messages.push({ role: "system", content: systemInstruction });
  // Embed schema in the user prompt so NVIDIA respects shape (json_object mode
  // doesn't enforce schema directly).
  messages.push({
    role: "user",
    content: `${prompt}\n\nRespond with JSON matching this schema (strict):\n${JSON.stringify(schema)}`,
  });
  const body = {
    model: "meta/llama-3.1-70b-instruct",
    messages,
    response_format: { type: "json_object" } as const,
    temperature: temperature ?? 0.2,
    max_tokens: 4096,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new GeminiApiError(`NVIDIA fallback HTTP ${res.status}: ${errText.slice(0, 200)}`, res.status, errText);
  }
  const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new GeminiApiError("NVIDIA fallback empty content", res.status, j);
  }
  console.info(`[gemini→nvidia] OK len=${content.length}`);
  return content;
}

function extractText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const shaped = payload as GeminiResponseShape;
  const cand = shaped.candidates?.[0];
  const part = cand?.content?.parts?.[0];
  const text = part?.text;
  return typeof text === "string" ? text : undefined;
}
