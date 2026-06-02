/**
 * Phase 5 env knob for SQLite → PG migration.
 *
 *   sqlite (default): primary reads from SQLite. PG shadow-writes only.
 *                     Pre-migration behavior, zero risk of regressing.
 *   dual:             reads SQLite (primary, return), fires PG read in
 *                     shadow, diffs result, logs drift. No latency impact
 *                     on hot path (PG read is fire-and-forget).
 *                     Phase 5 production observation mode — run 7 days
 *                     to confirm zero drift before flipping.
 *   pg:               primary reads from PG. SQLite becomes shadow-write.
 *                     Phase 6 flip. PG outage → sidecar degraded.
 *
 * Operator pivots the mode via OGAMEX_DB_MODE env, then SIGTERM the
 * sidecar (systemd respawn). No code redeploy needed for the flip.
 */

export type DbMode = "sqlite" | "dual" | "pg";

export function resolveDbMode(env: NodeJS.ProcessEnv = process.env): DbMode {
  const raw = (env.OGAMEX_DB_MODE ?? "sqlite").toLowerCase().trim();
  if (raw === "dual" || raw === "pg" || raw === "sqlite") return raw;
  console.warn(`[ogamex/sidecar] unknown OGAMEX_DB_MODE=${raw}, falling back to "sqlite"`);
  return "sqlite";
}
