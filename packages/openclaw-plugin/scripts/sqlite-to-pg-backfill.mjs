#!/usr/bin/env node
/**
 * Phase 3 — SQLite → PostgreSQL backfill.
 *
 * Standalone ESM Node script that reads goals.db + world.db (better-sqlite3)
 * and forward-fills ogame_goals + ogame_events in PG. Idempotent via
 * `ON CONFLICT(id) DO NOTHING` on goals; events get fresh PG identity ids
 * (we do not preserve old SQLite ids — they are local autoincrement and
 * not load-bearing for downstream readers).
 *
 * Usage:
 *   node scripts/sqlite-to-pg-backfill.mjs \
 *     --user-id=4baba0e2-17ab-4275-a8eb-d642ba8d969f \
 *     [--goals-db=/home/ddxs/.openclaw/workspace/ogamex/goals.db] \
 *     [--world-db=/home/ddxs/.openclaw/workspace/ogamex/world.db] \
 *     [--pg-url=postgres://...]  (or env DATABASE_URL) \
 *     [--dry-run | --execute]    (default --dry-run)
 *
 * Defaults are conservative — without --execute the script PLANS only:
 *   - opens both SQLite dbs read-only
 *   - opens the PG pool
 *   - counts source rows + describes the first/last few that would write
 *   - exits cleanly without mutating PG.
 *
 * Errors abort the batch and the offending row id is printed.
 */

import { parseArgs } from "node:util";
import path from "node:path";

