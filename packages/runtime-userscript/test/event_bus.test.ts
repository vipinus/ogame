import { describe, it, expect, vi } from "vitest";
import { EventBus, bus } from "../src/event_bus.js";

describe("EventBus", () => {
  it("delivers events to subscribers", () => {
    const b = new EventBus();
    const fn = vi.fn();
    b.on("resource_arrived", fn);
    b.emit("resource_arrived", { planet: "母星", delta: 100 });
    expect(fn).toHaveBeenCalledWith({ planet: "母星", delta: 100 });
  });

  it("unsubscribes cleanly via returned dispose function", () => {
    const b = new EventBus();
    const fn = vi.fn();
    const off = b.on("x", fn);
    off();
    b.emit("x", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("catches subscriber errors without breaking other handlers", () => {
    const b = new EventBus();
    const good = vi.fn();
    b.on("e", () => { throw new Error("bad"); });
    b.on("e", good);
    b.emit("e", 42);
    expect(good).toHaveBeenCalledWith(42);
  });

  it("supports multiple subscribers on the same event", () => {
    const b = new EventBus();
    const a = vi.fn(), c = vi.fn();
    b.on("y", a); b.on("y", c);
    b.emit("y", "hi");
    expect(a).toHaveBeenCalledWith("hi");
    expect(c).toHaveBeenCalledWith("hi");
  });

  it("exports a shared singleton `bus`", () => {
    expect(bus).toBeInstanceOf(EventBus);
  });
});
