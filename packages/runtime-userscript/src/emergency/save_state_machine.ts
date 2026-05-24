import type { CaseDecision } from "./case_decider.js";

export type SaveState =
  | "WATCHING" | "THREAT_DETECTED" | "SAVE_PLANNED"
  | "LAUNCHING" | "IN_FLIGHT" | "RECALL_READY" | "RECALLING"
  | "RETURNED" | "FALLBACK";

export interface SaveContext {
  saveWindowMinutes: number;
  safetyMarginMinutes: number;
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
      console.warn(`[fsm] LAUNCHING → IN_FLIGHT  fleetId=${this.fleetId} (waiting for hostile clear + ${this.ctx.safetyMarginMinutes}min margin to recall)`);
      this.state = "IN_FLIGHT";
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      // Operator 2026-05-24: "没船 应该走没船流程". When ogame rejects with
      // a "fleet too small / no recyclers / no ships" pattern, the planet
      // is functionally unsavable — don't enter FALLBACK (which carries
      // alarm noise + 10s lockout). Reset to WATCHING immediately so
      // nothing else gets retried for this dead-end. Patterns cover
      // ogame v12 errors 140011 (要回收該廢墟,必須派遣回收船),
      // 140042 (沒有選擇艦船), 140019 (over expedition limit — not really
      // no-ships but also a "give up and wait" signal).
      const noFleetRe = /回收船|necessary.*recycler|沒有選擇艦船|no.*ships? selected|140011|140042/i;
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
    if (eventId) this.pending.delete(eventId);
    else this.pending.clear();
    if (this.state === "IN_FLIGHT" && this.pending.size === 0) {
      console.warn(`[fsm] IN_FLIGHT → RECALL_READY  all hostiles clear, starting ${this.ctx.safetyMarginMinutes}min safety margin countdown`);
      this.state = "RECALL_READY";
      this.clearedAt = this.actions.now();
    }
  }

  async tick(): Promise<void> {
    if (this.state !== "RECALL_READY" || this.fleetId === null || this.clearedAt === null) return;
    const elapsed = this.actions.now() - this.clearedAt;
    if (elapsed < this.ctx.safetyMarginMinutes * 60) return;
    console.warn(`[fsm] RECALL_READY → RECALLING  fleetId=${this.fleetId} (elapsed=${elapsed}s ≥ margin ${this.ctx.safetyMarginMinutes}min)`);
    this.state = "RECALLING";
    try {
      await this.actions.recallFleet(this.fleetId);
      console.warn(`[fsm] RECALLING → (awaiting fleet return)  recallFleet POST OK`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.error(`[fsm] ❌ RECALLING → FALLBACK  err=${this.lastError}`);
      this.state = "FALLBACK";
    }
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
}
