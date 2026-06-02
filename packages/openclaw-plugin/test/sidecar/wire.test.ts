/**
 * M6.x sidecar wiring test.
 *
 * Black-box: start the real sidecar with all transports, push UpstreamMsg via a
 * `ws` client, and observe side-effects on the handle (state mirror, memory
 * file, reporter, failure aggregator). No internal-only spies — every
 * assertion goes through a public surface.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type {
  Strategy,
  UpstreamMsg,
  DownstreamMsg,
  WorldState,
} from "@ogamex/shared";
import { startSidecar, type SidecarHandle } from "../../src/sidecar/index.js";
import type {
  AnalyzeInput,
  AnalyzeResult,
} from "../../src/llm/strategy_analyzer.js";

const TOKEN = "wire-token";

// ---------------------------------------------------------------------------
// Cleanup registry — every test pushes its handle + tmp paths here; afterEach
// stops the sidecar and removes the tmp dirs so we never leak ports or files.
// ---------------------------------------------------------------------------
interface Resources {
  handle?: SidecarHandle;
  tmpDirs: string[];
}
const active: Resources = { tmpDirs: [] };

afterEach(async () => {
  if (active.handle) {
    try { await active.handle.stop(); } catch { /* ignore */ }
    active.handle = undefined;
  }
  for (const dir of active.tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  active.tmpDirs = [];
});

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  active.tmpDirs.push(dir);
  return dir;
}

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

interface BootOpts {
  discordChannelId?: string;
  sendDiscord?: (channelId: string, content: string) => Promise<void>;
  analyzer?: (input: AnalyzeInput) => Promise<AnalyzeResult>;
}

interface BootResult {
  handle: SidecarHandle;
  memoryDir: string;
  strategyRepoDir: string;
}

async function boot(opts: BootOpts = {}): Promise<BootResult> {
  const strategyRepoDir = makeTmpDir("ogamex-strat-");
  const memoryDir = makeTmpDir("ogamex-mem-");
  const startOpts: Parameters<typeof startSidecar>[1] = {
    defaultStrategy: makeDefaultStrategy(),
    ...(opts.sendDiscord ? { sendDiscord: opts.sendDiscord } : {}),
  };
  const handle = await startSidecar(
    {
      wsPort: 0,
      httpPort: 0,
      bridgeToken: TOKEN,
      strategyRepoDir,
      goalsDbPath: ":memory:",
      memoryDir,
      geminiApiKey: "fake-key",
      ...(opts.discordChannelId !== undefined ? { discordChannelId: opts.discordChannelId } : {}),
      ...(opts.analyzer !== undefined
        ? { analyzer: opts.analyzer as (i: AnalyzeInput, l: unknown) => Promise<AnalyzeResult> }
        : {}),
    },
    startOpts,
  );
  active.handle = handle;
  return { handle, memoryDir, strategyRepoDir };
}

