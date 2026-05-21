/**
 * M6.6 — MemoryWriter.
 *
 * Renders a human-readable Markdown digest of the live OgameX world state
 * (current WorldState + active Goals + Strategy) into OpenClaw's memory
 * subsystem so the agent can reference it across sessions.
 *
 * Behavior:
 *  - `push(snapshot)` stores the latest snapshot and schedules a debounced
 *    write (default 5s). Repeated pushes inside the window collapse to one
 *    write whose payload is the LATEST snapshot at fire-time.
 *  - A recurring `forceRefreshMs` timer (default 60s) guarantees the file is
 *    re-rendered at least that often, even if no `push` has arrived since
 *    the last write — useful for stale-detection from the agent's side.
 *  - `flush()` drains synchronously: cancels the pending debounce timer
 *    and writes the latest snapshot right now (used for shutdown).
 *  - `stop()` clears BOTH timers without flushing. Caller pairs with
 *    `flush()` when a final write is desired.
 *  - `MEMORY.md` in `memoryDir` is maintained idempotently — first write
 *    creates it; subsequent writes ensure the live-state pointer line is
 *    present exactly once.
 *
 * Writes go through `fs.mkdir({recursive:true})` + `fs.writeFile`, both of
 * which atomically replace the destination on most platforms. The pointer
 * line in MEMORY.md is appended only when absent (string search, not regex
 * because the filename is user-supplied and not necessarily regex-safe).
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { WorldState, Strategy } from "@ogamex/shared";
import type { GoalRow } from "./goals_store.js";

export interface MemoryWriterOptions {
  /** Directory containing MEMORY.md and the memory file. */
  memoryDir: string;
  /** Filename to write the live state to. Default "ogamex-live-state.md". */
  filename?: string;
  /** Debounce window for writes. Default 5000ms. */
  debounceMs?: number;
  /** Max time between forced refreshes (regardless of activity). Default 60000ms. */
  forceRefreshMs?: number;
  /** Optional clock for tests. */
  now?: () => number;
}

export interface MemorySnapshotInput {
  state: WorldState;
  goals: GoalRow[];
  strategy: Strategy;
}

export interface MemoryWriterHandle {
  /** Push a new snapshot. Writes are debounced + force-refreshed. */
  push(input: MemorySnapshotInput): void;
  /** Force a write right now (used for shutdown flush). */
  flush(): Promise<void>;
  stop(): void;
}

const DEFAULT_FILENAME = "ogamex-live-state.md";
const DEFAULT_DEBOUNCE_MS = 5000;
const DEFAULT_FORCE_REFRESH_MS = 60_000;
const MEMORY_INDEX_HEADER = "# Memory Index\n\n";
const POINTER_SUFFIX = " — auto-updated by ogamex plugin";

export function startMemoryWriter(opts: MemoryWriterOptions): MemoryWriterHandle {
  const memoryDir = opts.memoryDir;
  const filename = opts.filename ?? DEFAULT_FILENAME;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const forceRefreshMs = opts.forceRefreshMs ?? DEFAULT_FORCE_REFRESH_MS;
  const now = opts.now ?? Date.now;

  const memoryFile = join(memoryDir, filename);
  const indexFile = join(memoryDir, "MEMORY.md");
  const pointerLine = `- [OgameX live state](./${filename})${POINTER_SUFFIX}`;

  let latest: MemorySnapshotInput | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastWriteAt = Number.NEGATIVE_INFINITY;

  // Async write critical section — multiple firing paths (debounce, force
  // refresh, flush) must not interleave fs.writeFile calls or the MEMORY.md
  // dedupe check could race against itself.
  let writeChain: Promise<void> = Promise.resolve();

  const writeNow = async (): Promise<void> => {
    const snap = latest;
    if (snap === null) return;
    const markdown = renderMarkdown(snap, now());
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(memoryFile, markdown, "utf-8");
    await ensureIndexPointer(indexFile, pointerLine);
    lastWriteAt = now();
  };

  const scheduleWriteChain = (): Promise<void> => {
    writeChain = writeChain.then(writeNow).catch((err: unknown) => {
      // Surface but never crash the timer loop — a transient EIO must not
      // stop the agent's heartbeat. Operators see this in plugin logs.
      console.error("[ogamex/MemoryWriter] write failed", err);
    });
    return writeChain;
  };

  const onDebounceFire = (): void => {
    debounceTimer = null;
    if (stopped) return;
    void scheduleWriteChain();
  };

  const forceTimer = setInterval(() => {
    if (stopped) return;
    if (latest === null) return;
    // If we've written within forceRefreshMs we don't need to force.
    if (now() - lastWriteAt < forceRefreshMs) return;
    // Cancel any pending debounce — we're writing right now anyway.
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    void scheduleWriteChain();
  }, forceRefreshMs);
  // Don't keep the event loop alive solely for the force-refresh tick.
  if (typeof forceTimer.unref === "function") forceTimer.unref();

  const push = (input: MemorySnapshotInput): void => {
    if (stopped) return;
    latest = input;
    if (debounceTimer !== null) return; // existing timer will pick up latest
    debounceTimer = setTimeout(onDebounceFire, debounceMs);
    if (typeof debounceTimer.unref === "function") debounceTimer.unref();
  };

  const flush = async (): Promise<void> => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (latest === null) return;
    await scheduleWriteChain();
  };

  const stop = (): void => {
    stopped = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    clearInterval(forceTimer);
  };

  return { push, flush, stop };
}

