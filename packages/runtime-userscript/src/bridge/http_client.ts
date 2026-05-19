import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

/**
 * HttpBridgeClient — userscript-side HTTP long-poll client for the M4.3
 * sidecar fallback. Mirrors {@link BridgeClient}'s public surface so callers
 * can transparently swap transports (see {@link DualBridgeClient}).
 *
 * Auth: a Bearer token is sent in the `Authorization` header on every request.
 * Endpoints (matching server M4.3):
 *   - `POST {baseUrl}/ogamex/v1/push` with body = UpstreamMsg JSON
 *   - `POST {baseUrl}/ogamex/v1/poll` with body = `{since_ts}` →
 *     response `{messages: DownstreamMsg[]}`.
 *
 * The poll loop runs as a self-chained async cycle (NOT setInterval): each
 * `pollOnce()` schedules the next call only after the previous one completes,
 * giving natural backpressure. On HTTP failure the client transitions to
 * `error` state, waits `errorBackoffMs`, then retries.
 */

export interface HttpClientOptions {
  /** Injectable fetch — tests stub this. Default: `globalThis.fetch.bind(globalThis)`. */
  fetch?: typeof fetch;
  /** Poll timeout suggestion to server (ms). Default 25000 (under server's 30s default). */
  pollTimeoutHintMs?: number;
  /** Backoff (ms) between failed polls. Default 2000. */
  errorBackoffMs?: number;
}

export type HttpClientStatus = "disconnected" | "connecting" | "open" | "error" | "stopped";

type DownstreamType = DownstreamMsg["type"];
type DownstreamHandler<T extends DownstreamType> = (
  msg: Extract<DownstreamMsg, { type: T }>,
) => void;
type HandlerMap = { [K in DownstreamType]?: Set<DownstreamHandler<K>> };

const DEFAULT_POLL_TIMEOUT_HINT_MS = 25000;
const DEFAULT_ERROR_BACKOFF_MS = 2000;

export class HttpBridgeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutHintMs: number;
  private readonly errorBackoffMs: number;

  private state: HttpClientStatus = "disconnected";
  private handlers: HandlerMap = {};

  private baseUrl: string | null = null;
  private token: string | null = null;

  /** Highest server-side ts we've seen — sent as `since_ts` to dedupe. */
  private lastPollTs = 0;

  private currentAbort: AbortController | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: HttpClientOptions = {}) {
    const f = opts.fetch
      ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
    if (!f) {
      throw new Error(
        "[HttpBridgeClient] no fetch available (provide opts.fetch)",
      );
    }
    this.fetchImpl = f;
    this.pollTimeoutHintMs = opts.pollTimeoutHintMs ?? DEFAULT_POLL_TIMEOUT_HINT_MS;
    this.errorBackoffMs = opts.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS;
  }

  /**
   * Establishes the poll loop. Unlike WS we have no "open" handshake, so
   * the client is considered open as soon as connect() is called and the
   * poll loop is scheduled. The promise resolves synchronously after that.
   */
  connect(baseUrl: string, token: string): Promise<void> {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.state = "open";
    // Fire-and-forget — pollOnce() is self-scheduling.
    void this.pollLoop();
    return Promise.resolve();
  }

  send(msg: UpstreamMsg): Promise<void> {
    if (this.state === "stopped") {
      return Promise.reject(new Error("[HttpBridgeClient] stopped"));
    }
    const baseUrl = this.baseUrl;
    const token = this.token;
    if (baseUrl === null || token === null) {
      return Promise.reject(new Error("[HttpBridgeClient] connect() not called"));
    }
    return this.fetchImpl(`${baseUrl}/ogamex/v1/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(msg),
    }).then((res) => {
      if (!res.ok) {
        throw new Error(`[HttpBridgeClient] /push HTTP ${res.status}`);
      }
    });
  }

  on<T extends DownstreamType>(type: T, handler: DownstreamHandler<T>): () => void {
    let set = this.handlers[type] as Set<DownstreamHandler<T>> | undefined;
    if (!set) {
      set = new Set<DownstreamHandler<T>>();
      (this.handlers as Record<string, Set<DownstreamHandler<T>>>)[type] = set;
    }
    set.add(handler);
    return () => { set?.delete(handler); };
  }

  stop(): void {
    this.state = "stopped";
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    const ac = this.currentAbort;
    this.currentAbort = null;
    if (ac) {
      try { ac.abort(); } catch { /* ignore */ }
    }
  }

  status(): HttpClientStatus { return this.state; }

  // --- internals ---------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.state !== "stopped") {
      const cont = await this.pollOnce();
      if (!cont) break;
    }
  }

  /** Performs one poll cycle. Returns false iff the loop should exit. */
  private async pollOnce(): Promise<boolean> {
    if ((this.state as HttpClientStatus) === "stopped") return false;
    const baseUrl = this.baseUrl;
    const token = this.token;
    if (baseUrl === null || token === null) return false;

    const ac = new AbortController();
    this.currentAbort = ac;

    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/ogamex/v1/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          since_ts: this.lastPollTs,
          timeout_ms: this.pollTimeoutHintMs,
        }),
        signal: ac.signal,
      });
    } catch (e) {
      // Aborted via stop() — exit cleanly.
      if ((this.state as HttpClientStatus) === "stopped") return false;
      // Network error → enter error state, back off, retry.
      void e;
      return this.handleErrorAndBackoff();
    } finally {
      if (this.currentAbort === ac) this.currentAbort = null;
    }

    if ((this.state as HttpClientStatus) === "stopped") return false;

    if (!res.ok) {
      return this.handleErrorAndBackoff();
    }

    let parsed: unknown;
    try { parsed = await res.json(); }
    catch {
      return this.handleErrorAndBackoff();
    }

    if ((this.state as HttpClientStatus) === "stopped") return false;

    // Successful response — back to open.
    if (this.state !== "open") this.state = "open";

    const messages = (parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages))
      ? (parsed as { messages: unknown[] }).messages
      : [];

    for (const m of messages) {
      this.dispatchMessage(m);
    }
    // Advance the cursor unconditionally so we don't replay messages.
    this.lastPollTs = Date.now();
    return true;
  }

  private handleErrorAndBackoff(): Promise<boolean> {
    if (this.state !== "stopped") this.state = "error";
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        this.backoffTimer = null;
        if (this.state === "stopped") { resolve(false); return; }
        resolve(true);
      }, this.errorBackoffMs);
      this.backoffTimer = t;
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
    });
  }

  private dispatchMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const type = (msg as { type?: unknown }).type;
    if (typeof type !== "string") return;
    const set = (this.handlers as Record<string, Set<(m: DownstreamMsg) => void> | undefined>)[type];
    if (!set) return;
    for (const h of set) {
      try { h(msg as DownstreamMsg); }
      catch {
        // eslint-disable-next-line no-console
        console.warn(`[HttpBridgeClient] handler for '${type}' threw; continuing`);
      }
    }
  }
}
