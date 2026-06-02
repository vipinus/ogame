import Database from "better-sqlite3";
import type { WorldState } from "@ogamex/shared";

/**
 * SQLite-backed persistence for the live WorldState mirror.
 *
 * Operator 2026-06-01: "要持久化 ogame 里面的所有数据，不要每次都同步，
 * 事件驱动也要更新后台数据。如果 sqlite 不行就换 PostgreSQL".
 *
 * Storage shape: single-row table `world_state(id=1, json TEXT, updated_at)`.
 * WorldState is a tree of planet/research/queue/fleet/event records — small
 * enough (~50KB worst case for 10 planets) and append-amplification-free as a
 * blob. Upserting the blob on every state.snapshot keeps the schema in lock-
 * step with @ogamex/shared/WorldState without per-field migrations.
 *
 * Caller responsibilities:
 *  - debounce upserts (this class is synchronous; throttling lives in the
 *    sidecar to match the existing MemoryWriter cadence).
 *  - call hydrate() ONCE at boot to seed stateRef before any state.snapshot.
 *  - call close() during shutdown (sidecar stop()).
 *
 * If/when SQLite contention becomes real, replace this file with a PG-backed
 * variant honoring the same 4-method surface (hydrate, upsert, close,
 * lastUpdatedAt) — the seam is intentional.
 */
export interface WorldStateStoreOptions {
  /** Path to SQLite db. Use ":memory:" for tests. */
  dbPath: string;
  /** Optional injectable clock returning ms epoch. Defaults to Date.now. */
  clock?: () => number;
}

interface RawRow {
  json: string;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS world_state (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    json        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
`;

export interface EventRow {
  id: number;
  type: string;
  payload: unknown;
  created_at: number;
}

export class WorldStateStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly stmtGet: Database.Statement<[]>;
  private readonly stmtUpsert: Database.Statement<[string, number]>;
  private readonly stmtAppendEvent: Database.Statement<[string, string, number]>;
  private readonly stmtListEvents: Database.Statement<[number]>;
  private readonly stmtListEventsByType: Database.Statement<[string, number]>;
  private readonly stmtTrimEvents: Database.Statement<[number]>;

  constructor(opts: WorldStateStoreOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.now = opts.clock ?? Date.now;
    this.stmtGet = this.db.prepare<[]>("SELECT json, updated_at FROM world_state WHERE id = 1");
    this.stmtUpsert = this.db.prepare<[string, number]>(
      "INSERT INTO world_state (id, json, updated_at) VALUES (1, ?, ?) "
      + "ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
    );
    this.stmtAppendEvent = this.db.prepare<[string, string, number]>(
      "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
    );
    this.stmtListEvents = this.db.prepare<[number]>(
      "SELECT id, type, payload, created_at FROM events ORDER BY id DESC LIMIT ?",
    );
    this.stmtListEventsByType = this.db.prepare<[string, number]>(
      "SELECT id, type, payload, created_at FROM events WHERE type = ? ORDER BY id DESC LIMIT ?",
    );
    this.stmtTrimEvents = this.db.prepare<[number]>(
      "DELETE FROM events WHERE id <= (SELECT MAX(id) - ? FROM events)",
    );
  }

  /**
   * Return the most recently persisted WorldState, or null if the table is
   * empty (fresh install / sidecar never received a snapshot before).
   *
   * Throws SyntaxError if the stored blob is corrupt — caller decides whether
   * to surface or treat as null. Sidecar treats corrupt as null + warns so
   * boot survives.
   */
  hydrate(): { state: WorldState; updated_at: number } | null {
    const raw = this.stmtGet.get() as RawRow | undefined;
    if (raw === undefined) return null;
    const state = JSON.parse(raw.json) as WorldState;
    return { state, updated_at: raw.updated_at };
  }

  /** Replace the persisted blob with `state`. Stamped with current clock. */
  upsert(state: WorldState): void {
    const json = JSON.stringify(state);
    this.stmtUpsert.run(json, this.now());
  }

  /** Last persisted updated_at, or null if never written. */
  lastUpdatedAt(): number | null {
    const raw = this.stmtGet.get() as RawRow | undefined;
    return raw?.updated_at ?? null;
  }

  /**
   * Append an event audit-log row. Operator 2026-06-01 "事件驱动也要更新
   * 后台数据" — events are the per-tick deltas (emergency / daily_failure /
   * directive_completed). state.snapshot upserts cover the full mirror;
   * this table records WHAT happened, not just WHERE we ended up.
   *
   * payload is JSON-stringified — caller can pass any structured value.
   * Throws if payload contains a cycle (JSON.stringify will throw).
   */
  appendEvent(type: string, payload: unknown): number {
    const json = JSON.stringify(payload ?? null);
    const info = this.stmtAppendEvent.run(type, json, this.now());
    return info.lastInsertRowid as number;
  }

  /** Most-recent first; limit defaults to 100. */
  listRecentEvents(limit = 100): EventRow[] {
    const rows = this.stmtListEvents.all(limit) as Array<{ id: number; type: string; payload: string; created_at: number }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload) as unknown,
      created_at: r.created_at,
    }));
  }

  /** Filter by event type, most-recent first. */
  listEventsByType(type: string, limit = 100): EventRow[] {
    const rows = this.stmtListEventsByType.all(type, limit) as Array<{ id: number; type: string; payload: string; created_at: number }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload) as unknown,
      created_at: r.created_at,
    }));
  }

  /**
   * Keep the last `keepLast` event rows (rolling window — older rows DELETED).
   * Call periodically to bound disk growth; SQLite VACUUM not required for
   * normal use since auto_vacuum would add write amplification.
   */
  trimEvents(keepLast: number): void {
    this.stmtTrimEvents.run(keepLast);
  }

  close(): void {
    this.db.close();
  }
}
