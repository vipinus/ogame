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

  // Spy-as-test trigger. Operator 2026-05-23: "可以把侦察也当作威胁测试紧急
  // 起飞，下次侦察来的时候自动测试了". Spy events normally don't justify a
  // real fleet save (probe arrives in seconds — no save can outrun it),
  // but they make a good live-fire test of the entire emergency chain
  // (detect → case_decide → sendFleet → IN_FLIGHT → recall on all-clear).
  //
  // Single-shot mode by default: fires once, then auto-disarms. To re-arm
  // in DevTools console: `window.__ogamexSpyTestArmed = true`. Default-on
  // so the next inbound probe automatically runs the test end-to-end —
  // no operator action needed for the first verification.
  const winRef = (typeof window !== "undefined" ? window : globalThis) as Window & {
    __ogamexSpyTestArmed?: boolean;
  };
  if (winRef.__ogamexSpyTestArmed === undefined) winRef.__ogamexSpyTestArmed = true;
  const offSpy = bus.on("emergency.spy", (p: any) => {
    if (!winRef.__ogamexSpyTestArmed) {
      console.info(`[emergency/spy-test] spy ${p.event_id} ignored — disarmed. Re-arm: window.__ogamexSpyTestArmed = true`);
      return;
    }
    const sourceId = findTargetPlanet(p.to);
    if (!sourceId) {
      console.warn(`[emergency/spy-test] no planet at spy target ${p.to.join(":")} — cannot run test`);
      return;
    }
    console.warn(`[emergency/spy-test] 🚨 FIRING full emergency save chain on spy ${p.event_id} → ${p.to.join(":")} (single-shot test). Auto-disarming after this run.`);
    winRef.__ogamexSpyTestArmed = false;
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
