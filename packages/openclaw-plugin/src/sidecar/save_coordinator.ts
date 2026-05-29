/**
 * SaveCoordinator — backend FSM for multi-planet fleet save.
 *
 * Operator 2026-05-24: "fsm 可以放后台, 管理所有 fs". Migrated from
 * userscript-side per-planet FSM map to a single sidecar-side coordinator
 * that:
 *   - Stores every in-flight save indexed by planet_id (in-memory Map;
 *     persistence is a follow-up).
 *   - Watches WorldState.events_incoming each state.snapshot tick;
 *     when a save's pendingEventIds all dropped from events_incoming
 *     it transitions IN_FLIGHT → RECALL_READY.
 *   - Runs a 1Hz tick that flips RECALL_READY → RECALLING after the
 *     safety margin and emits a `save.recall_now` downstream message
 *     to the userscript (which has the cookies/token to POST recall).
 *
 * What stays in userscript (per operator's "前端立刻执行更有效率" rule):
 *   - Detection (attack_detector, spy_detector).
 *   - Case decision (case_decider.ts — chooses A/B/C).
 *   - sendFleet POST (fast critical path, <500ms).
 *   - recallFleet POST (page world owns the token).
 *
 * What this module owns:
 *   - Lifecycle bookkeeping after launch (pendingHostiles, clearedAt,
 *     recall scheduling). No POSTs, no decision logic.
 */

import type { DownstreamMsg, WorldState } from "@ogamex/shared";

// Operator 2026-05-26: "威胁解除立即召回，不要计时". RECALL_READY dropped —
// IN_FLIGHT → RECALLING fires the moment hostiles clear; safetyMargin tick
// removed.
export type SaveState =
  | "IN_FLIGHT" | "RECALLING" | "RETURNED" | "FALLBACK";

export interface SaveRecord {
  planet_id: string;
  fleet_id: number;
  state: SaveState;
  pendingEventIds: Set<string>;
  clearedAt: number | null;   // ms epoch when last hostile cleared
  launchedAt: number;
  lastError: string | null;
}

export interface SaveLaunchedInput {
  planet_id: string;
  fleet_id: number;
  hostile_event_ids: readonly string[];
}

export interface SaveCoordinatorOptions {
  /** State reference — coordinator reads events_incoming on every tick. */
  stateRef: { current: WorldState | null };
  /** Send a DownstreamMsg to userscript (typically ws.broadcast). */
  send: (msg: DownstreamMsg) => void;
  /** Clock injection for tests. */
  now?: () => number;
  /** @deprecated 2026-05-26 — kept for backward-compat test calls, ignored. */
  safetyMarginSeconds?: number;
}

export class SaveCoordinator {
  private readonly recordsByPlanet = new Map<string, SaveRecord>();
  private readonly recordsByFleet = new Map<number, SaveRecord>();
  private readonly opts: { stateRef: SaveCoordinatorOptions["stateRef"]; send: SaveCoordinatorOptions["send"]; now: () => number };

  constructor(opts: SaveCoordinatorOptions) {
    this.opts = {
      stateRef: opts.stateRef,
      send: opts.send,
      now: opts.now ?? Date.now,
    };
  }

  /** Called by HTTP handler when userscript reports a successful launch. */
  recordLaunch(input: SaveLaunchedInput): SaveRecord {
    const rec: SaveRecord = {
      planet_id: input.planet_id,
      fleet_id: input.fleet_id,
      state: "IN_FLIGHT",
      pendingEventIds: new Set(input.hostile_event_ids),
      clearedAt: null,
      launchedAt: this.opts.now(),
      lastError: null,
    };
    this.recordsByPlanet.set(input.planet_id, rec);
    this.recordsByFleet.set(input.fleet_id, rec);
    console.log(`[save-coord] LAUNCH planet=${input.planet_id} fleet=${input.fleet_id} pending=[${[...rec.pendingEventIds].join(",")}]`);
    return rec;
  }

  /** Called by HTTP handler when userscript confirms recall POST succeeded. */
  recordRecallConfirmed(fleetId: number): void {
    const rec = this.recordsByFleet.get(fleetId);
    if (!rec) {
      console.warn(`[save-coord] recall-confirmed for unknown fleet=${fleetId}`);
      return;
    }
    console.log(`[save-coord] RECALLING → RETURNED planet=${rec.planet_id} fleet=${fleetId}`);
    rec.state = "RETURNED";
    // Clean up so the planet can launch a new save later.
    this.recordsByPlanet.delete(rec.planet_id);
    this.recordsByFleet.delete(fleetId);
  }

  /** Called every state.snapshot — diff pendingEventIds vs new incoming. */
  onSnapshot(state: WorldState): void {
    const stillIncoming = new Set(
      (state.events_incoming ?? []).filter((e) => e.hostile).map((e) => e.id),
    );
    for (const rec of this.recordsByPlanet.values()) {
      if (rec.state !== "IN_FLIGHT") continue;
      let cleared = false;
      for (const pid of [...rec.pendingEventIds]) {
        if (!stillIncoming.has(pid)) {
          rec.pendingEventIds.delete(pid);
          cleared = true;
        }
      }
      if (cleared && rec.pendingEventIds.size === 0) {
        // Operator 2026-05-29 evidence: sidecar received LAUNCH with
        // fleet=0 placeholder and never got the second LAUNCH with the
        // real fleet id (frontend FSM silent-skipped on 140042 no-ships
        // so patchFleetId never fired). recall_now with fleet=0 is
        // useless — frontend's wireBridge handler skips it with
        // "backend fleet=0 and fsm has no real id either — skip recall".
        // We then keep re-firing the same useless message every snapshot.
        // Guard: if fleet_id is still 0/missing after hostiles cleared,
        // delete the record (the launch never actually committed a fleet,
        // and frontend can't help us patch it now).
        if (!rec.fleet_id || rec.fleet_id <= 0) {
          console.warn(`[save-coord] DROP unsalvageable record planet=${rec.planet_id} fleet=${rec.fleet_id} — never patched real fleet id (frontend silent-skip likely)`);
          this.recordsByPlanet.delete(rec.planet_id);
          this.recordsByFleet.delete(rec.fleet_id);
          continue;
        }
        // Operator 2026-05-26: "威胁解除立即召回". Skip RECALL_READY +
        // margin tick — instantly emit save.recall_now downstream so
        // userscript fires recall POST without waiting.
        rec.clearedAt = this.opts.now();
        rec.state = "RECALLING";
        console.log(`[save-coord] IN_FLIGHT → RECALLING (instant) planet=${rec.planet_id} fleet=${rec.fleet_id}`);
        this.opts.send({
          type: "save.recall_now",
          planet_id: rec.planet_id,
          fleet_id: rec.fleet_id,
          reason: `all hostiles clear (instant recall, no margin)`,
        });
      }
    }
  }

  /** @deprecated 2026-05-26 — no-op; recall is event-driven, no timer. */
  tick(): void { /* event-driven */ }

  /** @deprecated 2026-05-26 — no-op; no ticker to spawn. */
  start(): void { /* event-driven */ }

  /** @deprecated 2026-05-26 — no-op; no ticker to clear. */
  stop(): void { /* event-driven */ }

  /** Read-only snapshot for /v1/save/active. */
  list(): Array<Omit<SaveRecord, "pendingEventIds"> & { pendingEventIds: string[] }> {
    return [...this.recordsByPlanet.values()].map((r) => ({
      ...r, pendingEventIds: [...r.pendingEventIds],
    }));
  }
}
