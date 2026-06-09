// v0.0.1021 Phase 2 — owner 2026-06-09 "前端和后端做池连接做好持久化":
// sidecar 端 directive.dispatch 持久化. queueDownstream 写入 PG, 投递成功
// (HTTP poll consume / WS resend drain) 删 PG row. sidecar 重启时 SELECT all
// → 重建内存 bucket queue. 100% delivery 不靠 sidecar 进程生死.
//
// Table: ogame_pending_dispatch
//   id          text PRIMARY KEY  -- 匹配 QueueEntry.id ("m-{ts}-{uuid}")
//   user_id     text NOT NULL
//   payload     jsonb NOT NULL    -- DownstreamMsg
//   queued_at   timestamptz NOT NULL DEFAULT now()
//
// 跟 [[no-fallback-design]] 一致: 这是 transport 层 reliability, 不是 state
// 兜底. status 真态由 ack handler 写 ogame_goals 是唯一权威源.

import postgres from "postgres";
import type { DownstreamMsg } from "@ogamex/shared";

export interface PendingDispatchEntry {
  id: string;
  userId: string;
  payload: DownstreamMsg;
  queuedAt: number;
}

export interface PendingDispatchStorePgOptions {
  databaseUrl?: string;
  sql?: postgres.Sql;
  clock?: () => number;
}

export class PendingDispatchStorePg {
  private readonly sql: postgres.Sql;
  private readonly ownsPool: boolean;
  private readonly now: () => number;
  private tableReady = false;

  constructor(opts: PendingDispatchStorePgOptions) {
    if (opts.sql) {
      this.sql = opts.sql;
      this.ownsPool = false;
    } else if (opts.databaseUrl) {
      this.sql = postgres(opts.databaseUrl, {
        max: 2,
        idle_timeout: 30,
        connect_timeout: 10,
        onnotice: () => { /* */ },
      });
      this.ownsPool = true;
    } else {
      throw new Error("PendingDispatchStorePg: must supply databaseUrl or sql");
    }
    this.now = opts.clock ?? Date.now;
  }

  private async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS ogame_pending_dispatch (
        id         text PRIMARY KEY,
        user_id    text NOT NULL,
        payload    jsonb NOT NULL,
        queued_at  timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS ogame_pending_dispatch_user_idx
        ON ogame_pending_dispatch(user_id, queued_at)
    `;
    this.tableReady = true;
  }

  async upsert(entry: PendingDispatchEntry): Promise<void> {
    await this.ensureTable();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payloadJson = this.sql.json(entry.payload as any);
    await this.sql`
      INSERT INTO ogame_pending_dispatch (id, user_id, payload, queued_at)
      VALUES (${entry.id}, ${entry.userId}, ${payloadJson}, to_timestamp(${entry.queuedAt} / 1000.0))
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async deleteById(id: string): Promise<void> {
    await this.ensureTable();
    await this.sql`DELETE FROM ogame_pending_dispatch WHERE id = ${id}`;
  }

  async deleteAllForUser(userId: string): Promise<number> {
    await this.ensureTable();
    const res = await this.sql`DELETE FROM ogame_pending_dispatch WHERE user_id = ${userId}`;
    return res.count;
  }

  async loadAll(): Promise<PendingDispatchEntry[]> {
    await this.ensureTable();
    const rows = await this.sql<{ id: string; user_id: string; payload: DownstreamMsg; queued_at: Date }[]>`
      SELECT id, user_id, payload, queued_at
      FROM ogame_pending_dispatch
      ORDER BY user_id, queued_at
    `;
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      payload: r.payload,
      queuedAt: r.queued_at.getTime(),
    }));
  }

  /** Older than ms — purge. 24h default keeps queue from infinite growth if
   *  a uid never reconnects. */
  async purgeOlderThan(maxAgeMs: number): Promise<number> {
    await this.ensureTable();
    const cutoff = this.now() - maxAgeMs;
    const res = await this.sql`
      DELETE FROM ogame_pending_dispatch
      WHERE queued_at < to_timestamp(${cutoff} / 1000.0)
    `;
    return res.count;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      try { await this.sql.end({ timeout: 5 }); } catch { /* */ }
    }
  }
}
