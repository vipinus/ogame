import type { UpstreamMsg, DownstreamMsg } from "@ogamex/shared";

/**
 * BridgeClient — userscript-side WS client to the OpenClaw plugin sidecar.
 *
 * Auth: the browser WebSocket API does NOT allow custom headers, so we
 * smuggle the bearer token via the `Sec-WebSocket-Protocol` field, encoded
 * as `bearer.<token>`. The plugin sidecar (M4.2 WsServer) is expected to
 * recognise this subprotocol on the upgrade request. In tests we inject
 * the `ws` package's WebSocket which honours the same `(url, protocols)`
 * 2-arg signature, so the same code path is exercised end-to-end.
 *
 * Reconnect: exponential backoff with ±20% jitter, doubling from
 * `initialBackoffMs` up to `maxBackoffMs`. `stop()` cancels any pending
 * reconnect and prevents further reconnects.
 */

export interface BridgeClientOptions {
  /** Injectable WebSocket constructor — production uses browser global WebSocket;
   *  tests inject a server-spawned ws client. Subtype `typeof WebSocket`. */
  WebSocketCtor?: typeof WebSocket;

  /** Whether to auto-reconnect on close. Default true. */
  reconnectOnLoss?: boolean;

  /** Initial reconnect backoff in ms. Default 1000. Doubles up to maxBackoffMs. */
  initialBackoffMs?: number;

  /** Maximum reconnect backoff. Default 30000. */
  maxBackoffMs?: number;

  /** Buffer messages while disconnected; flush on reconnect. Default true. */
  replayOnReconnect?: boolean;

  /** Max queued messages before oldest is dropped. Default 100. */
  maxQueueSize?: number;
}

export type BridgeStatus =
  | "disconnected"
  | "connecting"
  | "open"
  | "reconnecting"
  | "stopped";

type DownstreamType = DownstreamMsg["type"];
type DownstreamHandler<T extends DownstreamType> = (
  msg: Extract<DownstreamMsg, { type: T }>,
) => void;
type HandlerMap = { [K in DownstreamType]?: Set<DownstreamHandler<K>> };

// Constants
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const JITTER_FRACTION = 0.2;

// Minimal structural type for the parts of WebSocket we use. Keeps tests free
// of the global DOM type while remaining assignable from both `lib.dom.d.ts`'s
// `WebSocket` and the `ws` package's `WebSocket`.
interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  removeEventListener?(type: string, listener: (ev: unknown) => void): void;
  // `ws` exposes EventEmitter-style on/off; the browser global exposes
  // addEventListener. We bind via whichever is available.
  on?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
}

// readyState constants (mirrors WebSocket.OPEN etc.)
const WS_OPEN = 1;

export class BridgeClient {
  readonly reconnectOnLoss: boolean;

  private readonly WSCtor: typeof WebSocket;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private ws: SocketLike | null = null;
  private state: BridgeStatus = "disconnected";
  private handlers: HandlerMap = {};

  private currentUrl: string | null = null;
  private currentToken: string | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextBackoffMs: number;

  private readonly replayOnReconnect: boolean;
  private readonly maxQueueSize: number;
  private queue: UpstreamMsg[] = [];
  private dropped = 0;

