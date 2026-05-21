import Database from "better-sqlite3";
import type { Goal } from "@ogamex/shared";

/**
 * Status values tracked by the store. Narrower than @ogamex/shared GoalStatus
 * (we drop "pending_confirm") because this store represents the goal-manager's
 * execution state, not the negotiation lifecycle.
 *
 * Terminal: completed, cancelled. Non-terminal (returned by listActive):
 * pending, active, blocked.
 */
export type GoalStatus = "pending" | "active" | "blocked" | "completed" | "cancelled";

const NON_TERMINAL: readonly GoalStatus[] = ["pending", "active", "blocked"];

export interface GoalRow {
  goal: Goal;
  status: GoalStatus;
  reason?: string;
  created_at: number;
  updated_at: number;
}

export interface GoalsStoreOptions {
  /** Path to SQLite db file. Use ":memory:" for tests. */
  dbPath: string;
  /** Optional injectable clock returning ms epoch. Defaults to Date.now. */
  clock?: () => number;
}

interface RawRow {
  id: string;
  goal_json: string;
  status: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS goals (
    id          TEXT PRIMARY KEY,
    goal_json   TEXT NOT NULL,
    status      TEXT NOT NULL,
    reason      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_goals_status  ON goals(status);
  CREATE INDEX IF NOT EXISTS idx_goals_created ON goals(created_at DESC);
`;

/**
 * Synchronous SQLite-backed CRUD store for user-defined goals (M5.1).
 *
 * Each row carries a full Goal JSON payload plus the goal-manager's status,
 * an optional human reason (e.g. "blocked: need gravitation 6"), and
 * timestamps. listActive() returns non-terminal rows for the priority
 * merger (M5.4).
 */
export class GoalsStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  // Prepared statements — better-sqlite3 caches plans across calls.
  private readonly stmtInsert: Database.Statement<[string, string, GoalStatus, string | null, number, number]>;
  private readonly stmtGet: Database.Statement<[string]>;
  private readonly stmtUpdateStatus: Database.Statement<[GoalStatus, string | null, number, string]>;
  private readonly stmtUpdateGoalJson: Database.Statement<[string, number, string]>;
  private readonly stmtDelete: Database.Statement<[string]>;
  private readonly stmtListAll: Database.Statement<[]>;
  private readonly stmtListByStatus: Database.Statement<[GoalStatus]>;
  private readonly stmtListActive: Database.Statement<[string, string, string]>;

  constructor(opts: GoalsStoreOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.now = opts.clock ?? Date.now;

    this.stmtInsert = this.db.prepare<[string, string, GoalStatus, string | null, number, number]>(
      "INSERT INTO goals (id, goal_json, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtGet = this.db.prepare<[string]>("SELECT * FROM goals WHERE id = ?");
    this.stmtUpdateStatus = this.db.prepare<[GoalStatus, string | null, number, string]>(
      "UPDATE goals SET status = ?, reason = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtUpdateGoalJson = this.db.prepare<[string, number, string]>(
      "UPDATE goals SET goal_json = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtDelete = this.db.prepare<[string]>("DELETE FROM goals WHERE id = ?");
    this.stmtListAll = this.db.prepare<[]>("SELECT * FROM goals ORDER BY created_at DESC");
    this.stmtListByStatus = this.db.prepare<[GoalStatus]>(
      "SELECT * FROM goals WHERE status = ? ORDER BY created_at DESC",
    );
    this.stmtListActive = this.db.prepare<[string, string, string]>(
      "SELECT * FROM goals WHERE status IN (?, ?, ?) ORDER BY created_at DESC",
    );
  }

  add(goal: Goal): GoalRow {
    const ts = this.now();
    const json = JSON.stringify(goal);
    // Throws SqliteError UNIQUE constraint on duplicate id — propagate.
    this.stmtInsert.run(goal.id, json, "pending", null, ts, ts);
    // If this goal is being added with is_main_goal=true, enforce the
    // single-main invariant by clearing any sibling row's flag.
    if (goal.is_main_goal === true) {
      this.setMainGoal(goal.id);
    }
    return { goal, status: "pending", created_at: ts, updated_at: ts };
  }

  get(id: string): GoalRow | null {
    const raw = this.stmtGet.get(id) as RawRow | undefined;
    if (raw === undefined) return null;
    return rowFromRaw(raw);
  }

  updateStatus(id: string, status: GoalStatus, reason?: string): GoalRow {
    const ts = this.now();
    const reasonValue = reason ?? null;
    const result = this.stmtUpdateStatus.run(status, reasonValue, ts, id);
    if (result.changes === 0) {
      throw new Error(`GoalsStore.updateStatus: unknown goal id "${id}"`);
    }
    const row = this.get(id);
    if (row === null) {
      // Should not happen — UPDATE just succeeded.
      throw new Error(`GoalsStore.updateStatus: row vanished after update for id "${id}"`);
    }
    return row;
  }

  remove(id: string): void {
    // No-op when no row matches; better-sqlite3 will not throw.
    this.stmtDelete.run(id);
  }

  list(): GoalRow[] {
    const raws = this.stmtListAll.all() as RawRow[];
    return raws.map(rowFromRaw);
  }

  listByStatus(status: GoalStatus): GoalRow[] {
    const raws = this.stmtListByStatus.all(status) as RawRow[];
    return raws.map(rowFromRaw);
  }

  listActive(): GoalRow[] {
    const [a, b, c] = NON_TERMINAL as readonly [GoalStatus, GoalStatus, GoalStatus];
    const raws = this.stmtListActive.all(a, b, c) as RawRow[];
    return raws.map(rowFromRaw);
  }

  /**
   * Replace `target` on the stored Goal by MERGING newTarget into the
   * existing target object, then writing the updated goal_json back. Used by
   * the build_ships progress watcher to decrement remaining amount as units
   * roll out of the shipyard.
   *
   * Throws if the id is unknown.
   */
  updateTarget(id: string, newTarget: Record<string, unknown>): GoalRow {
    const existing = this.get(id);
    if (existing === null) {
      throw new Error(`GoalsStore.updateTarget: unknown goal id "${id}"`);
    }
    const merged: Goal = {
      ...existing.goal,
      target: { ...existing.goal.target, ...newTarget },
    };
    const ts = this.now();
    const result = this.stmtUpdateGoalJson.run(JSON.stringify(merged), ts, id);
    if (result.changes === 0) {
      throw new Error(`GoalsStore.updateTarget: update failed for id "${id}"`);
    }
    const row = this.get(id);
    if (row === null) {
      throw new Error(`GoalsStore.updateTarget: row vanished after update for id "${id}"`);
    }
    return row;
  }

  /**
   * Mark goal `id` as the player's PRIMARY OBJECTIVE — sets is_main_goal=true
   * on that row and clears the flag on every other row. Pass `null` to
   * clear the main flag entirely (no goal is main anymore).
   *
   * Returns the updated main row, or null when clearing.
   */
  setMainGoal(id: string | null): GoalRow | null {
    const ts = this.now();
    // First, clear is_main_goal on every other row (or all rows when id is null).
    const allRows = this.stmtListAll.all() as RawRow[];
    for (const raw of allRows) {
      if (raw.id === id) continue;
      const g = JSON.parse(raw.goal_json) as Goal;
      if (g.is_main_goal === true || g.is_main_goal === false) {
        const cleared: Goal = { ...g, is_main_goal: false };
        this.stmtUpdateGoalJson.run(JSON.stringify(cleared), ts, raw.id);
      }
    }
    if (id === null) return null;
    // Now flip the target row's flag to true.
    const targetRaw = this.stmtGet.get(id) as RawRow | undefined;
    if (targetRaw === undefined) {
      throw new Error(`GoalsStore.setMainGoal: unknown goal id "${id}"`);
    }
    const targetGoal = JSON.parse(targetRaw.goal_json) as Goal;
    const updated: Goal = { ...targetGoal, is_main_goal: true };
    this.stmtUpdateGoalJson.run(JSON.stringify(updated), ts, id);
    const row = this.get(id);
    return row;
  }

  /** Return the row currently flagged is_main_goal=true, or null. */
  getMainGoal(): GoalRow | null {
    const raws = this.stmtListAll.all() as RawRow[];
    for (const raw of raws) {
      const g = JSON.parse(raw.goal_json) as Goal;
      if (g.is_main_goal === true) {
        return rowFromRaw(raw);
      }
    }
    return null;
  }

  close(): void {
    this.db.close();
  }
}

function rowFromRaw(raw: RawRow): GoalRow {
  const goal = JSON.parse(raw.goal_json) as Goal;
  const base = {
    goal,
    status: raw.status as GoalStatus,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
  return raw.reason === null ? base : { ...base, reason: raw.reason };
}
