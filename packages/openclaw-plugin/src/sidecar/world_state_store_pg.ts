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
import type { Goal, WorldState } from "@ogamex/shared";

import type { GoalRow, GoalStatus } from "./goals_types.js";

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
    // v0.0.831 — operator 2026-06-06 "JG cd 在 NULL/1377 之间震荡" 真因:
    // 多 ogame tab 同 uid push state.snapshot, 老逻辑 full overwrite, 最后 push
    // win → 一个 tab 有 JG store (cd=1377) 一个 tab fresh (cd=null) 互相覆盖.
    // [feedback_preserve_on_uncertainty]: incoming=null/undef 是 "no info"
    // 不该覆盖 PG 已 positive cd. Merge 策略: per-moon, 仅当 incoming 有
    // positive cd 或 explicit 0 (READY) 才覆盖, null 时保留 PG 已有.
    type Patch = { jumpgate_cooldown_sec?: number | null; jumpgate_harvested_at?: number | null; jumpgate_pair_with?: string | null };
    type StateShape = { planets?: Record<string, Patch & Record<string, unknown>> } | null | undefined;
    let merged: unknown = state;
    try {
      const incoming = state as StateShape;
      if (incoming && typeof incoming === "object" && incoming.planets) {
        const existing = await this.sql`SELECT json FROM ogame_world_state WHERE user_id = ${userId}`;
        if (existing.length > 0) {
          const ex = existing[0]!.json as StateShape;
          const exPlanets = ex?.planets ?? {};
          const inPlanets = incoming.planets;
          // v0.0.840 — operator 2026-06-06 跨租户污染审计: 老 merge guard 用
          // `{...exPlanets}` 起步, 把 PG 22 planets 全 keep, incoming 只 1 planet
          // overlay 救不回. 一次性 cross-tenant pollution → 永久残留. 改: incoming
          // planets 主导整 planet object (覆盖所有字段, 含废除不在 incoming 的
          // 老 planet), 仅 per-planet JG cd 三字段 preserve 真值.
          const mergedPlanets: Record<string, Patch & Record<string, unknown>> = {};
          for (const [pid, inP] of Object.entries(inPlanets)) {
            const exP = exPlanets[pid] ?? {};
            const inCd = inP.jumpgate_cooldown_sec;
            const exCd = exP.jumpgate_cooldown_sec;
            const exHarv = exP.jumpgate_harvested_at;
            // Preserve PG when incoming = null/undef AND PG has positive cd recent (<2h)
            const preserveCd = (inCd === null || inCd === undefined)
              && typeof exCd === "number" && exCd > 0
              && typeof exHarv === "number" && (Date.now() - exHarv) < 2 * 3600 * 1000;
            if (preserveCd) {
              mergedPlanets[pid] = {
                ...inP,
                jumpgate_cooldown_sec: exCd,
                jumpgate_harvested_at: exHarv,
                jumpgate_pair_with: exP.jumpgate_pair_with ?? inP.jumpgate_pair_with ?? null,
              };
            } else {
              mergedPlanets[pid] = inP;
            }
          }
          merged = { ...incoming, planets: mergedPlanets };
        }
      }
    } catch (e) {
      // Merge 失败 fallback 老 overwrite — safer than dropping snapshot
      console.warn(`[world_state_store_pg] JG merge guard threw uid=${userId.slice(0,8)} fallback to overwrite:`, e instanceof Error ? e.message : e);
    }
    await this.sql`
      INSERT INTO ogame_world_state (user_id, json, updated_at)
      VALUES (${userId}, ${this.sql.json(merged as postgres.JSONValue)}, NOW())
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

  /**
   * Phase 4b: SQLite-shape read mirror. Returns `{ state, updated_at }` where
   * `updated_at` is epoch-ms (matching the SQLite WorldStateStore.hydrate
   * contract byte-for-byte so callers in priority_merger / index.ts can swap
   * without edits).
   *
   * Returns null if the user has no persisted row yet (fresh install).
   */
  async hydrate(userId: string): Promise<{ state: WorldState; updated_at: number } | null> {
    const rows = await this.sql`
      SELECT json, EXTRACT(EPOCH FROM updated_at) * 1000 AS ts_ms
      FROM ogame_world_state
      WHERE user_id = ${userId}
    `;
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      state: row.json as WorldState,
      updated_at: Math.floor(Number(row.ts_ms)),
    };
  }

  /** Last persisted updated_at (epoch-ms), or null if never written. */
  async lastUpdatedAt(userId: string): Promise<number | null> {
    const rows = await this.sql`
      SELECT EXTRACT(EPOCH FROM updated_at) * 1000 AS ts_ms
      FROM ogame_world_state
      WHERE user_id = ${userId}
    `;
    if (rows.length === 0) return null;
    return Math.floor(Number(rows[0]!.ts_ms));
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

  /** Filter by event type, most-recent first. Mirrors SQLite listEventsByType. */
  async listEventsByType(userId: string, type: string, limit = 100): Promise<PgEventRow[]> {
    const rows = await this.sql`
      SELECT id, type, payload, EXTRACT(EPOCH FROM created_at) * 1000 AS ts_ms
      FROM ogame_events
      WHERE user_id = ${userId} AND type = ${type}
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

  // ---------------------------------------------------------------------------
  // user_settings.discord_webhook_url — Phase 9c.8 per-user notification routing
  // ---------------------------------------------------------------------------

  /** Read the user's configured Discord webhook URL, or null if absent.
   *  ReporterManager uses this to decide whether to mint a webhook-based
   *  Reporter for the user (else skip silently — user opted out of Discord). */
  async getDiscordWebhookUrl(userId: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT discord_webhook_url
      FROM user_settings
      WHERE user_id = ${userId}
        AND discord_webhook_url IS NOT NULL
        AND LENGTH(discord_webhook_url) > 0
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const url = row.discord_webhook_url;
    return typeof url === "string" && url.length > 0 ? url : null;
  }

  // ---------------------------------------------------------------------------
  // ogame_goals — Phase 4a shadow writes. SQLite (goals_store.ts) is still
  // primary; these mirror every mutation so the PG row reflects current
  // state. epoch-ms timestamps are converted to timestamptz on the way in
  // (and back out in the future read methods Phase 4b will add).
  //
  // Schema reminder:
  //   id varchar(80) PK, user_id text NOT NULL FK→users,
  //   goal_json jsonb, status varchar(20), reason text,
  //   is_main_goal bool DEFAULT false,
  //   created_at timestamptz, updated_at timestamptz
  // ---------------------------------------------------------------------------

  /** Insert or replace a full goal row. Mirrors GoalsStore.add/addForUser. */
  async upsertGoal(userId: string, row: GoalRow): Promise<void> {
    const goalJson = row.goal as unknown as postgres.JSONValue;
    const isMain = row.goal.is_main_goal === true;
    const createdAt = new Date(row.created_at);
    const updatedAt = new Date(row.updated_at);
    const reason = row.reason ?? null;
    await this.sql`
      INSERT INTO ogame_goals (id, user_id, goal_json, status, reason, is_main_goal, created_at, updated_at)
      VALUES (
        ${row.goal.id},
        ${userId},
        ${this.sql.json(goalJson)},
        ${row.status},
        ${reason},
        ${isMain},
        ${createdAt},
        ${updatedAt}
      )
      ON CONFLICT (id) DO UPDATE
        SET goal_json = EXCLUDED.goal_json,
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            is_main_goal = EXCLUDED.is_main_goal,
            updated_at = EXCLUDED.updated_at
        WHERE EXCLUDED.updated_at >= ogame_goals.updated_at
    `;
    // ^ v0.0.671 — Phase 6a timestamp guard: a late-arriving upsert
    //   (e.g. merger's status=active mirror racing the
    //   directive_completed handler's status=completed update) must
    //   NOT clobber a newer row. Without this clause we saw drift like
    //   sqlite=9 pg=11 — stale "active" persisted in PG after SQLite
    //   had already moved to "completed".
  }

  /** Mirror GoalsStore.updateStatus — sets status, reason, updated_at. */
  async updateGoalStatus(
    userId: string,
    id: string,
    status: GoalStatus,
    reason: string | null,
  ): Promise<void> {
    await this.sql`
      UPDATE ogame_goals
         SET status = ${status},
             reason = ${reason},
             updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId}
    `;
  }

  /**
   * Mirror GoalsStore.updateTarget — merges newTarget into goal_json.target
   * via jsonb deep merge (|| at the target subtree). Safer than jsonb_set
   * with a fixed path because the caller passes a partial target object
   * we want to shallow-merge into existing.target.
   */
  async updateGoalTarget(
    userId: string,
    id: string,
    newTarget: Record<string, unknown>,
  ): Promise<void> {
    const patch = { target: newTarget } as unknown as postgres.JSONValue;
    await this.sql`
      UPDATE ogame_goals
         SET goal_json = jsonb_set(
               goal_json,
               '{target}',
               COALESCE(goal_json->'target', '{}'::jsonb) || ${this.sql.json(patch)}::jsonb -> 'target',
               true
             ),
             updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId}
    `;
  }

  /**
   * Mirror GoalsStore.updateGoalJson — full goal_json replacement for
   * cases (setMainGoal) where the JSON has structural changes beyond
   * the target subtree.
   */
  async updateGoalJson(
    userId: string,
    id: string,
    goal: Goal,
  ): Promise<void> {
    const goalJson = goal as unknown as postgres.JSONValue;
    const isMain = goal.is_main_goal === true;
    await this.sql`
      UPDATE ogame_goals
         SET goal_json = ${this.sql.json(goalJson)},
             is_main_goal = ${isMain},
             updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId}
    `;
  }

  /** Mirror GoalsStore.remove. */
  async deleteGoal(userId: string, id: string): Promise<void> {
    await this.sql`
      DELETE FROM ogame_goals WHERE id = ${id} AND user_id = ${userId}
    `;
  }

  /**
   * Mirror GoalsStore.setMainGoal — clear is_main_goal for all the
   * user's other goals, then flip one to true (or none if id is null).
   * Also mirrors the in-Goal-JSON flag so future reads from PG see the
   * same shape SQLite does.
   *
   * Done as two statements; we don't open a transaction because shadow
   * writes are best-effort fire-and-forget — a partial failure here is
   * acceptable (next setMainGoal call will reconcile). SQLite primary
   * has the source of truth.
   */
  /**
   * v0.0.1028 — owner 2026-06-09 "合并 root 任务和主任务的逻辑" + "新账号建造
   * 树 一个星球一个树". setMainGoal 排他范围从 per-uid 收紧到 per-planet:
   * 同 planet 旧 main → clear, 不同 planet main 保留独立运行. 全局型 goal
   * (research / colonize / discovery 等无 planet 字段) 用 planetKey="" 自成一组.
   *
   * 调用约定: planetKey 必传 (createGoal 用 body.planet ?? ""), null 表示
   * 跨 planet 清空 (兼容老 unsetMainGoal 全清场景).
   */
  async setMainGoal(userId: string, id: string | null, planetKey?: string | null): Promise<void> {
    // null id + null planetKey = 全清 (老 unsetMainGoal 语义).
    const clearAllPlanets = id === null && (planetKey === null || planetKey === undefined);
    if (clearAllPlanets) {
      await this.sql`
        UPDATE ogame_goals
           SET is_main_goal = false,
               goal_json = jsonb_set(goal_json, '{is_main_goal}', 'false'::jsonb, true),
               updated_at = NOW()
         WHERE user_id = ${userId}
           AND is_main_goal = true
      `;
      return;
    }
    const pk = planetKey ?? "";
    // Per-planet 排他: clear 同 planet 旧 main (排除自己), 跨 planet main 保留.
    await this.sql`
      UPDATE ogame_goals
         SET is_main_goal = false,
             goal_json = jsonb_set(goal_json, '{is_main_goal}', 'false'::jsonb, true),
             updated_at = NOW()
       WHERE user_id = ${userId}
         AND (${id}::varchar IS NULL OR id <> ${id})
         AND is_main_goal = true
         AND COALESCE(goal_json->>'planet', '') = ${pk}
    `;
    if (id !== null) {
      await this.sql`
        UPDATE ogame_goals
           SET is_main_goal = true,
               goal_json = jsonb_set(goal_json, '{is_main_goal}', 'true'::jsonb, true),
               updated_at = NOW()
         WHERE id = ${id} AND user_id = ${userId}
      `;
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.sql.end({ timeout: 5 });
    }
  }
}
