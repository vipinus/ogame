process.env.OGAMEX_LEGACY_USER_ID = process.env.OGAMEX_LEGACY_USER_ID || "4baba0e2-17ab-4275-a8eb-d642ba8d969f";
/**
 * Standalone Discord command bridge for OgameX.
 *
 * Polls a Discord text channel, parses `/<cmd> [...]` messages, executes
 * against the local plugin's GoalsStore (+ Gemini for NL add_goal), replies
 * inline. Bypasses OpenClaw entirely — only uses the bot token from the
 * openclaw.json `channels.discord.token` field for outbound REST.
 *
 * Commands:
 *   /add <natural language>     — Gemini parses + queues a goal
 *   /list [pending|active|...]  — list goals (defaults to non-terminal)
 *   /cancel <id-prefix>         — cancel by id (prefix match if unambiguous)
 *   /pause <id-prefix>          — pause
 *   /resume <id-prefix>         — resume
 *   /health                     — sidecar health snapshot
 *   /help                       — list commands
 */

import fs from "node:fs";
const { readFileSync } = fs;
import path from "node:path";

const OPENCLAW_CONFIG = "/home/ddxs/.openclaw/openclaw.json";
const PLUGIN_DIST = "/home/ddxs/.openclaw/extensions/ogamex/dist";
// DB_PATH removed in Phase 7c.4 — daemon no longer opens goals.db.
const CHANNEL_ID = process.env.OGAMEX_CMD_CHANNEL_ID ?? "1506611423202250762";
const POLL_MS = 3500;
const DISCORD_API = "https://discord.com/api/v10";
const SIDECAR = "http://127.0.0.1:28791";
const SIDECAR_HEALTH_URL = `${SIDECAR}/ogamex/v1/health`;

// ─── Bot token + clients ───────────────────────────────────────────────────
const config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
const BOT_TOKEN = config.channels?.discord?.token;
if (!BOT_TOKEN) {
  console.error("no bot token at channels.discord.token");
  process.exit(2);
}
// LLM provider selection — Gemini free tier has limit:0 on the configured
// project and xAI team has no credits. We route /add NL parsing through
// NVIDIA NIM via an OpenAI-compatible shim that mirrors GeminiClient's
// generateJson signature, so addGoalTool needs no code change.
const NVIDIA_API_KEY = config.env?.NVIDIA_API_KEY;
if (!NVIDIA_API_KEY) {
  console.error("no NVIDIA_API_KEY in openclaw.json env");
  process.exit(2);
}

const { XaiClient } = await import("/home/ddxs/.openclaw/workspace/ogamex/runtime/ogamex_xai_client.mjs");
// Phase 7c.4 (2026-06-05) — daemon goes PG-primary. GoalsStore (SQLite)
// import retired; daemon used to open goals.db directly via better-sqlite3
// fd 20-22 and drift with sidecar (sidecar PG primary since 7c.2 caused
// 30s reconciler hack). All 31 store.* sites now route to PG via the
// goalsPg shim below.
const { WorldStateStorePg } = await import(`${PLUGIN_DIST}/sidecar/world_state_store_pg.js`);
const { GoalsStorePg } = await import(`${PLUGIN_DIST}/sidecar/goals_store_pg.js`);
const { makeAddGoalTool } = await import(`${PLUGIN_DIST}/tools/add_goal.js`);

// Ogame Chinese ↔ canonical-ID glossary. The NL parser sees this every
// call as systemInstruction so "大运" reliably maps to "largeCargo"
// instead of being misidentified as colonyShip (殖民船). Keep canonical
// IDs in sync with packages/shared/src/tech_tree.ts.
const OGAME_GLOSSARY = `
You translate ogame.org/gameforge Chinese terminology into canonical
English IDs used by the ogame game engine. ALWAYS use these exact IDs in
the structured JSON output — do not invent or guess.

Ships (build_ships):
  小运/小型运输船=smallCargo  大运/大型运输船=largeCargo
  轻战/轻型战斗机=lightFighter  重战/重型战斗机=heavyFighter
  巡洋舰=cruiser  战列舰=battleship  战巡=battlecruiser
  毁灭者=destroyer  死星=deathstar  轰炸机=bomber
  殖民船=colonyShip  回收船=recycler  间谍探测器/间谍=espionageProbe
  太阳能卫星=solarSatellite  破碎者=reaper  探索者=explorer

Buildings (build):
  金属矿=metalMine  晶体矿=crystalMine  重氢厂/重氢合成厂=deuteriumSynth
  太阳能电站=solarPlant  聚变反应堆=fusionReactor
  机器人工厂=roboticsFactory  纳米工厂=naniteFactory  造船厂=shipyard
  金属仓=metalStorage  晶体仓=crystalStorage  重氢罐=deuteriumTank
  研究实验室=researchLab  联盟仓库=allianceDepot  导弹井=missileSilo
  虫洞=jumpGate  地形改造仪=terraformer

Research:
  宇航学=astrophysics  间谍技术=espionageTech  能源技术=energyTech
  计算机技术=computerTech  武器技术=weapons  护盾技术=shielding
  装甲技术=armor  燃烧引擎=combustion  脉冲引擎=impulseDrive
  超光速引擎=hyperspaceDrive  重力技术=gravitonTech
  行星间通讯网/IRN=intergalactic
  激光技术=laserTech  离子技术=ionTech  等离子技术=plasmaTech

Defense:
  火箭发射器=rocketLauncher  轻型激光炮=lightLaser  重型激光炮=heavyLaser
  高斯炮=gaussCannon  离子炮=ionCannon  等离子炮=plasmaTurret
  小型护盾=smallShieldDome  大型护盾=largeShieldDome
  拦截导弹=antiBallisticMissile  星际导弹=interplanetaryMissile

If the user's instruction is ambiguous or names a term not in this list,
prefer LEAVING the field undefined over guessing. Never silently substitute
a different ID. Never output "?" or placeholder values.

When emitting target_json, use EXACTLY these shapes (JSON-encoded string):
  research:        {"tech":"<ID>","level":<N>}
                   e.g. {"tech":"astrophysics","level":4}
  build:           {"building":"<ID>","level":<N>}
                   e.g. {"building":"metalMine","level":18}
  build_ships:     {"ship":"<ID>","amount":<N>}
                   e.g. {"ship":"largeCargo","amount":10}
                   For multiple ship types, emit ONE goal per ship type.
  build_defense:   {"item":"<ID>","amount":<N>}
                   e.g. {"item":"rocketLauncher","amount":50}
  colonize:        {"target_coords":"G:S:P"}
                   e.g. {"target_coords":"2:158:8"}
                   Triggers on phrases like "去 2:158:8 殖民" / "殖民 1:100:5"
                   / "建立殖民地 G:S:P" / "colonize 2:158:8".
  deploy:          {"target_coords":"G:S:P","ships":{"<id>":<n>,...}}
                   ONE-WAY ship transfer to your OWN colony — ships stay there.
                   e.g. {"target_coords":"2:158:8","ships":{"smallCargo":50}}
                   Triggers: "部署 50 小运去 2:158:8" / "部署到 G:S:P" /
                   "派 X 艘 Y 去 G:S:P 驻守" / "deploy X ships to G:S:P".
  transport:       {"target_coords":"G:S:P","ships":{"<id>":<n>,...},"resources":{"m":N,"c":N,"d":N}}
                   ROUND-TRIP cargo run — ships return after delivery.
                   resources field optional (default fill cargo capacity).
                   Triggers: "运输 X 资源到 G:S:P" / "送 N M 金属到 G:S:P" /
                   "transport X to G:S:P".
  lifeform_building: {"building":"<id>","level":N}
                   Lifeform building upgrade (humans/rocktal/mechas/kaelesh).
                   Building IDs: residentialSector, biosphereFarm,
                   researchCentre, academyOfSciences, neuroCalibrationCentre,
                   highEnergySmelting, foodSilo, fusionPoweredProduction,
                   skyscraper, biotechLab, metropolis,
                   plantationOfMostBenevolentBeing (humans);
                   meditationEnclave, crystalFarm, runeTechnologium, runeForge,
                   oriktorium, magmaForge, disruptionChamber, megalith,
                   crystalRefinery (rocktal); ...
                   Triggers: "生命形式研究中心升级到 N" / "生物圈农场 N 级" /
                   "升级科学院" / "lifeform researchCentre level N".

Common misclassifications to AVOID:
  "升级金属矿到 N" is type=build (NOT research) — buildings live on planets.
  "研究宇航学" is type=research (NOT build) — research is player-global.
  "造大运" / "建造大运" / "建造2大运" / "造10个大运" / "建大运" — ALL must
  be type=build_ships, target_json={"ship":"largeCargo","amount":N}.
  "largeFreighter" IS NOT A VALID OGAME ID — never emit it. Large transport
  cargo = "largeCargo". Same for small transport = "smallCargo".
  If the user gives a ship/defense count, ALWAYS use type=build_ships or
  build_defense, NEVER type=build (which is for planet buildings).`;

class GlossaryClient {
  constructor(inner) { this.inner = inner; }
  async generateJson(prompt, schema, opts = {}) {
    const merged = {
      ...opts,
      systemInstruction: opts.systemInstruction
        ? OGAME_GLOSSARY + "\n\n" + opts.systemInstruction
        : OGAME_GLOSSARY,
    };
    return this.inner.generateJson(prompt, schema, merged);
  }
}

const gemini = new GlossaryClient(new XaiClient({ apiKey: NVIDIA_API_KEY }));

// PG primary — same default fallback as run_sidecar.mjs (postgres://ogamex:ogamex
// @127.0.0.1:5432/ogamex). Override via DATABASE_URL env. Daemon now requires
// PG (Phase 7c.4) — SQLite goals.db fd retired.
const DATABASE_URL = process.env.DATABASE_URL
  ?? config.env?.DATABASE_URL
  ?? "postgres://ogamex:ogamex@127.0.0.1:5432/ogamex";
const OPERATOR_UID = (process.env.OGAMEX_LEGACY_USER_ID ?? process.env.OGAMEX_OPERATOR_USER_ID ?? "").trim();
if (!OPERATOR_UID) {
  console.error("[daemon] no OGAMEX_LEGACY_USER_ID — operator pg uid required for PG writes");
  process.exit(2);
}
const pgStore = new WorldStateStorePg({ databaseUrl: DATABASE_URL });
const goalsPg = new GoalsStorePg({ sql: pgStore.sql });
console.log(`[daemon] PG primary — operator uid=${OPERATOR_UID.slice(0, 8)}…`);

// Phase 7c.6 (2026-06-05) — multi-tenant optimizer. CURRENT_UID is the
// active tenant during a tick; store shim reads it on every call so
// existing sync-shaped code paths don't need a uid param threaded
// through every callsite. expedition tick stays single-tenant for now
// (defer to 7c.7) — it owns rotation state + config file the optimizer
// doesn't touch. Default to OPERATOR_UID so out-of-tick paths (Discord
// command handlers etc.) keep operating on the operator's tenant.
let CURRENT_UID = OPERATOR_UID;
let CURRENT_BEARER = "";  // populated by optimizerTickAllTenants per tenant

async function loadActiveUidsWithTokens() {
  // Returns [{uid, bearer}] for users with bridge_token + active goals.
  // Operator's uid is always included; its bearer comes from
  // OGAMEX_BRIDGE_TOKEN env (same one sidecar accepts as global).
  const rows = await pgStore.sql`
    SELECT u.user_id, u.bridge_token
      FROM user_settings u
     WHERE u.bridge_token IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM ogame_goals g
          WHERE g.user_id = u.user_id
            AND g.status IN ('pending','active','blocked')
       )
  `;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    out.push({ uid: r.user_id, bearer: r.bridge_token });
  }
  if (!seen.has(OPERATOR_UID)) {
    out.push({ uid: OPERATOR_UID, bearer: process.env.OGAMEX_BRIDGE_TOKEN ?? "" });
  }
  return out;
}

// store shim — async wrappers; uid is CURRENT_UID at the moment of call
// so callers don't pass uid explicitly. Set CURRENT_UID before iterating
// per-tenant work then restore.
const store = {
  list: async () => goalsPg.list(CURRENT_UID),
  get: async (id) => goalsPg.get(CURRENT_UID, id),
  getMainGoal: async () => goalsPg.getMainGoal(CURRENT_UID),
  setMainGoal: async (id) => pgStore.setMainGoal(CURRENT_UID, id),
  updateStatus: async (id, status, reason) =>
    pgStore.updateGoalStatus(CURRENT_UID, id, status, reason ?? null),
  add: async (goal) => {
    const nowTs = Date.now();
    const row = {
      goal: {
        ...goal,
        status: goal.status ?? "pending",
        created_at: goal.created_at ?? nowTs,
        progress_pct: goal.progress_pct ?? 0,
        current_step: goal.current_step ?? "queued",
        eta_at: goal.eta_at ?? null,
      },
      status: "pending",
      created_at: nowTs,
      updated_at: nowTs,
    };
    await pgStore.upsertGoal(CURRENT_UID, row);
    return row;
  },
};

function listPlanetsFromHealth() {
  // Best-effort: read /v1/health from local sidecar to get planet coords.
  // If sidecar is down or returns no planets, return [] — add_goal will then
  // fall back to first-planet default. Sync wrapper: just return what we have
  // cached; refreshed by a background tick.
  return cachedPlanets;
}

// Planet map persisted to disk so we don't lose id→coords mapping across
// bridge restarts (userscript may not reconnect immediately).
const PLANETS_CACHE_FILE = "/home/ddxs/.openclaw/workspace/ogamex/runtime/ogamex-bridge-planets.json";
let cachedPlanets = [];
try {
  const raw = readFileSync(PLANETS_CACHE_FILE, "utf8");
  cachedPlanets = JSON.parse(raw);
  console.log(`[bridge] loaded ${cachedPlanets.length} planets from cache`);
} catch { /* no cache yet — empty */ }

async function refreshPlanets() {
  try {
    const r = await fetch(SIDECAR_HEALTH_URL);
    if (!r.ok) return;
    const h = await r.json();
    const fresh = (h?.state?.planets ?? []).map((p) => ({
      id: p.id, name: p.name ?? "", coords: Array.isArray(p.coords) ? p.coords : [0,0,0], type: p.type ?? "planet",
    }));
    if (fresh.length > 0) {
      cachedPlanets = fresh;
      // Best-effort persist; ignore write errors.
      try { (await import("node:fs/promises")).writeFile(PLANETS_CACHE_FILE, JSON.stringify(fresh)); } catch {}
    }
  } catch { /* ignore */ }
}
await refreshPlanets();
setInterval(refreshPlanets, 30_000);

const addGoalTool = makeAddGoalTool({ gemini, store, listPlanets: listPlanetsFromHealth });

// ─── Discord REST helpers ──────────────────────────────────────────────────
async function discordFetch(path, init = {}) {
  const r = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Discord ${r.status} ${init.method ?? "GET"} ${path}: ${body.slice(0,200)}`);
  }
  return r.json();
}

async function whoAmI() {
  const u = await discordFetch("/users/@me");
  return u.id;
}
const BOT_USER_ID = await whoAmI();
console.log(`[bridge] connected as bot user_id=${BOT_USER_ID}, channel=${CHANNEL_ID}`);

async function postMessage(content) {
  // Discord caps content at 2000 chars.
  const trimmed = content.length > 1990 ? content.slice(0, 1985) + "…" : content;
  await discordFetch(`/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: trimmed }),
  });
}

