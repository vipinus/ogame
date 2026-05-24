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
  /** Sidecar base URL (e.g. http://127.0.0.1:28791). When set, orchestrator
   *  reports each successful launch to /v1/save/launched so the backend
   *  SaveCoordinator owns recall scheduling. */
  sidecarBaseUrl?: string;
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
  // Operator 2026-05-24: "4 个星球同时起飞应该没有问题" — switched from a
  // single FSM (which serialized at one save at a time and silently
  // dropped concurrent threats on other planets) to a per-planet FSM
  // map. Each target planet gets its own state machine so parallel
  // saves run independently. API takeoff is fast enough (POST returns
  // in <500ms) that 4-way concurrency is no bottleneck.
  const fsmByPlanet = new Map<string, SaveStateMachine>();
  const getOrCreateFsm = (planetId: string): SaveStateMachine => {
    let fsm = fsmByPlanet.get(planetId);
    if (!fsm) {
      fsm = new SaveStateMachine(
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
      fsmByPlanet.set(planetId, fsm);
      console.warn(`[orchestrator] new FSM for planet ${planetId} (total fsm count: ${fsmByPlanet.size})`);
    }
    return fsm;
  };

  const stopDetector = startAttackDetector(bus, stateRef, { saveWindowMinutes: opts.saveWindowMinutes });

  const findTargetPlanet = (to: readonly [number, number, number]): string | null => {
    const t = Object.values(stateRef.current.planets ?? {}).find(pl =>
      pl.coords[0] === to[0] && pl.coords[1] === to[1] && pl.coords[2] === to[2]);
    return t?.id ?? null;
  };

  // Report a successful launch to the backend SaveCoordinator. Best-effort:
  // a failed POST means backend won't auto-recall, but frontend's own FSM
  // tick is still in place as fallback (won't break the save chain).
  const reportLaunchToBackend = async (sourceId: string, fsm: SaveStateMachine): Promise<void> => {
    if (!opts.sidecarBaseUrl) return;
    const snap = fsm.snapshot();
    if (snap.state !== "IN_FLIGHT" || snap.fleetId === null) return;
    try {
      await opts.fetch(`${opts.sidecarBaseUrl}/ogamex/v1/save/launched`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planet_id: sourceId,
          fleet_id: snap.fleetId,
          hostile_event_ids: snap.pendingThreats,
        }),
      });
      console.log(`[orchestrator] reported launch to backend planet=${sourceId} fleet=${snap.fleetId} pending=${snap.pendingThreats.length}`);
    } catch (e) {
      console.warn(`[orchestrator] backend report failed (frontend FSM still active as fallback):`, e);
    }
  };

  const offAttack = bus.on("emergency.attack", (p: any) => {
    const sourceId = findTargetPlanet(p.to);
    if (!sourceId) return;
    const fsm = getOrCreateFsm(sourceId);
    void fsm.handleThreat({ eventId: p.event_id, sourcePlanetId: sourceId, arrivesAt: p.arrives_at })
      .then(() => reportLaunchToBackend(sourceId, fsm));
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
    const fsm = getOrCreateFsm(sourceId);
    void fsm.handleThreat({ eventId: p.event_id, sourcePlanetId: sourceId, arrivesAt: p.arrives_at })
      .then(() => reportLaunchToBackend(sourceId, fsm));
  });

  // when state updates, check per-planet hostile clearance. Each FSM
  // owns its target's pending set; iterate all and notify each whose
  // pending events have all dropped from events_incoming. Single
  // global clear (notifyHostileClear with no args) was wrong for
  // multi-fsm — would clear pending for planet A on planet B's clear.
  const offState = bus.on("state.updated", () => {
    const stillIncoming = new Set(stateRef.current.events_incoming.filter(e => e.hostile).map(e => e.id));
    for (const fsm of fsmByPlanet.values()) {
      const snap = fsm.snapshot();
      for (const pendingId of snap.pendingThreats) {
        if (!stillIncoming.has(pendingId)) fsm.notifyHostileClear(pendingId);
      }
    }
  });

  // tick at 1Hz to drive RECALL_READY → RECALLING transition for every
  // active FSM. Tick is per-planet; one planet's recall timing doesn't
  // affect another's.
  const ticker = setInterval(() => {
    for (const fsm of fsmByPlanet.values()) void fsm.tick();
  }, 1000);

  return {
    snapshot: () => {
      // For backwards compat the OrchestratorHandle.snapshot returns one
      // FSM's snapshot — pick the first non-WATCHING if any, else first.
      const fsms = Array.from(fsmByPlanet.values());
      const active = fsms.find(f => f.snapshot().state !== "WATCHING");
      return (active ?? fsms[0])?.snapshot() ?? {
        state: "WATCHING", fleetId: null, decision: null,
        pendingThreats: [], clearedAt: null, lastError: null,
      };
    },
    stop: () => { clearInterval(ticker); offAttack(); offSpy(); offState(); stopDetector(); },
  };
}
