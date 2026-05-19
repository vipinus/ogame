import type { EventBus } from "../event_bus.js";

export interface StandaloneModeOptions {
  /** Bus to emit transitions on. Listeners can react via bus.on("standalone_mode.changed", (active:boolean)=>{...}). */
  bus: EventBus;
  /**
   * Poll interval (ms) for checking the source — i.e., how often we ask
   * `isBridgeConnected()`. Default 5000.
   */
  pollIntervalMs?: number;
  /**
   * How long the bridge must be reported disconnected before standalone activates. Default 60_000.
   */
  enterAfterDisconnectedMs?: number;
  /**
   * Optional clock injection for tests.
   */
  now?: () => number;
}

export interface StandaloneModeHandle {
  /** Current state. */
  isActive(): boolean;
  /** Manually force the state (e.g. tests, user override). */
  setActive(v: boolean, reason?: string): void;
  /** Stop polling. */
  stop(): void;
}

export interface StandaloneModeChangedEvent {
  active: boolean;
  reason: string;
}

const EVENT_TYPE = "standalone_mode.changed";

/**
 * Constructs a STANDALONE_MODE tracker.
 *
 * @param isBridgeConnected — caller-supplied. Should return true if the
 *   bridge is currently in a healthy connected state. Polled at pollIntervalMs.
 *   In production: `() => bridgeClient.status() === "open"`.
 */
export function startStandaloneMode(
  isBridgeConnected: () => boolean,
  opts: StandaloneModeOptions,
): StandaloneModeHandle {
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const enterAfterDisconnectedMs = opts.enterAfterDisconnectedMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const bus = opts.bus;

  let active = false;
  let disconnectedSince: number | null = null;
  let lastBusEmit: boolean | null = null;
  let stopped = false;

  const emitChange = (next: boolean, reason: string): void => {
    if (lastBusEmit === next) return;
    lastBusEmit = next;
    const payload: StandaloneModeChangedEvent = { active: next, reason };
    bus.emit<StandaloneModeChangedEvent>(EVENT_TYPE, payload);
  };

  const tick = (): void => {
    if (stopped) return;
    const connected = isBridgeConnected();
    if (connected) {
      disconnectedSince = null;
      if (active) {
        active = false;
        emitChange(false, "bridge reconnected");
      }
      return;
    }
    // Not connected.
    if (disconnectedSince === null) {
      disconnectedSince = now();
      return;
    }
    if (
      now() - disconnectedSince >= enterAfterDisconnectedMs &&
      !active
    ) {
      active = true;
      emitChange(
        true,
        `bridge disconnected > ${enterAfterDisconnectedMs}ms`,
      );
    }
  };

  const interval: ReturnType<typeof setInterval> = setInterval(
    tick,
    pollIntervalMs,
  );

  return {
    isActive(): boolean {
      return active;
    },
    setActive(v: boolean, reason?: string): void {
      if (active === v) return;
      active = v;
      if (v) {
        // Manual activation: clear disconnect tracking so reconnect logic
        // re-evaluates cleanly from current state.
        disconnectedSince = null;
      } else {
        disconnectedSince = null;
      }
      emitChange(v, reason ?? (v ? "forced active" : "forced inactive"));
    },
    stop(): void {
      stopped = true;
      clearInterval(interval);
    },
  };
}
