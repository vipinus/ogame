/**
 * Wires all userscript runtime subsystems onto an already-booted BootHandle.
 *
 * Composed:
 *   - TokenManager (CSRF refresh from current document/window)
 *   - Emergency save orchestrator (M2.7) + PriorityGate forwarding
 *   - ExpeditionStore + daily expedition loop (M3.7)
 *   - UiDirectiveExecutor + GoalRunner (M5.5 + M5.6) — only if a bridge is provided
 *   - Auditor (M6.5)
 *
 * The BootHandle (and any wired bridge) are owned by the caller; `stop()` here
 * only tears down the subsystems this file constructed.
 */

import type { BootHandle } from "./boot.js";
import type { BridgeClient } from "./bridge/ws_client.js";
import type { ExpeditionConfig } from "@ogamex/shared";
import { startEmergencySave } from "./emergency/save_orchestrator.js";
import { startSpyDetector } from "./emergency/spy_detector.js";
import { emergencyGate } from "./emergency/priority_gate.js";
import { startDailyExpeditionLoop } from "./daily/expedition/loop.js";
import { ExpeditionStore } from "./store/expedition_store.js";
import { startGoalRunner } from "./goal_runner.js";
import { UiDirectiveExecutor } from "./directive_executor.js";
import { ApiDirectiveExecutor } from "./api_executor.js";
import { startAuditor } from "./auditor.js";
import { TokenManager } from "./api/token_manager.js";
import { extractToken, type OgameWindow } from "./probes/extractors/token.js";
import type { StateRef } from "./emergency/attack_detector.js";
import { startGoalsPanel, type GoalsPanelHandle } from "./overlay/goals_panel.js";

export interface RuntimeWireOptions {
  /** BridgeClient to bind GoalRunner. Optional — if absent, GoalRunner is not started. */
  bridge?: BridgeClient;
  /** ExpeditionConfig provider — pulled from current Strategy when daily loop ticks. */
  expeditionConfig: () => ExpeditionConfig;
  /** Window for DOM clicks (browser injects window; tests inject jsdom). */
  win: Window;
  doc: Document;
  /** Initial audit thresholds (from Strategy.audit_rules_thresholds). */
  auditThresholds: Record<string, number>;
  /** Fetch impl for fleet API. */
  fetch: typeof fetch;
  /**
   * Sidecar HTTP base URL (e.g. "http://127.0.0.1:18791"). When set, mounts
   * an in-page goals overlay that polls /v1/goals and exposes cancel /
   * pause / resume buttons. Omit to skip the overlay (tests, dev).
   */
  goalsPanelBaseUrl?: string;
}

export interface RuntimeWireHandle {
  /** Stop EVERYTHING (emergency orchestrator + daily loop + GoalRunner + Auditor). Does NOT stop boot. */
  stop(): void;
}

/** ogame system range is 1..499; the daily loop only uses this when picking
 *  a fresh expedition target system. */
const OGAME_SYSTEM_COUNT = 499;

export function wireRuntime(
  boot: BootHandle,
  opts: RuntimeWireOptions,
): RuntimeWireHandle {
  // 1. Token manager — refreshes from live DOM on miss.
  const tokenManager = new TokenManager(() => {
    const tok = extractToken(opts.doc, opts.win as OgameWindow);
    return tok ?? "";
  });

  // 2. Emergency orchestrator. The state ref reads `current` lazily, so each
  //    consultation sees the latest StateStore snapshot.
  const stateRef: StateRef = {
    get current() {
      return boot.store.state;
    },
  };
  const emergency = startEmergencySave(boot.bus, stateRef, {
    tokenManager,
    fetch: opts.fetch,
    saveWindowMinutes: 30,
    safetyMarginMinutes: 5,
  });
  // Spy detector — informational only (no fleet save). Emits emergency.spy
  // bus event when an inbound espionage probe is detected. Bridge forwards
  // to Discord so operator can see "[spy] X is probing Y".
  const offSpyDetector = startSpyDetector(boot.bus, stateRef);

  // Forward gate transitions onto the bus so other subsystems can react.
  const offGate = emergencyGate.onChange((active) => {
    boot.bus.emit("emergency.gate.changed", { active });
  });

  // 3. Expedition store. In browser environment, opts.win.indexedDB is the
  //    real IDBFactory; tests inject fake-indexeddb. Guard against missing.
  const idbFactory = (opts.win as Window & { indexedDB?: IDBFactory }).indexedDB;
  const expeditionStore = new ExpeditionStore(
    idbFactory ? { factory: idbFactory } : {},
  );

  // 4. Daily expedition loop. Uses a 5-minute fallback tick.
  const daily = startDailyExpeditionLoop({
    bus: boot.bus,
    store: boot.store,
    expeditionStore,
    gate: emergencyGate,
    config: opts.expeditionConfig,
    send: async (p) => {
      const { sendFleet } = await import("./api/fleet_api.js");
      return sendFleet(p, { fetch: opts.fetch, token: tokenManager });
    },
    randomSystem: (_galaxy: number) =>
      1 + Math.floor(Math.random() * OGAME_SYSTEM_COUNT),
    fallbackIntervalMs: 5 * 60 * 1000,
  });

  // 5. UI executor + GoalRunner (only when a bridge is provided).
  let runner: ReturnType<typeof startGoalRunner> | null = null;
  if (opts.bridge) {
    // API executor is the ONLY executor (v0.0.222 — operator "装 A 全 API
    // 化"). UiDirectiveExecutor (DOM click + iframe path) DROPPED from
    // registration. ApiExec covers all actions (build, research,
    // build_ships, expedition, colonize, deploy, transport) as a superset
    // of UiExec's set. No DOM click during operator's active session.
    const apiExecutor = new ApiDirectiveExecutor({ win: opts.win, doc: opts.doc });
    runner = startGoalRunner({
      client: opts.bridge,
      gate: emergencyGate,
      executors: [apiExecutor],
    });
  }

  // 6. Auditor.
  const auditor = startAuditor({
    bus: boot.bus,
    store: boot.store,
    initialThresholds: opts.auditThresholds,
  });

  // 7. Optional goals overlay panel — operator-facing, polls sidecar HTTP.
  let goalsPanel: GoalsPanelHandle | null = null;
  if (opts.goalsPanelBaseUrl) {
    try {
      goalsPanel = startGoalsPanel({
        httpBaseUrl: opts.goalsPanelBaseUrl,
        doc: opts.doc,
        fetch: opts.fetch,
      });
    } catch (e) {
      console.warn("[wireRuntime] goalsPanel start failed", e);
    }
  }

  return {
    stop(): void {
      // Each in try/catch so one failure doesn't block the others.
      try {
        emergency.stop();
      } catch (e) {
        console.warn("[wireRuntime] emergency.stop failed", e);
      }
      try {
        offSpyDetector();
      } catch (e) {
        console.warn("[wireRuntime] spy_detector.stop failed", e);
      }
      try {
        daily.stop();
      } catch (e) {
        console.warn("[wireRuntime] daily.stop failed", e);
      }
      try {
        runner?.stop();
      } catch (e) {
        console.warn("[wireRuntime] runner.stop failed", e);
      }
      try {
        auditor.stop();
      } catch (e) {
        console.warn("[wireRuntime] auditor.stop failed", e);
      }
      try {
        offGate();
      } catch (e) {
        console.warn("[wireRuntime] offGate failed", e);
      }
      try {
        goalsPanel?.stop();
      } catch (e) {
        console.warn("[wireRuntime] goalsPanel.stop failed", e);
      }
    },
  };
}
