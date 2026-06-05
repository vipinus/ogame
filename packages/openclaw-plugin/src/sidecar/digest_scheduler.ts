/**
 * M8.2 — Daily digest scheduler.
 *
 * At a configured local hour (default 06:00 UTC) we compile a markdown
 * summary of the plugin's known signals — Strategy version & recent updates,
 * active/blocked/completed Goals, and the last WorldState snapshot — and
 * push it to Discord through the Reporter.
 *
 * Why a polling loop rather than a single setTimeout: laptops sleep, hosts
 * suspend, and a long-pending setTimeout can fire arbitrarily late (or right
 * at wake-time, repeatedly). A short poll interval lets us notice "the
 * deadline passed and we haven't published today yet" regardless of how the
 * process got there. We still publish at most once per local day per
 * scheduler instance.
 *
 * Expedition outcome stats live in `packages/runtime-userscript`'s
 * ExpeditionStore and are NOT visible from the plugin — the digest covers
 * what the sidecar can observe directly. If the spec ever requires real
 * expedition stats here, the userscript would have to push them upstream
 * (e.g. a periodic `event.expedition_digest` envelope).
 */
import type { Reporter } from "./reporter.js";
import type { GoalsStorePg } from "./goals_store_pg.js";
import type { GoalRow } from "./goals_types.js";
import type { StrategyManager } from "./strategy_manager.js";
import type { WorldState } from "@ogamex/shared";

export interface DigestSchedulerOptions {
  /** Hour-of-day (0–23) at which to publish digest. Default 6. */
  hourOfDay?: number;
  /** Optional offset minute (0–59). Default 0. */
  minuteOfHour?: number;
  /** Timezone offset (minutes east of UTC). Default 0 (UTC). For UTC-5 = -300. */
  tzOffsetMinutes?: number;
  /** Polling interval (how often we check whether it's time to publish). Default 60000 (1 min). */
  pollIntervalMs?: number;
  /** Clock injection for tests. Default Date.now. */
  now?: () => number;
}

export interface DigestSchedulerDeps {
  reporter: Reporter | null;
  /** Phase 7c.5.e (v0.0.784) — PG primary read. SQLite goalsStore retired. */
  goalsStorePg: GoalsStorePg;
  /** Operator uid (env OGAMEX_OPERATOR_USER_ID). digest 当前是 single-tenant
   *  daily 推送 operator's Discord digest, 所以读 operator uid 的 PG 行. */
  operatorUid: string;
  strategyManager: StrategyManager;
  /** Latest snapshot mirror. */
  stateRef: { current: WorldState | null };
}

export interface DigestSchedulerHandle {
  /** Manually trigger publish now (used by tests + future ogame_publish_digest tool). */
  publishNow(): Promise<{ sent: boolean; reason?: string }>;
  stop(): void;
}

const DEFAULT_HOUR = 6;
const DEFAULT_MINUTE = 0;
const DEFAULT_TZ_OFFSET = 0;
const DEFAULT_POLL_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Start the digest scheduler. The returned handle exposes publishNow() (for
 * manual triggers + tests) and stop() (clears the polling interval).
 */
export function startDigestScheduler(
  deps: DigestSchedulerDeps,
  opts: DigestSchedulerOptions = {},
): DigestSchedulerHandle {
  const hourOfDay = opts.hourOfDay ?? DEFAULT_HOUR;
  const minuteOfHour = opts.minuteOfHour ?? DEFAULT_MINUTE;
  const tzOffsetMinutes = opts.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;

  let lastPublishedAt: number | null = null;
  // Re-entrancy guard: the poll loop must not start a second publish while
  // one is still in flight (would double-send during slow Discord calls).
  let publishing = false;

  /** Compute the most recent expected deadline (today's hour:minute in tz) <= ts. */
  function deadlineForDay(ts: number): number {
    // Shift into target tz: local epoch = utc + tzOffsetMin*60000.
    const local = ts + tzOffsetMinutes * 60_000;
    const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
    const localDeadline = dayStart + hourOfDay * 60 * 60_000 + minuteOfHour * 60_000;
    // Shift back to utc epoch.
    return localDeadline - tzOffsetMinutes * 60_000;
  }

  const tick = async (): Promise<void> => {
    if (publishing) return;
    const t = now();
    const expected = deadlineForDay(t);
    // If today's deadline is still ahead (we're earlier in the day than the
    // configured hour), we have nothing to do this tick.
    if (t < expected) return;
    if (lastPublishedAt !== null && lastPublishedAt >= expected) return;
    publishing = true;
    try {
      await publishNow();
    } finally {
      publishing = false;
    }
  };

  const intervalHandle: ReturnType<typeof setInterval> = setInterval(() => {
    // Fire-and-forget; tick() owns its own re-entry guard.
    void tick().catch((err: unknown) => {
      console.error("[DigestScheduler] tick failed", err);
    });
  }, pollIntervalMs);
  // Don't keep the event loop alive solely for the digest poll — production
  // hosts the sidecar alongside transports that already pin the loop, and
  // unit tests prefer the process to exit cleanly after stop().
  if (typeof intervalHandle.unref === "function") intervalHandle.unref();

  async function publishNow(): Promise<{ sent: boolean; reason?: string }> {
    if (deps.reporter === null) {
      return { sent: false, reason: "no reporter configured" };
    }
    // Phase 7c.5.e — PG async pre-fetch. buildDigest 仍 sync, 接 prefetched
    // goals 数组. 如果 PG 读失败 fall back 空数组 (digest 跑出来 0 active /
    // 0 completed, 比静默 throw 更可观察).
    let allGoals: GoalRow[] = [];
    try {
      allGoals = await deps.goalsStorePg.list(deps.operatorUid);
    } catch (e) {
      console.warn("[digest] goalsStorePg.list threw, using empty:", e instanceof Error ? e.message : e);
    }
    const markdown = buildDigest(deps, allGoals, now());
    let pushed: boolean;
    try {
      pushed = await deps.reporter.push(markdown);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { sent: false, reason: message };
    }
    if (!pushed) {
      // Reporter.push returns false on throttle AND on send rejection (it
      // catches and logs). We surface "throttled" — operators can correlate
      // with reporter stats / logs if they need to distinguish.
      return { sent: false, reason: "throttled" };
    }
    lastPublishedAt = now();
    return { sent: true };
  }

  const stop = (): void => {
    clearInterval(intervalHandle);
  };

  return { publishNow, stop };
}