import Database from "better-sqlite3";
import postgres from "postgres";

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    "dry-run":   { type: "boolean", default: true },
    "execute":   { type: "boolean", default: false },
    "user-id":   { type: "string" },
    "goals-db":  { type: "string", default: "/home/ddxs/.openclaw/workspace/ogamex/goals.db" },
    "world-db":  { type: "string", default: "/home/ddxs/.openclaw/workspace/ogamex/world.db" },
    "pg-url":    { type: "string" },
    "batch-size":{ type: "string", default: "500" },
    "help":      { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: sqlite-to-pg-backfill.mjs --user-id=<uuid> [--execute]

Required:
  --user-id=<uuid>      Tenant uid that owns these legacy SQLite rows.

Optional:
  --goals-db=<path>     SQLite goals.db          (default: ~/.openclaw/workspace/ogamex/goals.db)
  --world-db=<path>     SQLite world.db          (default: ~/.openclaw/workspace/ogamex/world.db)
  --pg-url=<url>        Postgres connection url  (default: \$DATABASE_URL)
  --batch-size=<n>      PG insert batch size     (default: 500)
  --dry-run             Plan-only, no PG writes  (default: true)
  --execute             Actually write to PG     (overrides --dry-run)
`);
  process.exit(0);
}

const userId    = values["user-id"];
const goalsDb   = values["goals-db"];
const worldDb   = values["world-db"];
const pgUrl     = values["pg-url"] ?? process.env.DATABASE_URL;
const batchSize = Math.max(1, Number.parseInt(String(values["batch-size"]), 10) || 500);
// --execute beats default --dry-run=true
const execute   = Boolean(values.execute);
const dryRun    = !execute;

if (!userId) {
  console.error("ERROR: --user-id=<uuid> is required");
  process.exit(2);
}
if (!pgUrl) {
  console.error("ERROR: provide --pg-url=<url> or set DATABASE_URL env");
  process.exit(2);
}

console.log(dryRun ? "DRY RUN — no PG writes will occur" : "EXECUTING — PG will be mutated");
console.log(`  user-id  : ${userId}`);
console.log(`  goals-db : ${path.resolve(goalsDb)}`);
console.log(`  world-db : ${path.resolve(worldDb)}`);
console.log(`  pg-url   : ${redactPgUrl(pgUrl)}`);
console.log(`  batch    : ${batchSize}`);
console.log("");

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function redactPgUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable>";
  }
}

/** Pull is_main_goal out of the embedded Goal JSON (defaults false). */
function extractIsMainGoal(goalJsonText) {
  try {
    const g = JSON.parse(goalJsonText);
    return g && g.is_main_goal === true;
  } catch {
    return false;
  }
}

/** epoch-ms → Date safe for `postgres` driver. */
function msToDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return new Date(0);
  return new Date(n);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  // Open SQLite dbs read-only — never mutate the source of truth here.
  const goalsSqlite = new Database(goalsDb, { readonly: true, fileMustExist: true });
  const worldSqlite = new Database(worldDb, { readonly: true, fileMustExist: true });

  // Open PG pool.
  const sql = postgres(pgUrl, {
    max: 4,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });

  let backfilledGoals = 0;
  let backfilledEvents = 0;
  let skippedGoals = 0;
  let skippedEvents = 0;

  try {
    // --- Goals -------------------------------------------------------------
    // The SQLite goals table has nullable user_id; we WANT only rows that
    // belong to the operator. Legacy NULL rows are also operator-owned per
    // the boot-time backfill convention (see goals_store.backfillLegacyUserId).
    // We accept both: user_id = ? OR user_id IS NULL.
    const goalRows = goalsSqlite.prepare(
      `SELECT id, goal_json, status, reason, created_at, updated_at
         FROM goals
        WHERE user_id = ? OR user_id IS NULL
        ORDER BY created_at ASC`,
    ).all(userId);
    console.log(`[goals]  source rows (user_id = ? OR NULL) : ${goalRows.length}`);

    const pgGoalCount = Number((await sql`
      SELECT COUNT(*)::int AS n FROM ogame_goals WHERE user_id = ${userId}
    `)[0].n);
    console.log(`[goals]  pg existing rows for user         : ${pgGoalCount}`);

    if (goalRows.length > 0) {
      console.log("[goals]  sample first row id  :", goalRows[0].id);
      console.log("[goals]  sample first ts (ms) :", goalRows[0].created_at);
      console.log("[goals]  sample last  row id  :", goalRows[goalRows.length - 1].id);
    }

    if (dryRun) {
      // Count how many would actually insert vs conflict-skip.
      if (goalRows.length > 0) {
        const ids = goalRows.map((r) => r.id);
        const existing = await sql`
          SELECT id FROM ogame_goals WHERE id IN ${sql(ids)}
        `;
        const existingSet = new Set(existing.map((r) => r.id));
        const willInsert = goalRows.filter((r) => !existingSet.has(r.id)).length;
        const willSkip   = goalRows.length - willInsert;
        console.log(`[goals]  PLAN: would insert ${willInsert}, conflict-skip ${willSkip}`);
      } else {
        console.log("[goals]  PLAN: nothing to do");
      }
    } else {
      // Real execution: chunked INSERT ... VALUES (...), ON CONFLICT DO NOTHING.
      for (let i = 0; i < goalRows.length; i += batchSize) {
        const chunk = goalRows.slice(i, i + batchSize);
        const rowsForPg = chunk.map((r) => ({
          id:           r.id,
          user_id:      userId,
          goal_json:    sql.json(safeParse(r.goal_json)),
          status:       r.status,
          reason:       r.reason ?? null,
          is_main_goal: extractIsMainGoal(r.goal_json),
          created_at:   msToDate(r.created_at),
          updated_at:   msToDate(r.updated_at),
        }));

        try {
          const result = await sql`
            INSERT INTO ogame_goals ${sql(
              rowsForPg,
              "id",
              "user_id",
              "goal_json",
              "status",
              "reason",
              "is_main_goal",
              "created_at",
              "updated_at",
            )}
            ON CONFLICT (id) DO NOTHING
          `;
          // postgres lib `result.count` = affected rows.
          const inserted = Number(result.count ?? 0);
          backfilledGoals += inserted;
          skippedGoals    += chunk.length - inserted;
          process.stdout.write(
            `[goals]  chunk ${i / batchSize + 1}: +${inserted}, skipped ${chunk.length - inserted}\r`,
          );
        } catch (e) {
          console.error(`\n[goals] BATCH ABORTED at chunk starting row id "${chunk[0]?.id}":`, e.message ?? e);
          throw e;
        }
      }
      if (goalRows.length > 0) process.stdout.write("\n");
    }

    // --- Events ------------------------------------------------------------
    // SQLite events table has no user_id column — every row is operator-owned.
    const eventRows = worldSqlite.prepare(
      `SELECT id, type, payload, created_at FROM events ORDER BY id ASC`,
    ).all();
    console.log(`\n[events] source rows                       : ${eventRows.length}`);

    const pgEventCount = Number((await sql`
      SELECT COUNT(*)::int AS n FROM ogame_events WHERE user_id = ${userId}
    `)[0].n);
    console.log(`[events] pg existing rows for user         : ${pgEventCount}`);

    if (eventRows.length > 0) {
      console.log("[events] sample first sqlite id      :", eventRows[0].id);
      console.log("[events] sample first ts (ms)        :", eventRows[0].created_at);
      console.log("[events] sample last  sqlite id      :", eventRows[eventRows.length - 1].id);
    }

    if (dryRun) {
      // Cannot dedupe events deterministically (PG identity ids are fresh).
      // PLAN assumes all rows would insert — operator should be aware that
      // re-running execute mode would double-insert. Recommendation in
      // README: TRUNCATE ogame_events WHERE user_id=? before re-run, OR
      // accept that this is a one-shot.
      console.log(`[events] PLAN: would insert ${eventRows.length} (NOTE: not idempotent — PG identity)`);
    } else {
      for (let i = 0; i < eventRows.length; i += batchSize) {
        const chunk = eventRows.slice(i, i + batchSize);
        const rowsForPg = chunk.map((r) => ({
          user_id:    userId,
          type:       String(r.type ?? ""),
          payload:    sql.json(safeParse(r.payload)),
          created_at: msToDate(r.created_at),
        }));
        try {
          const result = await sql`
            INSERT INTO ogame_events ${sql(
              rowsForPg,
              "user_id",
              "type",
              "payload",
              "created_at",
            )}
          `;
          const inserted = Number(result.count ?? chunk.length);
          backfilledEvents += inserted;
          process.stdout.write(
            `[events] chunk ${i / batchSize + 1}: +${inserted}\r`,
          );
        } catch (e) {
          console.error(`\n[events] BATCH ABORTED at chunk starting sqlite-id "${chunk[0]?.id}":`, e.message ?? e);
          throw e;
        }
      }
      if (eventRows.length > 0) process.stdout.write("\n");
    }
  } finally {
    goalsSqlite.close();
    worldSqlite.close();
    await sql.end({ timeout: 5 });
  }

  console.log("");
  console.log(
    dryRun
      ? `DRY RUN complete — PLAN ONLY, no writes performed.`
      : `backfilled ${backfilledGoals} goals, ${backfilledEvents} events, ${skippedGoals + skippedEvents} skipped (goals: ${skippedGoals}, events: ${skippedEvents})`,
  );
}

function safeParse(text) {
  if (text == null) return null;
  try { return JSON.parse(text); }
  catch { return { __unparsed__: String(text) }; }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
