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
    if (this.state !== "WATCHING") return;       // re-entry handled by pending set
    this.state = "THREAT_DETECTED";
    try {
      this.decision = this.actions.decideCase(t.sourcePlanetId);
      this.state = "SAVE_PLANNED";
      this.state = "LAUNCHING";
      const res = await this.actions.sendFleet(this.decision);
      this.fleetId = res.fleetId;
      this.state = "IN_FLIGHT";
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.state = "FALLBACK";
    }
  }

  notifyNewThreat(t: NewThreatInput): void {
    this.pending.add(t.eventId);
  }

  notifyHostileClear(eventId?: string): void {
    if (eventId) this.pending.delete(eventId);
    else this.pending.clear();
    if (this.state === "IN_FLIGHT" && this.pending.size === 0) {
      this.state = "RECALL_READY";
      this.clearedAt = this.actions.now();
    }
  }

  async tick(): Promise<void> {
    if (this.state !== "RECALL_READY" || this.fleetId === null || this.clearedAt === null) return;
    const elapsed = this.actions.now() - this.clearedAt;
    if (elapsed < this.ctx.safetyMarginMinutes * 60) return;
    this.state = "RECALLING";
    try {
      await this.actions.recallFleet(this.fleetId);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
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
