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
  CREATE TABLE IF NOT EXISTS save_records (
    planet_id          TEXT PRIMARY KEY,
    fleet_id           INTEGER NOT NULL,
    state              TEXT NOT NULL,
    pending_event_ids  TEXT NOT NULL,
    cleared_at         INTEGER,
    launched_at        INTEGER NOT NULL,
    last_error         TEXT
  );
`;

export interface EventRow {
  id: number;
  type: string;
  payload: unknown;
  created_at: number;
}

/**
 * Persistence shape for SaveCoordinator records. Mirrors SaveRecord in
 * save_coordinator.ts but represents `pendingEventIds` as an array — Sets
 * don't serialize, and the table column is a JSON array column anyway.
 */
export interface PersistedSaveRecord {
  planet_id: string;
  fleet_id: number;
  state: string; // "IN_FLIGHT" | "RECALLING" | "RETURNED" | "FALLBACK"
  pending_event_ids: string[];
  cleared_at: number | null;
  launched_at: number;
  last_error: string | null;
}

export class WorldStateStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  /** Append counter — drives self-trim every TRIM_EVERY_N appends so a busy
   *  directive stream (1+/s) doesn't grow the events table without bound
   *  between sidecar restarts. */
  private appendCounter = 0;
  private static readonly TRIM_EVERY_N = 1000;
  private static readonly TRIM_KEEP_LAST = 10_000;
  private readonly stmtGet: Database.Statement<[]>;
  private readonly stmtUpsert: Database.Statement<[string, number]>;
  private readonly stmtAppendEvent: Database.Statement<[string, string, number]>;
  private readonly stmtListEvents: Database.Statement<[number]>;
  private readonly stmtListEventsByType: Database.Statement<[string, number]>;
  private readonly stmtTrimEvents: Database.Statement<[number]>;
  private readonly stmtUpsertSaveRecord: Database.Statement<[string, number, string, string, number | null, number, string | null]>;
  private readonly stmtDeleteSaveRecord: Database.Statement<[string]>;
  private readonly stmtListSaveRecords: Database.Statement<[]>;

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
    this.stmtUpsertSaveRecord = this.db.prepare<[string, number, string, string, number | null, number, string | null]>(
      "INSERT INTO save_records (planet_id, fleet_id, state, pending_event_ids, cleared_at, launched_at, last_error) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?) "
      + "ON CONFLICT(planet_id) DO UPDATE SET "
      + "  fleet_id = excluded.fleet_id, "
      + "  state = excluded.state, "
      + "  pending_event_ids = excluded.pending_event_ids, "
      + "  cleared_at = excluded.cleared_at, "
      + "  launched_at = excluded.launched_at, "
      + "  last_error = excluded.last_error",
    );
    this.stmtDeleteSaveRecord = this.db.prepare<[string]>("DELETE FROM save_records WHERE planet_id = ?");
    this.stmtListSaveRecords = this.db.prepare<[]>(
      "SELECT planet_id, fleet_id, state, pending_event_ids, cleared_at, launched_at, last_error FROM save_records",
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
    this.appendCounter += 1;
    if (this.appendCounter % WorldStateStore.TRIM_EVERY_N === 0) {
      try { this.stmtTrimEvents.run(WorldStateStore.TRIM_KEEP_LAST); }
      catch { /* trim is best-effort; never block append */ }
    }
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

  /**
   * Persist (insert or update) a save-coordinator record keyed by planet_id.
   * Operator 2026-06-01 "要持久化所有数据" — without this, a sidecar restart
   * during an active hostile window forgets the launched-fleet → recall map
   * and the FSM cannot fire save.recall_now when hostiles clear.
   */
  upsertSaveRecord(rec: PersistedSaveRecord): void {
    this.stmtUpsertSaveRecord.run(
      rec.planet_id,
      rec.fleet_id,
      rec.state,
      JSON.stringify(rec.pending_event_ids),
      rec.cleared_at,
      rec.launched_at,
      rec.last_error,
    );
  }

  /** Drop the record for a planet (called when state → RETURNED / FALLBACK). */
  deleteSaveRecord(planet_id: string): void {
    this.stmtDeleteSaveRecord.run(planet_id);
  }

  /** Load all persisted records. Called at boot to rehydrate SaveCoordinator. */
  listSaveRecords(): PersistedSaveRecord[] {
    const rows = this.stmtListSaveRecords.all() as Array<{
      planet_id: string;
      fleet_id: number;
      state: string;
      pending_event_ids: string;
      cleared_at: number | null;
      launched_at: number;
      last_error: string | null;
    }>;
    return rows.map((r) => ({
      planet_id: r.planet_id,
      fleet_id: r.fleet_id,
      state: r.state,
      pending_event_ids: JSON.parse(r.pending_event_ids) as string[],
      cleared_at: r.cleared_at,
      launched_at: r.launched_at,
      last_error: r.last_error,
    }));
  }

  /**
   * Force a WAL checkpoint, merging the -wal file back into the main .db.
   * better-sqlite3 in WAL mode only auto-checkpoints on close / commit
   * boundaries / 1000-page threshold; a long-running sidecar with bursty
   * writes (state.snapshot every 2s, directives ~1/s) can accumulate
   * hundreds of MB of WAL between natural checkpoints. Call this on a
   * 5-min cadence from startSidecar so disk stays bounded.
   *
   * TRUNCATE mode = checkpoint + zero out the WAL file. PASSIVE wouldn't
   * shrink the file. Safe to call while readers are active — WAL mode
   * never blocks reads.
   */
  checkpoint(): void {
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); }
    catch (e) { console.warn("[WorldStateStore] wal_checkpoint failed (continuing)", e); }
  }

  close(): void {
    this.db.close();
  }
}
