import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { StrategyManager } from "../../src/sidecar/strategy_manager.js";
import type { Strategy } from "@ogamex/shared";

/**
 * Build a minimum-valid Strategy. The shared Strategy interface
 * (packages/shared/src/types.ts ~line 173) requires version, updated_at,
 * updated_by, reason, daily, emergency, audit_rules_thresholds.
 */
function makeDefaultStrategy(): Strategy {
  return {
    version: 0,
    updated_at: 1_700_000_000_000,
    updated_by: "userscript-bootstrap",
    reason: "bootstrap",
    daily: {
      expedition: {
        enabled: true,
        auto_fill_slots: true,
        source_planet: null,
        duration: "short",
        target_position: 16,
        fleet_templates: {},
        galaxy_strategy: {
          mode: "fixed",
          home_galaxy_first: true,
          switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
          cross_galaxy_deut_budget: 0,
        },
        cargo_load: { smallCargo_capacity_pct: 100, largeCargo_capacity_pct: 100 },
      },
      resource_balance: { enabled: true, trigger_overflow_pct: 90 },
      defense_replenish: { enabled: true, keep_minimum: {} },
      default_build: { enabled: true, strategy: "balanced", ratio: {} },
      heartbeat: { enabled: true, schedule: [] },
    },
    emergency: {
      attack: {
        save_window_minutes: 15,
        prefer_moon: true,
        alliance_safe_planets: [],
        safety_margin_minutes: 2,
      },
      spy: { push_immediate: true, counter_spy: false, log_attacker: true },
      anomaly: { push_immediate: true, pause_planet_automation: false },
      resource_critical: { threshold_pct: 95, try_redistribute_first: true },
    },
    audit_rules_thresholds: {},
  };
}

describe("StrategyManager", () => {
  let dir: string;
  let mgr: StrategyManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
    mgr = new StrategyManager({ repoDir: dir, defaultStrategy: makeDefaultStrategy() });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("init creates git repo + strategy.json + v0 bootstrap commit", () => {
    mgr.init();
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "strategy.json"))).toBe(true);
    const s = mgr.load();
    expect(s.version).toBe(0);
    expect(s.updated_by).toBe("userscript-bootstrap");
    // git log shows v0 commit
    const log = spawnSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf-8" });
    expect(log.status).toBe(0);
    expect(log.stdout.trim()).toBe("v0: bootstrap");
  });

  it("init is idempotent — calling twice keeps version=0 and one commit", () => {
    mgr.init();
    expect(() => mgr.init()).not.toThrow();
    const s = mgr.load();
    expect(s.version).toBe(0);
    const log = spawnSync("git", ["log", "--format=%H"], { cwd: dir, encoding: "utf-8" });
    expect(log.stdout.trim().split("\n").length).toBe(1);
  });

  it("applyPatch bumps version, sets reason/by, persists", () => {
    mgr.init();
    const next = mgr.applyPatch({ reason: "x-ignored" }, "test patch", "openclaw-llm");
    expect(next.version).toBe(1);
    expect(next.reason).toBe("test patch");
    expect(next.updated_by).toBe("openclaw-llm");
    expect(next.updated_at).toBeGreaterThan(0);
    const loaded = mgr.load();
    expect(loaded.version).toBe(1);
    expect(loaded.reason).toBe("test patch");
  });

  it("applyPatch deep-merges nested objects, preserving sibling fields", () => {
    mgr.init();
    const next = mgr.applyPatch(
      { daily: { expedition: { enabled: false } } },
      "disable expeditions",
      "user-discord",
    );
    expect(next.daily.expedition.enabled).toBe(false);
    // siblings preserved
    expect(next.daily.expedition.auto_fill_slots).toBe(true);
    expect(next.daily.expedition.target_position).toBe(16);
    expect(next.daily.expedition.galaxy_strategy.mode).toBe("fixed");
    expect(next.daily.resource_balance.enabled).toBe(true);
    expect(next.emergency.attack.save_window_minutes).toBe(15);
  });

  it("applyPatch commits to git as vN: reason", () => {
    mgr.init();
    mgr.applyPatch({}, "test patch", "openclaw-llm");
    const log = spawnSync("git", ["log", "--format=%s", "--reverse"], { cwd: dir, encoding: "utf-8" });
    expect(log.status).toBe(0);
    const lines = log.stdout.trim().split("\n");
    expect(lines).toEqual(["v0: bootstrap", "v1: test patch"]);
  });

  it("history() returns commits newest-first with version+reason+by", () => {
    mgr.init();
    mgr.applyPatch({}, "first patch", "openclaw-llm");
    mgr.applyPatch({}, "second patch", "user-discord");
    const h = mgr.history();
    expect(h.length).toBe(3);
    expect(h[0]!.version).toBe(2);
    expect(h[0]!.reason).toBe("second patch");
    expect(h[0]!.by).toBe("user-discord");
    expect(h[1]!.version).toBe(1);
    expect(h[1]!.reason).toBe("first patch");
    expect(h[1]!.by).toBe("openclaw-llm");
    expect(h[2]!.version).toBe(0);
    expect(h[2]!.reason).toBe("bootstrap");
    expect(h[2]!.by).toBe("userscript-bootstrap");
  });

  it("rollback replays an earlier version's content as a new commit", () => {
    mgr.init();
    mgr.applyPatch({ daily: { expedition: { enabled: false } } }, "v1 patch", "openclaw-llm");
    mgr.applyPatch({ daily: { expedition: { target_position: 1 } } }, "v2 patch", "openclaw-llm");
    const rolled = mgr.rollback(0);
    expect(rolled.version).toBe(3);
    expect(rolled.reason).toBe("rollback to v0");
    expect(rolled.updated_by).toBe("user-discord");
    // content should match v0 default (enabled=true, target_position=16)
    expect(rolled.daily.expedition.enabled).toBe(true);
    expect(rolled.daily.expedition.target_position).toBe(16);
    const loaded = mgr.load();
    expect(loaded.version).toBe(3);
    expect(loaded.daily.expedition.enabled).toBe(true);
    expect(loaded.daily.expedition.target_position).toBe(16);
  });

  it("rollback to unknown version throws", () => {
    mgr.init();
    expect(() => mgr.rollback(99)).toThrow(/version not found: 99/);
  });
});
