import type { ExpeditionOutcome, WorldState } from "@ogamex/shared";
import type { EventBus, Handler } from "./event_bus.js";
import type { StateStore } from "./state_store.js";
import { blackHoleRate, lossRate } from "./daily/expedition/stats.js";

/**
 * M8.3 + M8.4 Auditor (expanded from M6.5)
 * --------------------------------------------------------------------
 * Subscribes to bus events + StateStore, runs hard-coded rule functions
 * against the live world state, and emits `audit.condition_unmet` with
 * an `AuditEvidence` payload whenever a threshold is violated.
 *
 * Thresholds come from `Strategy.audit_rules_thresholds` (a flat
 * `Record<string, number>` map) and may be hot-updated via
 * `setThresholds()` without restarting the auditor.
 *
 * Rules (10 total):
 *  M6.5 (general):
 *    1. resource_overflow
 *    2. fleet_slot_starvation
 *    3. build_queue_empty
 *  M8.3 (general):
 *    4. fleet_save_coverage_24h     — saved/attack ratio (24h window).
 *    5. queue_filler_efficiency     — fraction of planets with non-null
 *                                     build_q averaged over the last 12
 *                                     sample snapshots.
 *    6. research_progress_rate      — research completions / day.
 *    7. directive_failure_rate      — failed directives / total (24h).
 *  M8.3 (expedition):
 *    8. expedition_loss_rate_50     — lossRate over last 50 outcomes.
 *    9. expedition_black_hole_rate_high — blackHoleRate over last 50.
 *  M8.3 (defense):
 *   10. defense_minimum_breach      — per (planet, ship) minimum breach
 *                                     against `defenseKeepMinimum` map.
 *
 * For any rule whose threshold is missing from the supplied map the rule
 * is skipped silently.
 *
 * The auditor debounces `state.updated` floods: rules run at most once per
 * 1000 ms (timestamp-gated). `runAll()` bypasses the debounce.
 *
 * `runAll()` is async because expedition rules await `getRecentExpeditions`.
 */

export interface AuditorDeps {
  bus: EventBus;
  store: StateStore;
  /** Thresholds from Strategy.audit_rules_thresholds. Live-updated via setThresholds(). */
  initialThresholds: Record<string, number>;
  /** Optional — for expedition rules. Returns recent ExpeditionOutcomes (most recent last or first; we use last 50 in input order). */
  getRecentExpeditions?: () => Promise<ExpeditionOutcome[]>;
  /** Optional — for defense_minimum_breach. */
  defenseKeepMinimum?: Record<string, number>;
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
  /** Live-update defense keep_minimum map without restart. */
  setKeepMinimum(m: Record<string, number>): void;
  /** Force run all rules now. Returns evidences from rules that fired. */
  runAll(): Promise<AuditEvidence[]>;
  stop(): void;
  /** Test-only: snapshot of the internal log buffer. */
  _log(): readonly AuditEvidence[];
}

