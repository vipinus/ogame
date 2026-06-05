/**
 * Phase 7c.5.f (v0.0.784) — SQLite GoalsStore retired.
 *
 * 类被保留作 backwards-compat shell (constructor accepts {dbPath} no-op),
 * 所有 method noop / 返回空. 真实读写完全切 PG (goals_store_pg.ts).
 *
 * 物理 rm 此 file 留作 Phase 7d 单独 cleanup, 现在 retained so that
 * `import { GoalsStore } from "./goals_store.js"` 不 break boot. Class
 * instance 不再 hold SQLite handle, 也不再 require better-sqlite3 dep
 * (操作员同步 rm 了 package.json `better-sqlite3` 跟物理 .db).
 *
 * Type re-exports for backwards compat. New code 应 import 自 ./goals_types.js.
 */
import type { Goal } from "@ogamex/shared";
import type { GoalRow, GoalStatus } from "./goals_types.js";
export type { GoalRow, GoalStatus } from "./goals_types.js";

export interface GoalsStoreOptions {
  /** Retained for signature parity with v0.0.783 callers. Ignored — no
   *  SQLite file is opened. PG is the sole store. */
  dbPath: string;
  clock?: () => number;
}

export class GoalsStore {
  constructor(_opts: GoalsStoreOptions) { /* no-op (PG primary) */ }

  backfillLegacyUserId(_legacyUserId: string): number { return 0; }
  listActiveByUser(_userId: string | undefined): GoalRow[] { return []; }
  addForUser(_goal: Goal, _userId: string | undefined): GoalRow { throw new Error("GoalsStore retired — use goalsStorePg"); }
  add(_goal: Goal): GoalRow { throw new Error("GoalsStore retired — use goalsStorePg"); }
  get(_id: string): GoalRow | null { return null; }
  updateStatus(_id: string, _status: GoalStatus, _reason?: string): GoalRow { throw new Error("GoalsStore retired — use goalsStorePg.updateGoalStatus"); }
  updateTarget(_id: string, _target: Record<string, unknown>): GoalRow { throw new Error("GoalsStore retired — use goalsStorePg.updateGoalTarget"); }
  remove(_id: string): void { /* no-op */ }
  list(): GoalRow[] { return []; }
  listByStatus(_status: GoalStatus): GoalRow[] { return []; }
  listActive(): GoalRow[] { return []; }
  listByUser(_userId: string | undefined): GoalRow[] { return []; }
  ownerOf(_goalId: string): string | undefined { return undefined; }
  listChildren(_parentId: string): GoalRow[] { return []; }
  getMainGoal(_userId: string): GoalRow | null { return null; }
  setMainGoal(_userId: string, _goalId: string | null): void { /* no-op */ }
  close(): void { /* no-op */ }
}
