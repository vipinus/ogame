import Database from "better-sqlite3";
import type { Goal } from "@ogamex/shared";
// Phase 7c.5.d (v0.0.784) — types 抽到 goals_types.ts. 这里 re-export 保留
// 向后兼容 (其他 file 改成 import from "./goals_types.js" 之后这两行就可以删).
import type { GoalRow, GoalStatus } from "./goals_types.js";
export type { GoalRow, GoalStatus } from "./goals_types.js";

const NON_TERMINAL: readonly GoalStatus[] = ["pending", "active", "blocked"];

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

/** Phase 9c.2 — idempotent migration to add user_id column to existing
 *  goals.db files. better-sqlite3 supports ALTER TABLE ADD COLUMN for
 *  nullable cols. NULL means "legacy single-tenant operator goal" until
 *  a backfill is run via backfillLegacyUserId(). */
function migrateAddUserIdColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec("ALTER TABLE goals ADD COLUMN user_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status)");
  }
}

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
    migrateAddUserIdColumn(this.db);
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

  /**
   * Phase 9c.2 — one-shot backfill: set user_id on all rows that still
   * have NULL. Called from startSidecar at boot when
   * OGAMEX_LEGACY_USER_ID env is set. Returns number of rows updated.
   */
  backfillLegacyUserId(legacyUserId: string): number {
    const info = this.db.prepare("UPDATE goals SET user_id = ? WHERE user_id IS NULL").run(legacyUserId);
    return info.changes;
  }

  /**
   * Phase 9c.2 — multi-tenant variant of listActive(). When userId is
   * supplied, returns only rows matching that user_id. When undefined,
   * returns ALL rows (legacy single-tenant behavior — PriorityMerger
   * uses this when ALS frame is absent).
   */
  listActiveByUser(userId: string | undefined): GoalRow[] {
    if (!userId) {
      const rows = this.stmtListActive.all("pending", "active", "blocked") as RawRow[];
      return rows.map(rowFromRaw);
    }
    const rows = this.db.prepare(
      "SELECT * FROM goals WHERE user_id = ? AND status IN ('pending','active','blocked') ORDER BY created_at DESC",
    ).all(userId) as RawRow[];
    return rows.map(rowFromRaw);
  }

  /**
   * Assign user_id when creating a new goal. Default falls back to
   * stmtInsert (NULL user_id, treated as legacy operator).
   */
  addForUser(goal: Goal, userId: string | undefined): GoalRow {
    const ts = this.now();
    const json = JSON.stringify(goal);
    if (userId) {
      this.db.prepare(
        "INSERT INTO goals (id, goal_json, status, reason, created_at, updated_at, user_id) VALUES (?, ?, 'pending', NULL, ?, ?, ?)",
      ).run(goal.id, json, ts, ts, userId);
    } else {
      this.stmtInsert.run(goal.id, json, "pending", null, ts, ts);
    }
    if (goal.is_main_goal === true) this.setMainGoal(goal.id);
    return { goal, status: "pending", created_at: ts, updated_at: ts };
  }

  add(goal: Goal): GoalRow {
    const ts = this.now();
    const json = JSON.stringify(goal);
    // Phase 9c.9 — auto-tag with operator uid if env-configured. Legacy
    // callers (daemon, sidecar discovery handler, opt-builder) call
    // `add()` without user_id, which previously wrote NULL → merger's
    // listActiveByUser("4baba0e2…") skipped them → operator's panel
    // showed "pending" forever. Lazy-read env (ESM hoisting trap, see
    // [[feedback_esm_hoisting_env]]).
    const operatorUid = (process.env.OGAMEX_LEGACY_USER_ID ?? "").trim();
    if (operatorUid) {
      this.db.prepare(
        "INSERT INTO goals (id, goal_json, status, reason, created_at, updated_at, user_id) VALUES (?, ?, 'pending', NULL, ?, ?, ?)",
      ).run(goal.id, json, ts, ts, operatorUid);
    } else {
      // No operator configured (test/CI) — fall back to legacy INSERT
      // without user_id column (NULL).
      this.stmtInsert.run(goal.id, json, "pending", null, ts, ts);
    }
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
   * Phase 9c.7 — full goal list filtered by user_id. When userId is
   * undefined, returns ALL rows (legacy / operator panel behavior).
   * Mirrors listActiveByUser() but includes terminal goals so the panel
   * can show history.
   */
  listByUser(userId: string | undefined): GoalRow[] {
    if (!userId) return this.list();
    const rows = this.db.prepare(
      "SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC",
    ).all(userId) as RawRow[];
    return rows.map(rowFromRaw);
  }

  /**
   * Phase 9c.7 — read the user_id column for a given goal id (or undefined
   * if the row was created before user_id was tracked / legacy operator).
   * Used by mutation handlers to verify Bearer-resolved uid owns the goal
   * before pause/resume/delete.
   */
  ownerOf(goalId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT user_id FROM goals WHERE id = ?",
    ).get(goalId) as { user_id?: string | null } | undefined;
    if (!row) return undefined;
    const u = row.user_id;
    return typeof u === "string" && u.length > 0 ? u : undefined;
  }

  /**
   * Return rows whose Goal.parent_goal_id == parentId. Implemented as a
   * full scan + filter on goal_json — Goal is stored as JSON blob and
   * parent_goal_id is a recent addition that isn't a SQL column. For
   * typical goal-count (<100), the scan is cheap; if growth pressures
   * this we can promote parent_goal_id to a real column with index.
   *
   * Includes terminal children — caller filters if it only wants live ones.
   */
  listChildren(parentId: string): GoalRow[] {
    return this.list().filter((r) => r.goal.parent_goal_id === parentId);
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
