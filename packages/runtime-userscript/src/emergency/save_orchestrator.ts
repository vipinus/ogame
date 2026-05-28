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
  // Operator 2026-05-27: patchFleetId picked stale (operator daily-deploy from
  // same source planet) mission=4 fleet because state.fleets_outbound hadn't
  // refreshed yet. Result: FSM tracked wrong fleet id (2083526 instead of new
  // 2083474) → recall POST hit a ghost → ogame {"success":false}.
  // Fix: snapshot existing fleet ids BEFORE handleThreat fires sendFleet;
  // patcher then accepts only ids NOT in baseline = guaranteed new fleet.
  const baseFleetIds = new Map<string, Set<string>>();
  const getOrCreateFsm = (planetId: string): SaveStateMachine => {
    let fsm = fsmByPlanet.get(planetId);
    if (!fsm) {
      fsm = new SaveStateMachine(
        { saveWindowMinutes: opts.saveWindowMinutes },
        {
          decideCase: (sourceId) => decideCase(stateRef.current, sourceId),
          sendFleet: async (decision) => {
            // Operator 2026-05-26: "前端操作的时候会自动跳到其他星球".
            // sendFleet POST with cp=sourcePlanetId 切 ogame session-cp.
            // restoreSessionCp 由 fleet_api.sendFleet 内部经 fetchWithCpBypassBusy
            // 自动处理 (v0.0.352 架构迁移). 不再外层 try/finally restore.
            return await sendFleet({
              ships: decision.ships, cargo: decision.cargo, coords: decision.destCoords,
              destType: decision.destType, mission: decision.mission, speed: decision.speed,
              sourcePlanetId: decision.sourcePlanetId,
            }, { fetch: opts.fetch, token: opts.tokenManager });
          },
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

  // Operator 2026-05-25: "敌人探测和进攻的是月球，星球上的舰队不要FS,
  // 威胁指向的具体位置上面的舰队FS". planet + moon share G:S:P; the
  // target's body type comes from the event row (parseEventListHTMLAndInject
  // extracts it into ev.to_type). Use type to disambiguate; only fall back
  // to first-match-by-coord when type unknown (defensive).
  const findTargetPlanet = (
    to: readonly [number, number, number],
    toType?: "planet" | "moon",
  ): string | null => {
    const candidates = Object.values(stateRef.current.planets ?? {}).filter(pl =>
      pl.coords[0] === to[0] && pl.coords[1] === to[1] && pl.coords[2] === to[2],
    );
    if (candidates.length === 0) return null;
    if (toType) {
      const exact = candidates.find((c) => c.type === toType);
      if (exact) return exact.id;
      // type-mismatch (e.g., parser said "moon" but state has no moon
      // record yet) — don't silently FS the planet. Return null so
      // orchestrator skips this threat instead of saving the wrong body.
      console.warn(`[orchestrator] threat to_type=${toType} but no ${toType} at ${to.join(":")} — skip FS (won't save wrong body)`);
      return null;
    }
    // No type info — fall back to first match (legacy behavior).
    return candidates[0]!.id;
  };

  // Operator 2026-05-24: "星球和月球如果没有船就不用执行FS". Skip silently
  // before fsm — no decision, no POST, no FALLBACK, no alarm noise. Saves
  // operator from the dead-end where case_decider would throw "no ships"
  // and the planet's fsm flips into FALLBACK for 10s.
  const hasNoShips = (planetId: string): boolean => {
    const p = stateRef.current.planets?.[planetId];
    if (!p) return false;  // unknown planet — don't pre-skip, fsm will handle
    const ships = p.ships ?? {};
    let total = 0;
    for (const v of Object.values(ships)) total += (v ?? 0);
    return total === 0;
  };

  // Report a successful launch to the backend SaveCoordinator. Best-effort:
  // a failed POST means backend won't auto-recall, but frontend's own FSM
  // tick is still in place as fallback (won't break the save chain).
  const reportLaunchToBackend = async (sourceId: string, fsm: SaveStateMachine): Promise<void> => {
    // Operator 2026-05-26: sendFleet response has no fleetIdToReturn, so
    // fsm enters IN_FLIGHT with fleetId=0. Force a movement harvest right
    // after launch so the patchFleetId hook fires on the next state.updated
    // tick (without waiting for the next periodic harvest cycle).
    try {
      const harvestFn = (typeof window !== "undefined"
        ? (window as Window & { __ogamexHarvestMovement?: () => Promise<void> })
        : null);
      if (harvestFn?.__ogamexHarvestMovement) {
        void harvestFn.__ogamexHarvestMovement().catch(() => { /* */ });
      }
    } catch { /* */ }
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

  // Operator 2026-05-26: panel emergency pause button (⏸) → toggles
  // localStorage["ogamex.emergency.paused"]. When true, orchestrator skips
  // FS auto-launch for BOTH attack and spy events. operator 主动 pause 紧急
  // 起飞 (e.g. 测试 / 知道是友军 alpha attack / debug).
  const emergencyPaused = (): boolean => {
    try {
      const v = window.localStorage.getItem("ogamex.emergency.paused");
      return v === "true" || v === '"true"' || v === "1";
    } catch { return false; }
  };

  const offAttack = bus.on("emergency.attack", (p: any) => {
    if (emergencyPaused()) {
      console.warn(`[orchestrator] emergency PAUSED — attack ${p.event_id} ignored (operator toggled ⏸)`);
      return;
    }
    const sourceId = findTargetPlanet(p.to, p.to_type);
    if (!sourceId) return;
    if (hasNoShips(sourceId)) {
      console.info(`[orchestrator] skip FS: ${sourceId} (${p.to.join(":")}) has no ships — nothing to save`);
      return;
    }
    const fsm = getOrCreateFsm(sourceId);
    // Snapshot existing fleet ids BEFORE sendFleet so patcher distinguishes
    // pre-existing fleets from the one this FSM is about to launch.
    baseFleetIds.set(sourceId, new Set(
      (stateRef.current.fleets_outbound ?? [])
        .map((f) => f.id)
        .filter((id): id is string => typeof id === "string"),
    ));
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
    if (emergencyPaused()) {
      console.warn(`[orchestrator] emergency PAUSED — spy ${p.event_id} ignored (operator toggled ⏸)`);
      return;
    }
    const on = isSpyTriggersSaveOn();
    winRef.__ogamexSpyTriggersSave = on;  // keep mirror fresh
    if (!on) {
      console.info(`[emergency/spy] ${p.event_id} ignored — spy-triggers-save OFF (toggle on panel)`);
      return;
    }
    const sourceId = findTargetPlanet(p.to, p.to_type);
    if (!sourceId) {
      console.warn(`[emergency/spy] no planet at ${p.to.join(":")} — cannot route to FSM`);
      return;
    }
    if (hasNoShips(sourceId)) {
      console.info(`[emergency/spy] skip FS: ${sourceId} (${p.to.join(":")}) has no ships — nothing to save`);
      return;
    }
    console.warn(`[emergency/spy] 🚨 spy ${p.event_id} → ${p.to.join(":")}: routing to full save chain (toggle ON)`);
    const fsm = getOrCreateFsm(sourceId);
    baseFleetIds.set(sourceId, new Set(
      (stateRef.current.fleets_outbound ?? [])
        .map((f) => f.id)
        .filter((id): id is string => typeof id === "string"),
    ));
    const baseSnapshot = baseFleetIds.get(sourceId)!;
    console.warn(`[orchestrator] pre-launch baseline fleets=[${[...baseSnapshot].join(",") || "(empty)"}] → patcher will skip these`);
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
    // Operator 2026-05-26: reverse-patch real fleet id from /movement harvest.
    // sendFleet response has no fleetIdToReturn (v0.0.292), so fsm enters
    // IN_FLIGHT with fleetId=0 placeholder. After /movement scrape (now
    // captures data-fleet-id, v0.0.294), look for a fleets_outbound entry
    // matching this fsm's decision (origin coord + mission) and patch the
    // real id over the placeholder so recall POST can fire.
    const fleets = stateRef.current.fleets_outbound ?? [];
    for (const [planetId, fsm] of fsmByPlanet) {
      const snap = fsm.snapshot();
      if ((snap.state !== "IN_FLIGHT" && snap.state !== "RECALLING") ||
          (snap.fleetId !== null && snap.fleetId > 0)) continue;
      const dec = snap.decision;
      if (!dec) continue;
      const sourcePl = stateRef.current.planets?.[planetId];
      if (!sourcePl) continue;
      const srcKey = sourcePl.coords.join(":");
      // Find a fleet whose origin matches source planet + mission matches
      // decision.mission + id is numeric (real ogame id, not synthetic mvt-).
      const baseline = baseFleetIds.get(planetId) ?? new Set<string>();
      // Operator 2026-05-28 evidence: concurrent FSMs at the SAME coords
      // (planet 33649009 + moon 33640786, both at 2:279:8) both patched
      // to the same fleet 2142558 because find() didn't distinguish
      // planet-typed origin from moon-typed origin. Result: sidecar got
      // duplicate launch records, recall fired twice for one real fleet
      // (causing first cycle's 4-attempt FAIL → FALLBACK), and FSM 1
      // (whose sendFleet actually failed silent-skip) wrongly claimed
      // FSM 2's fleet. Add origin_type gate.
      const candidate = fleets.find((f) => {
        const id = f.id;
        if (typeof id !== "string" || !/^\d+$/.test(id)) return false;
        // Skip fleet ids that already existed BEFORE we fired sendFleet — they
        // belong to operator's other missions (e.g., daily deploy from same
        // source planet), not the one this FSM just launched.
        if (baseline.has(id)) return false;
        if (f.mission !== dec.mission) return false;
        // Origin type gate: planet vs moon share G:S:P; without this check
        // a planet-FSM steals a moon-FSM's fleet (or vice versa) when both
        // launched at the same coord.
        if (f.origin_type !== sourcePl.type) return false;
        const fOrig = Array.isArray(f.origin) ? f.origin.join(":") : "";
        return fOrig === srcKey;
      });
      if (candidate) {
        const realId = parseInt(candidate.id, 10);
        if (realId > 0) {
          const patched = fsm.patchFleetId(realId);
          // Clear baseline once we've matched — prevents stale baseline from
          // blocking a subsequent FSM cycle on same planet (e.g., second spy).
          if (patched) baseFleetIds.delete(planetId);
          // Operator 2026-05-26: backend SaveCoordinator was stored fleet=0 (frontend
          // reported launch with placeholder); when hostiles cleared, sidecar emitted
          // save.recall_now planet=X fleet=0 → recall POST FAILED. After patch, re-report
          // with real id so backend tracks correct fleet for any subsequent recall_now.
          if (patched) void reportLaunchToBackend(planetId, fsm);
        }
      }
    }
    // Hostile clear → fsm.notifyHostileClear (instant recall path).
    for (const fsm of fsmByPlanet.values()) {
      const snap = fsm.snapshot();
      for (const pendingId of snap.pendingThreats) {
        if (!stillIncoming.has(pendingId)) fsm.notifyHostileClear(pendingId);
      }
    }
  });

  // Operator 2026-05-26: "威胁解除立即召回，不要计时，改成事件驱动".
  // 1Hz tick removed — IN_FLIGHT → RECALLING is now fired the moment
  // notifyHostileClear empties pending (in fsm itself), no timer needed.

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
    stop: () => { offAttack(); offSpy(); offState(); stopDetector(); },
  };
}