async function fetchNewMessages(after) {
  const qs = after ? `?after=${after}&limit=10` : `?limit=5`;
  const arr = await discordFetch(`/channels/${CHANNEL_ID}/messages${qs}`);
  // Discord returns newest first; reverse so we process oldest first.
  return arr.reverse();
}

// ─── Command parser + dispatcher ───────────────────────────────────────────
async function resolveByPrefix(idPrefix) {
  const rows = await store.list();
  const matches = rows.filter((r) => r.goal.id.startsWith(idPrefix));
  if (matches.length === 0) return { error: `no goal with id starting "${idPrefix}"` };
  if (matches.length > 1) return { error: `ambiguous: ${matches.length} goals start with "${idPrefix}"; try more characters` };
  return { row: matches[0] };
}

/**
 * Build a planet-id → "G:S:P" map from the cached planets list. Used so we
 * never show the raw numeric planet id in user-facing text — operators read
 * coords, not internal ogame ids.
 */
function planetIdToCoords() {
  const m = new Map();
  for (const p of cachedPlanets) {
    if (Array.isArray(p.coords) && p.coords.length === 3) {
      m.set(p.id, `${p.coords[0]}:${p.coords[1]}:${p.coords[2]}`);
    }
  }
  return m;
}

/** Deep-clone of a goal target with any `planet: "<id>"` field rewritten to coords. */
function targetWithCoords(target, idMap) {
  if (!target || typeof target !== "object") return target;
  const out = { ...target };
  if (typeof out.planet === "string" && idMap.has(out.planet)) {
    out.planet = idMap.get(out.planet);
  }
  return out;
}

function fmtRow(r) {
  const idMap = planetIdToCoords();
  const target = targetWithCoords(r.goal.target, idMap);
  const tgt = JSON.stringify(target);
  const planetField = r.goal.planet ? ` @ ${idMap.get(r.goal.planet) ?? r.goal.planet}` : "";
  const reason = r.reason ? ` ↳ ${r.reason}` : "";
  const star = r.goal.is_main_goal === true ? "⭐ " : "";
  return `${star}\`${r.goal.id.slice(0,12)}\` **${r.status}** P${r.goal.priority} ${r.goal.type} ${tgt}${planetField}${reason}`;
}

/**
 * Required-keys per goal type — used to validate the LLM-parsed payload
 * BEFORE it's allowed to persist. NIM (and any non-Gemini model) doesn't
 * enforce the response schema as strictly, so we sometimes get back
 * `{ tech: undefined, level: 4 }` or worse `{}`. The store then writes the
 * goal, planner refuses to execute it, and it sits "blocked" forever.
 * Catch it here, cancel, return an error to the user.
 */
const REQUIRED_TARGET_KEYS = {
  research:        ["tech", "level"],
  build:           ["building", "level"],
  build_universal: ["building", "level"],
  build_ships:     ["ship", "amount"],
  defense:         ["item", "amount"],
  colonize:        ["target_coords"],
  deploy:          ["target_coords", "ships"],      // mission=4 (one-way move)
  transport:       ["target_coords", "ships"],      // mission=3 (cargo round-trip)
  lifeform_building: ["building", "level"],
};

function validateParsedGoal(g) {
  const required = REQUIRED_TARGET_KEYS[g.type];
  if (!required) return null; // unknown type — let planner reject
  if (!g.target || typeof g.target !== "object") return "target is empty";
  const missing = required.filter((k) => g.target[k] === undefined || g.target[k] === null || g.target[k] === "");
  if (missing.length > 0) return `target missing required keys: ${missing.join(", ")}`;
  return null;
}

// Pre-LLM substitution table: replaces Chinese ogame terms with canonical
// English IDs before the NL parser ever sees them. This is more reliable
// than prompt-engineering — NIM/llama keeps confusing 大运 (largeCargo)
// with 殖民 (colonyShip) regardless of glossary system instructions.
// Order matters: LONGEST keys first to avoid prefix overlap (e.g. "大型
// 运输船" must match before "大运").
const PRE_NL_SUBS = [
  // Ships
  ["大型运输船", "largeCargo"], ["大型运輸船", "largeCargo"],
  ["小型运输船", "smallCargo"], ["小型運輸船", "smallCargo"],
  ["殖民船", "colonyShip"],
  ["间谍探测器", "espionageProbe"], ["間諜探測器", "espionageProbe"],
  ["太阳能卫星", "solarSatellite"], ["太陽能衛星", "solarSatellite"],
  ["重型战斗机", "heavyFighter"], ["重型戰鬥機", "heavyFighter"],
  ["轻型战斗机", "lightFighter"], ["輕型戰鬥機", "lightFighter"],
  ["战列巡洋舰", "battlecruiser"], ["戰列巡洋艦", "battlecruiser"],
  ["毁灭者", "destroyer"], ["毀滅者", "destroyer"],
  ["战列舰", "battleship"], ["戰列艦", "battleship"],
  ["巡洋舰", "cruiser"], ["巡洋艦", "cruiser"],
  ["回收船", "recycler"],
  ["轰炸机", "bomber"], ["轟炸機", "bomber"],
  ["死星", "deathstar"],
  // Explorer (ogame v12 mission-specific ship) — multiple Chinese aliases.
  ["探路者", "explorer"], ["探索者", "explorer"], ["探险者", "explorer"], ["探險者", "explorer"],
  // Reaper / 破碎者 also common, add alias.
  ["破碎者", "reaper"], ["收割者", "reaper"],
  ["大运", "largeCargo"], ["小运", "smallCargo"],
  ["重战", "heavyFighter"], ["轻战", "lightFighter"], ["輕戰", "lightFighter"],
  ["战巡", "battlecruiser"], ["戰巡", "battlecruiser"],
  ["间谍", "espionageProbe"], ["間諜", "espionageProbe"],
  ["侦查", "espionageProbe"], ["偵查", "espionageProbe"],
  ["侦察", "espionageProbe"], ["偵察", "espionageProbe"],
  // Buildings
  ["金属矿", "metalMine"], ["金屬礦", "metalMine"],
  ["晶体矿", "crystalMine"], ["晶體礦", "crystalMine"],
  ["重氢合成器", "deuteriumSynth"], ["重氫合成器", "deuteriumSynth"],
  ["重氢厂", "deuteriumSynth"], ["重氫厂", "deuteriumSynth"],
  ["太阳能电站", "solarPlant"], ["太陽能發電廠", "solarPlant"], ["太阳能发电厂", "solarPlant"],
  ["聚变反应堆", "fusionReactor"], ["核融合反應器", "fusionReactor"], ["核聚变", "fusionReactor"],
  ["机器人工厂", "roboticsFactory"], ["機器人工厂", "roboticsFactory"],
  ["纳米工厂", "naniteFactory"], ["納米工厂", "naniteFactory"],
  ["研究实验室", "researchLab"], ["研究室", "researchLab"],
  // Lifeform buildings — keyed off "生命形式" / "生物圈" / "科学院" etc.
  ["生命形式研究中心", "researchCentre"], ["生命研究中心", "researchCentre"],
  ["研究中心", "researchCentre"],  // 99% of "研究中心" intent is lifeform now
  ["生物圈农场", "biosphereFarm"], ["生物圈農場", "biosphereFarm"], ["生物农场", "biosphereFarm"],
  ["住宅区", "residentialSector"], ["住宅區", "residentialSector"],
  ["科学院", "academyOfSciences"],
  ["神经校准中心", "neuroCalibrationCentre"],
  ["高能熔炼", "highEnergySmelting"],
  ["粮食筒仓", "foodSilo"], ["糧食筒倉", "foodSilo"],
  ["核聚变发电", "fusionPoweredProduction"],
  ["摩天大楼", "skyscraper"], ["摩天大樓", "skyscraper"],
  ["生物科技实验室", "biotechLab"],
  ["大都会", "metropolis"], ["大都會", "metropolis"],
  ["种植园", "plantationFarm"], ["種植園", "plantationFarm"],
  ["造船厂", "shipyard"], ["造船廠", "shipyard"],
  ["金属仓", "metalStorage"], ["金屬倉", "metalStorage"],
  ["晶体仓", "crystalStorage"], ["晶體倉", "crystalStorage"],
  ["重氢罐", "deuteriumTank"], ["重氫罐", "deuteriumTank"],
  // Research
  ["宇航学", "astrophysics"],
  ["间谍技术", "espionageTech"], ["間諜技術", "espionageTech"],
  ["能源技术", "energyTech"], ["能源技術", "energyTech"],
  ["计算机技术", "computerTech"], ["電腦技術", "computerTech"],
  ["武器技术", "weapons"], ["武器技術", "weapons"],
  ["护盾技术", "shielding"], ["護盾技術", "shielding"],
  ["装甲技术", "armor"], ["裝甲技術", "armor"],
  ["燃烧引擎", "combustion"], ["燃燒引擎", "combustion"],
  ["脉冲引擎", "impulseDrive"], ["脈衝引擎", "impulseDrive"],
  ["超光速引擎", "hyperspaceDrive"],
  ["重力技术", "gravitonTech"], ["重力技術", "gravitonTech"],
  ["等离子技术", "plasmaTech"], ["等離子技術", "plasmaTech"],
  ["离子技术", "ionTech"], ["離子技術", "ionTech"],
  ["激光技术", "laserTech"], ["雷射技術", "laserTech"],
].sort((a, b) => b[0].length - a[0].length);

function preprocessNL(text) {
  let out = text;
  for (const [zh, en] of PRE_NL_SUBS) {
    if (out.includes(zh)) out = out.split(zh).join(en);
  }
  return out;
}

/**
 * Extract planet coords from NL and return { cleanedNL, planetCoords }.
 * Accepts patterns: "在 1:190:6", "@1:190:6", "@earth", "在 earth", "[earth]".
 * If a planet NAME ("earth") is used, looks it up in cachedPlanets.
 */
function extractPlanetSpec(text) {
  // Direct coords: 1:190:6 / G:S:P
  const coordMatch = text.match(/(?:在|on|@|at)\s*\[?(\d+:\d+:\d+)\]?|\b(\d+:\d+:\d+)\b/);
  if (coordMatch) {
    const c = coordMatch[1] ?? coordMatch[2];
    return { cleanedNL: text.replace(coordMatch[0], "").trim(), planetCoords: c };
  }
  // Named planet: 在 earth / @earth / [earth]
  const nameMatch = text.match(/(?:在|on|@|at)\s*\[?([a-zA-Z0-9_一-鿿]+)\]?/);
  if (nameMatch) {
    const name = nameMatch[1].toLowerCase();
    const planet = cachedPlanets.find((p) =>
      (p.name ?? "").toLowerCase() === name ||
      (Array.isArray(p.coords) && p.coords.join(":") === name)
    );
    if (planet && Array.isArray(planet.coords)) {
      return { cleanedNL: text.replace(nameMatch[0], "").trim(), planetCoords: planet.coords.join(":") };
    }
  }
  return { cleanedNL: text, planetCoords: null };
}

async function handleAdd(rest) {
  const nl = rest.trim();
  if (!nl) return "usage: `/add <natural language>` — e.g. `/add 研究宇航学到 1`";
  // Step 1: extract explicit planet coords/name if user wrote one (e.g. "在 earth")
  const { cleanedNL, planetCoords: userPlanet } = extractPlanetSpec(nl);
  // Step 2: replace Chinese terms with canonical IDs.
  const nlEN = preprocessNL(cleanedNL);
  if (nlEN !== nl) console.log(`[bridge] preprocessed: "${nl}" -> "${nlEN}" planet=${userPlanet ?? "(default)"}`);
  // Step 3: if user didn't specify, default to the FIRST planet (active home).
  let defaultPlanet = userPlanet;
  if (!defaultPlanet && cachedPlanets.length > 0) {
    const p0 = cachedPlanets[0];
    if (Array.isArray(p0.coords)) defaultPlanet = p0.coords.join(":");
  }
  // Pass the planet hint inline so the LLM-generated target gets the right
  // planet_coords field. addGoalTool already resolves coords to a real
  // planet.id via listPlanets, so we feed coords here regardless of input.
  const nlWithPlanet = defaultPlanet && !nlEN.match(/\d+:\d+:\d+/)
    ? `${nlEN} (on planet ${defaultPlanet})`
    : nlEN;
  const result = await addGoalTool.execute({ natural_language: nlWithPlanet });
  if ("error" in result) return `❌ ${result.error}`;
  const g = result.parsed_goal;
  const validationError = validateParsedGoal(g);
  if (validationError) {
    // Roll back — the addGoal tool already persisted the row; cancel it
    // so the planner doesn't leak a permanently-blocked entry.
    try { await store.updateStatus(g.id, "cancelled", `auto-cancelled: ${validationError}`); } catch {}
    return `❌ LLM returned malformed goal (${validationError}). Original input: \`${nl.slice(0, 80)}\`. Try rephrasing more concretely, e.g. "研究宇航学到 4" or "建金属矿到 18 在 Earth"`;
  }
  const idMap = planetIdToCoords();
  const target = targetWithCoords(g.target, idMap);
  const planetField = g.planet ? ` @ ${idMap.get(g.planet) ?? g.planet}` : "";
  return `✅ added \`${g.id.slice(0,12)}\` — P${g.priority} ${g.type} ${JSON.stringify(target)}${planetField}`;
}

async function handleList(rest) {
  const VALID = new Set(["pending", "active", "blocked", "completed", "cancelled"]);
  const raw = rest.trim().toLowerCase();
  // Only honor `rest` if it's an actual status keyword. Otherwise treat as
  // unfiltered ("list" with trailing noise like 当前任务/all goals/...).
  const filter = VALID.has(raw) ? raw : null;
  const rows = await store.list();
  const filtered = filter
    ? rows.filter((r) => r.status === filter)
    : rows.filter((r) => r.status !== "completed" && r.status !== "cancelled");
  if (filtered.length === 0) return filter ? `no goals with status=${filter}` : "no active goals";
  const sorted = filtered.sort((a,b) => b.goal.priority - a.goal.priority);
  const lines = sorted.slice(0, 15).map(fmtRow);
  const tail = sorted.length > 15 ? `\n_…${sorted.length - 15} more (use /list <status>)_` : "";
  return `**${filtered.length} goals${filter ? ` (${filter})` : ""}**\n${lines.join("\n")}${tail}`;
}

async function handleCancel(rest) {
  const { error, row } = await resolveByPrefix(rest.trim());
  if (error) return `❌ ${error}`;
  if (row.status === "completed" || row.status === "cancelled") return `goal already ${row.status}`;
  await store.updateStatus(row.goal.id, "cancelled", "cancelled via discord");
  return `🛑 cancelled \`${row.goal.id.slice(0,12)}\` — ${row.goal.type} ${JSON.stringify(row.goal.target)}`;
}

async function handlePause(rest) {
  const { error, row } = await resolveByPrefix(rest.trim());
  if (error) return `❌ ${error}`;
  if (row.status === "completed" || row.status === "cancelled") return `goal already ${row.status}`;
  await store.updateStatus(row.goal.id, "blocked", "PAUSED: via discord");
  return `⏸ paused \`${row.goal.id.slice(0,12)}\``;
}

async function handleResume(rest) {
  const { error, row } = await resolveByPrefix(rest.trim());
  if (error) return `❌ ${error}`;
  const paused = row.status === "blocked" && (row.reason ?? "").startsWith("PAUSED");
  if (!paused) return `goal is not paused (status=${row.status})`;
  await store.updateStatus(row.goal.id, "pending");
  return `▶ resumed \`${row.goal.id.slice(0,12)}\``;
}

