/**
 * PostgreSQL-backed mirror of WorldStateStore — same surface but every
 * operation takes a user_id (multi-tenant).
 *
 * Phase 8a context: the legacy SQLite WorldStateStore stays primary; this
 * Postgres adapter is wired as a *shadow* writer in startSidecar when
 * OGAMEX_OPERATOR_USER_ID env is set. Lets ogame-next's /dashboard read
 * live state via Drizzle against the same Postgres without coupling to
 * the sidecar process boundary. Phase 8b will flip primary → Postgres
 * once we trust the shadow writes.
 *
 * 顶层设计:
 *   - 用 raw SQL via `postgres` driver (no Drizzle in sidecar — keeps the
 *     plugin's dep surface small; schema lives in ogame-next/src/lib/
 *     schema.ts, both sides agree on table names + columns).
 *   - 所有方法第一个参数都是 userId; cross-tenant query 在 ORM 层不存在.
 *   - 失败永远 swallow + warn (shadow writes 不能挡主链路).
 */

import postgres from "postgres";

export interface WorldStateStorePgOptions {
  /** Postgres connection URL, e.g. `postgres://ogamex:ogamex@127.0.0.1:5432/ogamex` */
  databaseUrl: string;
  /** Optional injectable clock for tests. Defaults to Date.now. */
  clock?: () => number;
  /** Optional preexisting Sql connection (tests share a pool). */
  sql?: postgres.Sql;
}

export interface PgPersistedSaveRecord {
  planet_id: string;
  fleet_id: number;
  state: string;
  pending_event_ids: string[];
  cleared_at: number | null;
  launched_at: number;
  last_error: string | null;
}

export interface PgEventRow {
  id: number;
  type: string;
  payload: unknown;
  created_at: number;
}

export class WorldStateStorePg {
  private readonly sql: postgres.Sql;
  private readonly ownsPool: boolean;
  private readonly now: () => number;

