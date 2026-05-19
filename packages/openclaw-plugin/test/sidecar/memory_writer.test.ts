import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startMemoryWriter,
  type MemorySnapshotInput,
} from "../../src/sidecar/memory_writer.js";
import type { WorldState, Strategy } from "@ogamex/shared";
import type { GoalRow } from "../../src/sidecar/goals_store.js";

/** Minimum-valid WorldState; tests override what they exercise. */
function makeState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    server: { universe: "uni-test", speed: 7 },
    player: { id: "p-1", name: "TestCmdr", alliance: null },
    planets: [],
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 1 },
    discovery_active: [],
    last_update: 0,
    page_snapshots: {},
    ...overrides,
  };
}

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    version: 1,
    updated_at: 1_700_000_000_000,
    updated_by: "openclaw-llm",
    reason: "initial",
    daily: {
      expedition: {
        enabled: false,
        auto_fill_slots: false,
        source_planet: null,
        duration: "short",
        target_position: 16,
        fleet_templates: {},
        galaxy_strategy: {
          mode: "fixed",
          home_galaxy_first: true,
          switch_threshold: { black_hole_rate_24h: 0.1, sample_size_min: 20 },
          cross_galaxy_deut_budget: 100000,
        },
        cargo_load: { smallCargo_capacity_pct: 80, largeCargo_capacity_pct: 80 },
      },
      resource_balance: { enabled: false, trigger_overflow_pct: 90 },
      defense_replenish: { enabled: false, keep_minimum: {} },
      default_build: { enabled: false, strategy: "balanced", ratio: {} },
      heartbeat: { enabled: false, schedule: [] },
    },
    emergency: {
      attack: {
        save_window_minutes: 30,
        prefer_moon: true,
        alliance_safe_planets: [],
        safety_margin_minutes: 5,
      },
      spy: { push_immediate: true, counter_spy: false, log_attacker: true },
      anomaly: { push_immediate: true, pause_planet_automation: false },
      resource_critical: { threshold_pct: 95, try_redistribute_first: true },
    },
    audit_rules_thresholds: {},
    ...overrides,
  };
}