// ogame standard base costs per tech/building, level 1. Cost at level N is
// base × MULT^(N-1). Research time uses lab; build time uses robotics+nanite.
// Reference: ogame.fandom.com (matches in-game formulas, server speed 1).
const TECH_COSTS = {
  // research — base, multiplier
  energyTech:                 { kind: "research", base: { m: 0,     c: 800,    d: 400  }, mult: 2 },
  laserTech:                  { kind: "research", base: { m: 200,   c: 100,    d: 0    }, mult: 2 },
  ionTech:                    { kind: "research", base: { m: 1000,  c: 300,    d: 100  }, mult: 2 },
  hyperspaceTech:             { kind: "research", base: { m: 0,     c: 4000,   d: 2000 }, mult: 2 },
  plasmaTech:                 { kind: "research", base: { m: 2000,  c: 4000,   d: 1000 }, mult: 2 },
  combustionDrive:            { kind: "research", base: { m: 400,   c: 0,      d: 600  }, mult: 2 },
  combustion:                 { kind: "research", base: { m: 400,   c: 0,      d: 600  }, mult: 2 },
  impulseDrive:               { kind: "research", base: { m: 2000,  c: 4000,   d: 600  }, mult: 2 },
  hyperspaceDrive:            { kind: "research", base: { m: 10000, c: 20000,  d: 6000 }, mult: 2 },
  espionageTech:              { kind: "research", base: { m: 200,   c: 1000,   d: 200  }, mult: 2 },
  computerTech:               { kind: "research", base: { m: 0,     c: 400,    d: 600  }, mult: 2 },
  astrophysics:               { kind: "research", base: { m: 4000,  c: 8000,   d: 4000 }, mult: 1.75 },
  intergalacticResearchNetwork:{ kind: "research", base: { m: 240000, c: 400000, d: 160000 }, mult: 2.5 },
  intergalactic:              { kind: "research", base: { m: 240000, c: 400000, d: 160000 }, mult: 2.5 },
  gravitonTech:               { kind: "research", base: { m: 0,     c: 0,      d: 0,  e: 300000 }, mult: 3 },
  weaponsTech:                { kind: "research", base: { m: 800,   c: 200,    d: 0    }, mult: 2 },
  weapons:                    { kind: "research", base: { m: 800,   c: 200,    d: 0    }, mult: 2 },
  shieldingTech:              { kind: "research", base: { m: 200,   c: 600,    d: 0    }, mult: 2 },
  shielding:                  { kind: "research", base: { m: 200,   c: 600,    d: 0    }, mult: 2 },
  armorTech:                  { kind: "research", base: { m: 1000,  c: 0,      d: 0    }, mult: 2 },
  armor:                      { kind: "research", base: { m: 1000,  c: 0,      d: 0    }, mult: 2 },
  // building — base, multiplier (cost only; time uses different formula)
  metalMine:        { kind: "building", base: { m: 60,    c: 15,     d: 0     }, mult: 1.5  },
  crystalMine:      { kind: "building", base: { m: 48,    c: 24,     d: 0     }, mult: 1.6  },
  deuteriumSynth:   { kind: "building", base: { m: 225,   c: 75,     d: 0     }, mult: 1.5  },
  solarPlant:       { kind: "building", base: { m: 75,    c: 30,     d: 0     }, mult: 1.5  },
  fusionReactor:    { kind: "building", base: { m: 900,   c: 360,    d: 180   }, mult: 1.8  },
  roboticsFactory:  { kind: "building", base: { m: 400,   c: 120,    d: 200   }, mult: 2    },
  naniteFactory:    { kind: "building", base: { m: 1000000,c: 500000, d: 100000}, mult: 2  },
  shipyard:         { kind: "building", base: { m: 400,   c: 200,    d: 100   }, mult: 2    },
  metalStorage:     { kind: "building", base: { m: 1000,  c: 0,      d: 0     }, mult: 2    },
  crystalStorage:   { kind: "building", base: { m: 1000,  c: 500,    d: 0     }, mult: 2    },
  deuteriumTank:    { kind: "building", base: { m: 1000,  c: 1000,   d: 0     }, mult: 2    },
  researchLab:      { kind: "building", base: { m: 200,   c: 400,    d: 200   }, mult: 2    },
};

// Server economy multiplier. ogame.gameforge.com defaults to x1 unless
// the universe is a speed event. Override via Discord with /eta speed=X.
const DEFAULT_SERVER_SPEED = 1;

function costAtLevel(techId, level) {
  const t = TECH_COSTS[techId];
  if (!t) return null;
  const mult = Math.pow(t.mult, level - 1);
  return {
    m: Math.floor(t.base.m * mult),
    c: Math.floor(t.base.c * mult),
    d: Math.floor((t.base.d ?? 0) * mult),
    e: Math.floor((t.base.e ?? 0) * mult),
  };
}

/** ogame research time (seconds): (m+c) / (1000 × (1+labLevel)) × 3600 / speed. */
function researchTimeSeconds(cost, labLevel, speed = DEFAULT_SERVER_SPEED) {
  return ((cost.m + cost.c) * 3600) / (1000 * (1 + labLevel) * speed);
}

/** ogame build time (seconds): (m+c) / (2500 × (1+robo) × 2^nano) × 3600 / speed. */
function buildTimeSeconds(cost, roboLevel = 0, nanoLevel = 0, speed = DEFAULT_SERVER_SPEED) {
  return ((cost.m + cost.c) * 3600) / (2500 * (1 + roboLevel) * Math.pow(2, nanoLevel) * speed);
}

