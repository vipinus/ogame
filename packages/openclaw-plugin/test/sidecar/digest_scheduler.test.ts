import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Reporter } from "../../src/sidecar/reporter.js";
import { GoalsStore } from "../../src/sidecar/goals_store.js";
import { StrategyManager } from "../../src/sidecar/strategy_manager.js";
import {
  startDigestScheduler,
  type DigestSchedulerHandle,
} from "../../src/sidecar/digest_scheduler.js";
import type { Goal, Strategy, WorldState } from "@ogamex/shared";

/** Poll until `predicate` returns truthy or timeout. Robust under load. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor: predicate never satisfied within ${timeoutMs}ms`);
}

function makeStrategy(): Strategy {
  return {
    version: 0,
    updated_at: Date.now(),
    updated_by: "userscript-bootstrap",
    reason: "bootstrap",
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
          switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 },
          cross_galaxy_deut_budget: 0,
        },
        cargo_load: { smallCargo_capacity_pct: 100, largeCargo_capacity_pct: 100 },
      },
      resource_balance: { enabled: false, trigger_overflow_pct: 90 },
      defense_replenish: { enabled: false, keep_minimum: {} },
      default_build: { enabled: false, strategy: "balanced", ratio: {} },
      heartbeat: { enabled: false, schedule: [] },
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

function makeWorldState(): WorldState {
  return {
    server: { universe: "uni42", speed: 1 },
    player: { id: "p1", name: "Calvin", alliance: null },
    // Minimal Planet shape — only counts matter for the digest. Post Map
    // refactor: state.planets is Record<string, Planet>.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    planets: { "33000001": { id: "33000001" } as any, "33000002": { id: "33000002" } as any },
    research: { levels: {}, queue: null },
    fleets_outbound: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "f1" } as any,
    ],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: 0,
    page_snapshots: {},
  };
}

function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: over.id ?? "g1",
    type: over.type ?? "research",
    target: over.target ?? { tech: "energy", level: 5 },
    priority: over.priority ?? 5,
    status: over.status ?? "pending",
    created_at: over.created_at ?? Date.now(),
    progress_pct: over.progress_pct ?? 0,
    current_step: over.current_step ?? "init",
    eta_at: over.eta_at ?? null,
    ...(over.planet !== undefined ? { planet: over.planet } : {}),
    ...(over.deadline !== undefined ? { deadline: over.deadline } : {}),
    ...(over.blocked_reason !== undefined ? { blocked_reason: over.blocked_reason } : {}),
  };
}

interface Fixture {
  reporter: Reporter | null;
  goalsStore: GoalsStore;
  strategyManager: StrategyManager;
  stateRef: { current: WorldState | null };
  send: ReturnType<typeof vi.fn>;
  repoDir: string;
}

function setupFixture(opts: { withReporter?: boolean; sendImpl?: (channelId: string, content: string) => Promise<void> } = {}): Fixture {
  const withReporter = opts.withReporter ?? true;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-sched-"));
  const strategyManager = new StrategyManager({
    repoDir,
    defaultStrategy: makeStrategy(),
  });
  strategyManager.init();

  const goalsStore = new GoalsStore({ dbPath: ":memory:" });
  goalsStore.add(makeGoal({ id: "g1", type: "research", priority: 7 }));
  goalsStore.add(makeGoal({ id: "g2", type: "build", priority: 3 }));
  goalsStore.add(makeGoal({ id: "g3", type: "build_ships", priority: 5 }));
  // Mark one completed to exercise completed counting.
  goalsStore.updateStatus("g3", "completed");

  const send = vi.fn(opts.sendImpl ?? (async () => undefined));
  const reporter = withReporter
    ? new Reporter({ channelId: "chan-x", send, throttleMs: 0 })
    : null;

  const stateRef: { current: WorldState | null } = { current: makeWorldState() };

  return { reporter, goalsStore, strategyManager, stateRef, send, repoDir };
}

describe("DigestScheduler", () => {
  let handles: DigestSchedulerHandle[];
  let errSpy: ReturnType<typeof vi.spyOn>;
  let fixtures: Fixture[];

  beforeEach(() => {
    handles = [];
    fixtures = [];
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const h of handles) h.stop();
    for (const f of fixtures) {
      try { f.goalsStore.close(); } catch { /* noop */ }
      try { fs.rmSync(f.repoDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
    errSpy.mockRestore();
  });

  function track(f: Fixture, h: DigestSchedulerHandle): DigestSchedulerHandle {
    fixtures.push(f);
    handles.push(h);
    return h;
  }

  it("publishNow with reporter sends markdown containing key sections", async () => {
    const f = setupFixture();
    const h = track(f, startDigestScheduler(
      { reporter: f.reporter, goalsStore: f.goalsStore, strategyManager: f.strategyManager, stateRef: f.stateRef },
      { pollIntervalMs: 10_000_000 }, // effectively disable polling
    ));

    const res = await h.publishNow();
    expect(res.sent).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    const content = f.send.mock.calls[0]![1] as string;
    expect(content).toMatch(/Strategy/);
    expect(content).toMatch(/Goals/);
    expect(content).toMatch(/snapshot/i);
    expect(content).toMatch(/uni42/); // universe name appears
    expect(content).toMatch(/Calvin/); // player name appears
  });

  it("publishNow with no reporter → sent:false, reason 'no reporter'", async () => {
    const f = setupFixture({ withReporter: false });
    const h = track(f, startDigestScheduler(
      { reporter: f.reporter, goalsStore: f.goalsStore, strategyManager: f.strategyManager, stateRef: f.stateRef },
      { pollIntervalMs: 10_000_000 },
    ));

    const res = await h.publishNow();
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/no reporter/i);
  });

  it("publishNow handles reporter.push returning false (throttled) → sent:false reason:'throttled'", async () => {
    const f = setupFixture();
    // First push consumes the slot; subsequent push within throttle returns false.
    const reporter = new Reporter({
      channelId: "chan-x",
      send: f.send,
      throttleMs: 10_000_000, // huge throttle so 2nd push is dropped
    });
    const h = track(f, startDigestScheduler(
      { reporter, goalsStore: f.goalsStore, strategyManager: f.strategyManager, stateRef: f.stateRef },
      { pollIntervalMs: 10_000_000 },
    ));

    const first = await h.publishNow();
    expect(first.sent).toBe(true);

    const second = await h.publishNow();
    expect(second.sent).toBe(false);
    expect(second.reason).toMatch(/throttled/i);
  });

  it("publishNow handles reporter throw → sent:false reason:<err>", async () => {
    const f = setupFixture({
      sendImpl: async () => { throw new Error("network down"); },
    });
    const h = track(f, startDigestScheduler(
      { reporter: f.reporter, goalsStore: f.goalsStore, strategyManager: f.strategyManager, stateRef: f.stateRef },
      { pollIntervalMs: 10_000_000 },
    ));

    const res = await h.publishNow();
    // Reporter.push catches the send rejection and returns false (it logs to
    // console.error rather than rethrowing). We surface that as throttled-or-error.
    // The visible signal here is sent:false with a reason string.
    expect(res.sent).toBe(false);
    expect(typeof res.reason).toBe("string");
    expect(res.reason!.length).toBeGreaterThan(0);
  });

  it("schedule fires at expected hour", async () => {
    const f = setupFixture();
    // Pick a base time where today 06:00 UTC has already passed by 2 minutes.
    // 2024-01-15 06:02:00 UTC → epoch ms.
    const base = Date.UTC(2024, 0, 15, 6, 2, 0);
    let clock = base;
    const h = track(f, startDigestScheduler(
      { reporter: f.reporter, goalsStore: f.goalsStore, strategyManager: f.strategyManager, stateRef: f.stateRef },
      {
        hourOfDay: 6,
        minuteOfHour: 0,
        tzOffsetMinutes: 0,
        pollIntervalMs: 25,
        now: () => clock,
      },
    ));

    await waitFor(() => f.send.mock.calls.length >= 1, 2000, 10);
    expect(f.send).toHaveBeenCalledTimes(1);
    // Stop the scheduler so the poll-loop doesn't keep running.
    h.stop();
    void clock; // silence unused warning when no extra advancement happens
  });

  it("schedule does NOT re-fire same day", async () => {
    const f = setupFixture();
    const base = Date.UTC(2024, 0, 15, 6, 2, 0);
    let clock = base;
    const h = track(f, startDigestScheduler(
      { reporter: f.reporter, goalsStore: f.goalsStore, strategyManager: f.strategyManager, stateRef: f.stateRef },
      {
        hourOfDay: 6,
        minuteOfHour: 0,
        tzOffsetMinutes: 0,
        pollIntervalMs: 25,
        now: () => clock,
      },
    ));

    await waitFor(() => f.send.mock.calls.length >= 1, 2000, 10);
    expect(f.send).toHaveBeenCalledTimes(1);

    // Advance virtual clock by 10 minutes — still same day, past the deadline.
    clock = base + 10 * 60_000;
    // Let several poll cycles run.
    await new Promise((r) => setTimeout(r, 200));
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("schedule fires next day", async () => {
    const f = setupFixture();
    const base = Date.UTC(2024, 0, 15, 6, 2, 0);
    let clock = base;
    const h = track(f, startDigestScheduler(
      { reporter: f.reporter, goalsStore: f.goalsStore, strategyManager: f.strategyManager, stateRef: f.stateRef },
      {
        hourOfDay: 6,
        minuteOfHour: 0,
        tzOffsetMinutes: 0,
        pollIntervalMs: 25,
        now: () => clock,
      },
    ));

    await waitFor(() => f.send.mock.calls.length >= 1, 2000, 10);
    expect(f.send).toHaveBeenCalledTimes(1);

    // Advance 24 hours — next 06:00 UTC has now passed.
    clock = base + 24 * 60 * 60_000;
    await waitFor(() => f.send.mock.calls.length >= 2, 2000, 10);
    expect(f.send).toHaveBeenCalledTimes(2);
    // Sanity check stop reference.
    void h;
  });
});