function makeGoalRow(idSuffix: string, overrides: Partial<GoalRow> = {}): GoalRow {
  const id = `goal-${idSuffix}`;
  return {
    goal: {
      id,
      type: "research",
      target: { tech: "gravitation", level: 6 },
      priority: 50,
      status: "pending",
      created_at: 1_700_000_000_000,
      progress_pct: 0,
      current_step: "queued",
      eta_at: null,
    },
    status: "pending",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

function makeSnapshot(over: Partial<MemorySnapshotInput> = {}): MemorySnapshotInput {
  return {
    state: makeState(),
    goals: [],
    strategy: makeStrategy(),
    ...over,
  };
}

/** Poll until `predicate` returns truthy or timeout. Robust under load. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor: predicate never satisfied within ${timeoutMs}ms`);
}

describe("MemoryWriter", () => {
  let memDir: string;

  beforeEach(() => {
    memDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "memwriter-"));
  });

  afterEach(() => {
    try {
      fsSync.rmSync(memDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("push → writes after debounceMs", async () => {
    const handle = startMemoryWriter({ memoryDir: memDir, debounceMs: 20, forceRefreshMs: 100_000 });
    handle.push(makeSnapshot());

    const target = path.join(memDir, "ogamex-live-state.md");
    await waitFor(() => fsSync.existsSync(target));
    handle.stop();
    const content = await fs.readFile(target, "utf-8");
    expect(content).toContain("# OgameX live state");
  });

  it("multiple pushes within debounce window collapse to one write with latest snapshot", async () => {
    const handle = startMemoryWriter({ memoryDir: memDir, debounceMs: 50, forceRefreshMs: 100_000 });
    handle.push(makeSnapshot({ state: makeState({ player: { id: "p-1", name: "Alice", alliance: null } }) }));
    // Push again 10ms later with new player name; debounce hasn't fired.
    setTimeout(() => {
      handle.push(makeSnapshot({ state: makeState({ player: { id: "p-1", name: "Bob", alliance: null } }) }));
    }, 10);

    const target = path.join(memDir, "ogamex-live-state.md");
    await waitFor(() => fsSync.existsSync(target));
    handle.stop();

    const content = await fs.readFile(target, "utf-8");
    expect(content).toContain("Name: Bob");
    expect(content).not.toContain("Name: Alice");
  });

  it("rendered markdown contains expected sections", async () => {
    const handle = startMemoryWriter({ memoryDir: memDir, debounceMs: 10, forceRefreshMs: 100_000 });
    const planetState = makeState({
      planets: [
        {
          id: "pl-1",
          name: "Home",
          coords: [1, 2, 3],
          type: "planet",
          resources: { m: 1000, c: 500, d: 200, e: 50 },
          storage: { m_max: 10000, c_max: 10000, d_max: 10000 },
          production: { m_h: 100, c_h: 50, d_h: 20 },
          buildings: {},
          build_q: null,
          shipyard_q: null,
          defense_q: null,
          ships: {},
          defense: {},
          lifeform: null,
        },
      ],
    });
    handle.push(makeSnapshot({ state: planetState, goals: [makeGoalRow("a")] }));

    const target = path.join(memDir, "ogamex-live-state.md");
    await waitFor(() => fsSync.existsSync(target));
    handle.stop();

    const content = await fs.readFile(target, "utf-8");
    expect(content).toContain("## Planets");
    expect(content).toContain("## Goals (active)");
    expect(content).toContain("## Strategy");
    expect(content).toContain("Home");
    expect(content).toContain("goal-a");
  });

  it("creates MEMORY.md on first write with entry line", async () => {
    const handle = startMemoryWriter({ memoryDir: memDir, debounceMs: 10, forceRefreshMs: 100_000 });
    handle.push(makeSnapshot());

    const memFile = path.join(memDir, "MEMORY.md");
    await waitFor(() => fsSync.existsSync(memFile));
    handle.stop();

    const content = await fs.readFile(memFile, "utf-8");
    expect(content).toContain("# Memory Index");
    expect(content).toContain("ogamex-live-state.md");
    expect(content).toContain("auto-updated by ogamex plugin");
  });

  it("MEMORY.md entry is idempotent across multiple writes", async () => {
    const handle = startMemoryWriter({ memoryDir: memDir, debounceMs: 10, forceRefreshMs: 100_000 });
    handle.push(makeSnapshot());
    await waitFor(() => fsSync.existsSync(path.join(memDir, "MEMORY.md")));
    await handle.flush(); // ensures first write done
    handle.push(makeSnapshot({ state: makeState({ player: { id: "p-1", name: "Second", alliance: null } }) }));
    await handle.flush();
    handle.stop();

    const memContent = await fs.readFile(path.join(memDir, "MEMORY.md"), "utf-8");
    const matches = memContent.match(/ogamex-live-state\.md/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("flush() writes immediately even before debounce expires", async () => {
    const handle = startMemoryWriter({ memoryDir: memDir, debounceMs: 10_000, forceRefreshMs: 100_000 });
    handle.push(makeSnapshot({ state: makeState({ player: { id: "p-1", name: "Flushed", alliance: null } }) }));
    // Don't wait for debounce — flush directly.
    await handle.flush();
    handle.stop();

    const target = path.join(memDir, "ogamex-live-state.md");
    expect(fsSync.existsSync(target)).toBe(true);
    const content = await fs.readFile(target, "utf-8");
    expect(content).toContain("Name: Flushed");
  });

  it("force refresh writes again after forceRefreshMs even without new push", async () => {
    const handle = startMemoryWriter({
      memoryDir: memDir,
      debounceMs: 5,
      forceRefreshMs: 40,
    });
    handle.push(makeSnapshot());

    const target = path.join(memDir, "ogamex-live-state.md");
    await waitFor(() => fsSync.existsSync(target));
    const firstMtime = (await fs.stat(target)).mtimeMs;

    // No new push. Wait long enough for force refresh to fire at least once.
    await waitFor(async () => {
      const m = (await fs.stat(target)).mtimeMs;
      return m > firstMtime;
    }, 2000);

    handle.stop();
  });

  it("stop() halts both timers — no further writes occur", async () => {
    const handle = startMemoryWriter({ memoryDir: memDir, debounceMs: 10, forceRefreshMs: 30 });
    handle.push(makeSnapshot());

    const target = path.join(memDir, "ogamex-live-state.md");
    await waitFor(() => fsSync.existsSync(target));

    // Stop first, then let any in-flight writes settle, then snapshot the
    // "baseline" mtime. After this point no new writes should happen.
    handle.stop();
    await new Promise((r) => setTimeout(r, 50));
    const baselineMtime = (await fs.stat(target)).mtimeMs;

    // Wait several force-refresh intervals; mtime must not change.
    await new Promise((r) => setTimeout(r, 150));
    const finalMtime = (await fs.stat(target)).mtimeMs;
    expect(finalMtime).toBe(baselineMtime);

    // Pushing after stop must also not trigger a write.
    handle.push(makeSnapshot({ state: makeState({ player: { id: "p-1", name: "Ghost", alliance: null } }) }));
    await new Promise((r) => setTimeout(r, 50));
    const afterPushMtime = (await fs.stat(target)).mtimeMs;
    expect(afterPushMtime).toBe(baselineMtime);
  });
});
