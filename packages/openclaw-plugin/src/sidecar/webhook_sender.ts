/**
 * Phase 9c.8 — Direct Discord webhook poster.
 *
 * Per-user notification routing: paid SaaS users supply their own Discord
 * webhook URL via `user_settings.discord_webhook_url` (stored in PG). The
 * sidecar's Reporter normally fans messages to a SINGLE OpenClaw-managed
 * channel (operator's), so this module gives us a parallel send-path for
 * arbitrary webhook URLs without the OpenClaw SDK.
 *
 * Discord webhook contract: POST application/json `{ content: <markdown> }`.
 * 2KB limit per message — caller is responsible for truncation.
 */

const MAX_CONTENT = 1900; // Discord caps at 2000; leave headroom for emoji bytes.

export interface WebhookSenderOptions {
  /** Optional fetch impl override (tests). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Default 10s — Discord SLA is usually well under. */
  timeoutMs?: number;
}

/**
 * Build a `send(channelId, content)` callback bound to a single webhook URL.
 *
 * The Reporter API treats its `send` arg as `(channelId, content) => Promise`.
 * For webhook mode `channelId` is unused (URL already specifies the channel);
 * we discard it so existing Reporter callsites work unchanged.
 */
export function buildWebhookSend(
  webhookUrl: string,
  opts: WebhookSenderOptions = {},
): (channelId: string, content: string) => Promise<void> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (!fetchImpl) {
    throw new Error("[webhook_sender] fetch is not available in this runtime");
  }

  return async function send(_channelId: string, content: string): Promise<void> {
    // Truncate eagerly — Discord 400s the whole request on overflow.
    const body = content.length > MAX_CONTENT
      ? content.slice(0, MAX_CONTENT - 3) + "..."
      : content;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: body }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`[webhook_sender] discord ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
