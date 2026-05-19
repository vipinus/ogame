import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Reporter } from "../../src/sidecar/reporter.js";

describe("Reporter", () => {
  let mockTime: number;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockTime = 0;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("normal push: invokes send with channelId + content and returns true", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = new Reporter({
      channelId: "chan-1",
      send,
      throttleMs: 5000,
      now: () => mockTime,
    });

    const ok = await r.push("hello");
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("chan-1", "hello");
    expect(r.stats().sent).toBe(1);
    expect(r.stats().dropped).toBe(0);
  });

  it("throttle drop: second push within window returns false and skips send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = new Reporter({
      channelId: "chan-1",
      send,
      throttleMs: 5000,
      now: () => mockTime,
    });

    mockTime = 0;
    const first = await r.push("a");
    expect(first).toBe(true);

    mockTime = 2000;
    const second = await r.push("b");
    expect(second).toBe(false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("chan-1", "a");
    expect(r.stats().sent).toBe(1);
    expect(r.stats().dropped).toBe(1);
  });

  it("throttle expires: push after throttleMs goes through", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = new Reporter({
      channelId: "chan-1",
      send,
      throttleMs: 5000,
      now: () => mockTime,
    });

    mockTime = 0;
    await r.push("a");

    mockTime = 2000;
    await r.push("b"); // dropped

    mockTime = 6000;
    const third = await r.push("c");
    expect(third).toBe(true);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "chan-1", "a");
    expect(send).toHaveBeenNthCalledWith(2, "chan-1", "c");
    expect(r.stats().sent).toBe(2);
    expect(r.stats().dropped).toBe(1);
  });

  it("emergency bypasses throttle: emergency within window still sends", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = new Reporter({
      channelId: "chan-1",
      send,
      throttleMs: 5000,
      now: () => mockTime,
    });

    mockTime = 0;
    await r.push("normal");

    mockTime = 1000;
    await r.pushEmergency("EMERGENCY");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(2, "chan-1", "EMERGENCY");
    expect(r.stats().emergencies).toBe(1);
  });

  it("emergency updates lastSendAt: subsequent normal push within new window is dropped", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = new Reporter({
      channelId: "chan-1",
      send,
      throttleMs: 5000,
      now: () => mockTime,
    });

    mockTime = 0;
    await r.push("normal-1");

    mockTime = 1000;
    await r.pushEmergency("EMERG");

    // emergency at t=1000 set lastSendAt; normal push at t=2000 is within throttle
    mockTime = 2000;
    const dropped = await r.push("normal-2");
    expect(dropped).toBe(false);
    expect(send).toHaveBeenCalledTimes(2); // only normal-1 + emergency
    expect(r.stats().dropped).toBe(1);
  });

  it("send error on normal push: returns false and logs", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const r = new Reporter({
      channelId: "chan-1",
      send,
      throttleMs: 5000,
      now: () => mockTime,
    });

    const ok = await r.push("hello");
    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toBe("[Reporter] send failed");
  });

  it("send error on emergency push: throws and logs", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const r = new Reporter({
      channelId: "chan-1",
      send,
      throttleMs: 5000,
      now: () => mockTime,
    });

    await expect(r.pushEmergency("BOOM")).rejects.toThrow("network");
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toBe("[Reporter] send failed");
  });
});
