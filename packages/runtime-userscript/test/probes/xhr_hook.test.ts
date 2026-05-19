import { describe, it, expect, vi } from "vitest";
import { installXhrHook, type Emitter, type XhrContext } from "../../src/probes/xhr_hook.js";

describe("xhr_hook", () => {
  it("emits xhr.response when fetch returns JSON for /game/index.php", async () => {
    const emitter: Emitter = { emit: vi.fn() };
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const ctx: XhrContext = { fetch: fakeFetch };
    installXhrHook(ctx, emitter);
    await ctx.fetch("/game/index.php?page=ingame&component=eventList&ajax=1");
    expect(emitter.emit).toHaveBeenCalledWith("xhr.response", expect.objectContaining({
      url: expect.stringContaining("eventList"),
      status: 200,
      body: { ok: 1 },
    }));
  });

  it("emits text body when response is not JSON", async () => {
    const emitter: Emitter = { emit: vi.fn() };
    const fakeFetch = vi.fn(async () =>
      new Response("<html>x</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    const ctx: XhrContext = { fetch: fakeFetch };
    installXhrHook(ctx, emitter);
    await ctx.fetch("/game/index.php?page=overview");
    expect(emitter.emit).toHaveBeenCalledWith("xhr.response", expect.objectContaining({
      url: expect.stringContaining("overview"),
      body: "<html>x</html>",
    }));
  });

  it("does NOT emit for non-ogame URLs", async () => {
    const emitter: Emitter = { emit: vi.fn() };
    const fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const ctx: XhrContext = { fetch: fakeFetch };
    installXhrHook(ctx, emitter);
    await ctx.fetch("https://other-site.com/api");
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it("returns original fetch response after hooking", async () => {
    const emitter: Emitter = { emit: vi.fn() };
    const fakeFetch = vi.fn(async () => new Response('{"hello":"world"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const ctx: XhrContext = { fetch: fakeFetch };
    installXhrHook(ctx, emitter);
    const res = await ctx.fetch("/game/index.php?page=overview");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ hello: "world" });
  });

  it("never breaks fetch on emitter error", async () => {
    const emitter: Emitter = { emit: vi.fn(() => { throw new Error("bad"); }) };
    const fakeFetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const ctx: XhrContext = { fetch: fakeFetch };
    installXhrHook(ctx, emitter);
    // should NOT throw
    const res = await ctx.fetch("/game/index.php?page=overview");
    expect(res.status).toBe(200);
  });
});
