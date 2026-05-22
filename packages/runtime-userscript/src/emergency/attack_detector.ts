import type { EventBus } from "../event_bus.js";
import type { WorldState } from "@ogamex/shared";

export interface AttackDetectorOptions {
  saveWindowMinutes: number;
}

export interface StateRef {
  current: WorldState;
}

export interface EmergencyAttackPayload {
  event_id: string;
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  arrives_at: number;        // unix seconds
  ships_count: number | "?";
  detected_at: number;       // unix seconds
}

/**
 * Subscribes to `state.updated` events. On each tick, scans events_incoming for
 * hostile events whose remaining arrival time is within [1s, saveWindowMinutes*60].
 * Emits `emergency.attack` once per event id (deduped across subsequent ticks).
 *
 * Returns a disposer that removes the bus subscription.
 */
export function startAttackDetector(
  bus: EventBus,
  ref: StateRef,
  opts: AttackDetectorOptions,
): () => void {
  const seen = new Set<string>();
  const handler = () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = opts.saveWindowMinutes * 60;
    for (const ev of ref.current.events_incoming) {
      if (!ev.hostile) continue;
      // Spy probes are surfaced via spy_detector → emergency.spy. Without
      // this gate, attack_detector ALSO fired emergency.attack for them
      // (operator's sidecar journal showed both subtypes for one evrow-N id).
      if (ev.type === "spy") continue;
      if (seen.has(ev.id)) continue;
      const remaining = ev.arrives_at - nowSec;
      if (remaining <= 0 || remaining > windowSec) continue;
      seen.add(ev.id);
      const payload: EmergencyAttackPayload = {
        event_id: ev.id,
        from: ev.from,
        to: ev.to,
        arrives_at: ev.arrives_at,
        ships_count: ev.ships_count,
        detected_at: nowSec,
      };
      bus.emit("emergency.attack", payload);
    }
  };
  return bus.on("state.updated", handler);
}
