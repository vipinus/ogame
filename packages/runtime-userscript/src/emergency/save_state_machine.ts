import type { CaseDecision } from "./case_decider.js";

export type SaveState =
  | "WATCHING" | "THREAT_DETECTED" | "SAVE_PLANNED"
  | "LAUNCHING" | "IN_FLIGHT" | "RECALLING"
  | "RETURNED" | "FALLBACK";

// Operator 2026-05-26: "威脅解除立即召回，不要計時，改成事件驅動".
// safetyMarginMinutes dropped — no more RECALL_READY intermediate state.
// hostile clear → immediate recall POST. Trade-off documented: if ogame's
// "hostile cleared" signal is a false positive (attacker swapped fleet),
// our save fleet will already be returning. Operator accepts the trade.
export interface SaveContext {
  saveWindowMinutes: number;
}

export interface SaveActions {
  decideCase: (sourcePlanetId: string) => CaseDecision;
  sendFleet: (decision: CaseDecision) => Promise<{ fleetId: number; raw: unknown }>;
  recallFleet: (fleetId: number) => Promise<void>;
  now: () => number;     // seconds
}

export interface ThreatInput { eventId: string; sourcePlanetId: string; arrivesAt: number; }
export interface NewThreatInput { eventId: string; arrivesAt: number; }

export interface SaveSnapshot {
  state: SaveState;
  fleetId: number | null;
  decision: CaseDecision | null;
  pendingThreats: string[];
  clearedAt: number | null;
  lastError: string | null;
}

export class SaveStateMachine {
  private state: SaveState = "WATCHING";
  private fleetId: number | null = null;
  private decision: CaseDecision | null = null;
  private pending = new Set<string>();         // unresolved threat event ids
  private clearedAt: number | null = null;
  private lastError: string | null = null;

  constructor(private ctx: SaveContext, private actions: SaveActions) {}

  snapshot(): SaveSnapshot {
    return {
      state: this.state, fleetId: this.fleetId, decision: this.decision,
      pendingThreats: [...this.pending], clearedAt: this.clearedAt, lastError: this.lastError,
    };
  }

  async handleThreat(t: ThreatInput): Promise<void> {
    this.pending.add(t.eventId);
    if (this.state !== "WATCHING") {
      // Operator 2026-05-24: silent re-entry was hiding multi-planet
      // threats. Log so it's obvious another planet was dropped.
      console.warn(`[fsm] DROP threat ${t.eventId} for planet ${t.sourcePlanetId} — state=${this.state} busy (single-fsm limitation, see save_orchestrator for multi-planet TODO)`);
      return;
    }
    console.warn(`[fsm] WATCHING → THREAT_DETECTED  eventId=${t.eventId} source=${t.sourcePlanetId} arrives=${t.arrivesAt}`);
    this.state = "THREAT_DETECTED";
    try {
      this.decision = this.actions.decideCase(t.sourcePlanetId);
      console.warn(`[fsm] THREAT_DETECTED → SAVE_PLANNED  case=${this.decision.case} mission=${this.decision.mission} speed=${this.decision.speed} dest=${this.decision.destCoords.join(":")}/type${this.decision.destType} ships=${Object.entries(this.decision.ships).filter(([,n]) => n > 0).map(([k,n]) => `${k}×${n}`).join(",")}`);
      this.state = "SAVE_PLANNED";
      console.warn(`[fsm] SAVE_PLANNED → LAUNCHING  (POST sendFleet)`);
      this.state = "LAUNCHING";
      const res = await this.actions.sendFleet(this.decision);
      this.fleetId = res.fleetId;
      console.warn(`[fsm] LAUNCHING → IN_FLIGHT  fleetId=${this.fleetId} (waiting for hostile clear → instant recall, no margin)`);
      this.state = "IN_FLIGHT";
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      // Operator 2026-05-24: "沒船 應該走沒船流程". When ogame rejects with
      // a "fleet too small / no recyclers / no ships" pattern, the planet
      // is functionally unsavable — don't enter FALLBACK (which carries
      // alarm noise + 10s lockout). Reset to WATCHING immediately so
      // nothing else gets retried for this dead-end. Patterns cover
      // ogame v12 errors 140011 (要回收該廢墟,必須派遣回收船),
      // 140042 (沒有選擇艦船), 140019 (over expedition limit — not really
      // no-ships but also a "give up and wait" signal).
      const noFleetRe = /回收船|recycler|沒有選擇艦船|no.*ships? selected|no ships available|140011|140042/i;
      if (noFleetRe.test(this.lastError)) {
        console.warn(`[fsm] silent skip: ogame says "${this.lastError}" — treating as no-ships, resetting without FALLBACK`);
        this.reset();
        return;
      }
      console.error(`[fsm] ❌ ${this.state} → FALLBACK  err=${this.lastError}`);
      this.state = "FALLBACK";
      // Auto-reset after 10s so the same planet can retry on the next
      // threat (operator 2026-05-24: a single FALLBACK was permanently
      // killing the planet's fsm — subsequent spies hit "state busy DROP").
      setTimeout(() => {
        if (this.state === "FALLBACK") {
          console.warn(`[fsm] FALLBACK → WATCHING (auto-reset 10s after failure, planet now retry-ready)`);
          this.reset();
        }
      }, 10_000);
    }
  }

  notifyNewThreat(t: NewThreatInput): void {
    this.pending.add(t.eventId);
  }

