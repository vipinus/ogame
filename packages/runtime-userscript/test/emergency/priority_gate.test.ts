import { describe, it, expect, vi } from "vitest";
import { PriorityGate, emergencyGate } from "../../src/emergency/priority_gate.js";

describe("PriorityGate", () => {
  it("defaults to inactive", () => {
    const g = new PriorityGate();
    expect(g.isActive()).toBe(false);
  });

  it("setActive(true) flips state and isActive() returns true", () => {
    const g = new PriorityGate();
    g.setActive(true);
    expect(g.isActive()).toBe(true);
    g.setActive(false);
    expect(g.isActive()).toBe(false);
  });

  it("notifies subscribers on state change", () => {
    const g = new PriorityGate();
    const spy = vi.fn();
    g.onChange(spy);
    g.setActive(true);
    g.setActive(false);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, true);
    expect(spy).toHaveBeenNthCalledWith(2, false);
  });

  it("does NOT notify when state does not change (idempotent set)", () => {
    const g = new PriorityGate();
    const spy = vi.fn();
    g.onChange(spy);
    g.setActive(false);   // already false
    g.setActive(false);
    expect(spy).not.toHaveBeenCalled();
    g.setActive(true);
    g.setActive(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("onChange returns a disposer that detaches the listener", () => {
    const g = new PriorityGate();
    const spy = vi.fn();
    const off = g.onChange(spy);
    g.setActive(true);
    off();
    g.setActive(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("exports a default singleton `emergencyGate`", () => {
    expect(emergencyGate).toBeInstanceOf(PriorityGate);
    expect(emergencyGate.isActive()).toBe(false);
  });

  it("catches listener errors without breaking other listeners", () => {
    const g = new PriorityGate();
    const good = vi.fn();
    g.onChange(() => { throw new Error("bad listener"); });
    g.onChange(good);
    g.setActive(true);
    expect(good).toHaveBeenCalledWith(true);
  });
});
