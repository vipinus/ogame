/**
 * PostgreSQL-backed READ-ONLY mirror of GoalsStore.
 *
 * Phase 8/9c migration context: legacy SQLite GoalsStore is currently
 * primary (all writes + reads). This PG class mirrors the SAME public
 * READ surface so priority_merger and http_server can swap their store
 * reference once the shadowFire writes have been verified. Method
 * signatures take `userId` as the FIRST param explicitly — PG schema
 * is multi-tenant by row, no ALS magic.
 *
 * Shape contract: every method returns `GoalRow` byte-identical to the
 * SQLite version (`{ goal, status, reason?, created_at, updated_at }`)
 * where created_at/updated_at are epoch-ms numbers, NOT Date objects.
 * Consumers parse goal_json (TEXT) via the same JSON.parse path.
 *
 * 顶层设计:
 *   - 用 raw SQL via `postgres` driver (与 world_state_store_pg.ts 同款).
 *   - 所有方法第一参数都是 userId; cross-tenant 查询不存在.
 *   - 仅 READ — 不复制 add/updateStatus/remove/setMainGoal 等 mutator.
 */

import postgres from "postgres";

import type { Goal } from "@ogamex/shared";
import type { GoalRow, GoalStatus } from "./goals_store.js";

export interface GoalsStorePgOptions {
  /** Postgres connection URL, e.g. `postgres://ogamex:ogamex@127.0.0.1:5432/ogamex` */
  databaseUrl?: string;
  /** Optional preexisting Sql connection (tests share a pool, sidecar reuses
   *  world_state_store_pg's pool). */
  sql?: postgres.Sql;
}

/** Raw SELECT projection — matches the column list pulled from ogame_goals.
 *  Numeric epoch-ms columns come back as JS `number` from
 *  EXTRACT(EPOCH ...) * 1000. goal_json is cast to text so JSON.parse
 *  works identically to the SQLite TEXT column. */
interface RawPgRow {
  id: string;
  goal_json: string;
  status: string;
  reason: string | null;
  is_main_goal: boolean;
  created_at: string | number;
  updated_at: string | number;
  user_id: string;
}

export class GoalsStorePg {
  private readonly sql: postgres.Sql;
  private readonly ownsPool: boolean;

