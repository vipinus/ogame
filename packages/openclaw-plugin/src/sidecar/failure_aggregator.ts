/**
 * M6.4 — FailureAggregator.
 *
 * Receives `event.daily_failure` upstream notifications (relayed via `record`)
 * and buckets them per-task in a sliding window. When the same task fails
 * `threshold` times within `windowMs`, calls `analyzeFailure` (the LLM
 * strategy analyzer), validates the suggested patch against the Strategy
 * schema, applies it via `StrategyManager.applyPatch` (git-audited), and
 * broadcasts a `strategy.update` downstream so the userscript reloads.
 *
 * A cooldown per task prevents back-to-back re-analysis after a patch (or
 * abstain/reject), avoiding LLM-call storms while the userscript is still
 * adapting. The bucket for the affected task is cleared after a successful
 * patch so a fresh failure streak is required to retrigger.
 */

import type { Strategy, WorldState, DownstreamMsg } from "@ogamex/shared";
import type { StrategyManager } from "./strategy_manager.js";
import type { GeminiClient } from "./gemini_client.js";
import { validatePatch } from "./strategy_validator.js";
import {
  analyzeFailure,
  type FailureRecord,
  type AnalyzeResult,
  type AnalyzeInput,
} from "../llm/strategy_analyzer.js";

export interface FailureEventPayload {
  task: string;
  attempts: number;
  last_error: string;
  context: unknown;
  /** Optional client-supplied ts; falls back to now() */
  ts?: number;
}

export interface FailureAggregatorOptions {
  /** Failures of the same task within window required to trigger analysis. Default 3. */
  threshold?: number;
  /** Sliding window in ms. Default 10 minutes. */
  windowMs?: number;
  /** Cooldown after analysis — re-analysis of same task suppressed. Default 30 minutes. */
  cooldownMs?: number;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
}

export interface FailureAggregatorDeps {
  strategyManager: StrategyManager;
  gemini: GeminiClient;
  /** Provider for the current world state — called at analysis time. */
  getState: () => WorldState;
  /** Bridge send callback. */
  send: (msg: DownstreamMsg) => void;
  /** Override for tests. Default uses the real `analyzeFailure` from ../llm/strategy_analyzer.js */
  analyzer?: (input: AnalyzeInput, llm: GeminiClient) => Promise<AnalyzeResult>;
}

export interface AggregatorStats {
  totalFailures: number;
  analysesTriggered: number;
  patchesApplied: number;
  /** validatePatch said no. */
  patchesRejected: number;
  abstains: number;
}

export interface FailureAggregator {
  /** Report a daily-task failure. */
  record(payload: FailureEventPayload): Promise<void>;
  /** Stats accessor (telemetry / tests). */
  stats(): AggregatorStats;
  /** Manually clear all buffers (tests). */
  reset(): void;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

export function createFailureAggregator(
  deps: FailureAggregatorDeps,
  opts?: FailureAggregatorOptions,
): FailureAggregator {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts?.now ?? Date.now;
  const analyzer = deps.analyzer ?? analyzeFailure;

  const failureBuckets = new Map<string, FailureRecord[]>();
  const lastAnalysisAt = new Map<string, number>();

  const counters: AggregatorStats = {
    totalFailures: 0,
    analysesTriggered: 0,
    patchesApplied: 0,
    patchesRejected: 0,
    abstains: 0,
  };

  async function record(payload: FailureEventPayload): Promise<void> {
    const t = payload.ts ?? now();
    const record: FailureRecord = {
      ts: t,
      error: payload.last_error,
      context: payload.context,
    };

    const task = payload.task;
    const bucket = failureBuckets.get(task) ?? [];
    bucket.push(record);

    // Evict entries older than `now() - windowMs`. Uses current clock (not
    // record ts) so a sparse stream still ages out eventually.
    const cutoff = now() - windowMs;
    const fresh = bucket.filter((r) => r.ts >= cutoff);
    failureBuckets.set(task, fresh);

    counters.totalFailures += 1;

    // Cooldown check — if we analyzed this task recently, skip regardless of
    // how many fresh failures are in the bucket. (We still buffer them; if
    // the cooldown lapses they'll fire the next call.) A task that has never
    // been analyzed has no entry in `lastAnalysisAt` and skips this gate.
    const last = lastAnalysisAt.get(task);
    if (last !== undefined && last + cooldownMs > now()) {
      return;
    }

    if (fresh.length < threshold) {
      return;
    }

    counters.analysesTriggered += 1;

    try {
      const currentStrategy = deps.strategyManager.load();
      // Cap how much we hand the LLM (it only really cares about the last few).
      const recentFailures = fresh.slice(0, threshold * 2);

      const result = await analyzer(
        {
          task,
          recentFailures,
          currentStrategy,
          worldState: deps.getState(),
        },
        deps.gemini,
      );

      if ("abstain" in result) {
        counters.abstains += 1;
        lastAnalysisAt.set(task, now());
        return;
      }

      const v = validatePatch(result.patch);
      if (!v.ok) {
        counters.patchesRejected += 1;
        console.warn("[FailureAggregator] patch rejected", v.errors);
        lastAnalysisAt.set(task, now());
        return;
      }

      const next: Strategy = deps.strategyManager.applyPatch(
        result.patch,
        result.reason,
        "openclaw-llm",
      );

      deps.send({
        type: "strategy.update",
        version: next.version,
        patch: result.patch,
        reason: result.reason,
      });

      counters.patchesApplied += 1;
      lastAnalysisAt.set(task, now());
      // Start fresh after a successful patch — require a new failure streak.
      failureBuckets.set(task, []);
    } catch (e) {
      console.error("[FailureAggregator] analysis failed", e);
      lastAnalysisAt.set(task, now());
    }
  }

  function stats(): AggregatorStats {
    return { ...counters };
  }

  function reset(): void {
    failureBuckets.clear();
    lastAnalysisAt.clear();
    counters.totalFailures = 0;
    counters.analysesTriggered = 0;
    counters.patchesApplied = 0;
    counters.patchesRejected = 0;
    counters.abstains = 0;
  }

  return { record, stats, reset };
}
