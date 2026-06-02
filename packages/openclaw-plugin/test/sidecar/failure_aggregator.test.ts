import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Strategy, WorldState, DownstreamMsg } from "@ogamex/shared";
import { createFailureAggregator } from "../../src/sidecar/failure_aggregator.js";
import type { StrategyManager } from "../../src/sidecar/strategy_manager.js";
import type { GeminiClient } from "../../src/sidecar/gemini_client.js";
import type { AnalyzeResult, AnalyzeInput } from "../../src/llm/strategy_analyzer.js";

// -----------------------------------------------------------------------------
// Factories — same shapes as strategy_analyzer.test.ts. Minimal valid Strategy
// + WorldState. Only fields touched by the aggregator path need real values.
// -----------------------------------------------------------------------------

function makeStrategy(version = 1): Strategy {
  return {
    version,
    updated_at: 0,
    updated_by: "openclaw-llm",
    reason: "init",
    daily: {
      expedition: {
        enabled: true,
        auto_fill_slots: true,
        source_planet: "p1",
        duration: "short",
        target_position: 16,
        fleet_templates: {},
        galaxy_strategy: {
          mode: "stats_based",
          home_galaxy_first: true,
          switch_threshold: { black_hole_rate_24h: 0.1, sample_size_min: 20 },
          cross_galaxy_deut_budget: 0,
        },
        cargo_load: { smallCargo_capacity_pct: 80, largeCargo_capacity_pct: 80 },
      },
      resource_balance: { enabled: true, trigger_overflow_pct: 90 },
      defense_replenish: { enabled: false, keep_minimum: {} },
      default_build: { enabled: false, strategy: "none", ratio: {} },
      heartbeat: { enabled: true, schedule: [] },
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
  };
}

function makeWorldState(): WorldState {
  return {
    server: { universe: "uni", speed: 1 },
    player: { id: "u", name: "test", alliance: null },
    planets: [],
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 1 },
    discovery_active: [],
    last_update: 0,
    page_snapshots: {},
  };
}

// -----------------------------------------------------------------------------
// Harness: builds an aggregator with all-fake deps and exposes the spies.
// -----------------------------------------------------------------------------

interface Harness {
  aggregator: ReturnType<typeof createFailureAggregator>;
  analyzer: ReturnType<typeof vi.fn>;
  applyPatch: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setNow: (t: number) => void;
  /** Reads of persistence sink calls — populated when persistence is wired. */
  persistedCooldowns: Array<{ task: string; ts: number }>;
}

function makeHarness(opts: {
  analyzerImpl: (input: AnalyzeInput) => Promise<AnalyzeResult>;
  applyImpl?: (patch: Record<string, unknown>, reason: string, by: Strategy["updated_by"]) => Strategy;
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
  initialTime?: number;
  /** Optional pre-seeded cooldowns the persistence mock will report at boot. */
  initialPersistedCooldowns?: Array<{ task: string; last_analysis_at: number }>;
  /** Set to true to wire a persistence sink and record its calls. */
  withPersistence?: boolean;
}): Harness {
  let mockTime = opts.initialTime ?? 1_000_000;

  const analyzer = vi.fn(opts.analyzerImpl);
  const applyPatch = vi.fn(
    opts.applyImpl ??
      ((_p: Record<string, unknown>, _r: string, _b: Strategy["updated_by"]) => makeStrategy(2)),
  );
  const load = vi.fn(() => makeStrategy(1));
  const send = vi.fn();

  const strategyManager = {
    load,
    applyPatch,
  } as unknown as StrategyManager;

  const gemini = {} as GeminiClient;

  const persistedCooldowns: Array<{ task: string; ts: number }> = [];
  const initialPersisted = opts.initialPersistedCooldowns ?? [];
  const persistence = opts.withPersistence === true || initialPersisted.length > 0
    ? {
        upsertCooldown: (task: string, last_analysis_at: number) => {
          persistedCooldowns.push({ task, ts: last_analysis_at });
        },
        listCooldowns: () => [...initialPersisted],
      }
    : undefined;

  const aggregator = createFailureAggregator(
    {
      strategyManager,
      gemini,
      getState: () => makeWorldState(),
      send,
      analyzer: analyzer as unknown as (i: AnalyzeInput, l: GeminiClient) => Promise<AnalyzeResult>,
      ...(persistence !== undefined ? { persistence } : {}),
    },
    {
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
      ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}),
      now: () => mockTime,
    },
  );

  return {
    aggregator,
    analyzer,
    applyPatch,
    load,
    send,
    setNow: (t: number) => {
      mockTime = t;
    },
    persistedCooldowns,
  };
}