// ---------------------------------------------------------------------------
// Digest construction
// ---------------------------------------------------------------------------

function buildDigest(deps: DigestSchedulerDeps, allGoals: GoalRow[], ts: number): string {
  const sections: string[] = [];
  sections.push("# 🪐 OgameX Daily Digest");
  sections.push("");
  sections.push(`_Generated: ${new Date(ts).toISOString()}_`);
  sections.push("");

  sections.push(strategySection(deps));
  sections.push("");
  sections.push(goalsSection(allGoals, ts));
  sections.push("");
  sections.push(snapshotSection(deps));
  sections.push("");
  sections.push("## Notes");
  sections.push("_(none — placeholder for future digestable signals)_");

  return sections.join("\n");
}

function strategySection(deps: DigestSchedulerDeps): string {
  const lines: string[] = [];
  lines.push("## Strategy");
  let version: number | "unknown" = "unknown";
  let history: ReturnType<StrategyManager["history"]> = [];
  try {
    version = deps.strategyManager.load().version;
  } catch (err) {
    // Strategy file missing or unreadable — degrade gracefully.
    lines.push(`- Current version: unknown (_${describeError(err)}_)`);
  }
  if (version !== "unknown") {
    lines.push(`- Current version: v${version}`);
  }
  try {
    history = deps.strategyManager.history();
  } catch {
    // Not a git repo, or first run — fall through with empty history.
  }
  lines.push("- Recent updates (last 5):");
  if (history.length === 0) {
    lines.push("  - _(none)_");
  } else {
    for (const entry of history.slice(0, 5)) {
      lines.push(
        `  - v${entry.version}: ${entry.reason} _(${entry.by}, ${new Date(entry.updated_at).toISOString()})_`,
      );
    }
  }
  return lines.join("\n");
}

function goalsSection(all: GoalRow[], ts: number): string {
  const lines: string[] = [];
  lines.push("## Goals");

  const active = all.filter((r) => r.status === "active" || r.status === "pending");
  const blocked = all.filter((r) => r.status === "blocked");
  const completed = all.filter((r) => r.status === "completed");

  // 24h window for completed goals. GoalRow doesn't expose updated_at on the
  // shared `Goal` shape; we use the row-level updated_at field which the
  // GoalsStore does maintain. This is exact, not an approximation — but if
  // the store ever stops persisting updated_at it would silently degrade.
  // Approximation note: kept inline per spec.
  const sinceMs = ts - DAY_MS;
  const completedRecent = completed.filter((r) => r.updated_at >= sinceMs);

  lines.push(`- Active: ${active.length}`);
  lines.push(`- Completed (last 24h): ${completedRecent.length}`);
  lines.push(`- Blocked: ${blocked.length}`);
  lines.push("");
  lines.push("### Top active goals (by priority)");
  const topActive = activeForDigest(active);
  if (topActive.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const row of topActive) {
      lines.push(
        `- [${row.goal.id}] (P${row.goal.priority}) ${row.goal.type} → ${JSON.stringify(row.goal.target)}`,
      );
    }
  }
  return lines.join("\n");
}

/** Pull up to 10 active goals sorted by priority descending. */
function activeForDigest(rows: GoalRow[]): GoalRow[] {
  return [...rows]
    .sort((a, b) => b.goal.priority - a.goal.priority)
    .slice(0, 10);
}

function snapshotSection(deps: DigestSchedulerDeps): string {
  const lines: string[] = [];
  lines.push("## Last snapshot");
  const s = deps.stateRef.current;
  if (s === null) {
    lines.push("- _(no snapshot received yet)_");
    return lines.join("\n");
  }
  const hostiles = s.events_incoming.length;
  lines.push(`- Universe: ${s.server.universe}`);
  lines.push(`- Player: ${s.player.name}`);
  lines.push(`- Planets: ${Object.keys(s.planets ?? {}).length}`);
  lines.push(`- Outbound fleets: ${s.fleets_outbound.length}`);
  lines.push(`- Hostile events: ${hostiles}`);
  return lines.join("\n");
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
