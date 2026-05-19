import { describe, it, expect, vi, beforeEach } from "vitest";
import { SaveStateMachine, type SaveContext, type SaveSnapshot } from "../../src/emergency/save_state_machine.js";

const baseCtx = (overrides: Partial<SaveContext> = {}): SaveContext => ({
  saveWindowMinutes: 30,
  safetyMarginMinutes: 5,
  ...overrides,
});

describe("SaveStateMachine", () => {
  let fsm: SaveStateMachine;
  let ctx: SaveContext;
  let actions: any;

  beforeEach(() => {
    actions = {
      decideCase: vi.fn(() => ({ case: "A", sourcePlanetId: "m1", destCoords: [1,42,8], destType: 2,
        mission: 8, speed: 1, ships: { recycler: 1 }, cargo: { m: 0, c: 0, d: 0 }, reason: "A" })),
      sendFleet:  vi.fn(async () => ({ fleetId: 99, raw: { success: true, fleetIdToReturn: 99 } })),
      recallFleet: vi.fn(async () => {}),
      now: () => 1_000_000,
    };
    ctx = baseCtx();
    fsm = new SaveStateMachine(ctx, actions);
  });

  it("happy path: WATCHING → THREAT_DETECTED → SAVE_PLANNED → LAUNCHING → IN_FLIGHT → RECALL_READY → RECALLING → RETURNED", async () => {
    expect(fsm.snapshot().state).toBe("WATCHING");

    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    expect(actions.sendFleet).toHaveBeenCalledTimes(1);
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");
    expect(fsm.snapshot().fleetId).toBe(99);

    fsm.notifyHostileClear();
    expect(fsm.snapshot().state).toBe("RECALL_READY");

    // safety margin not elapsed yet
    expect(actions.recallFleet).not.toHaveBeenCalled();

    actions.now = () => 1_000_000 + ctx.safetyMarginMinutes * 60 + 1;
    await fsm.tick();
    expect(actions.recallFleet).toHaveBeenCalledWith(99);
    expect(fsm.snapshot().state).toBe("RECALLING");

    fsm.notifyFleetReturned();
    expect(fsm.snapshot().state).toBe("RETURNED");
  });

  it("FALLBACK on sendFleet failure → degrades or escalates", async () => {
    actions.sendFleet = vi.fn(async () => { throw new Error("Not enough deut"); });
    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    expect(fsm.snapshot().state).toBe("FALLBACK");
    expect(fsm.snapshot().lastError).toMatch(/deut/);
  });

  it("re-enters detection when new hostile arrives during IN_FLIGHT", async () => {
    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");
    fsm.notifyNewThreat({ eventId: "e2", arrivesAt: 1_000_800 });
    expect(fsm.snapshot().pendingThreats).toContain("e2");
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");        // already in flight, just track
  });

  it("does NOT recall until ALL hostiles cleared", async () => {
    await fsm.handleThreat({ eventId: "e1", sourcePlanetId: "m1", arrivesAt: 1_000_600 });
    fsm.notifyNewThreat({ eventId: "e2", arrivesAt: 1_000_800 });
    fsm.notifyHostileClear("e1");
    expect(fsm.snapshot().state).toBe("IN_FLIGHT");
    fsm.notifyHostileClear("e2");
    expect(fsm.snapshot().state).toBe("RECALL_READY");
  });
});
