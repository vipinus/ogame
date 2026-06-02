/**
 * Phase 5 dual-read wrapper: SQLite primary + PG shadow with drift logging.
 *
 * Exposes the async IGoalsStoreReader so consumers target ONE interface.
 * In "dual" mode every call reads SQLite synchronously (primary, returned
 * to the caller) AND fires the PG read in shadow; results are compared
 * by (id, status). Drift gets a throttled console.warn line.
 *
 * PG read errors are swallowed silently — they must NEVER taint the hot
 * path. SQLite is the only source of truth in Phase 5.
 *
 * Once 7 days of zero-drift logs accumulate, Phase 6 swaps primary to
 * PG (consumers already use the async surface, so the wrapper drops out).
 */

import type { GoalsStore, GoalRow, GoalStatus } from "./goals_store.js";
import type { IGoalsStoreReader } from "./goals_store_iface.js";

interface DriftCounter {
  total_calls: number;
  drift_count: number;
  last_log_ts: number | null;
}

interface DualOpts {
  sqlite: GoalsStore;
  pg: IGoalsStoreReader | null;
  /** Minimum ms between drift log lines per method (avoid spam). Default 60_000. */
  logFloorMs?: number;
}

export class DualReadGoalsStore implements IGoalsStoreReader {
  private readonly sqlite: GoalsStore;
  private readonly pg: IGoalsStoreReader | null;
  private readonly logFloor: number;
  private readonly metrics: Record<string, DriftCounter> = {};

  constructor(opts: DualOpts) {
    this.sqlite = opts.sqlite;
    this.pg = opts.pg;
    this.logFloor = opts.logFloorMs ?? 60_000;
  }

  /** Snapshot of per-method drift counters (for /v1/debug exposure). */
  getMetrics(): Readonly<Record<string, DriftCounter>> {
    return this.metrics;
  }

  // ---------- IGoalsStoreReader (async surface) ----------

  async listActiveByUser(userId: string): Promise<GoalRow[]> {
    const primary = this.sqlite.listActiveByUser(userId);
    this.shadowCompare("listActiveByUser", primary, () => this.pg?.listActiveByUser(userId) ?? null);
    return primary;
  }

  async listByUser(userId: string): Promise<GoalRow[]> {
    const primary = this.sqlite.listByUser(userId);
    this.shadowCompare("listByUser", primary, () => this.pg?.listByUser(userId) ?? null);
    return primary;
  }

  /** SQLite has no per-user `list()` — alias to listByUser for the iface. */
  async list(userId: string): Promise<GoalRow[]> {
    return this.listByUser(userId);
  }

  async get(userId: string, id: string): Promise<GoalRow | null> {
    const sqliteRow = this.sqlite.get(id);
    // Ownership filter — only return if the row belongs to this user.
    const owner = this.sqlite.ownerOf(id);
    const primary = sqliteRow && owner === userId ? sqliteRow : null;
    this.shadowCompare(
      "get",
      primary ? [primary] : [],
      () => {
        const r = this.pg?.get(userId, id);
        return r ? r.then((row) => (row ? [row] : [])) : null;
      },
    );
    return primary;
  }

  async listByStatus(userId: string, status: GoalStatus): Promise<GoalRow[]> {
    // SQLite has listByStatus(status) cross-tenant — filter by user post-hoc.
    const primary = this.sqlite
      .listByUser(userId)
      .filter((r) => r.status === status);
    this.shadowCompare("listByStatus", primary, () => this.pg?.listByStatus(userId, status) ?? null);
    return primary;
  }

  async listChildren(userId: string, parentId: string): Promise<GoalRow[]> {
    // SQLite scans by parent across all users — verify ownership.
    const children = this.sqlite.listChildren(parentId);
    const owned = children.filter(() => {
      // Ownership probe uses parent's owner — children inherit chain context.
      const owner = this.sqlite.ownerOf(parentId);
      return owner === userId;
    });
    this.shadowCompare("listChildren", owned, () => this.pg?.listChildren(userId, parentId) ?? null);
    return owned;
  }

  async ownerOf(userId: string, goalId: string): Promise<string | undefined> {
    // SQLite returns the owner unconditionally; PG signature treats ownerOf
    // as a probe (returns userId iff matched). Reconcile by checking ==.
    const actual = this.sqlite.ownerOf(goalId);
    const primary = actual === userId ? userId : undefined;
    const wrap = (v: string | undefined): GoalRow[] =>
      v ? [{ goal: { id: goalId }, status: "pending", created_at: 0, updated_at: 0 } as unknown as GoalRow] : [];
    this.shadowCompare(
      "ownerOf",
      wrap(primary),
      () => {
        const r = this.pg?.ownerOf(userId, goalId);
        return r ? r.then(wrap) : null;
      },
    );
    return primary;
  }

  async getMainGoal(userId: string): Promise<GoalRow | null> {
    // SQLite getMainGoal() is per-user (filters by user_id internally in
    // recent revisions). Verify ownership to be defensive.
    const row = this.sqlite.getMainGoal();
    const owner = row ? this.sqlite.ownerOf((row.goal as { id?: string }).id ?? "") : undefined;
    const primary = row && owner === userId ? row : null;
    this.shadowCompare("getMainGoal", primary ? [primary] : [], () => {
      const r = this.pg?.getMainGoal(userId);
      return r ? r.then((v) => (v ? [v] : [])) : null;
    });
    return primary;
  }

  // ---------- drift comparator (fire-and-forget) ----------

  private shadowCompare(
    label: string,
    sqliteResult: GoalRow[],
    pgFactory: () => Promise<GoalRow[]> | null,
  ): void {
    if (!this.pg) return;
    const counter = (this.metrics[label] ??= { total_calls: 0, drift_count: 0, last_log_ts: null });
    counter.total_calls += 1;
    const p = pgFactory();
    if (!p) return;
    p.then((pgResult) => {
      const drift = this.compareRows(sqliteResult, pgResult);
      if (!drift) return;
      counter.drift_count += 1;
      this.maybeLog(label, counter, `sqlite=${sqliteResult.length} pg=${pgResult.length} ${drift.summary}`);
    }).catch((e) => {
      this.maybeLog(label, counter, `pg read threw: ${e instanceof Error ? e.message : e}`);
    });
  }

  private maybeLog(label: string, counter: DriftCounter, body: string): void {
    const now = Date.now();
    const last = counter.last_log_ts ?? 0;
    if (now - last < this.logFloor) return;
    counter.last_log_ts = now;
    console.warn(`[ogamex/sidecar/drift] ${label}: ${body}`);
  }

  private compareRows(a: GoalRow[], b: GoalRow[]): { summary: string } | null {
    if (a.length !== b.length) return { summary: `count ${a.length}≠${b.length}` };
    const idx = new Map<string, GoalRow>();
    for (const row of b) {
      const id = (row.goal as { id?: string }).id;
      if (id) idx.set(id, row);
    }
    const divergent: string[] = [];
    for (const row of a) {
      const id = (row.goal as { id?: string }).id;
      if (!id) continue;
      const bRow = idx.get(id);
      if (!bRow) divergent.push(`missing-in-pg:${id}`);
      else if (bRow.status !== row.status) divergent.push(`status:${id}:${row.status}≠${bRow.status}`);
      if (divergent.length >= 3) break;
    }
    return divergent.length ? { summary: divergent.join(",") } : null;
  }
}