function fmtDuration(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h${m.toString().padStart(2,"0")}m`;
}

/**
 * Walk the prereq tree post-order and compute time-to-complete in seconds.
 * Met nodes contribute 0. Unmet nodes contribute the time to research/build
 * EACH MISSING LEVEL from currentLevel+1 → targetLevel inclusive.
 *
 * The walk assumes serialized execution per slot type — all research is
 * one global slot, all building is one per planet slot. So total = sum.
 * (ogame really lets you parallelize one research + one build, but for an
 * order-of-magnitude estimate this is close enough; the gap is the
 * smaller of the two paths, rarely dominant.)
 */
function computeTreeEta(node, opts) {
  if (!node) return { total_seconds: 0, lines: [] };
  let total = 0;
  const lines = [];
  function walk(n, depth) {
    for (const c of n.children ?? []) walk(c, depth + 1);
    if (n.met) return;
    for (let lvl = n.currentLevel + 1; lvl <= n.targetLevel; lvl++) {
      const cost = costAtLevel(n.tech, lvl);
      if (!cost) { lines.push("  ".repeat(depth) + `${n.tech} L${lvl}: (cost unknown, skip)`); continue; }
      const t = n.kind === "research"
        ? researchTimeSeconds(cost, opts.labLevel, opts.speed)
        : buildTimeSeconds(cost, opts.roboLevel, opts.nanoLevel, opts.speed);
      total += t;
      const kind = n.kind === "research" ? "🧪" : "🏗";
      lines.push(`${"  ".repeat(depth)}${kind} ${n.tech} L${lvl}: ${fmtDuration(t)} (M=${cost.m} C=${cost.c}${cost.d?" D="+cost.d:""})`);
    }
  }
  walk(node, 1);
  return { total_seconds: total, lines };
}

async function handleEta(rest) {
  // Optional inline speed override: /eta speed=4
  let speed = DEFAULT_SERVER_SPEED;
  const m = rest.match(/speed\s*=\s*(\d+(?:\.\d+)?)/i);
  if (m) speed = Number(m[1]);

  // Pull live state via the sidecar — gives us prereq_tree AND any
  // current researchLab/robotics/nanite levels we can read off the
  // already-met building entries in that tree.
  const r = await fetch(`${SIDECAR}/ogamex/v1/goals`);
  const data = await r.json();
  const main = data.goals.find((g) => g.is_main_goal);
  if (!main) return "no main goal set. `/main <id-prefix>` first.";
  const tree = main.prereq_tree;
  if (!tree) return `main is set but has no prereq_tree (type=${main.type}).`;

  // Pluck current building levels from any "met" or "currentLevel>0"
  // building nodes inside the tree — that's the freshest signal we have.
  function findLevel(name) {
    let lvl = 0;
    function w(n) { if (n.tech === name) lvl = Math.max(lvl, n.currentLevel); (n.children ?? []).forEach(w); }
    w(tree);
    return lvl;
  }
  const labLevel = findLevel("researchLab");
  const roboLevel = findLevel("roboticsFactory");
  const nanoLevel = findLevel("naniteFactory");

  const { total_seconds, lines } = computeTreeEta(tree, {
    labLevel, roboLevel, nanoLevel, speed,
  });

  const head = `**ETA to ${main.type} ${JSON.stringify(main.target)}**\n` +
               `assumptions: researchLab=${labLevel}, robotics=${roboLevel}, nanite=${nanoLevel}, server speed=${speed}x\n` +
               `**total ≈ ${fmtDuration(total_seconds)}** (research-time only; excludes resource accumulation wait)\n\n`;
  const body = lines.length > 0 ? "```\n" + lines.join("\n") + "\n```" : "_(no unmet prereqs — main is achievable now)_";
  return head + body;
}

// ─────────────────────────────────────────────────────────────────────────
// Mine-upgrade optimizer — "矿升到几级最快"
//
// Given current resources/production/mine_levels and the main goal's
// resource cost (summed across all unmet prereqs), search over candidate
// mine upgrade targets and report which one minimizes total elapsed
// wall-clock time to reach the resource sum.
//
// Time model:
//   baseline_time  = max over (m,c,d) of  max(0, (need - cur) / prod_per_sec)
//   upgrade_time   = mine_build_time(L_cur → L_new) +
//                    max(0, (need + mine_cost - bank_at_t0_after_upgrade) / new_prod_per_sec)
//   where bank_at_t0_after_upgrade = cur - mine_cost_paid + prod * mine_build_time
//
// Deuterium synth production has a temperature factor that varies by
// planet; we read PRODUCTION rate from the state snapshot directly
// rather than recomputing, so the planet's actual modifiers apply.
// ─────────────────────────────────────────────────────────────────────────

// Production rate formula for a mine at level L (per hour, base, x1 universe).
// metalMine: 30 * L * 1.1^L * speed
// crystalMine: 20 * L * 1.1^L * speed
// deuteriumSynth: 10 * L * 1.1^L * (1.44 - 0.004*temp) * speed
function mineBaseProdPerHr(building, level, speed = 1, planetTempAvg = 30) {
  if (level <= 0) return 0;
  if (building === "metalMine")      return 30 * level * Math.pow(1.1, level) * speed;
  if (building === "crystalMine")    return 20 * level * Math.pow(1.1, level) * speed;
  if (building === "deuteriumSynth") return 10 * level * Math.pow(1.1, level) * (1.44 - 0.004 * planetTempAvg) * speed;
  return 0;
}

function mineCostAtLevel(building, level) {
  return costAtLevel(building, level); // reuse the table from handleEta
}

// ogame energy formulas (per hour, x1; speed cancels in delta calc).
// metalMine consumes:        10 * L * 1.1^L
// crystalMine consumes:      10 * L * 1.1^L
// deuteriumSynth consumes:   20 * L * 1.1^L
// solarPlant produces:       20 * L * 1.1^L
// fusionReactor produces:    50 * L * 1.1^L * (1 + 0.02 * energyTech)
function mineEnergyConsumption(building, level) {
  if (level <= 0) return 0;
  const base = (building === "deuteriumSynth") ? 20 : 10;
  return base * level * Math.pow(1.1, level);
}
function solarProduction(level) {
  if (level <= 0) return 0;
  return 20 * level * Math.pow(1.1, level);
}
/** Net energy change if we upgrade `building` from L_cur to L_new. Negative = costs more energy. */
function mineEnergyDelta(building, L_cur, L_new) {
  return -(mineEnergyConsumption(building, L_new) - mineEnergyConsumption(building, L_cur));
}

// v0.0.756 — operator "为什么有两套算法 统一一下". Single-level build time
// delegated to @ogamex/shared/build_time (compiled JS). This per-range helper
// keeps the v0.0.470 accelerator self-acceleration loop but uses the unified
// formula for each per-level calculation.
// Path: deployed daemon lives at ~/.openclaw/extensions/ogamex/runtime/, shared
// at ~/.openclaw/extensions/ogamex/node_modules/@ogamex/shared/dist/, so
// "../node_modules/@ogamex/shared/dist/build_time.js" resolves correctly.
import { buildingSec as sharedBuildingSec } from "../node_modules/@ogamex/shared/dist/build_time.js";

function buildSecondsForRange(building, fromLvl, toLvl, robo, nano, speed = 1) {
  // v0.0.470: accelerator self-acceleration (operator 2026-05-30 "优化错了
  // 就修改优化算法"). When iterating through levels of an accelerator
  // building, each COMPLETED level boosts subsequent level builds —
  // robotics L+1 grows the (1+R) divisor by 1; naniteFactory L+1 doubles
  // 2^N. Without tracking this, daemon overestimated total time by 2^range
  // for nanite — making robo L16 falsely look beneficial for nanite L7.
  let total = 0;
  let curRobo = robo;
  let curNano = nano;
  for (let L = fromLvl + 1; L <= toLvl; L++) {
    const c = mineCostAtLevel(building, L);
    if (!c) return null;
    total += sharedBuildingSec(c, { robotics: curRobo, nanite: curNano }, speed);
    if (building === "roboticsFactory") curRobo = L;
    else if (building === "naniteFactory") curNano = L;
  }
  return total;
}

function cumulativeMineCost(building, fromLvl, toLvl) {
  let m = 0, c = 0, d = 0;
  for (let L = fromLvl + 1; L <= toLvl; L++) {
    const co = mineCostAtLevel(building, L);
    if (!co) return null;
    m += co.m; c += co.c; d += co.d ?? 0;
  }
  return { m, c, d };
}

/** Wall-clock seconds to accumulate `need` given start bank + production rates per second. */
function waitFor(need, bank, prodPerSec) {
  let worst = 0;
  for (const k of ["m", "c", "d"]) {
    const deficit = (need[k] ?? 0) - (bank[k] ?? 0);
    if (deficit <= 0) continue;
    const rate = prodPerSec[k] ?? 0;
    if (rate <= 0) return Infinity; // would never accumulate
    worst = Math.max(worst, deficit / rate);
  }
  return worst;
}

/**
 * Sum the resource cost of every unmet level across the prereq tree.
 * This is the "what we still need to PAY" budget once enough resources
 * pile up — we ignore time ordering on purpose (the optimizer compares
 * one big lump-sum target across strategies, which is the conservative
 * estimate; if anything, the optimal strategy is even faster than this
 * predicts).
 */
function sumPrereqResourceCost(tree) {
  let total = { m: 0, c: 0, d: 0 };
  function walk(n) {
    if (!n.met) {
      for (let lvl = n.currentLevel + 1; lvl <= n.targetLevel; lvl++) {
        const c = costAtLevel(n.tech, lvl);
        if (!c) continue;
        total.m += c.m; total.c += c.c; total.d += c.d ?? 0;
      }
    }
    for (const ch of n.children ?? []) walk(ch);
  }
  walk(tree);
  return total;
}

/**
 * Pure compute — returns { baseline_sec, candidates, planet, researchSec }
 * or { error: "..." }. Used both by the human-facing handleOptimize and by
 * the autonomous optimizer loop, so they share one truth.
 */
// ─── Optimizer v2 — correct semantics ───────────────────────────────────
// Replaces the original computeOptimization which had several logic bugs:
//   1. Double-counted waits (subtree_eta_seconds + baselineWaitSec)
//   2. Considered candidates planner would naturally build anyway → 0 saving
//   3. Multiplied entire subtree by factor (ignored wait portion + cross-type nodes)
//   4. Solar formula assumed full wait elimination → ~18h spurious savings
// v2 walks the tree to compute (a) min prereq level of each accelerator
// (planner builds to this naturally — no novel savings from suggesting it),
// and (b) sum of m+c cost of nodes ACTUALLY affected by each accelerator.
// Then for each candidate level beyond min, savings = (build time saved on
// affected nodes) - (extra cost of building accelerator beyond min).
//
// Accelerator → which kinds of nodes it speeds up:
//   roboticsFactory  → all "building" nodes (factor 2500*(1+L))
//   naniteFactory    → all "building" nodes (factor 2500*2^L)
//   researchLab      → all "research" nodes (factor 1000*(1+L))
//   shipyard         → all ship build (rarely in subtree — main goal IS the ship)
//   solar/mines      → indirect via production rate (separate analysis below)

function findMinRequiredAccelLevel(tree, accelerator) {
  let maxLvl = 0;
  function walk(n) {
    if (n.tech === accelerator) maxLvl = Math.max(maxLvl, n.targetLevel);
    for (const c of n.children ?? []) walk(c);
  }
  walk(tree);
  return maxLvl;
}

function sumAffectedCost(tree, accelerator) {
  // v0.0.471: normalize by tech intrinsic per-level multiplier (operator
  // 2026-05-30 fix). naniteFactory has 2^L in build_time denom; its cost
  // also scales 2^L. Counting raw cost overstates savings by 2^L because
  // the cancellation in real build time is not reflected in the simplified
  // savings formula. Without normalization, daemon recommended robo L16
  // for nanite L7 with phantom "saves 6d19h" — real net savings NEGATIVE.
  let total = 0;
  function nodeAffected(n) {
    if (accelerator === "researchLab") return n.kind === "research";
    if (accelerator === "roboticsFactory" || accelerator === "naniteFactory") return n.kind === "building";
    if (accelerator === "shipyard") return n.kind === "ship";
    return false;
  }
  function walk(n) {
    if (!n.met && nodeAffected(n)) {
      for (let lvl = n.currentLevel + 1; lvl <= n.targetLevel; lvl++) {
        const c = costAtLevel(n.tech, lvl);
        if (c) {
          const intrinsicMult = (n.tech === "naniteFactory") ? Math.pow(2, lvl - 1) : 1;
          total += (c.m + c.c) / intrinsicMult;
        }
      }
    }
    for (const c of n.children ?? []) walk(c);
  }
  walk(tree);
  return total;
}

function accelFactor(accelerator, lvl) {
  // Returns DENOMINATOR of build/research time formula.
  // build_sec = (m+c) * 3600 / DENOM
  if (accelerator === "roboticsFactory") return 2500 * (1 + lvl);
  if (accelerator === "naniteFactory")   return 2500 * Math.pow(2, lvl);
  if (accelerator === "researchLab")     return 1000 * (1 + lvl);
  if (accelerator === "shipyard")        return 2500 * (1 + lvl);
  return 0;
}

function appliesToGoalType(accelerator, goalType) {
  if (goalType === "research") return accelerator === "researchLab";
  if (goalType === "build")    return accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  if (goalType === "build_ships") return accelerator === "shipyard" || accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  // 2026-06-05 — colonize cascades through building 1 colony ship at
  // the source planet, so it benefits from the same shipyard +
  // robotics/nanite accelerators as build_ships. Without this branch
  // the optimizer returned 0 candidates for daigang's s275 colonize
  // and emitted no opt- goal even after threshold was lowered.
  if (goalType === "colonize") return accelerator === "shipyard" || accelerator === "roboticsFactory" || accelerator === "naniteFactory";
  return false; // lifeform_building: no known regular-infra accelerator
}

// Per-goal optimizer. Pure (state + goal) → candidates. Used both by
// computeOptimization (which picks the bottleneck goal as a default focus)
// AND by optimizerTick which iterates every active user goal — operator
// required "每个加入的任务都要优化".
function computeOptimizationForGoal(state, main) {
  if (!main || !main.prereq_tree) return { error: "no tree" };
  // v0.0.739 — operator 2026-06-04 "现在忽略矿的时间, 不是新账号了".
  // Post-expedition phase (astrophysics >= 4): chain bottleneck is
  // resource shortage, planner just emits "waiting for resources"
  // with no production-wait ETA. Build-time accelerators (robotics /
  // nanite / researchLab / shipyard) only compress build_sec, not
  // wall-clock — they can't overcome resource shortage. Skip optimizer
  // entirely in this phase to avoid generating opt- goals that ogame
  // could even reject (e.g. 120012 fields-full when accelerator chain
  // tries to upgrade a saturated planet).
  const astro = state.research?.levels?.astrophysics ?? 0;
  if (astro >= 4) {
    return { baseline_sec: main.prereq_tree.subtree_eta_seconds ?? 0, baselineWaitSec: 0, researchSeconds: main.prereq_tree.subtree_eta_seconds ?? 0, candidates: [], planet: null, need: { m: 0, c: 0, d: 0 }, cur: { m: 0, c: 0, d: 0 }, curEnergy: 0, main, note: 'post-phase: optimizer skipped (resource-bottlenecked chain)' };
  }
  const planetsMap = state.planets ?? {};
  const MOON_ONLY_BUILDINGS = new Set(["lunarBase","sensorPhalanx","jumpgate","moonBase","moon_base","lunar_base","sensor_phalanx","jump_gate"]);
  const findPlanet = (ref) => {
    if (!ref) return null;
    if (planetsMap[ref]) return planetsMap[ref];
    const matches = [];
    for (const p of Object.values(planetsMap)) {
      if (Array.isArray(p?.coords) && p.coords.join(":") === ref) matches.push(p);
    }
    if (matches.length === 0) return null;
    const wantMoon = typeof main !== "undefined" && main && MOON_ONLY_BUILDINGS.has(main?.target?.building);
    if (wantMoon) {
      const moon = matches.find((p) => p?.type === "moon");
      if (moon) return moon;
    }
    return matches[0];
  };
  const planet = findPlanet(main.planet);
  if (!planet) return { error: `main goal planet not in state: ${main.planet}` };
  const tree = main.prereq_tree;
  const mainGoalType = main.type;
  const speed = state.server?.speed ?? 1;
  const cur = { m: planet.resources?.m ?? 0, c: planet.resources?.c ?? 0, d: planet.resources?.d ?? 0 };
  const prodPerSec = { m: (planet.production?.m_h ?? 0) / 3600, c: (planet.production?.c_h ?? 0) / 3600, d: (planet.production?.d_h ?? 0) / 3600 };
  const robo = planet.buildings?.roboticsFactory ?? 0;
  const nano = planet.buildings?.naniteFactory ?? 0;
  const baselineTotalSec = tree.subtree_eta_seconds ?? 0;
  const candidates = [];
  // For each accelerator that applies to main goal type:
  for (const accel of ["roboticsFactory", "naniteFactory", "researchLab", "shipyard"]) {
    if (!appliesToGoalType(accel, mainGoalType)) continue;
    const curLvl = planet.buildings?.[accel] ?? 0;
    const minRequired = findMinRequiredAccelLevel(tree, accel);
    // Base effective level during planner's natural execution.
    const baseEffective = Math.max(curLvl, minRequired);
    const affectedCost = sumAffectedCost(tree, accel);
    if (affectedCost === 0) continue; // no nodes affected → no savings possible
    // Each EXTRA level beyond baseEffective shrinks affected build time.
    for (let dL = 1; dL <= 4; dL++) {
      const L_new = baseEffective + dL;
      const denomOld = accelFactor(accel, baseEffective);
      const denomNew = accelFactor(accel, L_new);
      if (denomOld <= 0 || denomNew <= 0) continue;
      // v0.0.691 — operator 2026-06-03 "机器人工厂的公式有没有用错".
      // BUG: original formula missing 2^nano (for buildings) or (1+robo) (for nanite).
      // With nanite L7 this overestimated savings by 128×. accelFactor(accel,L)
      // only returns the FACTOR-specific part; need to divide by the OTHER
      // structural factor too:
      //   roboticsFactory affects building → also /2^nano
      //   naniteFactory   affects building → also /(1+robo)
      //   shipyard        affects ship builds → also /2^nano (ships use 2^nano)
      //   researchLab     affects research → no extra factor
      const extraStructFactor =
        accel === "roboticsFactory" ? Math.pow(2, nano) :
        accel === "naniteFactory"   ? (1 + robo) :
        accel === "shipyard"        ? Math.pow(2, nano) :
        1;
      // Savings on affected nodes (build time only — wait time unaffected).
      const buildSaving = affectedCost * 3600 * (1 / denomOld - 1 / denomNew) / speed / extraStructFactor;
      // Cost of building extra levels (from baseEffective to L_new).
      const extraCost = cumulativeMineCost(accel, baseEffective, L_new);
      if (!extraCost) continue;
      // Time to build extra levels (uses CURRENT planet robo/nano — we're
      // measuring what it costs to do this AT planner's current pace).
      const extraBuildSec = buildSecondsForRange(accel, baseEffective, L_new, robo, nano, speed);
      if (extraBuildSec === null) continue;
      // v0.0.690 — operator 2026-06-03 "不要考虑资源等待时间, 这样会算错".
      // Accelerator built optimally — ignore wait_for_resources.
      const extraTime = extraBuildSec;
      const netSavings = buildSaving - extraTime;
      candidates.push({
        mine: accel, L_cur: curLvl, L_new, dL,
        mineBuildSec: extraBuildSec, mineWaitSec: 0,
        totalSec: extraTime + Math.max(0, baselineTotalSec - buildSaving),
        savings: netSavings,
        baseEffective, minRequired, affectedCost,
        note: dL <= (baseEffective - curLvl) ? "tracks natural plan" : "beyond prereq",
      });
    }
  }
  candidates.sort((a, b) => b.savings - a.savings);
  return { baseline_sec: baselineTotalSec, baselineWaitSec: 0, researchSeconds: baselineTotalSec, candidates, planet, need: { m: 0, c: 0, d: 0 }, cur, curEnergy: planet.resources?.e ?? 0, main };
}

// Bottleneck wrapper — fetches state + goals, picks goal with largest subtree
// ETA, calls computeOptimizationForGoal. Used by /eta Discord command.
async function computeOptimization() {
  const [stateResp, goalsResp] = await Promise.all([
    fetch(`${SIDECAR}/ogamex/v1/state`), fetch(`${SIDECAR}/ogamex/v1/goals`),
  ]);
  if (!stateResp.ok || !goalsResp.ok) return { error: `sidecar unreachable` };
  const state = await stateResp.json();
  const goals = await goalsResp.json();
  if (state.ok === false) return { error: state.reason ?? "no snapshot" };
  // Phase 7c.6 (2026-06-05) — operator "所有任务只进优化": allow ALL
  // active/blocked/pending user-created goals to enter the optimizer.
  // Exclude only daemon-created derivatives (opt-/exp-/expb-) to avoid
  // recursive optimization of optimizer's own children.
  const activeGoals = goals.goals.filter(
    (g) => !g.id.startsWith("opt-") && !g.id.startsWith("exp-") && !g.id.startsWith("expb-")
        && ["active", "blocked", "pending"].includes(g.status),
  );
  if (activeGoals.length === 0) return { error: "no active user goals" };
  const main = activeGoals.sort((a, b) => (b.prereq_tree?.subtree_eta_seconds ?? 0) - (a.prereq_tree?.subtree_eta_seconds ?? 0))[0];
  return computeOptimizationForGoal(state, main);
}

// Per-goal iteration — used by optimizerTick. Returns array of
// { goal, optimization } pairs for ALL active user goals (excluding opt-/exp-).
// Phase 7c.6 — uses CURRENT_BEARER so sidecar's resolveBearer routes
// /v1/state and /v1/goals to the per-tenant userStates + goalsStorePg.
async function computeOptimizationsAllGoals() {
  const sidecarHeaders = CURRENT_BEARER ? { "Authorization": `Bearer ${CURRENT_BEARER}` } : {};
  const [stateResp, goalsResp] = await Promise.all([
    fetch(`${SIDECAR}/ogamex/v1/state`, { headers: sidecarHeaders }),
    fetch(`${SIDECAR}/ogamex/v1/goals`, { headers: sidecarHeaders }),
  ]);
  if (!stateResp.ok || !goalsResp.ok) return { error: `sidecar unreachable` };
  const state = await stateResp.json();
  const goals = await goalsResp.json();
  if (state.ok === false) return { error: state.reason ?? "no snapshot" };
  const activeGoals = goals.goals.filter(
    (g) => !g.id.startsWith("opt-") && !g.id.startsWith("exp-") && !g.id.startsWith("expb-")
        && ["active", "blocked", "pending"].includes(g.status),
  );
  if (activeGoals.length === 0) return { results: [] };
  const results = [];
  for (const g of activeGoals) {
    const r = computeOptimizationForGoal(state, g);
    if (r && !r.error) results.push({ goal: g, optimization: r });
  }
  return { results };
}

async function computeOptimizationLegacy_unused() {
  const [stateResp, goalsResp] = await Promise.all([
    fetch(`${SIDECAR}/ogamex/v1/state`),
    fetch(`${SIDECAR}/ogamex/v1/goals`),
  ]);
  if (!stateResp.ok || !goalsResp.ok) return { error: `sidecar unreachable (state=${stateResp.status} goals=${goalsResp.status})` };
  const state = await stateResp.json();
  const goals = await goalsResp.json();
  if (state.ok === false) return { error: state.reason ?? "no snapshot" };
  // Aggregate resource demand across ALL non-terminal goals — operator
  // doesn't have to mark a main goal. We sum need.m/c/d and pick mine
  // upgrades that maximally accelerate the SLOWEST goal in the bucket.
  const candidatesGoals = goals.goals.filter(
    (g) => ["active", "blocked", "pending"].includes(g.status) && g.prereq_tree,
  );
  if (candidatesGoals.length === 0) {
    // No active goals — recommend mine with shortest payback (ROI-based,
    // bootstrap mode). Use a synthetic "goal" that demands 10x the cost
    // of a single L+1 upgrade so payback comparison stays meaningful.
    return { error: "no active goals — set one via /add then optimizer can rank" };
  }
  // Pick the goal with the LARGEST eta (the bottleneck) — speeding it up
  // benefits operator the most. Aggregating costs across goals would be
  // more accurate but adds noise from concurrent independent goals.
  const main = candidatesGoals.sort((a, b) => (b.prereq_tree.subtree_eta_seconds ?? 0) - (a.prereq_tree.subtree_eta_seconds ?? 0))[0];
  // Optimizer's accelerator MUST live on the SAME planet as the main goal.
  // Earlier: hard-coded Object.values()[0] (home) — false savings when goal
  // was on a colony. Look up by main.planet (id-or-coords).
  const planetsMap = state.planets ?? {};
  const MOON_ONLY_BUILDINGS = new Set(["lunarBase","sensorPhalanx","jumpgate","moonBase","moon_base","lunar_base","sensor_phalanx","jump_gate"]);
  const findPlanet = (ref) => {
    if (!ref) return null;
    if (planetsMap[ref]) return planetsMap[ref];
    const matches = [];
    for (const p of Object.values(planetsMap)) {
      if (Array.isArray(p?.coords) && p.coords.join(":") === ref) matches.push(p);
    }
    if (matches.length === 0) return null;
    const wantMoon = typeof main !== "undefined" && main && MOON_ONLY_BUILDINGS.has(main?.target?.building);
    if (wantMoon) {
      const moon = matches.find((p) => p?.type === "moon");
      if (moon) return moon;
    }
    return matches[0];
  };
  const planet = findPlanet(main.planet) ?? Object.values(planetsMap)[0];
  if (!planet) return { error: "no planet data" };
  console.log(`[auto] main goal on planet ${planet.coords?.join(":") ?? planet.id} (target: ${planet.id})`);
  // Sanity gate: planet state must look CONSISTENT before optimizer proposes
  // upgrades. Avoid suggesting "solar L1" / "metalMine L1" on a planet whose
  // dict is corrupted (e.g. solar > 0 with all mines = 0 is impossible in
  // real ogame physics — stale page scrape). Skip and ask operator to visit
  // supplies page.
  // Sanity check: solar >= 10 with mines all 0 is physically impossible
  // (sustained solar L10+ needs accumulated metal/crystal beyond starter cargo).
  // Looser threshold than before — fresh colonies legitimately have solar 1-6
  // with mines=0 funded by colonyShip's 5000m cargo.
  const b = planet.buildings ?? {};
  if ((b.solarPlant ?? 0) >= 10 && (b.metalMine ?? 0) === 0 && (b.crystalMine ?? 0) === 0 && (b.deuteriumSynth ?? 0) === 0) {
    return { error: `planet ${planet.coords?.join(":")} state stale (solar=${b.solarPlant} but mines all 0). Visit supplies page to refresh.` };
  }
  const robo = planet.buildings?.roboticsFactory ?? 0;
  const nano = planet.buildings?.naniteFactory ?? 0;
  const speed = state.server?.speed ?? 1;
  const cur = { m: planet.resources?.m ?? 0, c: planet.resources?.c ?? 0, d: planet.resources?.d ?? 0 };
  const prodPerSec = { m: (planet.production?.m_h ?? 0) / 3600, c: (planet.production?.c_h ?? 0) / 3600, d: (planet.production?.d_h ?? 0) / 3600 };
  const need = sumPrereqResourceCost(main.prereq_tree);
  const researchSeconds = main.prereq_tree.subtree_eta_seconds ?? 0;
  // subtree_eta_seconds already includes per-level resource waits (sidecar
  // computes it that way as of v0.0.165). DON'T add baselineWaitSec again
  // — that would double-count. Keep baselineWaitSec for diagnostic only.
  const baselineWaitSec = waitFor(need, cur, prodPerSec);
  const baselineTotalSec = researchSeconds; // = subtree_eta_seconds, includes waits

  const curEnergy = planet.resources?.e ?? 0;

  const candidates = [];
  // Standard mine candidates — filter out ones that would push energy < 0
  // (matches the planner's ENERGY_GATED block; recommending them would
  // just create a blocked goal). Mark "needs_solar" so the report can
  // explain why an obvious-looking upgrade was skipped.
  for (const mine of ["metalMine", "crystalMine", "deuteriumSynth"]) {
    const L_cur = planet.buildings?.[mine] ?? 0;
    for (let dL = 1; dL <= 8; dL++) {
      const L_new = L_cur + dL;
      const mineBuildSec = buildSecondsForRange(mine, L_cur, L_new, robo, nano, speed);
      if (mineBuildSec === null) continue;
      const mineCost = cumulativeMineCost(mine, L_cur, L_new);
      if (!mineCost) continue;
      const mineWaitSec = waitFor(mineCost, cur, prodPerSec);
      if (!isFinite(mineWaitSec)) continue;
      const energyDelta = mineEnergyDelta(mine, L_cur, L_new);
      const energyAfter = curEnergy + energyDelta;
      // Skip if upgrade would leave energy negative — the planner's
      // ENERGY_GATED check would block the resulting goal anyway, and the
      // production math is wrong below 0 energy (mines under-produce).
      if (energyAfter < 0) continue;
      const elapsed = mineWaitSec + mineBuildSec;
      const bankEnd = {
        m: cur.m + prodPerSec.m * elapsed - mineCost.m,
        c: cur.c + prodPerSec.c * elapsed - mineCost.c,
        d: cur.d + prodPerSec.d * elapsed - mineCost.d,
      };
      const newProdHr = { m: planet.production?.m_h ?? 0, c: planet.production?.c_h ?? 0, d: planet.production?.d_h ?? 0 };
      const oldProdHr = mineBaseProdPerHr(mine, L_cur, speed);
      const newMineProdHr = mineBaseProdPerHr(mine, L_new, speed);
      if (mine === "metalMine")      newProdHr.m += newMineProdHr - oldProdHr;
      if (mine === "crystalMine")    newProdHr.c += newMineProdHr - oldProdHr;
      if (mine === "deuteriumSynth") newProdHr.d += newMineProdHr - oldProdHr;
      const newProdPerSec = { m: newProdHr.m / 3600, c: newProdHr.c / 3600, d: newProdHr.d / 3600 };
      const remainingWaitSec = waitFor(need, bankEnd, newProdPerSec);
      const totalSec = elapsed + remainingWaitSec + researchSeconds;
      candidates.push({
        mine, L_cur, L_new, dL, mineBuildSec, mineWaitSec,
        remainingWaitSec, totalSec,
        savings: baselineTotalSec - totalSec,
        energy_delta: energyDelta,
        energy_after: energyAfter,
      });
    }
  }

  // If current energy is already at deficit OR a mine upgrade is gated by
  // energy, also evaluate solarPlant upgrades — these don't speed up
  // production directly but UNLOCK higher-energy mine upgrades and
  // restore -1+% production capacity. We model their value indirectly:
  // upgrade solar enough to make the BEST blocked mine candidate viable.
  // Also suggest solar when energy is low (< 200) — even positive, the
  // headroom isn't enough to enable mine upgrades (each level consumes
  // 50-150 more energy). Without this branch, the optimizer stalls
  // forever once mines outgrow solar.
  // Infrastructure upgrade candidates — building reductions for build_time:
  //   researchLab: research_time × (1+old)/(1+new)
  //   roboticsFactory: building_time × (1+old)/(1+new)
  //   naniteFactory:   building_time × 2^(old-new)  (each level halves)
  //   shipyard:        ship_time × (1+old)/(1+new)  (used when main is build_ships)
  // We don't decompose prereq_tree into research/building/ship time portions
  // — simplified: apply factor to the WHOLE subtree_eta. Slightly optimistic
  // for mixed goals (over-saves for research nodes when robo upgrade applied)
  // but the cost-vs-savings ranking still picks correct top candidate.
  const evalInfraUpgrade = (building, getFactor, maxDL = 4) => {
    const L_cur = planet.buildings?.[building] ?? 0;
    for (let dL = 1; dL <= maxDL; dL++) {
      const L_new = L_cur + dL;
      const buildSec = buildSecondsForRange(building, L_cur, L_new, robo, nano, speed);
      if (buildSec === null) continue;
      const cost = cumulativeMineCost(building, L_cur, L_new);
      if (!cost) continue;
      const waitSec = waitFor(cost, cur, prodPerSec);
      if (!isFinite(waitSec)) continue;
      const factor = getFactor(L_cur, L_new);
      const newSubtreeSec = researchSeconds * factor;
      const elapsed = waitSec + buildSec;
      const bankEnd = {
        m: cur.m + prodPerSec.m * elapsed - cost.m,
        c: cur.c + prodPerSec.c * elapsed - cost.c,
        d: cur.d + prodPerSec.d * elapsed - cost.d,
      };
      const remainingWaitSec = waitFor(need, bankEnd, prodPerSec);
      const totalSec = elapsed + remainingWaitSec + newSubtreeSec;
      candidates.push({
        mine: building, L_cur, L_new, dL,
        mineBuildSec: buildSec, mineWaitSec: waitSec,
        remainingWaitSec, totalSec,
        savings: baselineTotalSec - totalSec,
        energy_delta: 0, energy_after: curEnergy,
      });
    }
  };
  const mainGoalType = main.type;
  if (researchSeconds > 60) {
    // Match accelerator to main goal type — using the wrong one is what
    // produced "为啥要建机器人工厂8级？" earlier (roboticsFactory applied
    // factor against a research subtree, false savings).
    //
    //  research          → researchLab (each lab level cuts research time)
    //  build (regular)   → roboticsFactory + naniteFactory (building speed)
    //  lifeform_building → no infra accelerator known to apply; skip
    //  build_ships       → shipyard + roboticsFactory + naniteFactory
    if (mainGoalType === "research") {
      evalInfraUpgrade("researchLab", (cur, neu) => (1 + cur) / (1 + neu));
    } else if (mainGoalType === "build") {
      evalInfraUpgrade("roboticsFactory", (cur, neu) => (1 + cur) / (1 + neu));
      evalInfraUpgrade("naniteFactory", (cur, neu) => Math.pow(2, cur - neu), 2);
    } else if (mainGoalType === "build_ships") {
      evalInfraUpgrade("shipyard", (cur, neu) => (1 + cur) / (1 + neu));
      evalInfraUpgrade("roboticsFactory", (cur, neu) => (1 + cur) / (1 + neu));
      evalInfraUpgrade("naniteFactory", (cur, neu) => Math.pow(2, cur - neu), 2);
    }
    // lifeform_building: lf queue is independent; no known regular-infra
    // accelerator. Owner can request specifically if data emerges.
  }
  const SOLAR_HEADROOM_THRESHOLD = 200;
  if (curEnergy < SOLAR_HEADROOM_THRESHOLD) {
    const solarLvl = planet.buildings?.solarPlant ?? 0;
    for (let dL = 1; dL <= 4; dL++) {
      const L_new = solarLvl + dL;
      const buildSec = buildSecondsForRange("solarPlant", solarLvl, L_new, robo, nano, speed);
      if (buildSec === null) continue;
      const cost = cumulativeMineCost("solarPlant", solarLvl, L_new);
      if (!cost) continue;
      const waitSec = waitFor(cost, cur, prodPerSec);
      if (!isFinite(waitSec)) continue;
      const energyGain = solarProduction(L_new) - solarProduction(solarLvl);
      // Solar doesn't accelerate research time directly — its value is
      // unblocking mine upgrades. For the candidate list we score it
      // conservatively as if it just restored production capacity (which
      // mines lose proportionally when e<0).
      // Approximate: if energy was at -X% deficit, restoring 0 boosts
      // mine output by X%. Use ratio of restored energy.
      const elapsed = waitSec + buildSec;
      candidates.push({
        mine: "solarPlant", L_cur: solarLvl, L_new, dL,
        mineBuildSec: buildSec, mineWaitSec: waitSec,
        remainingWaitSec: Math.max(0, baselineWaitSec - elapsed),
        totalSec: elapsed + researchSeconds, // conservative; real total can be less if it unblocks mines
        savings: baselineTotalSec - (elapsed + researchSeconds),
        energy_delta: energyGain,
        energy_after: curEnergy + energyGain,
        note: "energy unblock",
      });
    }
  }

  candidates.sort((a, b) => a.totalSec - b.totalSec);
  return { baseline_sec: baselineTotalSec, baselineWaitSec, researchSeconds, candidates, planet, need, cur, curEnergy, main };
}

function fmtH(sec) {
  if (!isFinite(sec)) return "∞";
  if (sec < 60) return `${Math.round(sec)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (h < 24) return `${h}h${m.toString().padStart(2,"0")}m`;
  return `${Math.floor(h/24)}d${(h%24).toString().padStart(2,"0")}h`;
}

async function handleOptimize(rest) {
  const r = await computeOptimization();
  if (r.error) return `❌ ${r.error}`;
  const { baseline_sec, baselineWaitSec, researchSeconds, candidates, planet, need, cur } = r;
  const robo = planet.buildings?.roboticsFactory ?? 0;
  const nano = planet.buildings?.naniteFactory ?? 0;

  const energyTag = r.curEnergy < 0 ? `⚡ **${r.curEnergy}** (deficit)` : `⚡ ${r.curEnergy} (surplus)`;
  const head = `**Optimize main-goal completion**\n` +
               `planet ${planet.name} (${planet.coords}) · robo=${robo} nano=${nano} · ${energyTag}\n` +
               `need: M=${need.m.toLocaleString()} C=${need.c.toLocaleString()} D=${need.d.toLocaleString()}\n` +
               `now : M=${Math.round(cur.m).toLocaleString()} C=${Math.round(cur.c).toLocaleString()} D=${Math.round(cur.d).toLocaleString()}\n` +
               `prod/h: M=${planet.production?.m_h?.toFixed(0)} C=${planet.production?.c_h?.toFixed(0)} D=${planet.production?.d_h?.toFixed(0)}\n\n` +
               `**baseline (no upgrade): ${fmtH(baseline_sec)}** (${fmtH(baselineWaitSec)} res-wait + ${fmtH(researchSeconds)} research)\n\n`;
  if (candidates.length === 0) {
    return head + (r.curEnergy < 0
      ? `_(no viable candidates — energy is **${r.curEnergy}**, all mine upgrades blocked. Build solarPlant first.)_`
      : "_(no viable candidates)_");
  }
  const best = candidates[0];
  const top5 = candidates.slice(0, 5).map((c, i) => {
    const sav = c.savings > 0 ? `💚 saves ${fmtH(c.savings)}` : c.savings < 0 ? `🔴 +${fmtH(-c.savings)}` : `—`;
    const note = c.note ? ` [${c.note}]` : "";
    const energyTag = c.energy_delta < 0 ? ` ⚡${c.energy_delta}` : c.energy_delta > 0 ? ` ⚡+${c.energy_delta}` : "";
    return `${i===0?"⭐":"  "} ${c.mine} ${c.L_cur}→${c.L_new}: total ${fmtH(c.totalSec)} ${sav}${energyTag}${note}`;
  });
  return head + "**top 5**:\n```\n" + top5.join("\n") + "\n```\n" +
    (best.savings > 0 ? `🎯 upgrade **${best.mine}** to L${best.L_new} (saves ${fmtH(best.savings)})` : `🛑 no upgrade helps, just wait`);
}

// ─────────────────────────────────────────────────────────────────────────
// Autonomous optimizer loop — runs every 60s; inserts/updates a
// "is_optimizer_managed" build goal at priority 8 (below main P9). Uses
// hysteresis (10-min savings threshold) to avoid thrashing between
// adjacent recommendations as resources tick in.
// ─────────────────────────────────────────────────────────────────────────

// AUTO is now ALWAYS ON — both optimizer + expedition daemons run from
// boot, no operator toggle needed. Persistence file kept for backwards
// compat but not consulted on startup.
const AUTO_STATE_PATH = "/home/ddxs/.openclaw/workspace/ogamex/runtime/ogamex-auto.json";
const AUTO_TICK_MS = 60_000;
// Phase 7c.6 (2026-06-05) — threshold lowered 1800→60s per operator
// "好了, 没看到优化过的 tree" on a fresh s275-en colonize tree where
// every prereq sits at L0/L1; per-candidate savings rarely cross 30
// minutes on those small upgrades, so the optimizer was emitting no
// opt- goals at all. Lock-in policy (AUTO_LOCKIN_WHEN_BUILDING below)
// still prevents the cancel-mid-build flip-flop that the higher
// threshold originally hedged against.
const AUTO_SAVINGS_THRESHOLD_SEC = 60;
// Once a candidate is dispatched (i.e. building started on ogame), the
// optimizer must NOT supersede it — cancelling mid-build wastes resources
// and time. Lock-in policy: if state.build_q.building matches the current
// opt- goal's target, refuse to replace it.
const AUTO_LOCKIN_WHEN_BUILDING = true;

// Hard-coded ON. Operator request: no manual toggle, always run.
// Auto-optimizer v2 — re-enabled with rewritten algorithm.
// Owner explicitly required correctness ("要所有的逻辑都正确"). v2:
//   - Compares only BEYOND-prereq levels (planner naturally builds to prereq)
//   - Counts savings only on ACTUAL affected nodes via tree walk
//   - Drops solar heuristic (was source of biggest false positives)
//   - Drops "single mine" candidates (already handled by sidecar's
//     pickResourceStrategy at goal-dispatch time)
const autoEnabled = true;

function saveAutoState() {
  try { fs.writeFileSync(AUTO_STATE_PATH, JSON.stringify({ enabled: autoEnabled, ts: Date.now() })); } catch {}
}

async function findOptimizerGoal() {
  return (await store.list()).find((r) =>
    r.goal.id?.startsWith("opt-") &&
    r.status !== "completed" &&
    r.status !== "cancelled"
  );
}

// Look up opt- goal that supports a specific user goal (via parent prefix tag).
async function findOptimizerGoalForParent(parentId) {
  return (await store.list()).find((r) =>
    r.goal.id?.startsWith(`opt-${parentId.slice(0, 8)}-`) &&
    r.status !== "completed" && r.status !== "cancelled"
  );
}

async function optimizerTick() {
  if (!autoEnabled) return;
  const r = await computeOptimizationsAllGoals();
  if (r.error) { console.log(`[auto] skip: ${r.error}`); return; }
  console.log(`[auto] tick: ${r.results.length} active user goal(s) to optimize`);
  let actioned = 0;
  let blocked = 0;
  let null_action = 0;
  for (const { goal, optimization } of r.results) {
    const tag = goal.id.slice(0, 8);
    const best = optimization.candidates[0];
    const ctx = `${goal.type} ${(goal.target?.building ?? goal.target?.tech ?? goal.target?.ship ?? "?")} @${goal.planet}`;
    if (!best || best.savings < AUTO_SAVINGS_THRESHOLD_SEC) {
      // No worthwhile candidate. Retire any existing opt- attached to this goal.
      const existing = await findOptimizerGoalForParent(goal.id);
      if (existing) {
        await store.updateStatus(existing.goal.id, "cancelled", "optimizer: savings below threshold");
        console.log(`[auto] retired ${existing.goal.id} (parent ${tag} has no candidate > 30m)`);
      }
      null_action += 1;
      continue;
    }
    const existing = await findOptimizerGoalForParent(goal.id);
    if (existing) {
      const t = existing.goal.target;
      if (t?.building === best.mine && t?.level === best.L_new) {
        // Already matches — no change.
        continue;
      }
      // Lock-in: refuse to supersede if currently building.
      if (AUTO_LOCKIN_WHEN_BUILDING && optimization.planet?.build_q?.building === t?.building) {
        const remainSec = Math.max(0, ((optimization.planet.build_q.ends_at ?? 0) - Date.now()) / 1000);
        console.log(`[auto] LOCK ${tag} parent: ${t?.building} L${t?.level} building (${Math.round(remainSec)}s left)`);
        blocked += 1;
        continue;
      }
      await store.updateStatus(existing.goal.id, "cancelled", "optimizer: superseded");
    }
    // Insert opt- goal tagged with parent (first 8 chars of parent id).
    const id = `opt-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
    await store.add({
      id, type: "build",
      target: { building: best.mine, level: best.L_new },
      planet: optimization.planet.id,
      priority: 8,
      status: "pending",
      created_at: Date.now(),
      progress_pct: 0, current_step: "queued", eta_at: null,
    });
    console.log(`[auto] ✓ ${tag} (${ctx}): build ${best.mine} L${best.L_new} saves ${fmtH(best.savings)} → ${id}`);
    actioned += 1;
  }
  console.log(`[auto] tick done: actioned=${actioned} locked=${blocked} no-action=${null_action}`);
}

// Phase 8a (v0.0.785) — operator 2026-06-05 "方案 A": optimizer 搬 sidecar
// (src/sidecar/optimizer.ts). daemon 这侧的 60s tick + multi-tenant 包装
// 全部 disable. /eta Discord command 仍调 computeOptimization 函数 (留
// computeOptimization /Bottleneck wrapper, 因为 Discord command 是 daemon
// 职责一部分). 真正"自动 emit opt-* goal" 由 sidecar 跑.
console.log(`[auto] daemon-side tick DISABLED — optimizer moved to sidecar (phase 8a)`);
// Phase 7c.6 — per-user optimizer iter. CURRENT_UID restored to OPERATOR_UID
// after the loop so Discord command handlers (which depend on store shim)
// keep operating on the operator's tenant.
async function optimizerTickAllTenants() {
  let tenants;
  try {
    tenants = await loadActiveUidsWithTokens();
  } catch (e) {
    console.warn("[auto] loadActiveUidsWithTokens threw:", e.message);
    return;
  }
  for (const { uid, bearer } of tenants) {
    CURRENT_UID = uid;
    CURRENT_BEARER = bearer;
    try {
      await optimizerTick();
    } catch (e) {
      console.warn(`[auto] tick error (uid=${uid.slice(0, 8)}):`, e.message);
    }
  }
  CURRENT_UID = OPERATOR_UID;
  CURRENT_BEARER = "";
}
// Phase 8a — setInterval daemon-side 已 disable, sidecar 跑 optimizer.
// 留 optimizerTickAllTenants 函数 unused (作为 archive), 防 git revert 需要回.
void optimizerTickAllTenants;

// ─── Expedition daemon ──────────────────────────────────────────────────
// Autonomous daily-task: when an expedition slot is free AND the planet
// has enough ships matching the configured fleet template, store.add an
// expedition goal. When ships are short, store.add build_ships goals (as
// the new main objective) so the planner accumulates the fleet first.
//
// Slot capacity = ceil(sqrt(astrophysics)). With astro 1 → 1 slot.
const EXPEDITION_TICK_MS = 5_000;  // safety net base cadence (was 10s)
const EXPEDITION_TRIGGER_POLL_MS = 1_000;  // event-driven trigger poll (LAN sidecar)
const EXPEDITION_TEMPLATE_PATH = "/home/ddxs/.openclaw/workspace/ogamex/runtime/ogamex-expedition.json";
const DEFAULT_EXPEDITION_TEMPLATE = { smallCargo: 1, espionageProbe: 1 };
function loadExpeditionConfig() {
  try { return JSON.parse(fs.readFileSync(EXPEDITION_TEMPLATE_PATH, "utf8")); }
  catch { return { enabled: true, template: DEFAULT_EXPEDITION_TEMPLATE }; }
}
function saveExpeditionConfig(cfg) {
  try { fs.writeFileSync(EXPEDITION_TEMPLATE_PATH, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.warn("[expedition] save cfg failed:", e.message); }
}

// In-process debounce — after daemon queues launches, ogame's state extractor
// needs 5-10s to reflect new outbound fleets. Without a cooldown, daemon
// re-queues each 10s tick and ApiExec spams POSTs that ogame rejects
// ("slots full" — server-side validation). One-shot per planet, 8s ttl.
// Track expedition launches that haven't been reflected in ogame's state
// yet. Each entry: { planetId, ts, count }. Used to inflate "outbound"
// count when computing freeSlots, so daemon doesn't re-queue.
const inFlightLaunches = [];
// Cool-off tracker: per-planet, when was the last expedition goal cancelled
// (failed). Daemon refuses to create a new goal for that planet for N minutes.
// Otherwise: ApiExec fail → goal cancelled → daemon immediately recreates →
// instant re-fail → ogame anti-bot trip. 5 min cool-off lets situation
// change (ships return, resources accumulate) before retry.
const failureCoolOff = new Map(); // planetId → unix ms of last failure
// Shortened 60s → 15s after v0.0.173 ApiExec preflight reliably writes
// 0-ships to store when hangar truly empty. With store updated within
// one state push (~5s), daemon's next-tick ship check already skips the
// planet — cool-off only needs to span the state-propagation window.
// 15s = 1 daemon tick + 1 push cycle, leaves room for race.
const FAILURE_COOL_OFF_MS = 15 * 1000;
const INFLIGHT_TTL_MS = 45_000;

async function expeditionTick() {
  // Always run — daemon enabled by default. Config file kept for template only.
  const cfg = loadExpeditionConfig();
  // Operator pause via panel: ogamex-expedition.json carries `paused: true`.
  if (cfg.paused === true) {
    console.log(`[expedition] tick skipped — paused by operator`);
    return;
  }
  const sidecarHeaders = CURRENT_BEARER ? { "Authorization": `Bearer ${CURRENT_BEARER}` } : {};
  const sRes = await fetch(`${SIDECAR}/ogamex/v1/state`, { headers: sidecarHeaders });
  const state = await sRes.json();
  // state.planets is Record<string, Planet> — use Object.values for iteration.
  let planetList = Object.values(state.planets ?? {});
  // Operator 2026-05-29: opt-in source pool — cfg.enabled_planets is a
  // string[] of planet ids. Empty/missing = all eligible (backward compat).
  // Frontend modal "发船星球" tab writes this via /v1/expedition/config.
  if (Array.isArray(cfg.enabled_planets) && cfg.enabled_planets.length > 0) {
    const allowed = new Set(cfg.enabled_planets);
    planetList = planetList.filter((p) => allowed.has(p.id));
  }
  // Operator 2026-05-29: round-robin 公平化 — 按 last expedition created_at
  // ASC 排序 planetList; 没起过 expedition 的 planet (lastTs=0) 排最前.
  // 这样新 planet 加入 (e.g. 4:299:8) 自动入下次 tick 的 launch pool,
  // 不再被 declaration order 锁死前 6. SQLite store.list() 同步无 await.
  {
    const lastExpTs = new Map();
    for (const r of (await store.list())) {
      if (r.goal?.type !== "expedition") continue;
      const pid = r.goal.target?.source_planet ?? r.goal.planet;
      if (!pid) continue;
      const ts = r.goal.created_at ?? r.created_at ?? 0;
      if (ts > (lastExpTs.get(pid) ?? 0)) lastExpTs.set(pid, ts);
    }
    planetList.sort((a, b) => (lastExpTs.get(a.id) ?? 0) - (lastExpTs.get(b.id) ?? 0));
    const head = planetList.slice(0, 3).map((p) => p.coords?.join(":") ?? p.id).join(",");
    console.log(`[expedition] rotation: head=${head} (lastExpTs ASC)`);
  }
  if (planetList.length === 0) return;
  // Operator strategy "从第一个星球开始；派得出就在本星球继续派；派不出换下一个星球；不要自动造船":
  //   1. Iterate planets in declaration order [planet 0, planet 1, ...].
  //   2. For each planet, while ships ≥ template, queue one exp- goal.
  //   3. Move on to next planet only when current can't launch anymore.
  //   4. NEVER create expb-* (build_ships) goals — daemon is pure dispatcher.
  // We compute everything in this tick (no 10s wait between launches) so
  // ApiExec can fire ~6 expeditions in 10s like the operator's other tool.
  const cfgTemplate = cfg.template ?? DEFAULT_EXPEDITION_TEMPLATE;
  // Use first planet only for the slotCap fallback fetch below; the real
  // per-planet decision happens later.
  const planet = planetList[0];
  // Sidecar now returns raw WorldState (post Map refactor) — research lives
  // under research.levels.* not research_levels.* (the old transformed shape).
  const astro = state.research?.levels?.astrophysics ?? state.research_levels?.astrophysics ?? 0;
  // Prefer ogame's real slot count (scraped from DOM by userscript;
  // accounts for class / lifeform / officer bonuses). Fall back to the
  // ceil(sqrt) formula if extractor hasn't run yet.
  const realSlots = state.server?.max_expedition_slots;
  // Authoritative source: sidecar /v1/expedition (DOM scrape + class bonus).
  // Bridge previously used its own formula → mismatch when scrape missing.
  // Fetch sidecar's computed max instead.
  let slotCap = 0;
  if (realSlots && realSlots > 0) {
    slotCap = realSlots;
  } else {
    // Fall back to sidecar's view (which knows class bonus).
    try {
      const expRes = await fetch(`${SIDECAR}/ogamex/v1/expedition`, { headers: sidecarHeaders });
      const expBody = await expRes.json();
      slotCap = expBody.max ?? 0;
    } catch { /* keep 0 */ }
  }
  if (slotCap === 0) return; // no astrophysics, no expeditions allowed
  // Prefer scraped used count from ogame DOM — fleets_outbound only
  // contains mission=15 entries when the user is on movement page.
  const scrapedUsed = state.server?.used_expedition_slots;
  const outboundCount = (state.fleets_outbound ?? []).filter((f) => f.mission === 15).length;
  // Guard: state not ready (sidecar restart / pre-userscript boot).
  // Refuse to act on "0 outbound" without a positive data signal — otherwise
  // we wrongly assume planet is idle and create build-supply goals.
  const haveOutboundSignal = (typeof scrapedUsed === "number") || outboundCount > 0;
  if (!haveOutboundSignal) {
    console.log(`[expedition] tick skipped — state not ready (scraped=${scrapedUsed} fleetsOut=${outboundCount})`);
    return;
  }
  // Prefer fleets_outbound (movement endpoint truth) when populated.
  const outbound = outboundCount > 0
    ? outboundCount
    : (typeof scrapedUsed === "number" ? scrapedUsed : 0);
  console.log(`[expedition] tick astro=${astro} slotCap=${slotCap} outbound=${outbound} (scraped=${scrapedUsed} fleetsOut=${outboundCount})`);
  if (outbound >= slotCap) {
    // Also cancel any active expedition goal that would otherwise
    // keep triggering sendFleet attempts (and failing with no slot).
    const activeExpGoals = (await store.list()).filter((r) =>
      !["completed", "cancelled"].includes(r.status) && r.goal.type === "expedition");
    for (const r of activeExpGoals) {
      await store.updateStatus(r.goal.id, "cancelled", "expedition: slots full (scraped)");
      console.log(`[expedition] cancelled ${r.goal.id} — slots full`);
    }
    return;
  }
  // Operator 2026-05-29: re-enabled auto-build via cfg.auto_build_ships.
  // When OFF (default), drain stale expb-* goals so they stop burning
  // resources. When ON, leave them alone — the ships-insufficient branch
  // below will queue fresh ones as needed.
  const autoBuildShips = cfg.auto_build_ships === true;
  if (!autoBuildShips) {
    const activeGoals = (await store.list()).filter((r) => !["completed", "cancelled"].includes(r.status));
    for (const r of activeGoals) {
      if (r.goal.id.startsWith("expb-")) {
        await store.updateStatus(r.goal.id, "cancelled", "daemon: auto-build disabled");
        console.log(`[expedition] cancelled stale expb ${r.goal.id.slice(0,8)}`);
      }
    }
  }

  // Expire stale in-flight markers (ogame should have reflected them in
  // outbound by now — if it hasn't after 45s, either we never actually
  // launched or extractor is dead, and we should trust real state again).
  const tickNow = Date.now();
  while (inFlightLaunches.length > 0 && tickNow - inFlightLaunches[0].ts > INFLIGHT_TTL_MS) {
    inFlightLaunches.shift();
  }
  const inFlightLocal = (await store.list()).filter((r) => !['completed','cancelled'].includes(r.status) && r.goal.type === 'expedition').length; // operator 2026-05-28: was push-counter (45s TTL inflated when ApiExec deferred via userBusy)
  // Also count active exp- goals already in sidecar queue (waiting for
  // ApiExec to drain them). Without this, daemon piles new goals every 10s
  // when ogame's outbound count stays stale → 17+ active goals → ogame
  // rejection storm on actual POST attempts.
  const activeExpInQueue = (await store.list()).filter((r) =>
    !["completed", "cancelled"].includes(r.status) && r.goal.type === "expedition").length;

  // Slot accounting — ONLY count truly flying fleets (ogame outbound) and
  // recent local launches (inFlightLocal, decays in 45s). activeExpInQueue
  // is goals in store; if userscript is offline / not ACK'ing, they sit
  // forever without actually launching. Counting them as "flying" deadlocks
  // the daemon ("no free slots" forever despite ogame slots being open).
  //
  // Owner observed: "no free slots (ogame=2 local=0 cap=6) 判断错误?" —
  // yes, queue=6 was inflating effectiveOutbound. Removed from MAX.
  // Stuck goals are still a problem (preflight should drain them), but
  // they no longer prevent NEW dispatches from filling actual free slots.
  const effectiveOutbound = Math.max(outbound, inFlightLocal);
  const freeSlots = Math.max(0, slotCap - effectiveOutbound);
  if (freeSlots === 0) {
    console.log(`[expedition] no free slots (ogame=${outbound} local=${inFlightLocal} queue=${activeExpInQueue} cap=${slotCap})`);
    return;
  }
  if (activeExpInQueue > freeSlots * 2) {
    // Safety: store has way more goals than ogame slots. Don't add more
    // — wait for some to drain (succeed or cancel). Prevents unbounded
    // accumulation when ACK loop broken (userscript offline).
    console.log(`[expedition] backlog full (queue=${activeExpInQueue} vs free=${freeSlots} cap=${slotCap}) — pausing new queue`);
    return;
  }
  let remainingSlots = freeSlots;

  // Iterate planets in declaration order. For each, queue as many exp-
  // goals as on-planet ships allow, up to remaining freeSlots. Move on
  // when this planet is exhausted.
  let launched = 0;
  // Update failureCoolOff from recently-cancelled exp goals.
  // store.list() returns ALL goals; filter for our own exp goals cancelled
  // recently with a fleet-rejection reason.
  const nowMs = Date.now();
  for (const r of (await store.list())) {
    if (r.goal.type !== "expedition") continue;
    if (r.status !== "cancelled") continue;
    const reason = r.reason ?? "";
    // Match BOTH ogame rejections AND ApiExec preflight aborts. Preflight
    // identifies hangar-empty before any POST — that's still a "don't retry
    // immediately" signal for daemon.
    if (!/rejected by ogame|140054|140019|140043|140042|资源不足|可用艦船不足|可用舰船不足|aborted \(preflight\)/.test(reason)) continue;
    const updated = r.updated_at ?? r.created_at ?? 0;
    if (nowMs - updated > FAILURE_COOL_OFF_MS) continue;
    const pId = r.goal.target?.source_planet ?? r.goal.planet;
    if (!pId) continue;
    const cur = failureCoolOff.get(pId) ?? 0;
    if (updated > cur) failureCoolOff.set(pId, updated);
  }
  // PLANET RACE-LOCK. Operator: "一个星球只能有一个参加 race, 发出去
  // 以后才能再次参加 race". Build set of planets that ALREADY have an
  // unfinished expedition goal in the queue (status NOT completed/cancelled).
  // Iteration below skips them; planet re-enters the race only after its
  // current exp completes or cancels.
  const lockedPlanets = new Set(
    (await store.list())
      .filter((r) =>
        r.goal.type === "expedition" &&
        !["completed", "cancelled"].includes(r.status))
      .map((r) => r.goal.target?.source_planet ?? r.goal.planet)
      .filter(Boolean)
  );
  for (const p of planetList) {
    if (remainingSlots === 0) break;
    if (lockedPlanets.has(p.id)) {
      console.log(`[expedition] LOCK ${p.coords?.join(":") ?? p.id} — already has unfinished exp goal`);
      continue;
    }
    const ships = p.ships ?? {};
    let maxFromThisPlanet = remainingSlots;
    for (const [shipName, need] of Object.entries(cfgTemplate)) {
      if (need <= 0) continue;
      const have = ships[shipName] ?? 0;
      maxFromThisPlanet = Math.min(maxFromThisPlanet, Math.floor(have / need));
    }
    const lastFail = failureCoolOff.get(p.id) ?? 0;
    const inCoolOff = lastFail && nowMs - lastFail < FAILURE_COOL_OFF_MS;
    // Cool-off SHORT-CIRCUIT: if planet currently meets template (ships are
    // real, fresh state), bypass cool-off. v0.0.168 ApiExec preflight will
    // catch any remaining race at the source — no need to lock out a planet
    // whose ships have just returned. Owner: "远征返回以后...自动派".
    if (inCoolOff && maxFromThisPlanet === 0) {
      const leftSec = Math.ceil((FAILURE_COOL_OFF_MS - (nowMs - lastFail)) / 1000);
      console.log(`[expedition] cool-off ${p.coords?.join(":") ?? p.id} (${leftSec}s left + still ships insufficient)`);
      continue;
    }
    if (inCoolOff && maxFromThisPlanet > 0) {
      console.log(`[expedition] cool-off OVERRIDE ${p.coords?.join(":") ?? p.id} — ships now sufficient (${maxFromThisPlanet}), clearing cool-off`);
      failureCoolOff.delete(p.id);
    }
    if (maxFromThisPlanet === 0) {
      // Operator 2026-05-29: cfg.auto_build_ships ON → queue a per-ship-type
      // build_ships goal for the missing count instead of silently skipping.
      // Guarded by an existing-expb check so we don't pile up duplicates each
      // tick.
      if (autoBuildShips) {
        const planetShips = p.ships ?? {};
        const missing = {};
        for (const [shipName, need] of Object.entries(cfgTemplate)) {
          if (need <= 0) continue;
          const have = planetShips[shipName] ?? 0;
          if (have < need) missing[shipName] = need - have;
        }
        if (Object.keys(missing).length > 0) {
          const hasActiveBuild = (await store.list()).some((r) =>
            r.goal.id.startsWith("expb-") &&
            !["completed", "cancelled"].includes(r.status) &&
            (r.goal.target?.source_planet === p.id || r.goal.planet === p.id));
          if (hasActiveBuild) {
            console.log(`[expedition] auto-build ${p.coords?.join(":") ?? p.id} — expb already in queue, skip`);
          } else {
            for (const [shipName, amount] of Object.entries(missing)) {
              const bid = `expb-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}-${shipName}`;
              await store.add({
                id: bid, type: "build_ships",
                target: { ship: shipName, amount, source_planet: p.id },
                planet: p.id, priority: 8, is_main_goal: false,
                status: "pending", created_at: Date.now(),
                progress_pct: 0, current_step: "queued", eta_at: null,
              });
              console.log(`[expedition] auto-build ${p.coords?.join(":") ?? p.id} expb ${shipName} × ${amount}`);
            }
          }
          continue;
        }
      }
      console.log(`[expedition] skip ${p.coords?.join(":") ?? p.id} — ships insufficient`);
      continue;
    }
    // Per-planet race-lock: cap to 1 queue per tick regardless of ship
    // count. Planet re-enters race only after current exp completes —
    // lockedPlanets set built above blocks subsequent ticks.
    const queueCount = 1;
    {
      const id = `exp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}-0`;
      await store.add({
        id, type: "expedition",
        target: { count: 1, source_planet: p.id, ships: { ...cfgTemplate } },
        planet: p.id, priority: 10, is_main_goal: false,
        status: "pending", created_at: Date.now(),
        progress_pct: 0, current_step: "queued", eta_at: null,
      });
      launched += 1;
      remainingSlots -= 1;
    }
    inFlightLaunches.push({ planetId: p.id, ts: tickNow, count: queueCount });
    lockedPlanets.add(p.id);
    console.log(`[expedition] queued 1 exp from ${p.coords?.join(":") ?? p.id} (planet locked until completion)`);
  }
  if (launched === 0) {
    console.log(`[expedition] no planet can launch — all out of template ships`);
  } else {
    console.log(`[expedition] queued ${launched} expedition(s) this tick; remaining freeSlots=${freeSlots}`);
  }
}

// Phase 7c.7 (2026-06-05) — expedition daemon RESTORED (multi-tenant).
// Operator 2026-06-05 "重开 expedition daemon (推荐)": optimizer alone
// 不主动 emit 远征 goal → 所有 exp- goal done 后远征停了. 现在恢复
// expedition tick + trigger poll, 用 CURRENT_UID/CURRENT_BEARER swap 跟
// optimizerTickAllTenants 同样的 multi-tenant pattern.
console.log(`[expedition] daemon boot ENABLED — multi-tenant (CURRENT_UID/BEARER swap per tick)`);

async function expeditionTickAllTenants() {
  let tenants;
  try {
    tenants = await loadActiveUidsWithTokens();
  } catch (e) {
    console.warn("[expedition] loadActiveUidsWithTokens threw:", e.message);
    return;
  }
  for (const { uid, bearer } of tenants) {
    CURRENT_UID = uid;
    CURRENT_BEARER = bearer;
    try {
      await expeditionTick();
    } catch (e) {
      console.warn(`[expedition] tick error (uid=${uid.slice(0, 8)}):`, e.message);
    }
  }
  CURRENT_UID = OPERATOR_UID;
  CURRENT_BEARER = "";
}

setInterval(() => {
  expeditionTickAllTenants().catch((e) => console.warn("[expedition] outer tick threw:", e.message));
}, EXPEDITION_TICK_MS);

// Event-driven trigger: poll sidecar's tiny /v1/expedition/trigger endpoint
// every 1s. Sidecar bumps trigger_ts on fleet-return delta (state.snapshot
// handler) OR explicit POST. When ts > lastSeen → fire expeditionTickAllTenants.
let lastExpeditionTriggerTs = 0;
setInterval(async () => {
  try {
    const r = await fetch(`${SIDECAR}/ogamex/v1/expedition/trigger`);
    if (!r.ok) return;
    const j = await r.json();
    const ts = typeof j?.trigger_ts === "number" ? j.trigger_ts : 0;
    if (ts > lastExpeditionTriggerTs) {
      lastExpeditionTriggerTs = ts;
      setTimeout(() => {
        expeditionTickAllTenants().catch((e) => console.warn("[expedition] event-tick error:", e.message));
      }, 2000);
    }
  } catch {}
}, EXPEDITION_TRIGGER_POLL_MS);

async function handleAuto(rest) {
  // No more on/off — both daemons always run. Return status only.
  void rest;
  const existing = await findOptimizerGoal();
  const cur = existing
    ? `optimizer managed: ${existing.goal.target?.building} L${existing.goal.target?.level} (${existing.status})`
    : "optimizer: no managed goal currently";
  const expCfg = loadExpeditionConfig();
  return [
    `**auto status** (always-on)`,
    `• optimizer: every ${AUTO_TICK_MS/1000}s — ${cur}`,
    `• expedition: every ${EXPEDITION_TICK_MS/1000}s — template ${JSON.stringify(expCfg.template ?? DEFAULT_EXPEDITION_TEMPLATE)}`,
    `change expedition template via \`fleet <ships>\``,
  ].join("\n");
}

