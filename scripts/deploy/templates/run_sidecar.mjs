// OgameX sidecar bootstrap — rendered by deploy.sh with envsubst.
//
// Required vars (defined in deploy.sh):
//   OPERATOR_USER_ID — owner's ogame-next users.id (UUID), used as
//     OGAMEX_OPERATOR_USER_ID + OGAMEX_LEGACY_USER_ID. Cold-start fallback so
//     directives without a Bearer route into operator's bucket.
//   PG_DSN — postgres URL (e.g. postgres://ogamex:ogamex@127.0.0.1:5432/ogamex)
//   REMOTE_HOME — sidecar workspace base (typically /root or /home/<user>),
//     used for goals.db/world.db/strategy/memory. Must be writable by the
//     service user. Memory [[audit-all-db-consumers]] — DO NOT hardcode
//     /home/ddxs; v1.0.17 expedition daemon also reads via PG, no fs path.
//   DISCORD_CHANNEL_ID — optional, "channel:<id>" or empty string

process.env.OGAMEX_OPERATOR_USER_ID = "${OPERATOR_USER_ID}";
process.env.OGAMEX_LEGACY_USER_ID = "${OPERATOR_USER_ID}";
process.env.DATABASE_URL = process.env.DATABASE_URL || "${PG_DSN}";
process.env.OGAMEX_DEFAULT_CLASS = "discoverer";

import { startSidecar } from "${REMOTE_HOME}/ogamex/packages/openclaw-plugin/dist/sidecar/index.js";

const handle = await startSidecar({
  wsPort: 28790,
  httpPort: 28791,
  bridgeToken: "${BRIDGE_TOKEN}",
  discordChannelId: "${DISCORD_CHANNEL_ID}",
  strategyRepoDir: "${REMOTE_HOME}/.openclaw/workspace/ogamex/strategy",
  goalsDbPath: "${REMOTE_HOME}/.openclaw/workspace/ogamex/goals.db",
  worldStateDbPath: "${REMOTE_HOME}/.openclaw/workspace/ogamex/world.db",
  memoryDir: "${REMOTE_HOME}/.openclaw/workspace/ogamex/memory",
  geminiApiKey: process.env.GEMINI_API_KEY,
}, {
  defaultStrategy: {
    version: 0,
    updated_at: 0,
    updated_by: "deploy.sh",
    reason: "production",
    daily: {
      expedition: { enabled: false, auto_fill_slots: false, source_planet: null, duration: "medium", target_position: 16, fleet_templates: {}, galaxy_strategy: { mode: "stats_based", home_galaxy_first: true, switch_threshold: { black_hole_rate_24h: 0.05, sample_size_min: 20 }, cross_galaxy_deut_budget: 0 }, cargo_load: { smallCargo_capacity_pct: 100, largeCargo_capacity_pct: 100 } },
      resource_balance: { enabled: false, trigger_overflow_pct: 95 },
      defense_replenish: { enabled: false, keep_minimum: {} },
      default_build: { enabled: false, strategy: "nano-first", ratio: {} },
      heartbeat: { enabled: false, schedule: [] },
    },
    emergency: { attack: { save_window_minutes: 30, prefer_moon: true, alliance_safe_planets: [], safety_margin_minutes: 5 }, spy: { push_immediate: true, counter_spy: false, log_attacker: true }, anomaly: { push_immediate: true, pause_planet_automation: false }, resource_critical: { threshold_pct: 90, try_redistribute_first: true } },
    audit_rules_thresholds: {},
  },
});

console.log("[sidecar] started ws=28790 http=28791 operator=${OPERATOR_USER_ID}");