/**
 * Append the pointer line to MEMORY.md if absent. Idempotent — repeated calls
 * never produce duplicates. Creates the file with a fresh header when missing.
 */
async function ensureIndexPointer(indexFile: string, pointerLine: string): Promise<void> {
  let existing: string;
  try {
    existing = await fs.readFile(indexFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(indexFile, MEMORY_INDEX_HEADER + pointerLine + "\n", "utf-8");
      return;
    }
    throw err;
  }
  if (existing.includes(pointerLine)) return;
  const sep = existing.endsWith("\n") ? "" : "\n";
  await fs.writeFile(indexFile, existing + sep + pointerLine + "\n", "utf-8");
}

// --- Markdown rendering ---------------------------------------------------

function renderMarkdown(snap: MemorySnapshotInput, nowMs: number): string {
  const { state, goals, strategy } = snap;
  const lines: string[] = [];

  lines.push("# OgameX live state");
  lines.push("");
  lines.push("> Auto-updated by the OgameX plugin. **Do not edit by hand.**");
  lines.push("");
  lines.push(`_Last refresh: ${new Date(nowMs).toISOString()}_`);
  lines.push("");

  lines.push("## Server");
  lines.push(`- Universe: ${state.server.universe}`);
  lines.push(`- Speed: ${state.server.speed}x`);
  lines.push("");

  lines.push("## Player");
  lines.push(`- Name: ${state.player.name}`);
  lines.push(`- ID: ${state.player.id}`);
  lines.push(`- Alliance: ${state.player.alliance ?? "(none)"}`);
  lines.push("");

  lines.push(`## Planets (${Object.keys(state.planets ?? {}).length})`);
  lines.push("| Coord | Name | Metal | Crystal | Deuterium |");
  lines.push("|---|---|---|---|---|");
  for (const p of Object.values(state.planets ?? {})) {
    const coord = `${p.coords[0]}:${p.coords[1]}:${p.coords[2]}`;
    lines.push(
      `| ${coord} | ${p.name} | ${Math.floor(p.resources.m)} | ${Math.floor(p.resources.c)} | ${Math.floor(p.resources.d)} |`,
    );
  }
  lines.push("");

  lines.push("## Goals (active)");
  if (goals.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const row of goals) {
      const g = row.goal;
      const targetJson = JSON.stringify(g.target);
      lines.push(`- \`${g.id}\` [${row.status}] ${g.type} → ${targetJson} (priority ${g.priority})`);
    }
  }
  lines.push("");

  lines.push("## Strategy");
  lines.push(`- Version: ${strategy.version}`);
  lines.push(`- Updated: ${new Date(strategy.updated_at).toISOString()}`);
  lines.push(`- Updated by: ${strategy.updated_by}`);
  lines.push(`- Reason: ${strategy.reason}`);
  lines.push("");

  const hostileCount = state.events_incoming.filter((e) => e.hostile).length;
  lines.push("## Stats");
  lines.push(`- Outbound fleets: ${state.fleets_outbound.length}`);
  lines.push(`- Incoming events (hostile/total): ${hostileCount}/${state.events_incoming.length}`);
  lines.push("");

  return lines.join("\n");
}
