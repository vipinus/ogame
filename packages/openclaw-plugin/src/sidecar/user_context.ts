/**
 * Per-request user_id context, propagated via AsyncLocalStorage.
 *
 * Phase 9a — when a push arrives with a Bearer token that maps to a
 * Postgres user_id (via user_settings.bridge_token), the HTTP handler
 * `als.run(userId, ...)` wraps the rest of the request. Every shadow
 * write deep inside priorityMerger / saveCoordinator / failureAggregator
 * reads `getCurrentUserId()` to know "this mutation belongs to user X".
 *
 * Falls back to OGAMEX_OPERATOR_USER_ID env for paths NOT triggered by
 * an authenticated push (boot hydrate, timer ticks, etc.).
 */

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<{ userId: string }>();

export function runWithUser<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}

export function getCurrentUserId(): string | undefined {
  return als.getStore()?.userId;
}

/** Resolve current user_id, falling back to the env-default if no
 *  request context is active. Empty string return means "no user known". */
export function resolveUserIdOrEnv(envDefault: string): string {
  return getCurrentUserId() ?? envDefault;
}
