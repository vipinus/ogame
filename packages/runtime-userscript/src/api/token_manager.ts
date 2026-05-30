export interface TokenManagerOptions {
  /** Time-to-live for cached token in ms. Defaults to 30 min. */
  ttlMs?: number;
}

/**
 * Caches a CSRF token with TTL-bounded freshness. Self-heals via `invalidate()` +
 * subsequent `getFreshToken()` which calls the refresh callback.
 *
 * Constructed with a refresh callback that knows how to obtain a current token
 * (e.g. by reading `input[name=token]`, `window.token`, etc. — see extractors/token.ts).
 */
export class TokenManager {
  private cached: { value: string; fetchedAt: number } | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly refresh: () => string,
    opts: TokenManagerOptions = {},
  ) {
    // v0.0.464: TTL collapsed from 30min → 0 (operator 2026-05-29 found
    // root cause: stale 30min cache held an old token through hundreds of
    // build POSTs, ogame returning 100001 "未知错误" for every one because
    // restore-captured newAjaxToken was sitting in dataset but TokenManager
    // never re-read it. DOM read is cheap; correctness > micro-perf.
    this.ttlMs = opts.ttlMs ?? 0;
  }

  /**
   * Returns a fresh token. If cache is valid, returns cached value. Otherwise
   * invokes refresh() and caches the result.
   * Throws if refresh returns empty or throws.
   */
  getFreshToken(): string {
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt < this.ttlMs) {
      return this.cached.value;
    }
    const value = this.refresh();
    if (!value) throw new Error("TokenManager.refresh returned empty value");
    this.cached = { value, fetchedAt: now };
    return value;
  }

  /**
   * Drops the cache. Next getFreshToken() will call refresh() again.
   * Returns a Promise for symmetry with potential async invalidation flows.
   */
  async invalidate(): Promise<void> {
    this.cached = null;
  }

  /**
   * Force-set a known-fresh token value (e.g. after observing a sendFleet response
   * that included a new token in newAjaxToken field).
   * No-op for falsy values.
   */
  set(value: string): void {
    if (!value) return;
    this.cached = { value, fetchedAt: Date.now() };
  }
}
