/**
 * M6.2 — Strategy schema validator.
 *
 * Provides typebox schemas + per-field range guards over `Strategy`. Two
 * validators:
 *   - validateStrategy(): full-shape check (all required fields must exist).
 *   - validatePatch(): same range guards but field-presence not enforced.
 *
 * Returns `{ ok, errors[] }` with human-readable "path: message" strings.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ---------- Leaf schemas with range guards ----------

const TUpdatedBy = Type.Union([
  Type.Literal("openclaw-llm"),
  Type.Literal("user-discord"),
  Type.Literal("userscript-bootstrap"),
]);

const TReason = Type.String({ maxLength: 500 });

const TShipCount = Type.Record(Type.String(), Type.Number({ minimum: 0 }));

const TFleetTemplate = Type.Object({
  fleet: TShipCount,
  used_when: Type.String(),
  reason: Type.Optional(Type.String()),
});

const TGalaxyStrategy = Type.Object({
  mode: Type.Union([
    Type.Literal("stats_based"),
    Type.Literal("fixed"),
    Type.Literal("rotate"),
  ]),
  home_galaxy_first: Type.Boolean(),
  switch_threshold: Type.Object({
    black_hole_rate_24h: Type.Number({ minimum: 0, maximum: 1 }),
    sample_size_min: Type.Integer({ minimum: 1, maximum: 500 }),
  }),
  cross_galaxy_deut_budget: Type.Number({ minimum: 0 }),
  preferred_galaxies: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
});

const TCargoLoad = Type.Object({
  smallCargo_capacity_pct: Type.Number({ minimum: 0, maximum: 100 }),
  largeCargo_capacity_pct: Type.Number({ minimum: 0, maximum: 100 }),
});

const TExpeditionConfig = Type.Object({
  enabled: Type.Boolean(),
  auto_fill_slots: Type.Boolean(),
  source_planet: Type.Union([Type.String(), Type.Null()]),
  target_position: Type.Integer({ minimum: 1, maximum: 16 }),
  fleet_templates: Type.Record(Type.String(), TFleetTemplate),
  galaxy_strategy: TGalaxyStrategy,
  cargo_load: TCargoLoad,
});

const TResourceBalance = Type.Object({
  enabled: Type.Boolean(),
  trigger_overflow_pct: Type.Number({ minimum: 0, maximum: 100 }),
});

const TDefenseReplenish = Type.Object({
  enabled: Type.Boolean(),
  keep_minimum: Type.Record(Type.String(), Type.Number({ minimum: 0 })),
});

const TDefaultBuild = Type.Object({
  enabled: Type.Boolean(),
  strategy: Type.String(),
  ratio: Type.Record(Type.String(), Type.Number({ minimum: 0 })),
});

const THeartbeat = Type.Object({
  enabled: Type.Boolean(),
  schedule: Type.Array(Type.String()),
});

const TDaily = Type.Object({
  expedition: TExpeditionConfig,
  resource_balance: TResourceBalance,
  defense_replenish: TDefenseReplenish,
  default_build: TDefaultBuild,
  heartbeat: THeartbeat,
});

const TCoords = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);

const TAttack = Type.Object({
  save_window_minutes: Type.Integer({ minimum: 5, maximum: 120 }),
  prefer_moon: Type.Boolean(),
  alliance_safe_planets: Type.Array(
    Type.Object({ coords: TCoords, name: Type.String() }),
  ),
  safety_margin_minutes: Type.Integer({ minimum: 1, maximum: 60 }),
});

const TSpy = Type.Object({
  push_immediate: Type.Boolean(),
  counter_spy: Type.Boolean(),
  log_attacker: Type.Boolean(),
});

const TAnomaly = Type.Object({
  push_immediate: Type.Boolean(),
  pause_planet_automation: Type.Boolean(),
});

const TResourceCritical = Type.Object({
  threshold_pct: Type.Number({ minimum: 0, maximum: 100 }),
  try_redistribute_first: Type.Boolean(),
});

const TEmergency = Type.Object({
  attack: TAttack,
  spy: TSpy,
  anomaly: TAnomaly,
  resource_critical: TResourceCritical,
});

const TAuditRulesThresholds = Type.Record(
  Type.String(),
  Type.Number({ minimum: 0 }),
);

/** Full Strategy schema with range constraints. */
export const StrategySchema = Type.Object({
  version: Type.Integer({ minimum: 0 }),
  updated_at: Type.Integer({ minimum: 0 }),
  updated_by: TUpdatedBy,
  reason: TReason,
  daily: TDaily,
  emergency: TEmergency,
  audit_rules_thresholds: TAuditRulesThresholds,
});

