// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startGoalRunner } from "../src/goal_runner.js";
import type { GoalRunnerDeps } from "../src/goal_runner.js";
import { PriorityGate } from "../src/emergency/priority_gate.js";
import type { DirectiveExecutor } from "../src/directive_executor_iface.js";
import type { BridgeClient } from "../src/bridge/ws_client.js";
import type { Directive, DownstreamMsg, UpstreamMsg } from "@ogamex/shared";

type DirectiveDispatch = Extract<DownstreamMsg, { type: "directive.dispatch" }>;
type DispatchHandler = (msg: DirectiveDispatch) => void;

// --- mock BridgeClient -------------------------------------------------------

interface MockBridgeClient {
  client: BridgeClient;
  emit: (directive: Directive) => void;
  sent: UpstreamMsg[];
  /** True if any handler is still registered for the given type. */
  hasHandler(type: string): boolean;
  onCalls: number;
}

function makeMockClient(): MockBridgeClient {
  const handlers = new Map<string, Set<(msg: unknown) => void>>();
  const sent: UpstreamMsg[] = [];
  let onCalls = 0;

  const client = {
    on(type: string, handler: (msg: unknown) => void): () => void {
      onCalls++;
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
        if (set && set.size === 0) handlers.delete(type);
      };
    },
    send(msg: UpstreamMsg): void {
      sent.push(msg);
    },
  } as unknown as BridgeClient;

  return {
    client,
    sent,
    emit(directive: Directive): void {
      const set = handlers.get("directive.dispatch");
      if (!set) return;
      const msg: DirectiveDispatch = { type: "directive.dispatch", directive };
      for (const h of set) (h as DispatchHandler)(msg);
    },
    hasHandler(type: string): boolean {
      const s = handlers.get(type);
      return !!s && s.size > 0;
    },
    get onCalls(): number {
      return onCalls;
    },
  };
}

// --- directive factory -------------------------------------------------------

function makeDirective(overrides: Partial<Directive> = {}): Directive {
  return {
    id: "d-1",
    source: "goal",
    method: "ui",
    priority: 50,
    action: "build_ship",
    params: { ship: "smallCargo", count: 10 },
    preconds: [],
    expires_at: Date.now() + 60_000,
    reason: "test",
    ...overrides,
  };
}

// --- executor mock helpers ---------------------------------------------------

function makeExecutor(opts: {
  canHandle?: boolean | ((d: Directive) => boolean);
  execute?: (d: Directive) => Promise<unknown>;
}): DirectiveExecutor & {
  canHandleMock: ReturnType<typeof vi.fn>;
  executeMock: ReturnType<typeof vi.fn>;
} {
  const canHandleVal = opts.canHandle ?? true;
  const canHandleMock = vi.fn((d: Directive) =>
    typeof canHandleVal === "function" ? canHandleVal(d) : canHandleVal,
  );
  const executeMock = vi.fn(
    opts.execute ?? ((_d: Directive) => Promise.resolve(undefined)),
  );
  return {
    canHandle: canHandleMock as unknown as DirectiveExecutor["canHandle"],
    execute: executeMock as unknown as DirectiveExecutor["execute"],
    canHandleMock,
    executeMock,
  };
}

// --- tests -------------------------------------------------------------------

