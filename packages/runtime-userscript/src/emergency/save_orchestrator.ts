import { EventBus } from "../event_bus.js";
import { startAttackDetector, type StateRef } from "./attack_detector.js";
import { decideCase } from "./case_decider.js";
import { SaveStateMachine, type SaveSnapshot } from "./save_state_machine.js";
import { sendFleet, recallFleet } from "../api/fleet_api.js";
import type { TokenManager } from "../api/token_manager.js";

export interface OrchestratorOptions {
  tokenManager: TokenManager;
  fetch: typeof fetch;
  saveWindowMinutes: number;
  safetyMarginMinutes: number;
}

export interface OrchestratorHandle {
  snapshot(): SaveSnapshot;
  stop(): void;
}

export function startEmergencySave(
  bus: EventBus,
  stateRef: StateRef,
  opts: OrchestratorOptions,
): OrchestratorHandle {
  const fsm = new SaveStateMachine(
    { saveWindowMinutes: opts.saveWindowMinutes, safetyMarginMinutes: opts.safetyMarginMinutes },
    {
      decideCase: (sourceId) => decideCase(stateRef.current, sourceId),
      sendFleet: (decision) => sendFleet({
        ships: decision.ships, cargo: decision.cargo, coords: decision.destCoords,
        destType: decision.destType, mission: decision.mission, speed: decision.speed,
      }, { fetch: opts.fetch, token: opts.tokenManager }),
      recallFleet: (id) => recallFleet(id, { fetch: opts.fetch, token: opts.tokenManager }),
      now: () => Math.floor(Date.now() / 1000),
    },
  );

  const stopDetector = startAttackDetector(bus, stateRef, { saveWindowMinutes: opts.saveWindowMinutes });

  const findTargetPlanet = (to: readonly [number, number, number]): string | null => {
    const t = Object.values(stateRef.current.planets ?? {}).find(pl =>
      pl.coords[0] === to[0] && pl.coords[1] === to[1] && pl.coords[2] === to[2]);
    return t?.id ?? null;
  };

  const offAttack = bus.on("emergency.attack", (p: any) => {
    const sourceId = findTargetPlanet(p.to);
    if (!sourceId) return;
    void fsm.handleThreat({ eventId: p.event_id, sourcePlanetId: sourceId, arrivesAt: p.arrives_at });
  });

  // Spy-as-threat trigger. Operator 2026-05-23: "把侦察也当作威胁测试紧急起飞,
  // 在面板上设置一个开关". Spy events become threats that drive the same
  // SaveStateMachine attack uses — gives operator a live-fire test of the
  // emergency chain (detect → case_decide → sendFleet → IN_FLIGHT → recall).
  //
  // Toggle source of truth: localStorage["OGAMEX_SPY_TRIGGERS_SAVE"].
  //   "on"  → fire on every spy event
  //   "off" → ignore spy events (info-only)
  //   unset → default ON (operator's request was "下次侦察来时自动测试")
  // Panel renders a button that flips the localStorage value. Re-read on
  // every spy event so panel changes take effect without reload. Window
  // mirror exposed for DevTools convenience.
  const winRef = (typeof window !== "undefined" ? window : globalThis) as Window & {
    __ogamexSpyTriggersSave?: boolean;
  };
  const isSpyTriggersSaveOn = (): boolean => {
    try {
      const v = window.localStorage.getItem("OGAMEX_SPY_TRIGGERS_SAVE");
      if (v === "on") return true;
      if (v === "off") return false;
      return true; // default ON
    } catch { return true; }
  };
  // Initial mirror to window for DevTools introspection.
  winRef.__ogamexSpyTriggersSave = isSpyTriggersSaveOn();
  const offSpy = bus.on("emergency.spy", (p: any) => {
    const on = isSpyTriggersSaveOn();
    winRef.__ogamexSpyTriggersSave = on;  // keep mirror fresh
    if (!on) {
      console.info(`[emergency/spy] ${p.event_id} ignored — spy-triggers-save OFF (toggle on panel)`);
      return;
    }
    const sourceId = findTargetPlanet(p.to);
    if (!sourceId) {
      console.warn(`[emergency/spy] no planet at ${p.to.join(":")} — cannot route to FSM`);
      return;
    }
    console.warn(`[emergency/spy] 🚨 spy ${p.event_id} → ${p.to.join(":")}: routing to full save chain (toggle ON)`);
    void fsm.handleThreat({ eventId: p.event_id, sourcePlanetId: sourceId, arrivesAt: p.arrives_at });
  });

  // when state updates, check if all known hostiles for target planet have cleared
  const offState = bus.on("state.updated", () => {
    const remaining = stateRef.current.events_incoming.filter(e => e.hostile);
    if (remaining.length === 0) fsm.notifyHostileClear();
  });

  // tick at 1Hz to drive RECALL_READY → RECALLING transition
  const ticker = setInterval(() => void fsm.tick(), 1000);

  return {
    snapshot: () => fsm.snapshot(),
    stop: () => { clearInterval(ticker); offAttack(); offSpy(); offState(); stopDetector(); },
  };
}