/**
 * Parse "一侦查一小运两大运" / "5 lc 3 ep" style ship counts into a
 * {<canonicalShipId>: <count>} map. Numerals can be Chinese (一二三..)
 * or ASCII. Names go through preprocessNL first so 大运→largeCargo etc.
 * Returns null if no recognizable pairs were found.
 */
const CHINESE_DIGITS = { 一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,几:1 };
const SHIP_IDS = ["smallCargo","largeCargo","colonyShip","espionageProbe","lightFighter","heavyFighter","cruiser","battleship","battlecruiser","destroyer","deathstar","recycler","bomber","reaper","explorer","solarSatellite"];
function parseShipCounts(text) {
  // Preprocess Chinese ship names to canonical IDs first.
  const en = preprocessNL(text);
  const ships = {};
  // Match patterns like "<count><shipId>" or "<shipId> <count>".
  // Count may be Chinese digit or arabic numerals.
  const numToken = "(?:\\d+|[一二两三四五六七八九十几])";
  for (const ship of SHIP_IDS) {
    // Try: <num><ship>
    const re1 = new RegExp(`(${numToken})\\s*${ship}`, "i");
    // Try: <ship>\s*<num> (e.g. "smallCargo 5")
    const re2 = new RegExp(`${ship}\\s*(${numToken})`, "i");
    const m = en.match(re1) || en.match(re2);
    if (!m) continue;
    const numStr = m[1];
    let n = parseInt(numStr, 10);
    if (isNaN(n)) n = CHINESE_DIGITS[numStr] ?? 1;
    ships[ship] = (ships[ship] ?? 0) + n;
  }
  return Object.keys(ships).length > 0 ? ships : null;
}