// v0.0.549 — WsServer is stubbed (operator removed ws path). Wire tests
// previously connected as a WS client; now they POST to /ogamex/v1/push,
// which fans into the SAME wrapped on() registry that ws.on/http.on share.
async function pushHttp(handle: SidecarHandle, msg: UpstreamMsg): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${handle.http.port()}/ogamex/v1/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (res.status !== 200) {
    throw new Error(`pushHttp got HTTP ${res.status}`);
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor: predicate never returned true within ${timeoutMs}ms`);
}

describe("startSidecar wiring", () => {
  it("returns all components with non-null handles", async () => {
    const { handle } = await boot();
    expect(handle.ws).toBeTruthy();
    expect(handle.http).toBeTruthy();
    expect(handle.strategyManager).toBeTruthy();
    expect(handle.goalsStore).toBeTruthy();
    expect(handle.priorityMerger).toBeTruthy();
    expect(handle.failureAggregator).toBeTruthy();
    expect(handle.memoryWriter).toBeTruthy();
    expect(handle.stateRef.current).toBeNull();
  });

  it("state.snapshot → updates stateRef and writes memory file", async () => {
    const { handle, memoryDir } = await boot();
    const snapshot = makeWorldState();
    snapshot.player.name = "alice";
    await pushHttp(handle, {
      type: "state.snapshot",
      ts: Date.now(),
      snapshot,
      strategy_version: 0,
    });

    await waitFor(() => handle.stateRef.current !== null);
    expect(handle.stateRef.current?.player.name).toBe("alice");

    // Force a flush so we don't have to wait for the 5s debounce.
    await handle.memoryWriter.flush();
    await waitFor(() => {
      try {
        const live = fs.readFileSync(
          path.join(memoryDir, "ogamex-live-state.md"),
          "utf-8",
        );
        return live.includes("alice");
      } catch {
        return false;
      }
    });
  });

  it("hello → strategy.full queued onto HTTP downstream poll", async () => {
    const { handle } = await boot();
    await pushHttp(handle, {
      type: "hello",
      strategy_version: 0,
      userscript_version: "0.0.1",
    });
    // The hello handler queues strategy.full via http.queueDownstream — long
    // polling on /poll returns it. We use a 5s timeout, well within vitest's
    // default test timeout. /poll is POST-only with since_ts cursor body.
    const pollRes = await fetch(`http://127.0.0.1:${handle.http.port()}/ogamex/v1/poll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ since_ts: 0 }),
    });
    expect(pollRes.status).toBe(200);
    const body = await pollRes.json() as { messages?: DownstreamMsg[] };
    const messages = body.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    const full = messages.find((m): m is Extract<DownstreamMsg, { type: "strategy.full" }> => m?.type === "strategy.full");
    expect(full).toBeTruthy();
    expect(full!.strategy.version).toBe(0);
    expect(full!.strategy.updated_by).toBe("userscript-bootstrap");
  });

  it("event.emergency with reporter → forwards markdown_report to send", async () => {
    const sendDiscord = vi.fn<(channelId: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { handle } = await boot({ discordChannelId: "chan-xyz", sendDiscord });
    // The boot already used sendDiscord for the online banner — capture
    // baseline calls so we can assert the emergency push specifically.
    const baselineCalls = sendDiscord.mock.calls.length;

    const markdown = "**ATTACK** — fleet incoming at coords 1:2:3";
    await pushHttp(handle, {
      type: "event.emergency",
      subtype: "attack",
      data: {},
      markdown_report: markdown,
    });

    await waitFor(() => sendDiscord.mock.calls.length > baselineCalls);
    const last = sendDiscord.mock.calls[sendDiscord.mock.calls.length - 1]!;
    expect(last[0]).toBe("chan-xyz");
    expect(last[1]).toBe(markdown);
  });

  it("event.daily_failure × threshold → failureAggregator triggers analyzer once", async () => {
    const analyzer = vi.fn<(input: AnalyzeInput) => Promise<AnalyzeResult>>(
      async () => ({ abstain: "no info" }),
    );
    const { handle } = await boot({ analyzer });

    // Default threshold is 3 — push exactly 3 failures of the same task.
    for (let i = 0; i < 3; i++) {
      await pushHttp(handle, {
        type: "event.daily_failure",
        task: "expedition",
        attempts: i + 1,
        last_error: "boom",
        context: { i },
      });
    }

    await waitFor(() => handle.failureAggregator.stats().analysesTriggered === 1);
    expect(handle.failureAggregator.stats().analysesTriggered).toBe(1);
    expect(analyzer).toHaveBeenCalledTimes(1);
  });

  it("stop() shuts down http + memory writer (no new requests, no memory churn)", async () => {
    const { handle, memoryDir } = await boot();
    const httpPort = handle.http.port();
    expect(httpPort).toBeGreaterThan(0);
    // Push one snapshot + flush to seed the memory file.
    await pushHttp(handle, {
      type: "state.snapshot",
      ts: Date.now(),
      snapshot: makeWorldState(),
      strategy_version: 0,
    });
    await waitFor(() => handle.stateRef.current !== null);
    await handle.memoryWriter.flush();

    const memFile = path.join(memoryDir, "ogamex-live-state.md");
    await waitFor(() => fs.existsSync(memFile));
    const mtimeBefore = fs.statSync(memFile).mtimeMs;

    await handle.stop();
    // After stop, attempting to push should fail (ECONNREFUSED).
    await expect(
      fetch(`http://127.0.0.1:${httpPort}/ogamex/v1/push`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow();
    // We MUST set this to undefined so afterEach does not re-stop.
    active.handle = undefined;

    // Memory file mtime stays stable (writer timers cleared).
    await new Promise((r) => setTimeout(r, 60));
    const mtimeAfter = fs.statSync(memFile).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
