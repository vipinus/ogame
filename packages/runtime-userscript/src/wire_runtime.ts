/**
 * Wires all userscript runtime subsystems onto an already-booted BootHandle.
 *
 * Composed:
 *   - TokenManager (CSRF refresh from current document/window)
 *   - Emergency save orchestrator (M2.7) + PriorityGate forwarding
 *   - GoalRunner + ApiDirectiveExecutor (M5.5+M5.6) — only if a bridge is provided
 *   - Auditor (M6.5)
 *
 * The BootHandle (and any wired bridge) are owned by the caller; `stop()` here
 * only tears down the subsystems this file constructed.
 *
 * 2026-05-27 dead-code purge: daily/expedition/loop + slot_filler + pickers
 * removed (was always-disabled in strategy; actual expedition dispatch lives
 * in sidecar discord-bridge daemon). directive_executor.ts (UiDirectiveExecutor
 * DOM-click executor) also removed — ApiDirectiveExecutor was the only
 * registered executor since v0.0.222.
 */

import type { BootHandle } from "./boot.js";
import type { BridgeClient } from "./bridge/ws_client.js";
import { startEmergencySave } from "./emergency/save_orchestrator.js";
import { recallFleet } from "./api/fleet_api.js";
import { startSpyDetector } from "./emergency/spy_detector.js";
import { emergencyGate } from "./emergency/priority_gate.js";
import { startGoalRunner } from "./goal_runner.js";
import { ApiDirectiveExecutor } from "./api_executor.js";
import { startAuditor } from "./auditor.js";
import { TokenManager } from "./api/token_manager.js";
import { extractToken, type OgameWindow } from "./probes/extractors/token.js";
import type { StateRef } from "./emergency/attack_detector.js";
import { startGoalsPanel, type GoalsPanelHandle } from "./overlay/goals_panel.js";

export interface RuntimeWireOptions {
  /** BridgeClient to bind GoalRunner. Optional — if absent, GoalRunner is not started. */
  bridge?: BridgeClient;
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
  /** Bearer token forwarded to goals panel for auth-required sidecar endpoints. */
  goalsPanelBridgeToken?: string;
}