async function handleFleet(rest) {
  if (!rest.trim()) return "usage: `fleet <ship counts>` — e.g. `fleet 一侦查一小运` (sets daemon template)";
  const ships = parseShipCounts(rest);
  if (!ships) return `❌ couldn't parse any ship counts from: \`${rest.slice(0,80)}\``;
  // Write daemon config — the autonomous expedition daemon reads this
  // file on every tick to decide ship requirements.
  const cfg = loadExpeditionConfig();
  cfg.template = ships;
  cfg.enabled = cfg.enabled ?? true;
  saveExpeditionConfig(cfg);
  const summary = Object.entries(ships).map(([s,n]) => `${n}×${s}`).join(" + ");
  return `🚀 expedition daemon template → ${summary}\n(daemon: ${cfg.enabled ? "✅ ON" : "❌ OFF — run \`expedition on\`"})`;
}

/**
 * Send N expedition fleets from a source planet (or default to first
 * planet). Runtime executor doesn't yet wire ogame's fleetSend AJAX so
 * this currently returns "not implemented" rather than silently creating
 * the wrong goal (which is what LLM-as-add was doing — hallucinating an
 * explorer build).
 */
async function handleExpedition(rest) {
  void rest;
  // No on/off — daemon always runs. Status only.
  const cfg = loadExpeditionConfig();
  return [
    `**expedition daemon** ✅ (always-on, tick ${EXPEDITION_TICK_MS/1000}s)`,
    `template: ${JSON.stringify(cfg.template ?? DEFAULT_EXPEDITION_TEMPLATE)}`,
    `change template via \`fleet <ships>\``,
  ].join("\n");
}

