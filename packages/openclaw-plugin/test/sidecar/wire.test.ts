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

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const t = setTimeout(() => {
      reject(new Error("connect timeout"));
      try { ws.terminate(); } catch { /* ignore */ }
    }, 1000);
    ws.once("open", () => { clearTimeout(t); resolve(ws); });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(t);
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
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
    const client = await connectWs(handle.ws.port());

    const snapshot = makeWorldState();
    snapshot.player.name = "alice";
    const msg: UpstreamMsg = {
      type: "state.snapshot",
      ts: Date.now(),
      snapshot,
      strategy_version: 0,
    };
    client.send(JSON.stringify(msg));

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

    client.close();
  });

  it("hello → server broadcasts strategy.full", async () => {
    const { handle } = await boot();
    const client = await connectWs(handle.ws.port());

    const received: DownstreamMsg[] = [];
    client.on("message", (data) => {
      try { received.push(JSON.parse(data.toString("utf8")) as DownstreamMsg); } catch { /* ignore */ }
    });

    client.send(JSON.stringify({
      type: "hello",
      strategy_version: 0,
      userscript_version: "0.0.1",
    } satisfies UpstreamMsg));

    await waitFor(() => received.some((m) => m.type === "strategy.full"));
    const full = received.find((m) => m.type === "strategy.full");
    expect(full).toBeTruthy();
    if (full?.type === "strategy.full") {
      expect(full.strategy.version).toBe(0);
      expect(full.strategy.updated_by).toBe("userscript-bootstrap");
    }

    client.close();
  });

  it("event.emergency with reporter → forwards markdown_report to send", async () => {
    const sendDiscord = vi.fn<(channelId: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { handle } = await boot({ discordChannelId: "chan-xyz", sendDiscord });
    // The boot already used sendDiscord for the online banner — capture
    // baseline calls so we can assert the emergency push specifically.
    const baselineCalls = sendDiscord.mock.calls.length;

    const client = await connectWs(handle.ws.port());
    const markdown = "**ATTACK** — fleet incoming at coords 1:2:3";
    client.send(JSON.stringify({
      type: "event.emergency",
      subtype: "attack",
      data: {},
      markdown_report: markdown,
    } satisfies UpstreamMsg));

    await waitFor(() => sendDiscord.mock.calls.length > baselineCalls);
    const last = sendDiscord.mock.calls[sendDiscord.mock.calls.length - 1]!;
    expect(last[0]).toBe("chan-xyz");
    expect(last[1]).toBe(markdown);

    client.close();
  });

  it("event.daily_failure × threshold → failureAggregator triggers analyzer once", async () => {
    const analyzer = vi.fn<(input: AnalyzeInput) => Promise<AnalyzeResult>>(
      async () => ({ abstain: "no info" }),
    );
    const { handle } = await boot({ analyzer });
    const client = await connectWs(handle.ws.port());

    // Default threshold is 3 — push exactly 3 failures of the same task.
    for (let i = 0; i < 3; i++) {
      client.send(JSON.stringify({
        type: "event.daily_failure",
        task: "expedition",
        attempts: i + 1,
        last_error: "boom",
        context: { i },
      } satisfies UpstreamMsg));
    }

    await waitFor(() => handle.failureAggregator.stats().analysesTriggered === 1);
    expect(handle.failureAggregator.stats().analysesTriggered).toBe(1);
    expect(analyzer).toHaveBeenCalledTimes(1);

    client.close();
  });

  it("stop() shuts down ws + http + memory writer (no new connections, no memory churn)", async () => {
    const { handle, memoryDir } = await boot();
    const wsPort = handle.ws.port();
    expect(wsPort).toBeGreaterThan(0);
    // Push one snapshot + flush to seed the memory file.
    const client = await connectWs(wsPort);
    client.send(JSON.stringify({
      type: "state.snapshot",
      ts: Date.now(),
      snapshot: makeWorldState(),
      strategy_version: 0,
    } satisfies UpstreamMsg));
    await waitFor(() => handle.stateRef.current !== null);
    await handle.memoryWriter.flush();

    const memFile = path.join(memoryDir, "ogamex-live-state.md");
    await waitFor(() => fs.existsSync(memFile));
    const mtimeBefore = fs.statSync(memFile).mtimeMs;

    client.close();

    await handle.stop();
    // After stop, attempting to connect should fail.
    await expect(connectWs(wsPort)).rejects.toThrow();
    // We MUST set this to undefined so afterEach does not re-stop.
    active.handle = undefined;

    // Memory file mtime stays stable (writer timers cleared).
    await new Promise((r) => setTimeout(r, 60));
    const mtimeAfter = fs.statSync(memFile).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
