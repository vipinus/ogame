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
  /** v1.0.28 — per-user bridge token. save/launched 必须带 Bearer 否则
   *  sidecar resolveBearer 拿不到 uid → recordSaveLaunched 退 legacy
   *  单例 saveCoordinator → 小号 FS save 记录串到 legacy → 召回 miss
   *  = 丢舰队. ([[cross-tenant-globals]] 家族, owner 2026-06-12). */
  bridgeToken?: string;
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
  // Operator 2026-05-24: "4 個星球同時起飛應該沒有問題" — switched from a
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

  // v0.0.714 — operator 2026-06-03: "FSM 没 localStorage persistence
  // 这个很有可能". Root cause of "auto-FS launched but no recall": userscript
  // FSM is in-memory only, F5 / page reload wipes it; backend never gets the
  // hostile-clear → recall transition because nobody is watching events_incoming
  // for that fleet anymore. Fix: persist each FSM snapshot to localStorage on
  // every transition, restore on boot. 24h TTL guards against zombie FSMs.
  const FSM_STORAGE_PREFIX = "ogamex.save.fsm.";
  const FSM_STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
  const persistFsm = (planetId: string, fsm: SaveStateMachine): void => {
    try {
      const snap = fsm.snapshot();
      // Terminal / idle states — drop from storage so we don't replay.
      if (snap.state === "WATCHING" || snap.state === "RETURNED") {
        window.localStorage.removeItem(FSM_STORAGE_PREFIX + planetId);
        return;
      }
      window.localStorage.setItem(
        FSM_STORAGE_PREFIX + planetId,
        JSON.stringify({ snap, ts: Date.now() }),
      );
    } catch { /* localStorage full / private mode — silent */ }
  };
  const persistAll = (): void => {
    for (const [planetId, fsm] of fsmByPlanet) persistFsm(planetId, fsm);
  };
  const getOrCreateFsm = (planetId: string): SaveStateMachine => {
    let fsm = fsmByPlanet.get(planetId);
    if (!fsm) {
      fsm = new SaveStateMachine(
        { saveWindowMinutes: opts.saveWindowMinutes },
        {
          decideCase: (sourceId) => decideCase(stateRef.current, sourceId),
          sendFleet: async (decision) => {
            // Operator 2026-05-26: "前端操作的時候會自動跳到其他星球".
            // sendFleet POST with cp=sourcePlanetId 切 ogame session-cp.
            // restoreSessionCp 由 fleet_api.sendFleet 內部經 fetchWithCpBypassBusy
            // 自動處理 (v0.0.352 架構遷移). 不再外層 try/finally restore.
            return await sendFleet({
              ships: decision.ships, cargo: decision.cargo, coords: decision.destCoords,
              destType: decision.destType, mission: decision.mission, speed: decision.speed,
              sourcePlanetId: decision.sourcePlanetId,
              // v1.0.26 — FS 保命链: 发船页 30s gate 直放.
              emergency: true,
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

  // v0.0.714 — restore any FSMs persisted by a previous userscript session.
  // Each restored FSM resumes in its prior state (IN_FLIGHT / RECALLING / etc.)
  // and starts receiving state.updated again — so when events_incoming clears,
  // it fires recall like the original would have. baseFleetIds is left empty
  // for restored FSMs; the patcher will match by mission+origin+origin_type
  // against the current /movement harvest (real fleet still in flight, will
  // be found). 24h TTL drops zombie snapshots from abandoned sessions.
  try {
    const now = Date.now();
    const keysToRestore: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(FSM_STORAGE_PREFIX)) keysToRestore.push(k);
    }
    for (const k of keysToRestore) {
      const planetId = k.slice(FSM_STORAGE_PREFIX.length);
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      try {
        const data = JSON.parse(raw) as { snap: SaveSnapshot; ts: number };
        if (now - data.ts > FSM_STORAGE_TTL_MS) {
          console.warn(`[orchestrator] discarding stale FSM snapshot ${planetId} (age ${Math.round((now - data.ts)/60000)}m > 24h)`);
          window.localStorage.removeItem(k);
          continue;
        }
        // v0.0.769 — operator 2026-06-04 evidence: 4 个 FSM 全卡 RECALLING
        // state, clearedAt 4h ago, fleet 早回了 patcher 没机会 mark RETURNED
        // → 所有新 spy/attack threat 命中 save_state_machine:58 DROP.
        // Sanity gate: RECALLING + clearedAt > 30min 前 = fleet 必定回家,
        // 直接 drop snapshot, planet 重新 WATCHING 接威胁.
        const snap = data.snap;
        if (snap.state === "RECALLING" && typeof snap.clearedAt === "number") {
          const clearedAgo = Math.floor(Date.now() / 1000) - snap.clearedAt;
          if (clearedAgo > 30 * 60) {
            console.warn(`[orchestrator] dropping stuck RECALLING FSM ${planetId} — clearedAt ${Math.round(clearedAgo/60)}m ago, fleet must have returned by now (was DROPPING all new threats)`);
            window.localStorage.removeItem(k);
            continue;
          }
        }
        const fsm = getOrCreateFsm(planetId);
        fsm.restoreFromSnapshot(snap);
        console.warn(`[orchestrator] restored FSM ${planetId} state=${snap.state} fleetId=${snap.fleetId} pending=[${snap.pendingThreats.join(",")}]`);
      } catch (e) {
        console.warn(`[orchestrator] failed to restore FSM ${planetId}, removing snapshot:`, e);
        try { window.localStorage.removeItem(k); } catch { /* */ }
      }
    }
  } catch { /* */ }

  const stopDetector = startAttackDetector(bus, stateRef, { saveWindowMinutes: opts.saveWindowMinutes });

  // Operator 2026-05-25: "敵人探測和進攻的是月球，星球上的艦隊不要FS,
  // 威脅指向的具體位置上面的艦隊FS". planet + moon share G:S:P; the
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

  // Operator 2026-05-24: "星球和月球如果沒有船就不用執行FS". Skip silently
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
    // Operator 2026-05-29: race fix — previously this fired
    // __ogamexHarvestMovement() fire-and-forget, then immediately POSTed
    // /v1/save/launched with fleetId=0 placeholder. When spy ETA < harvest
    // duration (~1s), hostile cleared → fsm transitioned IN_FLIGHT →
    // RECALLING with fleetId still 0 → recall POST skipped → ships stuck
    // at deploy destination. Now: SYNCHRONOUSLY await the harvest (capped
    // at 3s) so patchFleetId fires BEFORE backend report + RECALLING gate.
    try {
      const harvestFn = (typeof window !== "undefined"
        ? (window as Window & { __ogamexHarvestMovement?: () => Promise<void> })
        : null);
      if (harvestFn?.__ogamexHarvestMovement) {
        const HARVEST_TIMEOUT_MS = 3000;
        await Promise.race([
          harvestFn.__ogamexHarvestMovement().catch(() => { /* swallow */ }),
          new Promise<void>((resolve) => setTimeout(resolve, HARVEST_TIMEOUT_MS)),
        ]);
      }
    } catch { /* */ }
    if (!opts.sidecarBaseUrl) return;
    const snap = fsm.snapshot();
    if (snap.state !== "IN_FLIGHT" || snap.fleetId === null) return;
    if (!snap.fleetId || snap.fleetId === 0) {
      console.warn(`[orchestrator] post-harvest fleetId still 0 for ${sourceId} — backend will be told 0; recall will rely on later harvest tick`);
    }
    try {
      await opts.fetch(`${opts.sidecarBaseUrl}/ogamex/v1/save/launched`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // v1.0.28 — per-user Bearer so sidecar tags this save record to
          // the owning uid (else recordSaveLaunched falls to legacy单例 →
          // 跨户召回 miss → 丢舰队).
          ...(opts.bridgeToken ? { Authorization: `Bearer ${opts.bridgeToken}` } : {}),
        },
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
  // FS auto-launch for BOTH attack and spy events. operator 主動 pause 緊急
  // 起飛 (e.g. 測試 / 知道是友軍 alpha attack / debug).
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
      .then(() => { persistFsm(sourceId, fsm); return reportLaunchToBackend(sourceId, fsm); });
  });

  // Spy-as-threat trigger. Operator 2026-05-23: "把偵察也當作威脅測試緊急起飛,
  // 在面板上設定一個開關". Spy events become threats that drive the same
  // SaveStateMachine attack uses — gives operator a live-fire test of the
  // emergency chain (detect → case_decide → sendFleet → IN_FLIGHT → recall).
  //
  // Toggle source of truth: localStorage["OGAMEX_SPY_TRIGGERS_SAVE"].
  //   "on"  → fire on every spy event
  //   "off" → ignore spy events (info-only)
  //   unset → default ON (operator's request was "下次偵察來時自動測試")
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
  // v1.0.8 — owner 2026-06-10 "被侦察都没看到自动 FS" 实证 ogame_save_records 24h 0 行.
  // 4 silent return branch 真因不明, 加 sidecar debug log push 给每个 skip 留痕迹,
  // 下次 spy 来时能 grep 真因.
  const debugLog = (tag: string, text: string): void => {
    try {
      const winLs = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
      const baseUrl = winLs.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://fs.7x24hrs.com";
      void fetch(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, text }),
      }).catch(() => { /* */ });
    } catch { /* */ }
  };
  const offSpy = bus.on("emergency.spy", (p: any) => {
    debugLog("orchestrator-spy", `RECEIVED event_id=${p.event_id} to=${(p.to ?? []).join(":")} to_type=${p.to_type ?? "(none)"} arrives_at=${p.arrives_at}`);
    if (emergencyPaused()) {
      const msg = `SKIP ${p.event_id}: emergency PAUSED (operator toggled ⏸)`;
      console.warn(`[orchestrator] ${msg}`);
      debugLog("orchestrator-spy", msg);
      return;
    }
    const on = isSpyTriggersSaveOn();
    winRef.__ogamexSpyTriggersSave = on;  // keep mirror fresh
    if (!on) {
      const msg = `SKIP ${p.event_id}: spy-triggers-save OFF (LS getItem)`;
      console.info(`[emergency/spy] ${msg}`);
      debugLog("orchestrator-spy", msg);
      return;
    }
    const sourceId = findTargetPlanet(p.to, p.to_type);
    if (!sourceId) {
      const msg = `SKIP ${p.event_id}: findTargetPlanet returned null for to=${p.to.join(":")} to_type=${p.to_type ?? "(none)"}`;
      console.warn(`[emergency/spy] ${msg}`);
      debugLog("orchestrator-spy", msg);
      return;
    }
    if (hasNoShips(sourceId)) {
      const planet = stateRef.current.planets?.[sourceId];
      const msg = `SKIP ${p.event_id}: hasNoShips planet=${sourceId} (${p.to.join(":")}, type=${planet?.type ?? "?"}) — nothing to save`;
      console.info(`[emergency/spy] ${msg}`);
      debugLog("orchestrator-spy", msg);
      return;
    }
    debugLog("orchestrator-spy", `FIRE ${p.event_id} → planet=${sourceId} ${p.to.join(":")} routing to full save chain`);
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
      .then(() => { persistFsm(sourceId, fsm); return reportLaunchToBackend(sourceId, fsm); });
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
    // v0.0.714 — catch-all persist after every tick. Cheap (1 setItem per
    // active FSM), idempotent, covers patchFleetId / notifyHostileClear /
    // async recall .then state mutations.
    persistAll();
  });

  // Operator 2026-05-26: "威脅解除立即召回，不要計時，改成事件驅動".
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
