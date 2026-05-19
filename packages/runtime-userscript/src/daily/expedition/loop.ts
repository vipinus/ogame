/**
 * Daily expedition orchestration loop (M3.7).
 *
 * Subscribes to bus events and a fallback timer to:
 *   1. Parse expedition reports into ExpeditionOutcome records on fleet return.
 *   2. Persist outcomes via ExpeditionStore.
 *   3. Emit `expedition_data_updated` so downstream stats consumers can react.
 *   4. Re-evaluate empty expedition slots and (if free) launch new ones via
 *      `fillExpeditionSlots`.
 *   5. Yield unconditionally to the emergency PriorityGate.
 *
 * NOTE — boot wiring is out of scope for M3.7. The loop is delivered as a
 * standalone subscribable component; M4+ wires `startDailyExpeditionLoop`
 * into the userscript main entrypoint after the WS bridge lands.
 */

import type { FleetMovement } from "@ogamex/shared";
import { Mission } from "@ogamex/shared";
import type { EventBus } from "../../event_bus.js";
import type { StateStore } from "../../state_store.js";
import type { ExpeditionStore } from "../../store/expedition_store.js";
import type { PriorityGate } from "../../emergency/priority_gate.js";
import type { SlotFillerActions } from "./slot_filler.js";
import { fillExpeditionSlots } from "./slot_filler.js";
import { parseExpeditionReport } from "../../probes/extractors/expedition_report.js";
import type { ExpeditionConfig } from "@ogamex/shared";

export interface DailyExpeditionLoopDeps {
  bus: EventBus;
  store: StateStore;
  expeditionStore: ExpeditionStore;
  gate: PriorityGate;
  config: () => ExpeditionConfig;
  send: SlotFillerActions["send"];
  randomSystem: SlotFillerActions["randomSystem"];
  /** Optional fallback interval. Default 5 minutes. Set 0 to disable for tests. */
  fallbackIntervalMs?: number;
}

export interface DailyExpeditionLoopHandle {
  /** Force a fillSlots cycle now (used by tests + initial boot pulse). */
  tick(): Promise<void>;
  stop(): void;
}

interface FleetReturnedPayload {
  fleet: FleetMovement;
  reportHtml?: string;
}

const DEFAULT_FALLBACK_MS = 5 * 60 * 1000;

export function startDailyExpeditionLoop(
  deps: DailyExpeditionLoopDeps,
): DailyExpeditionLoopHandle {
  const fallbackMs = deps.fallbackIntervalMs ?? DEFAULT_FALLBACK_MS;

  const tick = async (): Promise<void> => {
    if (deps.gate.isActive()) {
      return;
    }
    let outcomes;
    try {
      outcomes = await deps.expeditionStore.recent(100);
    } catch (e) {
      console.error("[daily/expedition/loop] failed to read recent outcomes", e);
      return;
    }
    const state = deps.store.state;
    try {
      const result = await fillExpeditionSlots(
        state,
        deps.config(),
        outcomes,
        { send: deps.send, randomSystem: deps.randomSystem },
        { gate: deps.gate },
      );
      console.debug(
        `[daily/expedition/loop] tick: launched=${result.launched}` +
          (result.reasons.length ? ` reasons=${result.reasons.join("; ")}` : ""),
      );
    } catch (e) {
      console.error("[daily/expedition/loop] fillExpeditionSlots threw", e);
    }
  };

  const onFleetReturned = async (payload: FleetReturnedPayload): Promise<void> => {
    const fleet = payload.fleet;
    if (fleet.mission !== Mission.EXPEDITION) return;
    if (!payload.reportHtml) {
      // Spec: skip silently for M3.7; the real WS flow lands in M4.
      console.debug(
        "[daily/expedition/loop] fleet_returned (expedition) without reportHtml — skipping parse",
      );
      return;
    }

    // M3.7 derives missing context with placeholders. Source planet is best-effort
    // matched by coords; otherwise "unknown". Template id and launched_at are not
    // available off the FleetMovement payload yet — M4 will plumb them through.
    const sourcePlanet = deps.store.state.planets.find(
      (p) =>
        p.coords[0] === fleet.origin[0] &&
        p.coords[1] === fleet.origin[1] &&
        p.coords[2] === fleet.origin[2],
    );
    const source_planet_id = sourcePlanet?.id ?? "unknown";
    console.debug(
      "[daily/expedition/loop] parsing expedition report with placeholder context " +
        "(template_id='unknown', launched_at=0) — to be hardened in M3.7 smoke / M4",
    );

    let outcome;
    try {
      outcome = parseExpeditionReport(payload.reportHtml, {
        expedition_id: fleet.id,
        source_planet_id,
        source_coords: fleet.origin,
        template_id: "unknown",
        fleet_sent: fleet.ships,
        launched_at: 0,
      });
    } catch (e) {
      console.error("[daily/expedition/loop] parseExpeditionReport failed", e);
      return;
    }

    try {
      await deps.expeditionStore.put(outcome);
    } catch (e) {
      console.error("[daily/expedition/loop] expeditionStore.put failed", e);
      return;
    }

    deps.bus.emit("expedition_data_updated", { expedition_id: outcome.expedition_id });
  };

  const onExpeditionDataUpdated = (): void => {
    void tick();
  };

  const offFleetReturned = deps.bus.on<FleetReturnedPayload>(
    "fleet_returned",
    onFleetReturned,
  );
  const offDataUpdated = deps.bus.on(
    "expedition_data_updated",
    onExpeditionDataUpdated,
  );

  let timer: ReturnType<typeof setInterval> | null = null;
  if (fallbackMs > 0) {
    timer = setInterval(() => {
      void tick();
    }, fallbackMs);
  }

  return {
    tick,
    stop(): void {
      offFleetReturned();
      offDataUpdated();
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