  constructor(opts: GoalsStorePgOptions) {
    if (opts.sql) {
      this.sql = opts.sql;
      this.ownsPool = false;
    } else {
      if (!opts.databaseUrl) {
        throw new Error("GoalsStorePg: either `sql` or `databaseUrl` must be supplied");
      }
      this.sql = postgres(opts.databaseUrl, {
        max: 4,
        idle_timeout: 30,
        connect_timeout: 10,
        onnotice: () => { /* swallow NOTICE noise */ },
      });
      this.ownsPool = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Read methods — public surface mirrors goals_store.ts
  // ---------------------------------------------------------------------------

  /** Non-terminal rows (pending|active|blocked) scoped to userId, newest first.
   *  Mirrors GoalsStore.listActiveByUser(userId). */
  async listActiveByUser(userId: string): Promise<GoalRow[]> {
    const rows = await this.sql<RawPgRow[]>`
      SELECT id,
             goal_json::text AS goal_json,
             status,
             reason,
             is_main_goal,
             EXTRACT(EPOCH FROM created_at) * 1000 AS created_at,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at,
             user_id
      FROM ogame_goals
      WHERE user_id = ${userId}
        AND status IN ('pending', 'active', 'blocked')
      ORDER BY created_at DESC
    `;
    return rows.map(rowFromRaw);
  }

  /** All rows (any status) scoped to userId, newest first. Mirrors
   *  GoalsStore.list() / listByUser(userId). */
  async list(userId: string): Promise<GoalRow[]> {
    const rows = await this.sql<RawPgRow[]>`
      SELECT id,
             goal_json::text AS goal_json,
             status,
             reason,
             is_main_goal,
             EXTRACT(EPOCH FROM created_at) * 1000 AS created_at,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at,
             user_id
      FROM ogame_goals
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return rows.map(rowFromRaw);
  }

  /** Alias used by priority_merger / http_server panel handlers. */
  async listByUser(userId: string): Promise<GoalRow[]> {
    return this.list(userId);
  }

  /** Fetch a single row by goal id, scoped to userId so cross-tenant
   *  reads are physically impossible. Returns null when absent. */
  async get(userId: string, id: string): Promise<GoalRow | null> {
    const rows = await this.sql<RawPgRow[]>`
      SELECT id,
             goal_json::text AS goal_json,
             status,
             reason,
             is_main_goal,
             EXTRACT(EPOCH FROM created_at) * 1000 AS created_at,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at,
             user_id
      FROM ogame_goals
      WHERE user_id = ${userId} AND id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rowFromRaw(rows[0]!);
  }

  /** Rows whose status equals the supplied value, newest first. */
  async listByStatus(userId: string, status: GoalStatus): Promise<GoalRow[]> {
    const rows = await this.sql<RawPgRow[]>`
      SELECT id,
             goal_json::text AS goal_json,
             status,
             reason,
             is_main_goal,
             EXTRACT(EPOCH FROM created_at) * 1000 AS created_at,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at,
             user_id
      FROM ogame_goals
      WHERE user_id = ${userId} AND status = ${status}
      ORDER BY created_at DESC
    `;
    return rows.map(rowFromRaw);
  }

  /** Children of `parentId` — rows where the embedded Goal.parent_goal_id
   *  matches. Implemented as full per-user fetch + filter on the parsed
   *  JSON, identical to SQLite (parent_goal_id lives inside goal_json,
   *  not as a column). Goal volume is bounded (<100/user) so the scan is
   *  cheap; if pressure builds, promote parent_goal_id to a real column. */
  async listChildren(userId: string, parentId: string): Promise<GoalRow[]> {
    const all = await this.list(userId);
    return all.filter((r) => r.goal.parent_goal_id === parentId);
  }

  /** Read the user_id of a row by goal id. Returns undefined if the row
   *  does not exist (or — should never happen in PG — has NULL user_id).
   *  Used by mutation handlers to verify Bearer-resolved uid owns the
   *  goal before pause/resume/delete. */
  async ownerOf(userId: string, goalId: string): Promise<string | undefined> {
    // Scoped to userId per the PG multi-tenant contract: callers that
    // want to check ownership ALREADY know whose uid is asking. Returns
    // the row's user_id if it exists under this tenant, else undefined.
    const rows = await this.sql<Array<{ user_id: string | null }>>`
      SELECT user_id FROM ogame_goals
      WHERE user_id = ${userId} AND id = ${goalId}
      LIMIT 1
    `;
    if (rows.length === 0) return undefined;
    const u = rows[0]!.user_id;
    return typeof u === "string" && u.length > 0 ? u : undefined;
  }

  /** Return the row currently flagged is_main_goal=true for this user,
   *  or null. Uses the indexed `is_main_goal` column for O(1) lookup
   *  (SQLite has to scan + parse JSON because the flag lives in the blob). */
  async getMainGoal(userId: string): Promise<GoalRow | null> {
    const rows = await this.sql<RawPgRow[]>`
      SELECT id,
             goal_json::text AS goal_json,
             status,
             reason,
             is_main_goal,
             EXTRACT(EPOCH FROM created_at) * 1000 AS created_at,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at,
             user_id
      FROM ogame_goals
      WHERE user_id = ${userId} AND is_main_goal = true
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rowFromRaw(rows[0]!);
  }

  // ---------------------------------------------------------------------------
  // utility
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.sql.end({ timeout: 5 });
    }
  }
}

/** Convert the raw SELECT projection into a GoalRow byte-identical to
 *  the SQLite store's output. `reason` is omitted (not present) when
 *  NULL so === comparisons in callers behave the same. */
function rowFromRaw(raw: RawPgRow): GoalRow {
  const goal = JSON.parse(raw.goal_json) as Goal;
  const base = {
    goal,
    status: raw.status as GoalStatus,
    created_at: Math.floor(Number(raw.created_at)),
    updated_at: Math.floor(Number(raw.updated_at)),
  };
  return raw.reason === null ? base : { ...base, reason: raw.reason };
}
