import type { EventBus } from "../event_bus.js";
import type { StateRef } from "./attack_detector.js";

export interface EmergencySpyPayload {
  event_id: string;
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  arrives_at: number;
  detected_at: number;
}

/**
 * Subscribes to `state.updated` events. Detects incoming espionage probes
 * (mission type 6 in ogame). Spy is informational only — no fleet save can
 * outrun a probe — but we surface it so the operator gets a Discord ping
 * and can manually defend / counter-spy.
 *
 * Emits `emergency.spy` once per event id.
 */
export function startSpyDetector(bus: EventBus, ref: StateRef): () => void {
  const seen = new Set<string>();
  const handler = (): void => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const ev of ref.current.events_incoming) {
      if (ev.type !== "spy") continue;
      if (seen.has(ev.id)) continue;
      const remaining = ev.arrives_at - nowSec;
      if (remaining <= 0) continue;
      seen.add(ev.id);
      const payload: EmergencySpyPayload = {
        event_id: ev.id,
        from: ev.from,
        to: ev.to,
        arrives_at: ev.arrives_at,
        detected_at: nowSec,
      };
      bus.emit("emergency.spy", payload);
    }
  };
  return bus.on("state.updated", handler);
}
