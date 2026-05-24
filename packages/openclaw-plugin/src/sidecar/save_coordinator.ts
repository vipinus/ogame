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

export type SaveState =
  | "IN_FLIGHT" | "RECALL_READY" | "RECALLING" | "RETURNED" | "FALLBACK";

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
  /** Safety margin between "all hostiles clear" and "fire recall". */
  safetyMarginSeconds: number;
  /** State reference — coordinator reads events_incoming on every tick. */
  stateRef: { current: WorldState | null };
  /** Send a DownstreamMsg to userscript (typically ws.broadcast). */
  send: (msg: DownstreamMsg) => void;
  /** Clock injection for tests. */
  now?: () => number;
}

export class SaveCoordinator {
  private readonly recordsByPlanet = new Map<string, SaveRecord>();
  private readonly recordsByFleet = new Map<number, SaveRecord>();
  private readonly opts: Required<Omit<SaveCoordinatorOptions, "now">> & { now: () => number };
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SaveCoordinatorOptions) {
    this.opts = {
      safetyMarginSeconds: opts.safetyMarginSeconds,
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
        rec.state = "RECALL_READY";
        rec.clearedAt = this.opts.now();
        console.log(`[save-coord] IN_FLIGHT → RECALL_READY planet=${rec.planet_id} fleet=${rec.fleet_id} margin=${this.opts.safetyMarginSeconds}s`);
      }
    }
  }

  /** 1Hz tick — promote RECALL_READY → RECALLING when margin elapsed. */
  tick(): void {
    const now = this.opts.now();
    const marginMs = this.opts.safetyMarginSeconds * 1000;
    for (const rec of this.recordsByPlanet.values()) {
      if (rec.state !== "RECALL_READY" || rec.clearedAt === null) continue;
      if (now - rec.clearedAt < marginMs) continue;
      console.log(`[save-coord] RECALL_READY → RECALLING planet=${rec.planet_id} fleet=${rec.fleet_id} (elapsed=${Math.floor((now - rec.clearedAt) / 1000)}s)`);
      rec.state = "RECALLING";
      this.opts.send({
        type: "save.recall_now",
        planet_id: rec.planet_id,
        fleet_id: rec.fleet_id,
        reason: `all hostiles clear ${Math.floor((now - rec.clearedAt) / 1000)}s ago`,
      });
    }
  }

  /** Spawn the 1Hz tick loop. */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Read-only snapshot for /v1/save/active. */
  list(): Array<Omit<SaveRecord, "pendingEventIds"> & { pendingEventIds: string[] }> {
    return [...this.recordsByPlanet.values()].map((r) => ({
      ...r, pendingEventIds: [...r.pendingEventIds],
    }));
  }
}
