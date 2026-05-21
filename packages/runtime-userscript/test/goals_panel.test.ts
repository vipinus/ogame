// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startGoalsPanel, type GoalRowFromHttp } from "../src/overlay/goals_panel.js";

const BASE = "http://test.local";
const URL_LIST = `${BASE}/ogamex/v1/goals`;

function mkGoal(o: Partial<GoalRowFromHttp> & Pick<GoalRowFromHttp, "id">): GoalRowFromHttp {
  return {
    type: "research", target: { tech: "energyTech", level: 1 },
    priority: 5, status: "active", created_at: 0, updated_at: 0,
    ...o,
  };
}

function fakeFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    // Auto-stub the side-section endpoints so tests focused on goals don't
    // have to special-case them. Test caller can still override by handling
    // these URLs explicitly in the impl.
    if (url.endsWith("/ogamex/v1/emergency")) {
      const r = impl(url, init);
      // If caller returned a non-204 response with content-type json AND
      // status<400, trust caller. Otherwise default to empty payload.
      return Promise.resolve(r).then((resp) => resp.ok ? resp : new Response(JSON.stringify({ hostile: [], count: 0, snapshot_age_ms: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (url.endsWith("/ogamex/v1/expedition")) {
      const r = impl(url, init);
      return Promise.resolve(r).then((resp) => resp.ok ? resp : new Response(JSON.stringify({ active: [], used: 0, max: 0, astrophysics_level: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(impl(url, init));
  };
}

function makeResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Flush enough microtasks/macrotasks for: initial auto-refresh (fetch → json
 * → render) PLUS any handle-driven refresh chain to fully settle. Two macrotask
 * ticks is enough — first lets the auto-fetch promise resolve, second runs the
 * render. We also have an extra tick to absorb click → fetch → refresh chains.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("startGoalsPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one row per non-terminal goal after first poll", async () => {
    const goals = [
      mkGoal({ id: "g-active", status: "active", priority: 7 }),
      mkGoal({ id: "g-pending", status: "pending", priority: 3 }),
      mkGoal({ id: "g-done", status: "completed" }),  // filtered out
      mkGoal({ id: "g-cancel", status: "cancelled" }), // filtered out
    ];
    const handle = startGoalsPanel({
      httpBaseUrl: BASE, pollMs: 99999, doc: document,
      fetch: fakeFetch((url) => {
        expect(url).toBe(URL_LIST);
        return makeResp({ goals });
      }),
    });

    await settle();

    const panel = document.getElementById("ogamex-goals-panel")!;
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain("research"); // goal type visible
    expect(panel.textContent).toContain("active");
    expect(panel.textContent).toContain("pending");
    expect(panel.textContent).toContain("2 active"); // 2 non-terminal goals
    // Terminal statuses filtered out by default
    expect(panel.querySelectorAll("[data-action-cancel]")).toHaveLength(2);

    handle.stop();
    expect(document.getElementById("ogamex-goals-panel")).toBeNull();
  });

  it("shows 'paused' label and Resume button for PAUSED rows", async () => {
    const goals = [
      mkGoal({ id: "g-paused", status: "blocked", reason: "PAUSED: by operator" }),
    ];
    const handle = startGoalsPanel({
      httpBaseUrl: BASE, pollMs: 99999, doc: document,
      fetch: fakeFetch(() => makeResp({ goals })),
    });

    await settle();
    const panel = document.getElementById("ogamex-goals-panel")!;
    expect(panel.textContent).toContain("paused");
    expect(panel.querySelector("[data-action-resume]")).toBeTruthy();
    expect(panel.querySelector("[data-action-pause]")).toBeNull();
    handle.stop();
  });

  it("active goal shows Pause + Cancel; blocked-non-paused shows Pause + Cancel too", async () => {
    const goals = [
      mkGoal({ id: "g1", status: "active" }),
      mkGoal({ id: "g2", status: "blocked", reason: "need crystal mine 10" }),
    ];
    const handle = startGoalsPanel({
      httpBaseUrl: BASE, pollMs: 99999, doc: document,
      fetch: fakeFetch(() => makeResp({ goals })),
    });
    await settle();
    const panel = document.getElementById("ogamex-goals-panel")!;
    expect(panel.querySelectorAll("[data-action-pause]")).toHaveLength(2);
    expect(panel.querySelectorAll("[data-action-cancel]")).toHaveLength(2);
    expect(panel.querySelectorAll("[data-action-resume]")).toHaveLength(0);
    handle.stop();
  });

  it("cancel button POSTs to /cancel and triggers refresh", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    let nthList = 0;
    const handle = startGoalsPanel({
      httpBaseUrl: BASE, pollMs: 99999, doc: document,
      fetch: fakeFetch((url, init) => {
        requests.push({ url, method: init?.method });
        if (url === URL_LIST) {
          nthList += 1;
          // First poll → row exists; second poll (after cancel) → empty list.
          return makeResp({ goals: nthList === 1 ? [mkGoal({ id: "g-x", status: "active" })] : [] });
        }
        if (url.endsWith("/cancel")) return makeResp({ ok: true });
        return makeResp({ error: "?" }, 404);
      }),
    });

    await settle();
    const btn = document.querySelector<HTMLElement>("[data-action-cancel]")!;
    expect(btn).toBeTruthy();
    btn.click();
    await settle();

    expect(requests.some((r) => r.url === `${BASE}/ogamex/v1/goals/g-x/cancel` && r.method === "POST")).toBe(true);
    // Empty-state UI should show after refresh.
    expect(document.getElementById("ogamex-goals-panel")?.textContent).toContain("no active goals");
    handle.stop();
  });

  it("pause and resume buttons POST to the correct endpoints", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    let phase: "active" | "paused" = "active";
    const handle = startGoalsPanel({
      httpBaseUrl: BASE, pollMs: 99999, doc: document,
      fetch: fakeFetch((url, init) => {
        requests.push({ url, method: init?.method });
        if (url === URL_LIST) {
          return makeResp({
            goals: [phase === "active"
              ? mkGoal({ id: "g-p", status: "active" })
              : mkGoal({ id: "g-p", status: "blocked", reason: "PAUSED: by operator" })],
          });
        }
        if (url.endsWith("/pause")) { phase = "paused"; return makeResp({ ok: true }); }
        if (url.endsWith("/resume")) { phase = "active"; return makeResp({ ok: true }); }
        return makeResp({}, 404);
      }),
    });

    await settle();
    document.querySelector<HTMLElement>("[data-action-pause]")!.click();
    await settle();
    expect(requests.find((r) => r.url.endsWith("/g-p/pause"))?.method).toBe("POST");

    // After pause + refresh, a Resume button should be present.
    const resumeBtn = document.querySelector<HTMLElement>("[data-action-resume]");
    expect(resumeBtn).toBeTruthy();
    resumeBtn!.click();
    await settle();
    expect(requests.find((r) => r.url.endsWith("/g-p/resume"))?.method).toBe("POST");

    handle.stop();
  });

  it("shows error message in header when GET /goals fails", async () => {
    const handle = startGoalsPanel({
      httpBaseUrl: BASE, pollMs: 99999, doc: document,
      fetch: fakeFetch(() => new Response("server down", { status: 500 })),
    });
    await settle();
    expect(document.getElementById("ogamex-goals-panel")?.textContent).toContain("http 500");
    handle.stop();
  });

  it("close button removes panel and stops polling", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(makeResp({ goals: [] })));
    const handle = startGoalsPanel({
      httpBaseUrl: BASE, pollMs: 99999, doc: document, fetch: fetchSpy,
    });
    await settle();
    const closeBtn = document.querySelector<HTMLElement>("[data-action=\"close\"]")!;
    closeBtn.click();
    expect(document.getElementById("ogamex-goals-panel")).toBeNull();
    handle.stop(); // idempotent
  });
});
