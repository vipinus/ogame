export interface Emitter {
  emit(type: string, payload: unknown): void;
}

export interface XhrContext {
  fetch: typeof fetch;
}

/**
 * Wraps ctx.fetch so that ogame ajax responses are emitted on the bus.
 * Never throws; never alters the response returned to the caller.
 */
export function installXhrHook(ctx: XhrContext, emitter: Emitter): void {
  const origFetch = ctx.fetch.bind(ctx);
  ctx.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const res = await origFetch(input as any, init);
    try {
      if (url.includes("/game/index.php")) {
        const clone = res.clone();
        const ct = clone.headers.get("content-type") ?? "";
        let body: unknown;
        if (ct.includes("json")) {
          body = await clone.json().catch(() => null);
        } else {
          body = await clone.text().catch(() => null);
        }
        try {
          emitter.emit("xhr.response", { url, status: res.status, body });
        } catch {
          /* swallow emitter errors — never break fetch */
        }
      }
    } catch {
      /* swallow probe errors */
    }
    return res;
  }) as typeof fetch;
}
