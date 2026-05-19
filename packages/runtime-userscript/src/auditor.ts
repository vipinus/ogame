import type { Planet, WorldState } from "@ogamex/shared";
import type { EventBus, Handler } from "./event_bus.js";
import type { StateStore } from "./state_store.js";

/**
 * M6.5 Auditor
 * --------------------------------------------------------------------
 * Subscribes to bus events + StateStore, runs hard-coded rule functions
 * against the live world state, and emits `audit.condition_unmet` with
 * an `AuditEvidence` payload whenever a threshold is violated.
 *
 * Thresholds come from `Strategy.audit_rules_thresholds` (a flat
 * `Record<string, number>` map) and may be hot-updated via
 * `setThresholds()` without restarting the auditor.
 *
 * Rules implemented in M6.5:
 *  1. resource_overflow       — any planet has resources[r] / storage[r_max]
 *                                 above `resource_overflow_pct` (0-100).
 *  2. fleet_slot_starvation   — fleets_outbound utilisation above
 *                                 `fleet_slot_starvation_pct` (0-100).
 *                                 Requires `player.fleet_slots_max` — if
 *                                 absent the rule is silently skipped.
 *                                 (M6.5 smoke will add the field.)
 *  3. build_queue_empty       — planet.build_q === null and the planet has
 *                                 been idle longer than
 *                                 `build_queue_idle_minutes_max` (minutes).
 *                                 Idle time is approximated via
 *                                 `state.last_update`; M6.7 smoke refines.
 *
 * For any rule whose threshold is missing from the supplied map the rule
 * is skipped silently.
 *
 * The auditor debounces `state.updated` floods: rules run at most once per
 * 1000 ms (timestamp-gated, no setTimeout — avoids leaking timers in tests
 * and headless runs). `runAll()` bypasses the debounce.
 */

export interface AuditorDeps {
  bus: EventBus;
  store: StateStore;
  /** Thresholds from Strategy.audit_rules_thresholds. Live-updated via setThresholds(). */
  initialThresholds: Record<string, number>;
}

export interface AuditEvidence {
  rule_id: string;
  threshold: number;
  observed: number;
  details: Record<string, unknown>;
  ts: number;
}

export interface AuditorHandle {
  /** Live-update thresholds without restart. */
  setThresholds(t: Record<string, number>): void;
  /** Force run all rules now (used by tests + heartbeat tick). */
  runAll(): AuditEvidence[];
  stop(): void;
  /** Test-only: snapshot of the internal log buffer. */
  _log(): readonly AuditEvidence[];
}

const DEBOUNCE_MS = 1000;
const LOG_CAP = 100;

type Rule = (state: WorldState, thresholds: Record<string, number>) => AuditEvidence[];

// ---------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------

const RESOURCE_KEYS: ReadonlyArray<{ res: "m" | "c" | "d"; cap: "m_max" | "c_max" | "d_max" }> = [
  { res: "m", cap: "m_max" },
  { res: "c", cap: "c_max" },
  { res: "d", cap: "d_max" },
];

function ruleResourceOverflow(state: WorldState, thresholds: Record<string, number>): AuditEvidence[] {
  const pct = thresholds["resource_overflow_pct"];
  if (typeof pct !== "number") return [];
  const out: AuditEvidence[] = [];
  const ts = Date.now();
  for (const planet of state.planets) {
    for (const { res, cap } of RESOURCE_KEYS) {
      const value = planet.resources[res];
      const max = planet.storage[cap];
      if (max <= 0) continue;
      const ratio = (value / max) * 100;
      if (ratio > pct) {
        out.push({
          rule_id: "resource_overflow",
          threshold: pct,
          observed: ratio,
          details: { planet_id: planet.id, resource: res, ratio },
          ts,
        });
      }
    }
  }
  return out;
}

function ruleFleetSlotStarvation(state: WorldState, thresholds: Record<string, number>): AuditEvidence[] {
  const pct = thresholds["fleet_slot_starvation_pct"];
  if (typeof pct !== "number") return [];
  // `fleet_slots_max` is not yet in the shared Player type — M6.5 smoke
  // will add it. Treat its absence as "skip rule silently".
  const player = state.player as { fleet_slots_max?: number };
  const max = player.fleet_slots_max;
  if (typeof max !== "number" || max <= 0) return [];
  const used = state.fleets_outbound.length;
  const ratio = (used / max) * 100;
  if (ratio <= pct) return [];
  return [
    {
      rule_id: "fleet_slot_starvation",
      threshold: pct,
      observed: ratio,
      details: { used, max, ratio },
      ts: Date.now(),
    },
  ];
}

function ruleBuildQueueEmpty(state: WorldState, thresholds: Record<string, number>): AuditEvidence[] {
  const idleMinutes = thresholds["build_queue_idle_minutes_max"];
  if (typeof idleMinutes !== "number") return [];
  const now = Date.now();
  const idleMs = idleMinutes * 60 * 1000;
  // Approximation: use state.last_update as a proxy for "last activity".
  // M6.7 smoke refines per-planet tracking.
  const idleObserved = state.last_update > 0 ? now - state.last_update : 0;
  if (idleObserved < idleMs) return [];
  const out: AuditEvidence[] = [];
  const ts = now;
  for (const planet of state.planets) {
    if (planet.build_q === null) {
      out.push({
        rule_id: "build_queue_empty",
        threshold: idleMinutes,
        observed: idleObserved / 60000,
        details: { planet_id: planet.id, idle_ms: idleObserved },
        ts,
      });
    }
  }
  return out;
}

const RULES: ReadonlyArray<Rule> = [
  ruleResourceOverflow,
  ruleFleetSlotStarvation,
  ruleBuildQueueEmpty,
];

// ---------------------------------------------------------------------
// Auditor
// ---------------------------------------------------------------------

export function startAuditor(deps: AuditorDeps): AuditorHandle {
  const { bus, store } = deps;
  let thresholds: Record<string, number> = { ...deps.initialThresholds };
  let lastRunAt = 0;
  const log: AuditEvidence[] = [];
  let stopped = false;

  const runRules = (): AuditEvidence[] => {
    const state = store.state;
    const out: AuditEvidence[] = [];
    for (const rule of RULES) {
      try {
        const evs = rule(state, thresholds);
        for (const ev of evs) out.push(ev);
      } catch (e) {
        // Rule errors must not crash the auditor.
        console.error("[Auditor] rule error", e);
      }
    }
    for (const ev of out) {
      log.push(ev);
      if (log.length > LOG_CAP) log.shift();
      bus.emit("audit.condition_unmet", ev);
    }
    lastRunAt = Date.now();
    return out;
  };

  const onStateUpdated: Handler = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastRunAt < DEBOUNCE_MS) return;
    runRules();
  };

  const off = bus.on("state.updated", onStateUpdated);

  return {
    setThresholds(t: Record<string, number>): void {
      thresholds = { ...t };
    },
    runAll(): AuditEvidence[] {
      return runRules();
    },
    stop(): void {
      stopped = true;
      off();
    },
    _log(): readonly AuditEvidence[] {
      return log.slice();
    },
  };
}
