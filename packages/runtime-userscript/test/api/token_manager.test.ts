import { describe, it, expect, vi } from "vitest";
import { TokenManager } from "../../src/api/token_manager.js";

describe("TokenManager", () => {
  it("returns cached token until TTL expires", () => {
    const tm = new TokenManager(() => "tok-1", { ttlMs: 10000 });
    expect(tm.getFreshToken()).toBe("tok-1");
    expect(tm.getFreshToken()).toBe("tok-1");   // cache hit
  });

  it("self-heals via refresh callback on invalidate()", async () => {
    let n = 0;
    const tm = new TokenManager(() => `tok-${++n}`);
    expect(tm.getFreshToken()).toBe("tok-1");
    await tm.invalidate();
    expect(tm.getFreshToken()).toBe("tok-2");
  });

  it("re-fetches automatically when TTL has expired", () => {
    let n = 0;
    const tm = new TokenManager(() => `tok-${++n}`, { ttlMs: 100 });
    expect(tm.getFreshToken()).toBe("tok-1");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 200);
    expect(tm.getFreshToken()).toBe("tok-2");
    vi.useRealTimers();
  });

  it("throws when refresh callback returns empty string", () => {
    const tm = new TokenManager(() => "");
    expect(() => tm.getFreshToken()).toThrow();
  });

  it("throws when refresh callback throws", () => {
    const tm = new TokenManager(() => { throw new Error("no DOM"); });
    expect(() => tm.getFreshToken()).toThrow(/no DOM/);
  });

  it("set() forces value bypassing refresh callback", () => {
    let calls = 0;
    const tm = new TokenManager(() => { calls++; return "from-refresh"; });
    tm.set("from-set");
    expect(tm.getFreshToken()).toBe("from-set");
    expect(calls).toBe(0);
  });

  it("set() ignores empty value", () => {
    const tm = new TokenManager(() => "real");
    tm.set("");
    expect(tm.getFreshToken()).toBe("real");
  });
});
