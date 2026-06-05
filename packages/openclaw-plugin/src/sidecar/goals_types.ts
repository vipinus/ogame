import type { Goal } from "@ogamex/shared";

/**
 * Phase 7c.5.d (v0.0.784) — types 解耦. 之前 GoalRow / GoalStatus 同时
 * 是 goals_store.ts (SQLite) 的内部 type, 所有 consumer (priority_merger,
 * goals_store_pg, world_state_store_pg, memory_writer, digest_scheduler,
 * index.ts) 都要 `import type ... from "./goals_store.js"`. 这条 import
 * 链阻塞 SQLite file 物理删除. 抽到独立 `goals_types.ts` 后, 全部 type-
 * only 引用切到这里, goals_store.ts 真成"只剩 SQLite class"的孤岛.
 *
 * Status: terminal = completed/cancelled. Non-terminal (returned by
 * listActive) = pending/active/blocked.
 */
export type GoalStatus = "pending" | "active" | "blocked" | "completed" | "cancelled";

export interface GoalRow {
  goal: Goal;
  status: GoalStatus;
  reason?: string;
  created_at: number;
  updated_at: number;
}