  constructor(opts: BridgeClientOptions = {}) {
    const ctor = opts.WebSocketCtor
      ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    if (!ctor) {
      throw new Error(
        "[BridgeClient] no WebSocket constructor available (provide opts.WebSocketCtor)",
      );
    }
    this.WSCtor = ctor;
    this.reconnectOnLoss = opts.reconnectOnLoss ?? true;
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.nextBackoffMs = this.initialBackoffMs;
    this.replayOnReconnect = opts.replayOnReconnect ?? true;
    this.maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  /** Resolves once the first 'open' event fires. Rejects on initial connect error. */
  connect(url: string, token: string): Promise<void> {
    this.currentUrl = url;
    this.currentToken = token;
    this.nextBackoffMs = this.initialBackoffMs;
    return this.openSocket();
  }

  /**
   * Send an UpstreamMsg.
   *
   * - If OPEN: forwards immediately.
   * - Else if `replayOnReconnect` is enabled and the client is not stopped:
   *   the message is buffered into an in-memory queue and flushed on the next
   *   `open` transition. When the queue exceeds `maxQueueSize`, the OLDEST
   *   queued message is evicted and `droppedCount()` increments (FIFO eviction
   *   preserves the most-recent intent of the caller).
   * - Else (stopped, or replay disabled): drops with a warning.
   */
  send(msg: UpstreamMsg): void {
    const ws = this.ws;
    if (this.state === "open" && ws && ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    if (this.replayOnReconnect && this.state !== "stopped") {
      this.queue.push(msg);
      if (this.queue.length > this.maxQueueSize) {
        this.queue.shift();
        this.dropped++;
        // eslint-disable-next-line no-console
        console.warn("[BridgeClient] queue overflow, dropped oldest");
      }
      return;
    }
    const st = this.state;
    // eslint-disable-next-line no-console
    console.warn(`[BridgeClient] send dropped, status=${st}`);
  }

  /** Test/inspection: number of queued messages awaiting replay. */
  queuedCount(): number { return this.queue.length; }

  /** Test/inspection: number of messages dropped due to queue overflow. */
  droppedCount(): number { return this.dropped; }

  /** Subscribe to a downstream message type. Returns an unsubscribe fn. */
  on<T extends DownstreamType>(type: T, handler: DownstreamHandler<T>): () => void {
    let set = this.handlers[type] as Set<DownstreamHandler<T>> | undefined;
    if (!set) {
      set = new Set<DownstreamHandler<T>>();
      (this.handlers as Record<string, Set<DownstreamHandler<T>>>)[type] = set;
    }
    set.add(handler);
    return () => { set?.delete(handler); };
  }

  /** Stop client and disable reconnect. Clears any pending replay queue.
   *  Idempotent. */
  stop(): void {
    this.state = "stopped";
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  status(): BridgeStatus { return this.state; }

  // --- internals ---

  private openSocket(): Promise<void> {
    if (this.state === "stopped") {
      return Promise.reject(new Error("[BridgeClient] stopped"));
    }
    const url = this.currentUrl;
    const token = this.currentToken;
    if (url === null || token === null) {
      return Promise.reject(new Error("[BridgeClient] connect() not called"));
    }

    this.state = "connecting";

    // Subprotocol-based auth — see file-level docblock. We pass the protocols
    // as the 2nd positional arg, which matches both the browser DOM API and
    // the `ws` package's client constructor.
    const protocol = `bearer.${token}`;
    const Ctor = this.WSCtor as unknown as new (
      url: string | URL,
      protocols?: string | string[],
    ) => SocketLike;
    let ws: SocketLike;
    try {
      ws = new Ctor(url, protocol);
    } catch (e) {
      this.state = "disconnected";
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const onOpen = (): void => {
        if (settled) return;
        settled = true;
        this.state = "open";
        this.nextBackoffMs = this.initialBackoffMs;
        // Drain any messages that were queued while we were disconnected /
        // reconnecting. We splice() once up-front so any failure mid-flush
        // does not re-enqueue and create an infinite loop on the next open.
        const toFlush = this.queue.splice(0);
        for (const m of toFlush) {
          try { this.ws!.send(JSON.stringify(m)); }
          catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[BridgeClient] replay send failed", e);
          }
        }
        resolve();
      };

      const onMessage = (evOrData: unknown): void => {
        // Browser fires MessageEvent (with .data); `ws` fires (data, isBinary).
        let text: string | null = null;
        const ev = evOrData as { data?: unknown };
        if (ev && typeof ev === "object" && "data" in ev) {
          const d = ev.data;
          if (typeof d === "string") text = d;
          else if (d instanceof ArrayBuffer) text = bufToString(d);
        } else if (typeof evOrData === "string") {
          text = evOrData;
        } else if (evOrData instanceof ArrayBuffer) {
          text = bufToString(evOrData);
        } else if (evOrData && typeof (evOrData as { toString?: () => string }).toString === "function") {
          // `ws` passes a Buffer.
          try { text = (evOrData as { toString: () => string }).toString(); }
          catch { text = null; }
        }
        if (text === null) return;
        this.dispatchMessage(text);
      };

      const onClose = (): void => {
        if (this.ws !== ws) return; // a newer socket has taken over
        this.ws = null;
        if (this.state === "stopped") return;
        if (!settled) {
          settled = true;
          // Initial connect failed before open — surface as rejection.
          this.state = "disconnected";
          reject(new Error("[BridgeClient] connection closed before open"));
          // If reconnect is enabled, still schedule a retry so callers
          // who fire-and-forget the connect() promise can recover.
          if (this.reconnectOnLoss) this.scheduleReconnect();
          return;
        }
        if (this.reconnectOnLoss) {
          this.state = "reconnecting";
          this.scheduleReconnect();
        } else {
          this.state = "disconnected";
        }
      };

      const onError = (_e: unknown): void => {
        // Errors on a ws always precede a close; let onClose handle state.
      };

      // Bind using whichever API is available. Use Event-style first (browser),
      // fall back to EventEmitter-style (`ws` Node client).
      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
      } else if (typeof ws.on === "function") {
        ws.on("open", onOpen);
        ws.on("message", onMessage);
        ws.on("close", onClose);
        ws.on("error", onError);
      } else {
        settled = true;
        this.state = "disconnected";
        reject(new Error("[BridgeClient] socket has neither addEventListener nor on()"));
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.state === "stopped") return;
    if (this.reconnectTimer !== null) return;
    const base = this.nextBackoffMs;
    // ±20% jitter
    const jitter = base * JITTER_FRACTION;
    const delay = Math.max(0, base + (Math.random() * 2 - 1) * jitter);
    this.nextBackoffMs = Math.min(this.maxBackoffMs, base * 2);
    this.state = "reconnecting";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === "stopped") return;
      // Fire-and-forget; openSocket handles its own state transitions.
      this.openSocket().catch(() => { /* next close will reschedule */ });
    }, delay);
  }

  private dispatchMessage(text: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
      // eslint-disable-next-line no-console
      console.warn("[BridgeClient] dropping malformed message");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string") return;
    const set = (this.handlers as Record<string, Set<(m: DownstreamMsg) => void> | undefined>)[type];
    if (!set) return;
    for (const h of set) {
      try { h(parsed as DownstreamMsg); }
      catch {
        // eslint-disable-next-line no-console
        console.warn(`[BridgeClient] handler for '${type}' threw; continuing`);
      }
    }
  }
}

function bufToString(b: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(b);
}
