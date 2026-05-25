import type { EventBus } from "../event_bus.js";
import type { StateRef } from "./attack_detector.js";

export interface EmergencySpyPayload {
  event_id: string;
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  to_type?: "planet" | "moon";
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
      // Operator clarification: "已发生不用报警, 正在发生报警".
      //   in-progress (arrives_at > now) → fire emergency.spy
      //   already arrived (arrives_at ≤ now) → don't alarm (info-only)
      // The remaining > 0 gate below is CORRECT for this semantic.
      // BUT log every scanned spy event (even skipped) so we can verify
      // observer caught the row and dedupe state.
      const remaining = ev.arrives_at - nowSec;
      if (seen.has(ev.id)) continue;
      if (remaining <= 0) {
        // Mark as seen so we don't keep re-logging on every state.updated.
        seen.add(ev.id);
        console.info(`[spy_detector] ${ev.id} ARRIVED ${-remaining}s ago — info-only, no alarm`);
        continue;
      }
      console.warn(`[spy_detector] ${ev.id} IN-PROGRESS (${remaining}s ETA) — firing emergency.spy`);
      seen.add(ev.id);
      const payload: EmergencySpyPayload = {
        event_id: ev.id,
        from: ev.from,
        to: ev.to,
        ...(ev.to_type !== undefined ? { to_type: ev.to_type } : {}),
        arrives_at: ev.arrives_at,
        detected_at: nowSec,
      };
      bus.emit("emergency.spy", payload);
    }
  };
  return bus.on("state.updated", handler);
}