export interface RuntimeWireHandle {
  /** Stop EVERYTHING (emergency orchestrator + GoalRunner + Auditor). Does NOT stop boot. */
  stop(): void;
}

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
    // safetyMarginMinutes removed 2026-05-26 — recall is now instant on
    // hostile clear (event-driven, no timer).
    // Operator 2026-05-24: "fsm 可以放后台" — orchestrator reports each
    // successful launch to sidecar's SaveCoordinator; sidecar owns recall
    // scheduling and emits save.recall_now downstream when ready.
    sidecarBaseUrl: "https://ogame.anyfq.com",
  });
  // Expose recallFleet for bridge wire's save.recall_now handler (sidecar
  // tells us when, we POST it because cookies+token live in the page).
  (opts.win as Window & {
    __ogamexRecallFleet?: (fleetId: number) => Promise<void>;
  }).__ogamexRecallFleet = (fleetId: number) =>
    recallFleet(fleetId, { fetch: opts.fetch, token: tokenManager });

  // Cargo Calc one-shot deploy — operator 2026-05-26: 改 Fill 按钮成"部署
  // 这些船到本星球的月球". Source = current page planet (from meta), dest =
  // SAME coords + type=3 (moon), mission=4 (deploy), speed=10, no cargo.
  // Returns { ok, message } for panel feedback.
  const sendFleetFn = async (p: import("@ogamex/shared").Coords, ships: import("@ogamex/shared").ShipCount, sourceId: string): Promise<{ ok: boolean; message: string }> => {
    const { sendFleet } = await import("./api/fleet_api.js");
    // restoreSessionCp 由 fleet_api.sendFleet 内部 fetchWithCpBypassBusy 自动处理.
    try {
      const res = await sendFleet(
        { ships, cargo: { m: 0, c: 0, d: 0 }, coords: p, destType: 3, mission: 4, speed: 10, sourcePlanetId: sourceId },
        { fetch: opts.fetch, token: tokenManager },
      );
      return { ok: true, message: `fleetId=${res.fleetId}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
  type DeployFn = (shipName: string, count: number) => Promise<{ ok: boolean; message: string }>;
  const deployHelper: DeployFn = async (shipName, count) => {
    const sourceId = opts.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    if (!sourceId) return { ok: false, message: "no current planet meta" };
    const src = stateRef.current.planets?.[sourceId];
    if (!src) return { ok: false, message: `planet ${sourceId} not in store` };
    if (src.type === "moon") return { ok: false, message: "already on moon — cannot deploy to itself" };
    // Find same-coord moon
    const moonAtSame = Object.values(stateRef.current.planets ?? {}).find((pl) =>
      pl.type === "moon" && pl.coords[0] === src.coords[0] && pl.coords[1] === src.coords[1] && pl.coords[2] === src.coords[2]
    );
    if (!moonAtSame) return { ok: false, message: `no moon at ${src.coords.join(":")}` };
    return sendFleetFn(src.coords, { [shipName]: count } as import("@ogamex/shared").ShipCount, sourceId);
  };
  (opts.win as Window & { __ogamexDeployToMoon?: DeployFn }).__ogamexDeployToMoon = deployHelper;
  try {
    if (typeof (globalThis as { unsafeWindow?: Window }).unsafeWindow !== "undefined") {
      ((globalThis as { unsafeWindow: Window }).unsafeWindow as Window & { __ogamexDeployToMoon?: DeployFn }).__ogamexDeployToMoon = deployHelper;
    }
  } catch { /* */ }
  // Dual-expose emergency orchestrator handle + spy-trigger mirror to BOTH
  // sandbox window (env.win) AND page-world (unsafeWindow) so DevTools console
  // can verify orchestrator state. Sandbox isolation otherwise makes console
  // verify always undefined regardless of orchestrator's real status.
  // Pattern proven in fetchPlanetShips dual-expose (v0.0.286).
  type PageWin = Window & {
    __ogamexEmergencySnapshot?: () => unknown;
    __ogamexSpyTriggersSaveOn?: () => boolean;
    __ogamexFireTestSpy?: (toCoords: string, toType?: "planet" | "moon") => void;
  };
  const wireExpose = (target: PageWin): void => {
    target.__ogamexEmergencySnapshot = () => emergency.snapshot();
    target.__ogamexSpyTriggersSaveOn = () => {
      try {
        const v = opts.win.localStorage.getItem("OGAMEX_SPY_TRIGGERS_SAVE");
        return v === "off" ? false : true;
      } catch { return true; }
    };
    target.__ogamexFireTestSpy = (toCoords, toType) => {
      const [g, s, p] = toCoords.split(":").map((x) => parseInt(x, 10));
      boot.bus.emit("emergency.spy", {
        event_id: `test-${Date.now()}`,
        from: [0, 0, 0],
        to: [g, s, p],
        to_type: toType ?? "planet",
        arrives_at: Math.floor(Date.now() / 1000) + 600,
        hostile: true,
      });
      console.warn(`[wireRuntime] test spy event fired → ${toCoords} (${toType ?? "planet"})`);
    };
  };
  wireExpose(opts.win as PageWin);
  try {
    if (typeof (globalThis as { unsafeWindow?: Window }).unsafeWindow !== "undefined") {
      wireExpose((globalThis as { unsafeWindow: Window }).unsafeWindow as PageWin);
    }
  } catch { /* unsafeWindow may be undefined in tests */ }
  // Spy detector — informational only (no fleet save). Emits emergency.spy
  // bus event when an inbound espionage probe is detected. Bridge forwards
  // to Discord so operator can see "[spy] X is probing Y".
  const offSpyDetector = startSpyDetector(boot.bus, stateRef);

  // Forward gate transitions onto the bus so other subsystems can react.
  const offGate = emergencyGate.onChange((active) => {
    boot.bus.emit("emergency.gate.changed", { active });
  });

  // GoalRunner (only when a bridge is provided).
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
      // Operator 2026-05-27: cp=PID shift bounce — defer non-emergency
      // directives while operator is interacting with ogame UI.
      userBusy: () => {
        // Operator 2026-05-28: bug — user_busy_until is written in MS
        // (Date.now() + IDLE_GUARD_MS at boot.ts:322), but here we compared
        // against SECONDS (Date.now()/1000). ms > sec → always true →
        // GoalRunner deferred forever once any mousedown ever happened.
        // Sidecar (index.ts:1048) compares against Date.now() ms correctly.
        const u = (boot.store.state.server as { user_busy_until?: number } | undefined)?.user_busy_until;
        return typeof u === "number" && u > Date.now();
      },
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
        ...(opts.goalsPanelBridgeToken ? { bridgeToken: opts.goalsPanelBridgeToken } : {}),
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