export type StrategySchemaT = Static<typeof StrategySchema>;

// ---------- Patch schema (all top-level fields optional, nested too) ----------

// Build patch versions where every property is optional. We keep the same
// range guards, but `Type.Partial` recursively makes top-level optional; we
// also need nested partials for the common patch shapes used by the sidecar
// (e.g., `{ emergency: { attack: { save_window_minutes: 200 } } }`).

const TDailyPatch = Type.Partial(
  Type.Object({
    expedition: Type.Partial(
      Type.Object({
        enabled: Type.Boolean(),
        auto_fill_slots: Type.Boolean(),
        source_planet: Type.Union([Type.String(), Type.Null()]),
        target_position: Type.Integer({ minimum: 1, maximum: 16 }),
        fleet_templates: Type.Record(Type.String(), TFleetTemplate),
        galaxy_strategy: Type.Partial(
          Type.Object({
            mode: Type.Union([
              Type.Literal("stats_based"),
              Type.Literal("fixed"),
              Type.Literal("rotate"),
            ]),
            home_galaxy_first: Type.Boolean(),
            switch_threshold: Type.Partial(
              Type.Object({
                black_hole_rate_24h: Type.Number({ minimum: 0, maximum: 1 }),
                sample_size_min: Type.Integer({ minimum: 1, maximum: 500 }),
              }),
            ),
            cross_galaxy_deut_budget: Type.Number({ minimum: 0 }),
            preferred_galaxies: Type.Array(Type.Integer({ minimum: 1 })),
          }),
        ),
        cargo_load: Type.Partial(
          Type.Object({
            smallCargo_capacity_pct: Type.Number({ minimum: 0, maximum: 100 }),
            largeCargo_capacity_pct: Type.Number({ minimum: 0, maximum: 100 }),
          }),
        ),
      }),
    ),
    resource_balance: Type.Partial(TResourceBalance),
    defense_replenish: Type.Partial(TDefenseReplenish),
    default_build: Type.Partial(TDefaultBuild),
    heartbeat: Type.Partial(THeartbeat),
  }),
);

const TEmergencyPatch = Type.Partial(
  Type.Object({
    attack: Type.Partial(
      Type.Object({
        save_window_minutes: Type.Integer({ minimum: 5, maximum: 120 }),
        prefer_moon: Type.Boolean(),
        alliance_safe_planets: Type.Array(
          Type.Object({ coords: TCoords, name: Type.String() }),
        ),
        safety_margin_minutes: Type.Integer({ minimum: 1, maximum: 60 }),
      }),
    ),
    spy: Type.Partial(TSpy),
    anomaly: Type.Partial(TAnomaly),
    resource_critical: Type.Partial(TResourceCritical),
  }),
);

/** Patch schema — partial Strategy, but values still range-checked. */
export const StrategyPatchSchema = Type.Partial(
  Type.Object({
    version: Type.Integer({ minimum: 0 }),
    updated_at: Type.Integer({ minimum: 0 }),
    updated_by: TUpdatedBy,
    reason: TReason,
    daily: TDailyPatch,
    emergency: TEmergencyPatch,
    audit_rules_thresholds: TAuditRulesThresholds,
  }),
);

// ---------- Public validators ----------

export interface ValidationResult {
  ok: boolean;
  /** Human-readable "field-path: message" strings, one per violation. */
  errors: string[];
}

function runValidator(schema: TSchema, data: unknown): ValidationResult {
  const errors: string[] = [];
  for (const err of Value.Errors(schema, data)) {
    // err.path is like "/emergency/attack/save_window_minutes". Strip leading
    // slash and surface the human path verbatim so consumers can grep for
    // field names (e.g., "save_window_minutes").
    const path = err.path.length > 0 ? err.path.replace(/^\//, "") : "(root)";
    errors.push(`${path}: ${err.message}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate a full Strategy object. */
export function validateStrategy(s: unknown): ValidationResult {
  return runValidator(StrategySchema, s);
}

/** Validate a partial Strategy patch. Range guards still apply. */
export function validatePatch(p: unknown): ValidationResult {
  return runValidator(StrategyPatchSchema, p);
}
