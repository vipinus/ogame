import { describe, it, expect, vi } from "vitest";
import { sendFleet, recallFleet } from "../../src/api/fleet_api.js";
import { TokenManager } from "../../src/api/token_manager.js";
import { Mission } from "@ogamex/shared";

describe("sendFleet", () => {
  it("POSTs URL-encoded with token + ship counts + cargo; rotates token from newAjaxToken on success", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, fleetIdToReturn: 42, newAjaxToken: "tok-X-NEW" }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const tm = new TokenManager(() => "tok-X");
    const setSpy = vi.spyOn(tm, "set");

    const result = await sendFleet(
      { ships: { smallCargo: 50, recycler: 1 }, cargo: { m: 1000, c: 0, d: 500 },
        coords: [1, 42, 8], destType: 3, mission: Mission.TRANSPORT, speed: 10 },
      { fetch: fetchMock as any, token: tm }
    );

    expect(result.fleetId).toBe(42);
    expect(setSpy).toHaveBeenCalledWith("tok-X-NEW");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain("action=sendFleet");
    expect(url).toContain("ajax=1");
    expect(url).toContain("asJson=1");
    expect((opts as any).method).toBe("POST");
    const body = new URLSearchParams((opts as any).body);
    expect(body.get("token")).toBe("tok-X");
    expect(body.get("galaxy")).toBe("1");
    expect(body.get("system")).toBe("42");
    expect(body.get("position")).toBe("8");
    expect(body.get("type")).toBe("3");
    expect(body.get("mission")).toBe("3");
    expect(body.get("speed")).toBe("10");
    expect(body.get("am202")).toBe("50");      // smallCargo
    expect(body.get("am209")).toBe("1");       // recycler
    expect(body.get("metal")).toBe("1000");
    expect(body.get("deuterium")).toBe("500");
  });

  it("invalidates token + retries once on 'token expired' response", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(
        JSON.stringify({ success: false, message: "Invalid token" }), { status: 200 });
      return new Response(JSON.stringify({ success: true, fleetIdToReturn: 100 }), { status: 200 });
    });
    const tm = new TokenManager(() => `t${call}`);
    const result = await sendFleet(
      { ships: { smallCargo: 1, recycler: 1 }, cargo: { m: 0, c: 0, d: 0 },
        coords: [1, 1, 1], destType: 1, mission: 8, speed: 1 },
      { fetch: fetchMock as any, token: tm }
    );
    expect(result.fleetId).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws FleetApiError on persistent failure", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: false, message: "Not enough deuterium" }), { status: 200 }));
    const tm = new TokenManager(() => "t1");
    await expect(sendFleet(
      { ships: { smallCargo: 1, recycler: 1 }, cargo: { m: 0, c: 0, d: 0 },
        coords: [1, 1, 1], destType: 1, mission: 8, speed: 1 },
      { fetch: fetchMock as any, token: tm }
    )).rejects.toThrow(/Not enough deuterium/);
  });
});

describe("recallFleet", () => {
  it("POSTs fleetId=<id> + token; updates TokenManager with newAjaxToken from response", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, newAjaxToken: "tok-Z-NEW" }), { status: 200 }));
    const tm = new TokenManager(() => "tok-Z");
    const setSpy = vi.spyOn(tm, "set");
    await recallFleet(42, { fetch: fetchMock as any, token: tm });
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain("component=movement");
    expect(url).toContain("action=recallFleetAjax");
    expect(url).toContain("asJson=1");
    const body = new URLSearchParams((opts as any).body);
    expect(body.get("fleetId")).toBe("42");
    expect(body.get("token")).toBe("tok-Z");
    expect(setSpy).toHaveBeenCalledWith("tok-Z-NEW");
  });

  it("invalidates token + retries once on invalid-token response", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(
        JSON.stringify({ success: false, message: "Invalid token" }), { status: 200 });
      return new Response(JSON.stringify({ success: true, newAjaxToken: "tok-NEW" }), { status: 200 });
    });
    const tm = new TokenManager(() => `t${call}`);
    await recallFleet(7, { fetch: fetchMock as any, token: tm });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
