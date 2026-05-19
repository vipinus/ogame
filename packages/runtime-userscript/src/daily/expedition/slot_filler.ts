import type {
  ExpeditionConfig,
  ExpeditionOutcome,
  WorldState,
} from "@ogamex/shared";
import { expeditionSlots, Mission, DestType } from "@ogamex/shared";
import type { SendFleetParams } from "../../api/fleet_api.js";
import { PriorityGate } from "../../emergency/priority_gate.js";
import { pickGalaxy } from "./galaxy_picker.js";
import { pickTemplate, type TemplatePickStats } from "./template_picker.js";
import { avgResourceYield, blackHoleRate, lossRate } from "./stats.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SlotFillerActions {
  send: (p: SendFleetParams) => Promise<{ fleetId: number }>;
  randomSystem: (galaxy: number) => number;
}

export interface SlotFillerResult {
  launched: number;
  /** One string per non-launch decision, for debugging/audit. */
  reasons: string[];
}

export interface SlotFillerOptions {
  gate: PriorityGate;
}

function holdingTimeFor(duration: ExpeditionConfig["duration"]): number {
  switch (duration) {
    case "short":
      return 1;
    case "medium":
      return 4;
    case "long":
      return 8;
  }
}

/**
 * Fills available expedition slots by combining galaxy_picker + template_picker
 * + Fleet API.
 *
 * Yields to the emergency gate: if `opts.gate.isActive()` is true, returns
 * immediately with `launched: 0` and makes no API calls.
 *
 * Slot accounting is computed from authoritative state (no trust in cached
 * counters): `freeSlots = max(0, expeditionSlots(astro) - inFlightExpeditions)`.
 *
 * On send failure the loop stops (rather than burning through remaining slots
 * with the same error). Subsequent ticks will retry.
 */
export async function fillExpeditionSlots(
  state: WorldState,
  config: ExpeditionConfig,
  outcomes: ExpeditionOutcome[],
  actions: SlotFillerActions,
  opts: SlotFillerOptions,
): Promise<SlotFillerResult> {
  const reasons: string[] = [];

  // 1. Emergency gate yields BEFORE any work.
  if (opts.gate.isActive()) {
    return { launched: 0, reasons: ["emergency gate active"] };
  }

  // 2. Feature flag.
  if (!config.enabled || !config.auto_fill_slots) {
    return { launched: 0, reasons: ["disabled in config"] };
  }

  // 3. Slot accounting (compute, don't trust cached state alone).
  const astro = state.research.levels["astrophysics"] ?? 0;
  const maxSlots = expeditionSlots(astro);
  const inFlight = state.fleets_outbound.filter(
    (f) => f.mission === Mission.EXPEDITION,
  ).length;
  const freeSlots = Math.max(0, maxSlots - inFlight);
  if (freeSlots === 0) {
    return { launched: 0, reasons: ["no free slots"] };
  }

  // 4. Source planet must exist.
  const sourcePlanet = state.planets.find((p) => p.id === config.source_planet);
  if (sourcePlanet === undefined) {
    return { launched: 0, reasons: ["source planet not found"] };
  }

  // 5. Stats for template picker (24h window).
  // `returned_at` is a millisecond epoch (Date.now()) — see expedition_report.ts.
  const cutoff = Date.now() - DAY_MS;
  const recent = outcomes.filter((o) => o.returned_at >= cutoff);
  const stats: TemplatePickStats = {
    black_hole_rate_24h: blackHoleRate(recent),
    loss_rate_24h: lossRate(recent),
    avg_yield_24h: avgResourceYield(recent),
  };

  // 6. Fill loop.
  let launched = 0;
  for (let i = 0; i < freeSlots; i++) {
    const galaxy = pickGalaxy({ state, recentOutcomes: outcomes, config });
    const picked = pickTemplate({ templates: config.fleet_templates, stats });
    const system = actions.randomSystem(galaxy);
    const params: SendFleetParams = {
      ships: picked.template.fleet,
      cargo: { m: 0, c: 0, d: 0 },
      coords: [galaxy, system, config.target_position],
      destType: DestType.planet,
      mission: Mission.EXPEDITION,
      speed: 10,
      holdingTime: holdingTimeFor(config.duration),
    };
    try {
      const result = await actions.send(params);
      launched++;
      reasons.push(
        `launched expedition ${result.fleetId} via template ${picked.id}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reasons.push(`failed: ${msg}`);
      // Stop the loop — don't burn through remaining slots with the same error.
      break;
    }
  }

  return { launched, reasons };
}
