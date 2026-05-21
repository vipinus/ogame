import { describe, it, expect, vi } from "vitest";
import type { Strategy, WorldState } from "@ogamex/shared";
import { GeminiClient, GeminiApiError } from "../../src/sidecar/gemini_client.js";
import { analyzeFailure, type FailureRecord } from "../../src/llm/strategy_analyzer.js";

// -----------------------------------------------------------------------------
// Factories — minimal viable Strategy / WorldState. Only fields the analyzer
// might read are populated meaningfully; everything else is a stub.
// -----------------------------------------------------------------------------

function makeStrategy(): Strategy {
  return {
    version: 1,
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
    planets: [{
        id: "p1",
        name: "Homeworld",
        coords: [1, 1, 1],
        type: "planet",
        resources: { m: 1000, c: 500, d: 200, e: 0 },
        storage: { m_max: 1_000_000, c_max: 1_000_000, d_max: 1_000_000 },
        production: { m_h: 100, c_h: 50, d_h: 20 },
        buildings: {},
        build_q: null,
        shipyard_q: null,
        defense_q: null,
        ships: {},
        defense: {},
        lifeform: null,
      }],
    research: { levels: { astrophysics: 4 }, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 1 },
    discovery_active: [],
    last_update: 0,
    page_snapshots: {},
  };
}

// Build a fake GeminiClient where generateJson is a vi.fn we control.
interface FakeClient {
  client: GeminiClient;
  generateJson: ReturnType<typeof vi.fn>;
}
function makeFakeClient(impl: (...args: unknown[]) => Promise<unknown>): FakeClient {
  const generateJson = vi.fn(impl);
  // Construct a real GeminiClient (fetch unused since we override generateJson).
  const client = new GeminiClient({ apiKey: "test", fetch: (async () => new Response("{}")) as unknown as typeof fetch });
  (client as unknown as { generateJson: typeof generateJson }).generateJson = generateJson;
  return { client, generateJson };
}

function makeFailures(): FailureRecord[] {
  return [
    { ts: 1, error: "fleet slot exhausted", context: { task: "expedition_fill_slot" } },
    { ts: 2, error: "insufficient deuterium", context: {} },
    { ts: 3, error: "source planet has no ships", context: {} },
  ];
}

describe("analyzeFailure", () => {
  it("returns patch + reason when LLM returns a valid patch shape", async () => {
    const { client } = makeFakeClient(async () => ({
      patch: { daily: { expedition: { duration: "medium" } } },
      reason: "shorter duration reduces deut burn",
    }));
    const out = await analyzeFailure(
      {
        task: "expedition_fill_slot",
        recentFailures: makeFailures(),
        currentStrategy: makeStrategy(),
        worldState: makeWorldState(),
      },
      client,
    );
    expect(out).toEqual({
      patch: { daily: { expedition: { duration: "medium" } } },
      reason: "shorter duration reduces deut burn",
    });
  });

  it("returns abstain when LLM returns abstain shape", async () => {
    const { client } = makeFakeClient(async () => ({ abstain: "not enough data" }));
    const out = await analyzeFailure(
      {
        task: "expedition_fill_slot",
        recentFailures: makeFailures(),
        currentStrategy: makeStrategy(),
        worldState: makeWorldState(),
      },
      client,
    );
    expect(out).toEqual({ abstain: "not enough data" });
  });

  it("defensively abstains when LLM returns neither shape", async () => {
    const { client } = makeFakeClient(async () => ({}));
    const out = await analyzeFailure(
      {
        task: "expedition_fill_slot",
        recentFailures: makeFailures(),
        currentStrategy: makeStrategy(),
        worldState: makeWorldState(),
      },
      client,
    );
    expect(out).toEqual({ abstain: "model did not produce a valid response shape" });
  });

  it("returns abstain on SyntaxError (malformed JSON)", async () => {
    const { client } = makeFakeClient(async () => {
      throw new SyntaxError("Unexpected token");
    });
    const out = await analyzeFailure(
      {
        task: "expedition_fill_slot",
        recentFailures: makeFailures(),
        currentStrategy: makeStrategy(),
        worldState: makeWorldState(),
      },
      client,
    );
    expect(out).toEqual({ abstain: "model output was not parseable JSON" });
  });

  it("re-throws on GeminiApiError", async () => {
    const { client } = makeFakeClient(async () => {
      throw new GeminiApiError("HTTP 500", 500);
    });
    await expect(
      analyzeFailure(
        {
          task: "expedition_fill_slot",
          recentFailures: makeFailures(),
          currentStrategy: makeStrategy(),
          worldState: makeWorldState(),
        },
        client,
      ),
    ).rejects.toBeInstanceOf(GeminiApiError);
  });

  it("prompt includes task name and at least one failure error message", async () => {
    const { client, generateJson } = makeFakeClient(async () => ({ abstain: "ok" }));
    await analyzeFailure(
      {
        task: "expedition_fill_slot",
        recentFailures: makeFailures(),
        currentStrategy: makeStrategy(),
        worldState: makeWorldState(),
      },
      client,
    );
    expect(generateJson).toHaveBeenCalledTimes(1);
    const promptArg = generateJson.mock.calls[0]![0] as string;
    expect(promptArg).toContain("expedition_fill_slot");
    expect(promptArg).toContain("fleet slot exhausted");
  });
});