async function handleSetMain(rest) {
  const arg = rest.trim();
  if (!arg) {
    const cur = await store.getMainGoal();
    if (!cur) return "no main goal set. usage: `/main <id-prefix>` to set, `/main clear` to clear.";
    return `current main: ${fmtRow(cur)}`;
  }
  if (/^(clear|none|off|unset)$/i.test(arg)) {
    await store.setMainGoal(null);
    return "🧹 main goal cleared — planner reverts to flat priority order";
  }
  const { error, row } = await resolveByPrefix(arg);
  if (error) return `❌ ${error}`;
  await store.setMainGoal(row.goal.id);
  return `⭐ main goal set: ${fmtRow({ ...row, goal: { ...row.goal, is_main_goal: true } })}`;
}

async function handleHealth() {
  try {
    const r = await fetch(SIDECAR_HEALTH_URL);
    const h = await r.json();
    return [
      `**sidecar** ${h.ok ? "✅" : "❌"} uptime ${h.sidecar?.uptime_seconds}s`,
      `**userscript** ${h.userscript?.connected ? "✅ connected" : "❌ disconnected"} (${h.userscript?.last_seen_ago_seconds ?? "n/a"}s ago)`,
      `**llm** ${h.llm?.ok ? `✅ ${h.llm.rtt_ms}ms` : `❌ ${h.llm?.error}`}`,
      `**state** ${h.state?.planets_count} planets, ${h.state?.fleets_outbound_count} fleets out, ${h.state?.hostile_events_count} hostile events`,
    ].join("\n");
  } catch (e) {
    return `❌ sidecar unreachable: ${e.message}`;
  }
}