  notifyHostileClear(eventId?: string): void {
    // Operator 2026-05-26 evidence: pendingThreats=[] but state=IN_FLIGHT no recall.
    // Race: orchestrator state.updated fired DURING handleThreat (fsm.state==LAUNCHING),
    // notifyHostileClear cleared pending; then fsm reached IN_FLIGHT — but pending
    // already empty so subsequent state.updated never sees a pendingId to clear
    // → notifyHostileClear never gets called when state==IN_FLIGHT → never RECALLING.
    // Fix: don't burn the signal early. Only honor clear when post-launch.
    if (this.state !== "IN_FLIGHT" && this.state !== "RECALLING") return;
    if (eventId) this.pending.delete(eventId);
    else this.pending.clear();
    if (this.state === "IN_FLIGHT" && this.pending.size === 0) {
      this.clearedAt = this.actions.now();
      // Operator 2026-05-26: "威脅解除立即召回，不要計時". RECALL_READY +
      // safetyMargin tick removed — IN_FLIGHT → RECALLING the moment last
      // hostile drops from events_incoming. POST recall immediately.
      console.warn(`[fsm] IN_FLIGHT → RECALLING  all hostiles clear, instant recall (fleetId=${this.fleetId})`);
      this.state = "RECALLING";
      // v0.0.716 — operator 2026-06-03 "需要recall 的时候再去拿真ID". Lazy
      // /movement fetch is now triggered HERE (not by eventbox-hook periodic
      // poll). When fleetId is still placeholder 0, await one /movement
      // scrape so patcher can populate the real ogame fleet_id, then fire
      // recall POST. If patcher (state.updated handler) already patched
      // (rare race), this lazy fetch is just a fresh confirmation pass.
      void this.fireRecall();
    }
  }

  private async fireRecall(): Promise<void> {
    if (this.fleetId === null || this.fleetId <= 0) {
      // Lazy fetch /movement to populate real fleet_id. Patcher in
      // save_orchestrator state.updated handler will match by mission +
      // origin + origin_type and call patchFleetId. patchFleetId itself
      // re-fires recall on success, so we just await the harvest then bail.
      try {
        const win = (typeof window !== "undefined" ? window : globalThis) as unknown as Window & {
          __ogamexHarvestMovement?: () => Promise<void>;
        };
        if (typeof win.__ogamexHarvestMovement === "function") {
          console.warn(`[fsm] RECALLING — fleetId still 0, lazy fetching /movement once for patcher`);
          await win.__ogamexHarvestMovement();
        } else {
          console.warn(`[fsm] RECALLING skipped recall POST — fleetId=${this.fleetId} unknown and no __ogamexHarvestMovement available`);
          return;
        }
      } catch (e) {
        console.error(`[fsm] lazy /movement fetch threw, RECALLING stays stuck:`, e);
        return;
      }
      // After harvest, patcher in orchestrator state.updated handler should
      // have fired patchFleetId, which itself re-fires recall. If fleetId is
      // still 0 here, /movement didn't include our fleet (very recent launch
      // not yet visible) — patcher will retry on next state.updated.
      if (this.fleetId === null || this.fleetId <= 0) {
        console.warn(`[fsm] RECALLING still no fleetId after lazy /movement — patcher will retry on next state.updated`);
        return;
      }
    }
    void this.actions.recallFleet(this.fleetId)
      .then(() => console.warn(`[fsm] RECALLING → (awaiting fleet return)  recallFleet POST OK`))
      .catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error(`[fsm] ❌ RECALLING → FALLBACK  err=${this.lastError}`);
        this.state = "FALLBACK";
      });
  }

  /** Deprecated — kept for backward compat (call site count). No-op now. */
  async tick(): Promise<void> { /* recall is event-driven, no timer */ }

  /**
   * Patch real ogame fleet id over the placeholder (0) set when sendFleet
   * couldn't return fleetIdToReturn. Called by orchestrator after each
   * /movement harvest. Idempotent: only writes when fleetId is currently
   * placeholder (null / <=0) and we're in IN_FLIGHT / RECALLING.
   * Returns true if patched, false if no-op.
   */
  patchFleetId(realId: number): boolean {
    if (realId <= 0) return false;
    if (this.state !== "IN_FLIGHT" && this.state !== "RECALLING") return false;
    if (this.fleetId !== null && this.fleetId > 0) return false;
    const prev = this.fleetId;
    this.fleetId = realId;
    console.warn(`[fsm] patchFleetId ${prev} → ${realId} (state=${this.state})`);
    // If we were stuck in RECALLING with no id, fire recall now.
    if (this.state === "RECALLING") {
      void this.actions.recallFleet(realId)
        .then(() => console.warn(`[fsm] (post-patch) recallFleet POST OK fleetId=${realId}`))
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
          console.error(`[fsm] ❌ (post-patch) RECALLING → FALLBACK  err=${this.lastError}`);
          this.state = "FALLBACK";
        });
    }
    return true;
  }

  notifyFleetReturned(): void {
    if (this.state === "RECALLING") this.state = "RETURNED";
  }

  reset(): void {
    this.state = "WATCHING";
    this.fleetId = null;
    this.decision = null;
    this.pending.clear();
    this.clearedAt = null;
    this.lastError = null;
  }

  /** Restore FSM internal state from a previously-persisted snapshot.
   *  Used by orchestrator to rehydrate FSMs after page reload — without
   *  it, FSMs are in-memory only and an F5 mid-flight loses the ability
   *  to fire auto-recall (v0.0.714 fix). Caller must ensure ctx + actions
   *  are wired identically to the original construction; only mutable
   *  state is restored. */
  restoreFromSnapshot(snap: SaveSnapshot): void {
    this.state = snap.state;
    this.fleetId = snap.fleetId;
    this.decision = snap.decision;
    this.pending = new Set(snap.pendingThreats);
    this.clearedAt = snap.clearedAt;
    this.lastError = snap.lastError;
  }
}