const DEBOUNCE_MS = 1000;
const LOG_CAP = 100;
const TRACK_LOG_CAP = 200;
const SAMPLE_BUFFER_MAX = 12;
const SAMPLE_BUFFER_MIN_FOR_FIRE = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Rules — pure functions over state + thresholds + extras
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
  for (const planet of Object.values(state.planets ?? {})) {
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
  const idleObserved = state.last_update > 0 ? now - state.last_update : 0;
  if (idleObserved < idleMs) return [];
  const out: AuditEvidence[] = [];
  const ts = now;
  for (const planet of Object.values(state.planets ?? {})) {
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

// --- M8.3 rules below ---

interface AttackLogEntry { ts: number; saved: boolean; event_id: string }
interface ResearchLogEntry { ts: number; tech: string; level: number }
interface DirectiveLogEntry { ts: number; success: boolean }

function pruneOld<T extends { ts: number }>(buf: T[], now: number, maxAgeMs: number): void {
  // Drop entries older than maxAgeMs in-place.
  while (buf.length > 0 && buf[0]!.ts < now - maxAgeMs) buf.shift();
}

function ruleFleetSaveCoverage(
  thresholds: Record<string, number>,
  attackLog: AttackLogEntry[],
): AuditEvidence[] {
  const min = thresholds["fleet_save_coverage_24h"];
  if (typeof min !== "number") return [];
  const now = Date.now();
  pruneOld(attackLog, now, DAY_MS);
  const total = attackLog.length;
  if (total < 3) return [];
  let saved = 0;
  for (const a of attackLog) if (a.saved) saved++;
  const coverage = saved / total;
  if (coverage >= min) return [];
  return [
    {
      rule_id: "fleet_save_coverage_24h",
      threshold: min,
      observed: coverage,
      details: { saved, total },
      ts: now,
    },
  ];
}

function ruleQueueFillerEfficiency(
  thresholds: Record<string, number>,
  fillSamples: number[],
): AuditEvidence[] {
  const min = thresholds["queue_filler_efficiency"];
  if (typeof min !== "number") return [];
  if (fillSamples.length < SAMPLE_BUFFER_MIN_FOR_FIRE) return [];
  // Use the most recent SAMPLE_BUFFER_MIN_FOR_FIRE samples; require ALL below threshold.
  const recent = fillSamples.slice(-SAMPLE_BUFFER_MIN_FOR_FIRE);
  for (const v of recent) {
    if (v >= min) return [];
  }
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return [
    {
      rule_id: "queue_filler_efficiency",
      threshold: min,
      observed: avg,
      details: { samples: recent, samples_total: fillSamples.length },
      ts: Date.now(),
    },
  ];
}

function ruleResearchProgressRate(
  thresholds: Record<string, number>,
  researchLog: ResearchLogEntry[],
): AuditEvidence[] {
  const min = thresholds["research_progress_rate"];
  if (typeof min !== "number") return [];
  const now = Date.now();
  pruneOld(researchLog, now, DAY_MS);
  const completionsPerDay = researchLog.length; // window = 24h, so count == per-day rate
  if (completionsPerDay >= min) return [];
  return [
    {
      rule_id: "research_progress_rate",
      threshold: min,
      observed: completionsPerDay,
      details: { completions_24h: completionsPerDay },
      ts: now,
    },
  ];
}

function ruleDirectiveFailureRate(
  thresholds: Record<string, number>,
  directiveLog: DirectiveLogEntry[],
): AuditEvidence[] {
  const max = thresholds["directive_failure_rate"];
  if (typeof max !== "number") return [];
  const now = Date.now();
  pruneOld(directiveLog, now, DAY_MS);
  const total = directiveLog.length;
  if (total < 5) return [];
  let failed = 0;
  for (const d of directiveLog) if (!d.success) failed++;
  const rate = failed / total;
  if (rate <= max) return [];
  return [
    {
      rule_id: "directive_failure_rate",
      threshold: max,
      observed: rate,
      details: { failed, total },
      ts: now,
    },
  ];
}

function ruleExpeditionLossRate(
  thresholds: Record<string, number>,
  recent: ExpeditionOutcome[],
): AuditEvidence[] {
  const max = thresholds["expedition_loss_rate_50"];
  if (typeof max !== "number") return [];
  const last50 = recent.slice(-50);
  if (last50.length < 10) return [];
  const observed = lossRate(last50);
  if (observed <= max) return [];
  return [
    {
      rule_id: "expedition_loss_rate_50",
      threshold: max,
      observed,
      details: { sample_size: last50.length },
      ts: Date.now(),
    },
  ];
}

function ruleExpeditionBlackHoleRateHigh(
  thresholds: Record<string, number>,
  recent: ExpeditionOutcome[],
): AuditEvidence[] {
  const max = thresholds["expedition_black_hole_rate_high"];
  if (typeof max !== "number") return [];
  const last50 = recent.slice(-50);
  if (last50.length < 10) return [];
  const observed = blackHoleRate(last50);
  if (observed <= max) return [];
  return [
    {
      rule_id: "expedition_black_hole_rate_high",
      threshold: max,
      observed,
      details: { sample_size: last50.length },
      ts: Date.now(),
    },
  ];
}

function ruleDefenseMinimumBreach(
  state: WorldState,
  thresholds: Record<string, number>,
  keepMinimum: Record<string, number>,
): AuditEvidence[] {
  const flag = thresholds["defense_minimum_breach"];
  if (typeof flag !== "number" || flag < 1) return [];
  const out: AuditEvidence[] = [];
  const ts = Date.now();
  for (const planet of Object.values(state.planets ?? {})) {
    for (const [shipKey, minRequired] of Object.entries(keepMinimum)) {
      if (typeof minRequired !== "number" || minRequired <= 0) continue;
      const have = planet.defense[shipKey] ?? 0;
      if (have < minRequired) {
        out.push({
          rule_id: "defense_minimum_breach",
          threshold: minRequired,
          observed: have,
          details: { planet_id: planet.id, ship: shipKey, have, min_required: minRequired },
          ts,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Auditor
// ---------------------------------------------------------------------

export function startAuditor(deps: AuditorDeps): AuditorHandle {
  const { bus, store } = deps;
  let thresholds: Record<string, number> = { ...deps.initialThresholds };
  let keepMinimum: Record<string, number> = { ...(deps.defenseKeepMinimum ?? {}) };
  let lastRunAt = 0;
  const log: AuditEvidence[] = [];
  let stopped = false;

  // Per-rule rolling logs (capped at 200 entries; ages pruned per-rule).
  const attackLog: AttackLogEntry[] = [];
  const researchLog: ResearchLogEntry[] = [];
  const directiveLog: DirectiveLogEntry[] = [];
  const fillSamples: number[] = [];

  const pushCapped = <T,>(buf: T[], v: T): void => {
    buf.push(v);
    if (buf.length > TRACK_LOG_CAP) buf.shift();
  };

  // --- Subscriptions for tracking rule inputs ---

  const offAttack = bus.on<{ event_id?: string }>("emergency.attack", (p) => {
    const event_id = typeof p?.event_id === "string" ? p.event_id : `attack-${Date.now()}-${Math.random()}`;
    pushCapped(attackLog, { ts: Date.now(), saved: false, event_id });
  });
  const offSave = bus.on<{ event_id?: string }>("emergency.save_completed", (p) => {
    const event_id = typeof p?.event_id === "string" ? p.event_id : null;
    if (event_id === null) {
      // Best-effort fallback: mark most recent unsaved attack as saved.
      for (let i = attackLog.length - 1; i >= 0; i--) {
        if (!attackLog[i]!.saved) {
          attackLog[i]!.saved = true;
          break;
        }
      }
      return;
    }
    const entry = attackLog.find((a) => a.event_id === event_id);
    if (entry) entry.saved = true;
  });
  const offResearch = bus.on<{ tech?: string; level?: number }>("research_completed", (p) => {
    const tech = typeof p?.tech === "string" ? p.tech : "unknown";
    const level = typeof p?.level === "number" ? p.level : 0;
    pushCapped(researchLog, { ts: Date.now(), tech, level });
  });
  const offDirective = bus.on<{ success?: boolean }>("directive_completed", (p) => {
    pushCapped(directiveLog, { ts: Date.now(), success: p?.success === true });
  });

  const sampleQueueFill = (state: WorldState): void => {
    if (Object.keys(state.planets ?? {}).length === 0) return;
    let filled = 0;
    for (const planet of Object.values(state.planets ?? {})) {
      if (planet.build_q !== null) filled++;
    }
    const ratio = filled / Object.keys(state.planets ?? {}).length;
    fillSamples.push(ratio);
    if (fillSamples.length > SAMPLE_BUFFER_MAX) fillSamples.shift();
  };

  const runRules = async (): Promise<AuditEvidence[]> => {
    const state = store.state;
    sampleQueueFill(state);

    let expeditions: ExpeditionOutcome[] | null = null;
    if (deps.getRecentExpeditions) {
      try {
        expeditions = await deps.getRecentExpeditions();
      } catch (e) {
        console.error("[Auditor] getRecentExpeditions failed", e);
        expeditions = null;
      }
    }

    const out: AuditEvidence[] = [];
    const safePush = (evs: AuditEvidence[]): void => {
      for (const ev of evs) out.push(ev);
    };
    try { safePush(ruleResourceOverflow(state, thresholds)); }
    catch (e) { console.error("[Auditor] resource_overflow error", e); }
    try { safePush(ruleFleetSlotStarvation(state, thresholds)); }
    catch (e) { console.error("[Auditor] fleet_slot_starvation error", e); }
    try { safePush(ruleBuildQueueEmpty(state, thresholds)); }
    catch (e) { console.error("[Auditor] build_queue_empty error", e); }
    try { safePush(ruleFleetSaveCoverage(thresholds, attackLog)); }
    catch (e) { console.error("[Auditor] fleet_save_coverage_24h error", e); }
    try { safePush(ruleQueueFillerEfficiency(thresholds, fillSamples)); }
    catch (e) { console.error("[Auditor] queue_filler_efficiency error", e); }
    try { safePush(ruleResearchProgressRate(thresholds, researchLog)); }
    catch (e) { console.error("[Auditor] research_progress_rate error", e); }
    try { safePush(ruleDirectiveFailureRate(thresholds, directiveLog)); }
    catch (e) { console.error("[Auditor] directive_failure_rate error", e); }
    try { safePush(ruleDefenseMinimumBreach(state, thresholds, keepMinimum)); }
    catch (e) { console.error("[Auditor] defense_minimum_breach error", e); }
    if (expeditions !== null) {
      try { safePush(ruleExpeditionLossRate(thresholds, expeditions)); }
      catch (e) { console.error("[Auditor] expedition_loss_rate_50 error", e); }
      try { safePush(ruleExpeditionBlackHoleRateHigh(thresholds, expeditions)); }
      catch (e) { console.error("[Auditor] expedition_black_hole_rate_high error", e); }
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
    // Fire-and-forget; rule side effects emit on the bus.
    void runRules();
  };

  const offState = bus.on("state.updated", onStateUpdated);

  return {
    setThresholds(t: Record<string, number>): void {
      thresholds = { ...t };
    },
    setKeepMinimum(m: Record<string, number>): void {
      keepMinimum = { ...m };
    },
    async runAll(): Promise<AuditEvidence[]> {
      return runRules();
    },
    stop(): void {
      stopped = true;
      offState();
      offAttack();
      offSave();
      offResearch();
      offDirective();
    },
    _log(): readonly AuditEvidence[] {
      return log.slice();
    },
  };
}
