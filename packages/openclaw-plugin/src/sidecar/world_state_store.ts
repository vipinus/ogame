/**
 * Phase 7c.5.f (v0.0.784) — SQLite WorldStateStore retired.
 *
 * 类被保留作 backwards-compat shell (constructor accepts {dbPath} no-op),
 * 所有 method noop / 返回空. 真实读写完全切 PG (world_state_store_pg.ts +
 * shadowFire mirror).
 *
 * 物理 rm 此 file 留作 Phase 7d 单独 cleanup, 现在 retained so that
 * `import { WorldStateStore } from "./world_state_store.js"` 不 break boot.
 * Class instance 不再 hold SQLite handle, 也不再 require better-sqlite3 dep
 * (操作员同步 rm 了 package.json `better-sqlite3` 跟物理 .db).
 */
import type { WorldState } from "@ogamex/shared";

export interface WorldStateStoreOptions {
  /** Retained for signature parity with v0.0.783 callers. Ignored — no
   *  SQLite file is opened. PG is the sole store. */
  dbPath: string;
  clock?: () => number;
}

export interface EventRow {
  id: number;
  type: string;
  payload: unknown;
  created_at: number;
}

export interface PersistedSaveRecord {
  planet_id: string;
  fleet_id: number;
  state: string;
  pending_event_ids: string[];
  cleared_at: number | null;
  launched_at: number;
  last_error: string | null;
}

export class WorldStateStore {
  constructor(_opts: WorldStateStoreOptions) { /* no-op (PG primary) */ }

  hydrate(): { state: WorldState; updated_at: number } | null { return null; }
  upsert(_state: WorldState): void { /* no-op */ }
  upsertWorldState(_state: WorldState): void { /* no-op (alias) */ }
  lastUpdatedAt(): number | null { return null; }

  appendEvent(_type: string, _payload: unknown): number { return 0; }
  listRecentEvents(_limit = 100): EventRow[] { return []; }
  listEventsByType(_type: string, _limit = 100): EventRow[] { return []; }
  trimEvents(_keepLast: number): void { /* no-op */ }

  upsertSaveRecord(_rec: PersistedSaveRecord): void { /* no-op */ }
  deleteSaveRecord(_planet_id: string): void { /* no-op */ }
  listSaveRecords(): PersistedSaveRecord[] { return []; }

  upsertFailureCooldown(_task: string, _last_analysis_at: number): void { /* no-op */ }
  listFailureCooldowns(): Array<{ task: string; last_analysis_at: number }> { return []; }

  rowCounts(): { events: number; save_records: number; failure_cooldowns: number; world_state_present: boolean } {
    return { events: 0, save_records: 0, failure_cooldowns: 0, world_state_present: false };
  }

  checkpoint(): void { /* no-op */ }
  close(): void { /* no-op */ }
}