describe("FailureAggregator", () => {
  beforeEach(() => {
    // Silence the warn/error inside aggregator during expected failure paths.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("below threshold → does not call analyzer", async () => {
    const h = makeHarness({
      threshold: 3,
      analyzerImpl: async () => ({ patch: {}, reason: "noop" }),
    });
    await h.aggregator.record({ task: "expedition", attempts: 1, last_error: "e1", context: {} });
    await h.aggregator.record({ task: "expedition", attempts: 2, last_error: "e2", context: {} });
    expect(h.analyzer).not.toHaveBeenCalled();
    expect(h.aggregator.stats().totalFailures).toBe(2);
    expect(h.aggregator.stats().analysesTriggered).toBe(0);
  });

  it("reaches threshold → triggers analyzer, applies patch, broadcasts", async () => {
    const patch = { daily: { expedition: { duration: "medium" as const } } };
    const reason = "x";
    const h = makeHarness({
      threshold: 3,
      analyzerImpl: async () => ({ patch, reason }),
      applyImpl: (_p, r, by) => ({ ...makeStrategy(2), reason: r, updated_by: by }),
    });

    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({
        task: "expedition",
        attempts: i + 1,
        last_error: "boom",
        context: { i },
      });
    }

    expect(h.analyzer).toHaveBeenCalledTimes(1);
    expect(h.applyPatch).toHaveBeenCalledTimes(1);
    expect(h.applyPatch).toHaveBeenCalledWith(patch, reason, "openclaw-llm");

    expect(h.send).toHaveBeenCalledTimes(1);
    const sent = h.send.mock.calls[0]![0] as DownstreamMsg;
    expect(sent).toEqual({ type: "strategy.update", version: 2, patch, reason });

    const s = h.aggregator.stats();
    expect(s.analysesTriggered).toBe(1);
    expect(s.patchesApplied).toBe(1);
    expect(s.patchesRejected).toBe(0);
    expect(s.abstains).toBe(0);
  });

  it("abstain result → no patch applied, no broadcast, abstains++", async () => {
    const h = makeHarness({
      threshold: 3,
      analyzerImpl: async () => ({ abstain: "not enough info" }),
    });

    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "e", context: {} });
    }

    expect(h.analyzer).toHaveBeenCalledTimes(1);
    expect(h.applyPatch).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.aggregator.stats().abstains).toBe(1);
  });

  it("invalid patch → rejected, no broadcast, patchesRejected++", async () => {
    const h = makeHarness({
      threshold: 3,
      // save_window_minutes=999 is out of [5,120] range, so validatePatch will fail.
      analyzerImpl: async () => ({
        patch: { emergency: { attack: { save_window_minutes: 999 } } },
        reason: "bad",
      }),
    });

    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "e", context: {} });
    }

    expect(h.analyzer).toHaveBeenCalledTimes(1);
    expect(h.applyPatch).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.aggregator.stats().patchesRejected).toBe(1);
  });

  it("cooldown blocks re-analysis", async () => {
    const h = makeHarness({
      threshold: 3,
      cooldownMs: 30 * 60 * 1000,
      analyzerImpl: async () => ({ patch: { daily: { expedition: { enabled: false } } }, reason: "x" }),
    });

    // First batch triggers.
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "e", context: {} });
    }
    expect(h.analyzer).toHaveBeenCalledTimes(1);

    // Bucket cleared after success — push 3 more, still within cooldown.
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "e", context: {} });
    }
    expect(h.analyzer).toHaveBeenCalledTimes(1); // still 1: cooldown blocked the second.
  });

  it("window expiry drops old failures", async () => {
    const windowMs = 10 * 60 * 1000;
    const h = makeHarness({
      threshold: 3,
      windowMs,
      analyzerImpl: async () => ({ patch: {}, reason: "x" }),
    });

    // 2 failures at t=1_000_000.
    await h.aggregator.record({ task: "expedition", attempts: 1, last_error: "e1", context: {} });
    await h.aggregator.record({ task: "expedition", attempts: 2, last_error: "e2", context: {} });

    // Advance past the window.
    h.setNow(1_000_000 + windowMs + 1);

    // One more failure — old two should be evicted, so bucket length is 1.
    await h.aggregator.record({ task: "expedition", attempts: 3, last_error: "e3", context: {} });

    // Add one more — bucket length is 2 (< 3), still no trigger.
    await h.aggregator.record({ task: "expedition", attempts: 4, last_error: "e4", context: {} });

    expect(h.analyzer).not.toHaveBeenCalled();
  });

  it("bucket cleared after successful patch", async () => {
    const h = makeHarness({
      threshold: 3,
      cooldownMs: 0, // Disable cooldown for this test to isolate clear behavior.
      analyzerImpl: async () => ({ patch: { daily: { expedition: { enabled: false } } }, reason: "x" }),
    });

    // First batch triggers + applies.
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "e", context: {} });
    }
    expect(h.analyzer).toHaveBeenCalledTimes(1);

    // Bucket should be empty now → push 2 more, NO trigger.
    await h.aggregator.record({ task: "expedition", attempts: 4, last_error: "e", context: {} });
    await h.aggregator.record({ task: "expedition", attempts: 5, last_error: "e", context: {} });
    expect(h.analyzer).toHaveBeenCalledTimes(1);

    // 3rd new failure → triggers again.
    await h.aggregator.record({ task: "expedition", attempts: 6, last_error: "e", context: {} });
    expect(h.analyzer).toHaveBeenCalledTimes(2);
  });

  it("different tasks tracked independently", async () => {
    const h = makeHarness({
      threshold: 3,
      analyzerImpl: async () => ({ patch: { daily: { expedition: { enabled: false } } }, reason: "x" }),
    });

    // 3 of "A" → triggers.
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "A", attempts: i + 1, last_error: "e", context: {} });
    }
    // 2 of "B" → no trigger.
    for (let i = 0; i < 2; i++) {
      await h.aggregator.record({ task: "B", attempts: i + 1, last_error: "e", context: {} });
    }

    expect(h.analyzer).toHaveBeenCalledTimes(1);
    const callArg = h.analyzer.mock.calls[0]![0] as AnalyzeInput;
    expect(callArg.task).toBe("A");
  });

  it("hydrated cooldown blocks immediate re-fire after restart", async () => {
    // Simulate: prior sidecar analyzed task "expedition" 5 min ago, then
    // crashed. New aggregator boots, reads persistence sink, sees the
    // cooldown. Next failure burst MUST NOT re-fire the analyzer until
    // the cooldown elapses.
    const cooldownMs = 30 * 60 * 1000; // 30 min default
    const initialTime = 1_000_000_000;
    const h = makeHarness({
      threshold: 3,
      cooldownMs,
      initialTime,
      analyzerImpl: async () => ({ patch: { daily: { expedition: { enabled: false } } }, reason: "x" }),
      initialPersistedCooldowns: [
        { task: "expedition", last_analysis_at: initialTime - 5 * 60 * 1000 }, // 5 min ago
      ],
    });
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "boom", context: {} });
    }
    expect(h.analyzer).not.toHaveBeenCalled();
    // Advance past cooldown — next failure should fire analyzer.
    h.setNow(initialTime + 26 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "boom", context: {} });
    }
    expect(h.analyzer).toHaveBeenCalledTimes(1);
  });

  it("persistence sink — each cooldown stamp mirrored to disk", async () => {
    const initialTime = 1_000_000_000;
    const h = makeHarness({
      threshold: 3,
      initialTime,
      analyzerImpl: async () => ({ patch: { daily: { expedition: { enabled: false } } }, reason: "x" }),
      withPersistence: true,
    });
    // 3 failures of "expedition" → analyzer fires → applies → cooldown stamped
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "e", context: {} });
    }
    expect(h.persistedCooldowns).toEqual([
      { task: "expedition", ts: initialTime },
    ]);
    // Another task crosses threshold at a different time
    h.setNow(initialTime + 1000);
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "metal_balance", attempts: i + 1, last_error: "e", context: {} });
    }
    expect(h.persistedCooldowns).toEqual([
      { task: "expedition", ts: initialTime },
      { task: "metal_balance", ts: initialTime + 1000 },
    ]);
  });

  it("persistence sink — abstain path also stamps cooldown", async () => {
    const initialTime = 1_000_000_000;
    const h = makeHarness({
      threshold: 3,
      initialTime,
      // Analyzer returns abstain (no patch) — cooldown should still be stamped
      // so we don't re-burn LLM tokens on the same task while it's stale.
      analyzerImpl: async () => ({ abstain: "insufficient info" }),
      withPersistence: true,
    });
    for (let i = 0; i < 3; i++) {
      await h.aggregator.record({ task: "expedition", attempts: i + 1, last_error: "e", context: {} });
    }
    expect(h.aggregator.stats().abstains).toBe(1);
    expect(h.persistedCooldowns).toEqual([
      { task: "expedition", ts: initialTime },
    ]);
  });
});