function handleHelp() {
  return [
    "**OgameX commands** — 直接打字即可，**不要 `/` 前缀**（Discord 会拦）",
    "`研究宇航学到 4 在 earth` / `升级金属矿到 18` — NL 加目标",
    "`列出` / `list` / `显示任务` — 看目标队列",
    "`取消 <id>` / `暂停 <id>` / `恢复 <id>`",
    "`主目标 <id>` — 设置主目标 · `主目标 clear` — 清",
    "`eta` / `多久` — 主目标剩余时间",
    "`optimize` / `最优` — 矿升级 top 5 推荐 (含能量过滤)",
    "`auto on` / `auto off` — 自动优化器开关 (60s 插入 P8 mine goal)",
    "`fleet 一侦查一小运` — 远征舰队 template",
    "`status` / `健康` — 系统状态",
    "`help` / `帮助` — 这个",
    "",
    "**没认出来的话**走 NL parser → 当作 add goal（解析失败会回错误）",
  ].join("\n");
}

const HANDLERS = {
  add:    handleAdd,
  list:   handleList,
  cancel: handleCancel,
  pause:  handlePause,
  resume: handleResume,
  main:   handleSetMain,
  eta:    handleEta,
  optimize: handleOptimize,
  auto:   handleAuto,
  fleet:  handleFleet,
  expedition: handleExpedition,
  health: handleHealth,
  help:   handleHelp,
  // Aliases — Discord reserves `/help` for its own client UI (it shows
  // Discord's built-in help dialog + never delivers the message to the
  // bot). Operators need a working alias they can actually slash-send.
  h:      handleHelp,
  "?":    handleHelp,
  menu:   handleHelp,
  帮助:    handleHelp,
  "命令":  handleHelp,
};

/**
 * Map free-form text → { cmd, rest }. Tries (in order):
 *   1. Slash-prefixed: `/list pending` → { cmd:"list", rest:"pending" }
 *   2. Keyword match (zh + en): 列出/查看/list/show → list; 取消→cancel; 暂停→pause; 恢复→resume; 健康/health→health; 帮助/help→help
 *   3. Fallback: treat whole text as natural-language goal → /add <text>
 */
// Keyword routing. `\b` (ASCII-only word boundary) doesn't fire on Chinese
// chars, so we use explicit "end OR non-letter" lookaheads where ambiguity
// matters (e.g. avoid matching `list` inside `listen`). For Chinese keywords
// the prefix match is enough — there's no embedded-token problem.
const KEYWORD_MAP = [
  // No-slash command matching — these run BEFORE the LLM router so common
  // typed commands don't need a network round-trip. Order matters: put
  // distinctive prefixes (cancel/pause/resume etc.) before the more
  // permissive substring matchers (list/help).
  { re: /^(?:cancel|取消|删除|delete)\s+(.+)/i,  cmd: "cancel", restGroup: 1 },
  { re: /^(?:pause|暂停)\s+(.+)/i,                cmd: "pause",  restGroup: 1 },
  { re: /^(?:resume|恢复|继续)\s+(.+)/i,          cmd: "resume", restGroup: 1 },
  { re: /^(?:main|主目标|主要目标)\s*(.*)/i,      cmd: "main",   restGroup: 1 },
  { re: /^(?:eta|剩余时间|多久|还要多久|estimate)(?=\s|$)/i, cmd: "eta" },
  { re: /^(?:optimize|optimise|优化|最优|矿升级)(?=\s|$)/i,   cmd: "optimize" },
  { re: /^(?:auto|自动|自动优化|automate)\s*(.*)$/i,         cmd: "auto",   restGroup: 1 },
  { re: /^(?:fleet|远征舰队|远征队|舰队设置)\s+(.+)/i,        cmd: "fleet",  restGroup: 1 },
  // Expedition LAUNCH (verb forms): "派/派出/launch/send + 远征/expedition".
  // Catch BEFORE add-fallback so LLM doesn't hallucinate explorer build_ships.
  { re: /^(.*(?:派.*远征|远征.*派|launch.*expedition|send.*expedition|expedition.*(?:fleet|launch|send|out)))/i, cmd: "expedition", restGroup: 1 },
  { re: /^(.*(?:一|二|两|三|四|五|\d+)\s*(?:队|波)\s*远征)/i, cmd: "expedition", restGroup: 1 },
  { re: /^(?:health|健康|状态|status)(?=\s|$)/i,             cmd: "health" },
  { re: /^(?:help|帮助|h|menu|命令|\?)(?=\s|$)/i,            cmd: "help" },
  // List has the broadest substring match — keep it AFTER specific cmds.
  { re: /(列出|查看|显示|看一下|看看|看下|当前任务|任务列表|任务清单|目标列表|list goals?|show goals?|current (?:goals?|tasks?))/i, cmd: "list" },
  { re: /^(?:list|show)(?=\s|$)/i,                cmd: "list" },
  { re: /^all\s+tasks?$/i,                        cmd: "list" },
];

// Canonical command set the LLM router classifies into. Keep in sync with
// HANDLERS keys (any cmd here MUST exist in HANDLERS or dispatch silently
// drops the message).
const VALID_INTENTS = ["list", "cancel", "pause", "resume", "main", "eta", "optimize", "auto", "fleet", "expedition", "add", "health", "help"];

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: VALID_INTENTS },
    args:   { type: "string", description: "Args passed to the handler. For cancel/pause/resume/main: the goal id-prefix. For add: the full NL goal description. Empty for list/health/help." },
  },
  required: ["intent", "args"],
};

const INTENT_SYSTEM_PROMPT = `You are an intent router for an ogame automation bot.
Classify the user message into ONE intent:
  list   - user wants to see current goals/tasks (e.g. "显示当前任务列表", "列出", "看一下", "show goals", "current tasks")
  cancel - user wants to delete a goal (needs id-prefix, e.g. "取消 abc12", "cancel xyz")
  pause  - user wants to temporarily stop a goal (needs id-prefix)
  resume - user wants to un-pause a goal (needs id-prefix)
  main   - user wants to set/check/clear the main objective (id-prefix or "clear" or empty)
  add    - user wants to CREATE a new goal (research/build/build_ships/etc — anything that sounds like a NEW task)
  health - user wants system status (e.g. "状态", "健康检查", "health")
  eta    - user asks how long until main goal completes (e.g. "完成主要任务还要多久", "ETA", "多久能完成", "剩多少时间")
  optimize - user asks for optimal mine-upgrade recommendation (e.g. "最优解", "矿升到几级最快", "optimize", "矿升级到多少级最快")
  auto   - user toggles autonomous optimizer (e.g. "auto on/off", "自动 开/关", "开启自动优化"). args=on|off|status
  fleet  - user sets the EXPEDITION FLEET template (NOT a goal to build ships; this stores a ship-count
           mix for future expedition missions). Triggers: "远征舰队设置...", "expedition fleet set...",
           "expedition template ...", "set expedition fleet 1 小运 2 侦查". args=full ship count text.
  expedition - user wants to LAUNCH expedition fleets NOW (send N fleets out on missions).
           Triggers: "派一队远征", "send 1 expedition", "一队远征从earth派出", "派出 2 队远征",
           "launch expedition fleet". DO NOT route these to add (build_ships) — there is no
           build_ships goal for "远征" / "expedition" verb. The LLM has been hallucinating
           explorer builds when it should use this expedition intent.
           args=full text (count + source planet).
  help   - user asks how to use the bot (e.g. "帮助", "how do I...", "?")

Rules:
- If ambiguous between add and list, prefer list when phrasing implies READING ("显示", "查看", "看", "show", "list").
- If user describes WHAT TO DO (build/research/produce), prefer add.
- For cancel/pause/resume/main, extract the goal id-prefix into args.
- For add, put the FULL original message into args (will be re-parsed by add handler).
- For list/health/help, args may be empty.
- "清空/清除/取消主目标" or "main clear/unset" → intent=main, args="clear".
- "取消 <id>" means delete a specific goal (cancel intent), not clear-main.
- 取消 / cancel / delete + a goal id-prefix → cancel intent.

Examples:
  "显示当前任务列表" → {intent:"list", args:""}
  "造 5 个大运"        → {intent:"add",  args:"造 5 个大运"}
  "取消 abc12"        → {intent:"cancel", args:"abc12"}
  "主目标 expo"       → {intent:"main",  args:"expo"}
  "主要目标 清空"      → {intent:"main",  args:"clear"}
  "状态"              → {intent:"health", args:""}`;

/**
 * LLM-first intent router. Sends the user text to NIM/Grok via the
 * GlossaryClient; returns { cmd, rest }. Falls back to regex KEYWORD_MAP
 * if the LLM fails (rate limit, bad JSON, etc.).
 */
async function classifyIntentLLM(text) {
  const out = await gemini.generateJson(
    `User message: ${text}`,
    INTENT_SCHEMA,
    { temperature: 0, systemInstruction: INTENT_SYSTEM_PROMPT },
  );
  if (!VALID_INTENTS.includes(out.intent)) {
    throw new Error(`LLM returned invalid intent: ${out.intent}`);
  }
  return { cmd: out.intent, rest: out.args ?? "" };
}

function classifyIntentRegex(text) {
  for (const m of KEYWORD_MAP) {
    const match = text.match(m.re);
    if (match) {
      const rest = m.restGroup != null ? (match[m.restGroup] ?? "") : text.slice(match[0].length).trim();
      return { cmd: m.cmd, rest };
    }
  }
  return null;
}

async function parseIntent(text) {
  // Slash commands bypass the LLM — they're explicit and deterministic.
  if (text.startsWith("/")) {
    const space = text.indexOf(" ");
    const cmd = (space < 0 ? text.slice(1) : text.slice(1, space)).toLowerCase();
    const rest = space < 0 ? "" : text.slice(space + 1);
    return { cmd, rest, route: "slash" };
  }
  // LLM primary path.
  try {
    const r = await classifyIntentLLM(text);
    return { ...r, route: "llm" };
  } catch (e) {
    console.warn(`[bridge] LLM intent classifier failed (${e.message?.slice(0,80)}), falling back to regex`);
    const r = classifyIntentRegex(text);
    if (r) return { ...r, route: "regex-fallback" };
    // Last-resort: treat as NL add — same as before.
    return { cmd: "add", rest: text, route: "default-add" };
  }
}

async function handleMessage(msg) {
  if (msg.author?.id === BOT_USER_ID) return; // ignore our own replies
  if (msg.author?.bot) return; // ignore other bots
  const text = (msg.content ?? "").trim();
  if (!text) return;
  const { cmd, rest, route } = await parseIntent(text);
  const handler = HANDLERS[cmd];
  if (!handler) return; // unknown — silently ignore (low noise)
  // Refresh planet cache opportunistically so coord display stays current
  // even if the 30s background refresh hasn't ticked since boot.
  if (cachedPlanets.length === 0) await refreshPlanets();
  console.log(`[bridge] cmd=${cmd} route=${route} from=${msg.author?.username} rest=${rest.slice(0,80)}`);
  let reply;
  try {
    reply = await handler(rest);
  } catch (e) {
    reply = `❌ command failed: ${e.message}`;
  }
  try {
    await postMessage(reply);
  } catch (e) {
    console.error("[bridge] failed to post reply:", e.message);
  }
}

// ─── Poll loop ─────────────────────────────────────────────────────────────
// Persist lastSeenId so bridge restarts don't replay the backlog and
// re-execute already-handled /add commands (each replay can yield a
// different LLM parse, producing duplicate-yet-distinct goal records).
const LAST_SEEN_PATH = "/home/ddxs/.openclaw/workspace/ogamex/runtime/ogamex-bridge-lastseen.json";
const DISCORD_SNOWFLAKE_MAX = "9223372036854775807"; // int64 max
let lastSeenId = null;
try {
  const v = JSON.parse(fs.readFileSync(LAST_SEEN_PATH, "utf8")).lastSeenId;
  // Reject values that exceed Discord's snowflake range (Discord rejects
  // ?after=<oversized> with HTTP 400, breaking the poll loop). Common
  // mistake on first-boot sentinels.
  if (typeof v === "string" && v.length <= DISCORD_SNOWFLAKE_MAX.length && v <= DISCORD_SNOWFLAKE_MAX) {
    lastSeenId = v;
  } else if (v) {
    console.warn(`[bridge] discarding out-of-range lastSeenId=${v} (max=${DISCORD_SNOWFLAKE_MAX})`);
  }
} catch {}
const persistLastSeen = () => {
  try { fs.writeFileSync(LAST_SEEN_PATH, JSON.stringify({ lastSeenId, ts: Date.now() })); } catch {}
};
// In-process dedupe — even within one boot, Discord can occasionally
// re-deliver a message in the next poll window before lastSeenId advances.
const processedIds = new Set();

{
  const BACKLOG_N = 10;
  const recent = await discordFetch(`/channels/${CHANNEL_ID}/messages?limit=${BACKLOG_N}`);
  console.log(`[bridge] backlog scan: ${recent.length} recent messages (skipping <= ${lastSeenId ?? "<none>"})`);
  // Snowflake numeric comparison: pad to the same length, then lex compare
  // (snowflake max is 19 digits — 9223372036854775807). Using string > on
  // unpadded ids gives wrong results for size-mismatched ids.
  const idGt = (a, b) => a.padStart(20, "0") > b.padStart(20, "0");
  let skipped = 0;
  // Track the newest id we observed REGARDLESS of skip status — so even when
  // a stale persisted lastSeenId blocks everything, we still advance to the
  // current newest and the poll loop can start fresh.
  let newestSeen = null;
  for (const m of [...recent].reverse()) {
    if (newestSeen === null || idGt(m.id, newestSeen)) newestSeen = m.id;
    if (lastSeenId !== null && !idGt(m.id, lastSeenId)) { skipped += 1; continue; }
    if (processedIds.has(m.id)) { skipped += 1; continue; }
    processedIds.add(m.id);
    try { await handleMessage(m); } catch (e) { console.error("backlog handle err:", e); }
    lastSeenId = m.id;
    persistLastSeen();
  }
  // If we processed nothing but observed messages, advance to newest so the
  // poll loop's ?after= param uses a valid id (not a stale sentinel).
  if (lastSeenId === null && newestSeen) {
    lastSeenId = newestSeen;
    persistLastSeen();
  } else if (newestSeen && idGt(newestSeen, lastSeenId ?? "0")) {
    lastSeenId = newestSeen;
    persistLastSeen();
  }
  console.log(`[bridge] backlog done, processed ${recent.length - skipped}, skipped ${skipped}, lastSeenId=${lastSeenId ?? "<empty>"}`);
}

await postMessage("🪐 OgameX bridge online — type `/help` for commands.");

setInterval(async () => {
  try {
    const newMsgs = await fetchNewMessages(lastSeenId);
    if (newMsgs.length === 0) return;
    for (const m of newMsgs) {
      if (processedIds.has(m.id)) continue; // poll-loop dedupe — matches backlog
      processedIds.add(m.id);
      try { await handleMessage(m); } catch (e) { console.error("handleMessage err:", e); }
      lastSeenId = m.id;
      persistLastSeen(); // persist per-message so crash doesn't replay
    }
  } catch (e) {
    console.error("[bridge] poll error:", e.message);
  }
}, POLL_MS);

console.log("[bridge] poll loop running, every", POLL_MS, "ms");
