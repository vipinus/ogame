/**
 * Shared async interface for goals store implementations.
 *
 * Phase 5 of SQLite → PG migration: introduces an async surface so the
 * priority_merger + http_server can target ONE interface that both the
 * SQLite-via-sync-shim AND native PG implement. dual_read_goals_store.ts
 * uses this to wrap both backends; eventual PG-only path drops the shim.
 *
 * Signature convention: every method takes userId as the FIRST param
 * (mirrors goals_store_pg.ts — multi-tenant by row, no ALS magic).
 * SQLite-side wrappers ignore userId or filter post-hoc.
 *
 * Migration order:
 *   Phase 5: wrapper exposes this async interface, internally reads SQLite
 *            sync (primary) + async PG (shadow) for drift validation.
 *   Phase 6: flip primary to PG, SQLite reads become shadow.
 *   Phase 7: delete SQLite path entirely, only PG implementer remains.
 */

import type { GoalRow, GoalStatus } from "./goals_types.js";

export interface IGoalsStoreReader {
  /** Non-terminal rows (pending|active|blocked) for a user. */
  listActiveByUser(userId: string): Promise<GoalRow[]>;
  /** All rows for a user (across all statuses). */
  listByUser(userId: string): Promise<GoalRow[]>;
  /** All rows for a user (alias of listByUser to keep parity with SQLite list()). */
  list(userId: string): Promise<GoalRow[]>;
  /** Single row lookup. */
  get(userId: string, id: string): Promise<GoalRow | null>;
  /** Rows filtered by status, scoped to user. */
  listByStatus(userId: string, status: GoalStatus): Promise<GoalRow[]>;
  /** Direct child goals (chain leg lookup) scoped to user. */
  listChildren(userId: string, parentId: string): Promise<GoalRow[]>;
  /** Ownership probe: returns userId iff the goal exists and belongs to that user. */
  ownerOf(userId: string, goalId: string): Promise<string | undefined>;
  /** Current main goal for a user. */
  getMainGoal(userId: string): Promise<GoalRow | null>;
}
