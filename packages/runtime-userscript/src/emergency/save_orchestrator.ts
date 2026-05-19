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

  const offAttack = bus.on("emergency.attack", (p: any) => {
    // pick source: planet whose coords match the attack's destination
    const target = stateRef.current.planets.find(pl =>
      pl.coords[0] === p.to[0] && pl.coords[1] === p.to[1] && pl.coords[2] === p.to[2]);
    if (!target) return;
    void fsm.handleThreat({ eventId: p.event_id, sourcePlanetId: target.id, arrivesAt: p.arrives_at });
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
    stop: () => { clearInterval(ticker); offAttack(); offState(); stopDetector(); },
  };
}
