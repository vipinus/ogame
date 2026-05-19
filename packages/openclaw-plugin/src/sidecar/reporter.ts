/**
 * M4.4 — Discord Reporter.
 *
 * Pushes Markdown content to an OpenClaw-managed Discord channel via an
 * injected `send` callback. The callback is SDK-agnostic so M4.5 (sidecar
 * boot) can wire it to the real OpenClaw SDK while tests inject a `vi.fn`.
 *
 * Normal `push` is throttled — drops calls within `throttleMs` of the last
 * successful send. `pushEmergency` bypasses the throttle (e.g. fleet attack
 * alerts) and still updates `lastSendAt` so subsequent normal pushes observe
 * the emergency send.
 */

export interface ReporterOptions {
  /** OpenClaw channel id to deliver to. */
  channelId: string;
  /** Injected send callback. Sidecar (M4.5) wires this to OpenClaw SDK; tests inject a vi.fn. */
  send: (channelId: string, content: string) => Promise<void>;
  /** Throttle for normal pushes. Defaults to 5000 ms — at most one normal push per 5s. */
  throttleMs?: number;
  /** Optional clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface ReporterStats {
  sent: number;
  dropped: number;
  emergencies: number;
  lastSendAt: number;
}

export class Reporter {
  private readonly channelId: string;
  private readonly send: (channelId: string, content: string) => Promise<void>;
  private readonly throttleMs: number;
  private readonly now: () => number;

  private lastSendAt = Number.NEGATIVE_INFINITY;
  private sentCount = 0;
  private droppedCount = 0;
  private emergencyCount = 0;

  constructor(opts: ReporterOptions) {
    this.channelId = opts.channelId;
    this.send = opts.send;
    this.throttleMs = opts.throttleMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Normal throttled push. Returns `true` if the message was sent,
   * `false` if it was dropped by the throttle or the send rejected.
   */
  async push(content: string): Promise<boolean> {
    const now = this.now();
    if (now - this.lastSendAt < this.throttleMs) {
      this.droppedCount += 1;
      return false;
    }

    try {
      await this.send(this.channelId, content);
      this.lastSendAt = this.now();
      this.sentCount += 1;
      return true;
    } catch (err) {
      console.error("[Reporter] send failed", err);
      return false;
    }
  }

  /**
   * Emergency push — bypasses the throttle and always attempts a send.
   * Updates `lastSendAt` on success so subsequent normal pushes correctly
   * see the emergency send. Re-throws on failure so the caller may retry.
   */
  async pushEmergency(content: string): Promise<void> {
    try {
      await this.send(this.channelId, content);
      this.lastSendAt = this.now();
      this.emergencyCount += 1;
    } catch (err) {
      console.error("[Reporter] send failed", err);
      throw err;
    }
  }

  stats(): ReporterStats {
    return {
      sent: this.sentCount,
      dropped: this.droppedCount,
      emergencies: this.emergencyCount,
      lastSendAt: this.lastSendAt,
    };
  }
}
