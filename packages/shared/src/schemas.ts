import { Type } from "@sinclair/typebox";

export const GoalSchema = Type.Object({
  id: Type.String(),
  type: Type.Union([
    Type.Literal("research"),
    Type.Literal("build"),
    Type.Literal("build_universal"),
    Type.Literal("colonize"),
    Type.Literal("build_ships"),
    Type.Literal("build_defense"),
    Type.Literal("terraformer_to"),
    // 2026 LifeForm goals
    Type.Literal("pick_lifeform"),
    Type.Literal("lifeform_level_to"),
    Type.Literal("lifeform_research"),
    Type.Literal("lifeform_building"),
  ]),
  target: Type.Record(Type.String(), Type.Unknown()),
  planet: Type.Optional(Type.String()),
  priority: Type.Integer({ minimum: 0, maximum: 200 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("active"),
    Type.Literal("blocked"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
    Type.Literal("pending_confirm"),
  ]),
  created_at: Type.Number(),
  deadline: Type.Optional(Type.Number()),
  progress_pct: Type.Integer({ minimum: 0, maximum: 100 }),
  current_step: Type.String(),
  eta_at: Type.Union([Type.Number(), Type.Null()]),
  blocked_reason: Type.Optional(Type.String()),
});

export const DirectiveSchema = Type.Object({
  id: Type.String(),
  source: Type.Union([
    Type.Literal("daily"),
    Type.Literal("emergency"),
    Type.Literal("goal"),
    Type.Literal("user"),
  ]),
  method: Type.Union([Type.Literal("api"), Type.Literal("ui")]),
  priority: Type.Integer({ minimum: 0, maximum: 200 }),
  action: Type.String(),
  params: Type.Record(Type.String(), Type.Unknown()),
  preconds: Type.Array(Type.String()),
  expires_at: Type.Number(),
  reason: Type.String(),
  goal_id: Type.Optional(Type.String()),
});

export const SendFleetParamsSchema = Type.Object({
  source_planet_id: Type.String(),
  coords: Type.Tuple([Type.Integer(), Type.Integer(), Type.Integer()]),
  destType: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  mission: Type.Integer({ minimum: 1, maximum: 15 }),
  speed: Type.Integer({ minimum: 1, maximum: 10 }),
  ships: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  cargo: Type.Object({
    m: Type.Integer({ minimum: 0 }),
    c: Type.Integer({ minimum: 0 }),
    d: Type.Integer({ minimum: 0 }),
  }),
});