describe("GoalRunner", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function setup(overrides: Partial<GoalRunnerDeps> = {}): {
    mock: MockBridgeClient;
    gate: PriorityGate;
    executors: ReturnType<typeof makeExecutor>[];
    handle: ReturnType<typeof startGoalRunner>;
  } {
    const mock = makeMockClient();
    const gate = overrides.gate ?? new PriorityGate();
    const executors =
      (overrides.executors as ReturnType<typeof makeExecutor>[] | undefined) ?? [
        makeExecutor({}),
      ];
    const handle = startGoalRunner({
      client: overrides.client ?? mock.client,
      gate,
      executors,
    });
    return { mock, gate, executors, handle };
  }

  it("validates directive shape — drops directive missing required fields", async () => {
    const { mock, executors, handle } = setup();
    // Cast to bypass the factory's type guard; emit a malformed object.
    const bad = { id: "d-bad", source: "goal", method: "ui", priority: 1 } as unknown as Directive;
    mock.emit(bad);
    // Let any microtasks settle.
    await Promise.resolve();
    expect(executors[0]!.executeMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    // No ack — validation failures are silent drops per spec.
    expect(mock.sent).toEqual([]);
    handle.stop();
  });

  it("acks expired directives with success:false, error:'expired' and skips execution", async () => {
    const { mock, executors, handle } = setup();
    const d = makeDirective({ id: "d-expired", expires_at: Date.now() - 1000 });
    mock.emit(d);
    await Promise.resolve();
    expect(executors[0]!.executeMock).not.toHaveBeenCalled();
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toEqual({
      type: "event.directive_completed",
      directive_id: "d-expired",
      result: { success: false, error: "expired" },
    });
    handle.stop();
  });

  it("routes to the first executor whose canHandle returns true", async () => {
    const first = makeExecutor({ canHandle: false });
    const second = makeExecutor({
      canHandle: true,
      execute: () => Promise.resolve({ ok: 1 }),
    });
    const { mock, handle } = setup({ executors: [first, second] });
    const d = makeDirective({ id: "d-route" });
    mock.emit(d);
    await Promise.resolve();
    await Promise.resolve();
    expect(first.executeMock).not.toHaveBeenCalled();
    expect(second.executeMock).toHaveBeenCalledTimes(1);
    expect(second.executeMock).toHaveBeenCalledWith(d);
    handle.stop();
  });

  it("acks with 'no executor' error when no executor canHandle the directive", async () => {
    const a = makeExecutor({ canHandle: false });
    const b = makeExecutor({ canHandle: false });
    const { mock, handle } = setup({ executors: [a, b] });
    const d = makeDirective({ id: "d-noexec", action: "unknown_action" });
    mock.emit(d);
    await Promise.resolve();
    expect(a.executeMock).not.toHaveBeenCalled();
    expect(b.executeMock).not.toHaveBeenCalled();
    expect(mock.sent).toHaveLength(1);
    const ack = mock.sent[0] as Extract<UpstreamMsg, { type: "event.directive_completed" }>;
    expect(ack.type).toBe("event.directive_completed");
    expect(ack.directive_id).toBe("d-noexec");
    const r = ack.result as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no executor/);
    expect(r.error).toContain("unknown_action");
    handle.stop();
  });

  it("acks success:true with result on successful execute", async () => {
    const exec = makeExecutor({
      canHandle: true,
      execute: () => Promise.resolve({ fleetId: 42 }),
    });
    const { mock, handle } = setup({ executors: [exec] });
    const d = makeDirective({ id: "d-ok" });
    mock.emit(d);
    // Two microtask drains: one for canHandle dispatch, one for executor's resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toEqual({
      type: "event.directive_completed",
      directive_id: "d-ok",
      result: { success: true, result: { fleetId: 42 } },
    });
    handle.stop();
  });

  it("acks success:false with error message when execute rejects", async () => {
    const exec = makeExecutor({
      canHandle: true,
      execute: () => Promise.reject(new Error("network")),
    });
    const { mock, handle } = setup({ executors: [exec] });
    const d = makeDirective({ id: "d-fail" });
    mock.emit(d);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toEqual({
      type: "event.directive_completed",
      directive_id: "d-fail",
      result: { success: false, error: "network" },
    });
    handle.stop();
  });

  it("queues directives while gate is active and drains in order when gate goes inactive", async () => {
    const order: string[] = [];
    const exec = makeExecutor({
      canHandle: true,
      execute: (d) => {
        order.push(d.id);
        return Promise.resolve(undefined);
      },
    });
    const gate = new PriorityGate();
    gate.setActive(true);
    const { mock, handle } = setup({ gate, executors: [exec] });
    const d1 = makeDirective({ id: "q-1" });
    const d2 = makeDirective({ id: "q-2" });
    mock.emit(d1);
    mock.emit(d2);
    await Promise.resolve();
    expect(exec.executeMock).not.toHaveBeenCalled();
    expect(handle.pendingCount()).toBe(2);
    // Transition back to inactive — drain.
    gate.setActive(false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(exec.executeMock).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["q-1", "q-2"]);
    expect(handle.pendingCount()).toBe(0);
    handle.stop();
  });

  it("stop() unsubscribes from client and gate so further emissions are ignored", async () => {
    const { mock, gate, executors, handle } = setup();
    handle.stop();
    // After stop: no client handler should remain.
    expect(mock.hasHandler("directive.dispatch")).toBe(false);
    // Emit anyway — nobody should listen.
    mock.emit(makeDirective({ id: "post-stop" }));
    await Promise.resolve();
    expect(executors[0]!.executeMock).not.toHaveBeenCalled();
    expect(mock.sent).toEqual([]);
    // Gate transitions should also be a no-op now (no exception, no execute).
    gate.setActive(true);
    gate.setActive(false);
    await Promise.resolve();
    expect(executors[0]!.executeMock).not.toHaveBeenCalled();
  });
});