  constructor(opts: WorldStateStorePgOptions) {
    if (opts.sql) {
      this.sql = opts.sql;
      this.ownsPool = false;
    } else {
      this.sql = postgres(opts.databaseUrl, {
        max: 4,
        idle_timeout: 30,
        connect_timeout: 10,
        // Sidecar is a long-running daemon — never let SIGTERM teardown
        // queue queries; just close.
        onnotice: () => { /* swallow NOTICE noise */ },
      });
      this.ownsPool = true;
    }
    this.now = opts.clock ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // world_state — single row per user (JSONB blob)
  // ---------------------------------------------------------------------------

  async upsertWorldState(userId: string, state: unknown): Promise<void> {
    await this.sql`
      INSERT INTO ogame_world_state (user_id, json, updated_at)
      VALUES (${userId}, ${this.sql.json(state as postgres.JSONValue)}, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET json = EXCLUDED.json, updated_at = EXCLUDED.updated_at
    `;
  }

  async hydrateWorldState(userId: string): Promise<{ json: unknown; updatedAt: Date } | null> {
    const rows = await this.sql`
      SELECT json, updated_at FROM ogame_world_state WHERE user_id = ${userId}
    `;
    if (rows.length === 0) return null;
    return { json: rows[0]!.json as unknown, updatedAt: rows[0]!.updated_at as Date };
  }

  // ---------------------------------------------------------------------------
  // events — append-only audit, user_id partitioned
  // ---------------------------------------------------------------------------

  async appendEvent(userId: string, type: string, payload: unknown): Promise<number> {
    const rows = await this.sql`
      INSERT INTO ogame_events (user_id, type, payload, created_at)
      VALUES (${userId}, ${type}, ${this.sql.json(payload as postgres.JSONValue)}, NOW())
      RETURNING id
    `;
    return Number(rows[0]!.id);
  }

  async listRecentEvents(userId: string, limit = 100): Promise<PgEventRow[]> {
    const rows = await this.sql`
      SELECT id, type, payload, EXTRACT(EPOCH FROM created_at) * 1000 AS ts_ms
      FROM ogame_events
      WHERE user_id = ${userId}
      ORDER BY id DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      type: String(r.type),
      payload: r.payload as unknown,
      created_at: Math.floor(Number(r.ts_ms)),
    }));
  }

  async trimEvents(userId: string, keepLast: number): Promise<void> {
    await this.sql`
      DELETE FROM ogame_events
      WHERE user_id = ${userId}
        AND id <= COALESCE(
          (SELECT MAX(id) FROM ogame_events WHERE user_id = ${userId}) - ${keepLast},
          0
        )
    `;
  }

  // ---------------------------------------------------------------------------
  // save_records — (user_id, planet_id) FSM rows
  // ---------------------------------------------------------------------------

  async upsertSaveRecord(userId: string, rec: PgPersistedSaveRecord): Promise<void> {
    const clearedAtMs = rec.cleared_at != null ? new Date(rec.cleared_at) : null;
    const launchedAtMs = new Date(rec.launched_at);
    await this.sql`
      INSERT INTO ogame_save_records (user_id, planet_id, fleet_id, state, pending_event_ids, cleared_at, launched_at, last_error)
      VALUES (
        ${userId},
        ${rec.planet_id},
        ${rec.fleet_id},
        ${rec.state},
        ${this.sql.json(rec.pending_event_ids as postgres.JSONValue)},
        ${clearedAtMs},
        ${launchedAtMs},
        ${rec.last_error}
      )
      ON CONFLICT (user_id, planet_id) DO UPDATE
        SET fleet_id = EXCLUDED.fleet_id,
            state = EXCLUDED.state,
            pending_event_ids = EXCLUDED.pending_event_ids,
            cleared_at = EXCLUDED.cleared_at,
            launched_at = EXCLUDED.launched_at,
            last_error = EXCLUDED.last_error
    `;
  }

  async deleteSaveRecord(userId: string, planetId: string): Promise<void> {
    await this.sql`DELETE FROM ogame_save_records WHERE user_id = ${userId} AND planet_id = ${planetId}`;
  }

  async listSaveRecords(userId: string): Promise<PgPersistedSaveRecord[]> {
    const rows = await this.sql`
      SELECT planet_id, fleet_id, state, pending_event_ids,
             EXTRACT(EPOCH FROM cleared_at) * 1000 AS cleared_at_ms,
             EXTRACT(EPOCH FROM launched_at) * 1000 AS launched_at_ms,
             last_error
      FROM ogame_save_records
      WHERE user_id = ${userId}
    `;
    return rows.map((r) => ({
      planet_id: String(r.planet_id),
      fleet_id: Number(r.fleet_id),
      state: String(r.state),
      pending_event_ids: (r.pending_event_ids as string[]) ?? [],
      cleared_at: r.cleared_at_ms == null ? null : Math.floor(Number(r.cleared_at_ms)),
      launched_at: Math.floor(Number(r.launched_at_ms)),
      last_error: r.last_error == null ? null : String(r.last_error),
    }));
  }

  // ---------------------------------------------------------------------------
  // failure_cooldowns — (user_id, task) PK
  // ---------------------------------------------------------------------------

  async upsertFailureCooldown(userId: string, task: string, lastAnalysisAt: number): Promise<void> {
    await this.sql`
      INSERT INTO ogame_failure_cooldowns (user_id, task, last_analysis_at)
      VALUES (${userId}, ${task}, ${new Date(lastAnalysisAt)})
      ON CONFLICT (user_id, task) DO UPDATE
        SET last_analysis_at = EXCLUDED.last_analysis_at
    `;
  }

  async listFailureCooldowns(userId: string): Promise<Array<{ task: string; last_analysis_at: number }>> {
    const rows = await this.sql`
      SELECT task, EXTRACT(EPOCH FROM last_analysis_at) * 1000 AS ts_ms
      FROM ogame_failure_cooldowns
      WHERE user_id = ${userId}
    `;
    return rows.map((r) => ({
      task: String(r.task),
      last_analysis_at: Math.floor(Number(r.ts_ms)),
    }));
  }

  // ---------------------------------------------------------------------------
  // utility
  // ---------------------------------------------------------------------------

  /** Cheap row counts — Phase 8a observability. */
  async rowCounts(userId: string): Promise<{
    events: number;
    save_records: number;
    failure_cooldowns: number;
    world_state_present: boolean;
  }> {
    const rows = await this.sql`
      SELECT
        (SELECT COUNT(*) FROM ogame_events WHERE user_id = ${userId})::int AS events,
        (SELECT COUNT(*) FROM ogame_save_records WHERE user_id = ${userId})::int AS save_records,
        (SELECT COUNT(*) FROM ogame_failure_cooldowns WHERE user_id = ${userId})::int AS failure_cooldowns,
        EXISTS (SELECT 1 FROM ogame_world_state WHERE user_id = ${userId}) AS world_state_present
    `;
    const r = rows[0]!;
    return {
      events: Number(r.events),
      save_records: Number(r.save_records),
      failure_cooldowns: Number(r.failure_cooldowns),
      world_state_present: Boolean(r.world_state_present),
    };
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.sql.end({ timeout: 5 });
    }
  }
}
