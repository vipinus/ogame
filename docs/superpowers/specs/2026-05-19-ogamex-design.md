# OgameX 自动化系统 — 设计 Spec

- **Status**: Draft v1
- **Date**: 2026-05-19
- **Target server**: ogame.org 官方商业服
- **Host**: `ddxs@192.168.2.100` (主机名 `europa`, OpenClaw v2026.5.18 已部署)

---

## 1. 目标与约束

### 1.1 目标
构建一个长驻 Ogame 自动化系统，覆盖三类任务：

| 类别 | 频率/触发 | 是否需要 LLM | 实现位置 |
|---|---|---|---|
| **日常任务** (7×24) | 每 10-60s | 否 | userscript 内 |
| **目标任务** (用户驱动) | 用户 Discord 下指令 | 是（NLU） | OpenClaw plugin |
| **紧急任务** (中断式) | 事件触发 | 否 | userscript 内 |

### 1.2 硬约束
- **ToS 风险**：ogame.org GameForge ToS 禁止自动化脚本。系统通过 **attach 用户真实 Chrome 会话**降低指纹差异，但被检测责任在用户。
- **基础设施约束**：单机部署在 openclaw 主机，依赖 GNOME + Chrome + OpenClaw v2026.5.17+。
- **故障隔离**：OpenClaw 挂掉时日常 + 紧急任务必须照常运行；userscript 挂掉时 plugin 必须保留目标待恢复。

### 1.3 非目标
- 农场刷怪（attack inactives，已剔除，风险过高）
- 多账号并行
- 历史战报分析、市场套利、联盟联合作战
- 离线远程 web UI（Discord 即唯一外部界面）

---

## 2. 总体架构

### 2.1 双引擎拓扑

```
                      User on Discord
                            ↑↓
   ┌─── OpenClaw Gateway :18789 ────────────────────────────┐
   │   Discord ext · LLM (gemma/gemini fallback chain)       │
   │                                                          │
   │   ┌──── OgameX-OC plugin (goals + LLM 仲裁) ────┐       │
   │   │  Tools (LLM-facing):                         │       │
   │   │    ogame_add_goal · query_goals · cancel...  │       │
   │   │  GoalEngine + Planner + tech_tree.ts         │       │
   │   │  HTTP/WS server (userscript-facing):         │       │
   │   │    ws://127.0.0.1:18790                      │       │
   │   │    GET/POST /ogamex/v1/* (long-poll fallback)│       │
   │   │  Reporter → Discord (markdown)               │       │
   │   │  MemoryWriter → ogamex-live-state.md         │       │
   │   │  StrategyStore (SQLite + git audit log)      │       │
   │   │  GoalsStore (SQLite)                         │       │
   │   └──────────────────────────────────────────────┘       │
   └────────────────────────┬────────────────────────────────┘
                            │ WS 主通道 + HTTP 兜底
                            │ ↑↓
   ┌────────────────────────┴───────────────────────────────┐
   │   Chrome (用户真实 session, ogame 已登录)              │
   │   Tampermonkey: ogame-runtime.user.js                  │
   │   ├─ Probes (MutationObserver / XHR hook / extractors) │
   │   ├─ EventBus (内部事件总线)                            │
   │   ├─ DailyLoop      ← 7×24 ambient                     │
   │   ├─ EmergencyHandler ← 0ms reaction, in-page          │
   │   ├─ GoalRunner     ← 收 plugin 下发 directives        │
   │   ├─ Auditor        ← 事件驱动 self-audit              │
   │   ├─ DirectiveExecutor (点击 / 表单 / 拟人化时序)       │
   │   ├─ StateStore (IndexedDB)                            │
   │   └─ Bridge (WS 客户端 + 重连 + fallback long-poll)    │
   └────────────────────────────────────────────────────────┘
```

### 2.2 故障域

| 故障 | 日常 | 紧急 | 目标 | 处理 |
|---|---|---|---|---|
| OpenClaw 整体宕 | ✅ | ✅ | ⏸ | userscript STANDALONE_MODE，目标暂停，事件排队 |
| Plugin 进程崩 | ✅ | ✅ | ⏸ | 同上 |
| userscript / Chrome 崩 | ❌ | ❌ | ⏸ | systemd 守护 Chrome 进程，崩则重启 |
| 网络断（局域网正常）| ✅ | ✅ | ✅ | 全 localhost，无影响 |
| ogame DOM 改版 | 部分降级 | 部分降级 | 部分降级 | extractor 失败 → 上报 → LLM 协助适配 |

---

## 3. 三类任务体系

### 3.1 日常任务（userscript 内）

YAML 驱动的固定 pipeline，全规则化：

```yaml
daily:
  expedition:                          # 详见 §3.1.1 远征专题
    enabled: true
    auto_fill_slots: true              # 始终占满 astrophysics 解锁的槽位
    
  resource_balance:
    enabled: true
    trigger_overflow_pct: 85
    action: redistribute_to_lowest
    
  defense_replenish:
    enabled: true
    keep_minimum: {rocketLauncher: 1000, lightLaser: 500}
    
  default_build:
    enabled: true
    strategy: maintain_ratio
    ratio: {metalMine: 1.0, crystalMine: 0.6, deuteriumSynth: 0.4}
    
  heartbeat:
    enabled: true
    schedule:
      - "06:00 collect_officer_bonus"
      - "every 4h click_random_planet"
```

每个子任务独立 enable/disable。每次失败上报 → 失败累计 → LLM 调整策略。

### 3.1.1 远征任务专题（数据驱动自适应）

远征不是"开火即忘"，是一个**完整反馈控制循环**：观测战报 → 统计 (黑洞率/产出/损失) → 决策 (换星系/调编队) → 执行下一轮。

#### 配置 schema

```yaml
daily.expedition:
  enabled: true
  auto_fill_slots: true
  source_planet: null               # null = 各星球本星系发；指定 = 单点发
  duration: short                   # short(1h)/medium(2h)/long(4h)
  target_position: 16
  
  fleet_templates:                  # 多模板，按损失率/黑洞率自动切换
    conservative:
      fleet: {smallCargo: 30, largeCargo: 20, lightFighter: 30, espionageProbe: 1}
      used_when: "black_hole_rate_24h > 0.05"
      reason: "黑洞率高，缩减投入"
    standard:
      fleet: {smallCargo: 50, largeCargo: 30, lightFighter: 50, espionageProbe: 1}
      used_when: "default"
    aggressive:
      fleet: {smallCargo: 100, largeCargo: 50, lightFighter: 100, cruiser: 20, espionageProbe: 1}
      used_when: "black_hole_rate_24h < 0.01 AND avg_resource_yield_24h > 500000"
      reason: "低风险高产出，加码"
  
  galaxy_strategy:
    mode: "stats_based"             # stats_based / fixed / rotate
    home_galaxy_first: true         # 优先各星球本星系（省 deut）
    switch_threshold:
      black_hole_rate_24h: 0.05     # ≥5% 触发评估
      sample_size_min: 20           # 至少 20 次远征才有统计意义
    cross_galaxy_deut_budget: 50000 # 跨星系远征单次 deut 上限
  
  cargo_load:
    smallCargo_capacity_pct: 100    # 装满（带回资源更多）
    largeCargo_capacity_pct: 100
```

#### 远征战报数据模型

```ts
type ExpeditionOutcome = {
  expedition_id: string,                       // 来自 fleetIdToReturn
  source_planet_id: string,
  source_coords: [number, number, number],
  target_galaxy: number,
  target_system: number,
  target_position: 16,
  template_id: string,                         // "conservative" | "standard" | ...
  fleet_sent: Record<string, number>,
  launched_at: number,
  returned_at: number,
  duration_actual_seconds: number,
  outcome_type: 
    | "resources_small" | "resources_medium" | "resources_large"
    | "ships_gained_small" | "ships_gained_medium" | "ships_gained_large"
    | "aliens_easy" | "aliens_hard"
    | "pirates_easy" | "pirates_hard"
    | "merchant" | "explorer"
    | "delay_short" | "delay_long"
    | "early_return"
    | "black_hole"
    | "nothing"
    | "item_dark_matter" | "item_other",
  resources_gained: { m: number, c: number, d: number },
  ships_gained: Record<string, number>,
  ships_lost: Record<string, number>,          // 大部分为 0，黑洞为全部
  raw_report_id: string,                       // ogame messages id
  raw_report_html_sample: string,              // 关键 DOM 片段留作排障
}
```

#### Slot 填充逻辑

```ts
// 触发：startup / fleet_returned event(expedition) / 每 5min cron 兜底
function fillExpeditionSlots() {
  const astro = state.research.astrophysics;
  const totalSlots = computeExpeditionSlots(astro);    // 见公式
  const officerBonus = state.officers.admiral ? 0 : 0; // ogame 不加 expedition slot
  const inflight = state.fleets_outbound
    .filter(f => f.mission === 15)
    .length;
  const available = totalSlots - inflight;
  
  for (let i = 0; i < available; i++) {
    const source = pickSourcePlanet(state);             // 按 deut/编队可达性
    const galaxy = pickTargetGalaxy(state, source);     // 见 galaxy 策略
    const system = randomSystem(state, source, galaxy); // 防止聚集 1 个系
    const template = pickFleetTemplate(state, galaxy);
    
    enqueueDirective({
      method: "api",                                    // §5.4 fleet API 直发
      action: "send_fleet",
      params: {
        source_planet: source,
        coords: [galaxy, system, 16],
        destType: 1,                                    // 远征是 type=1 (planet 位)
        mission: 15,
        speed: 10,
        ships: template.fleet,
        cargo: minDeutForFlight(source, [galaxy, system, 16], template.fleet),
      },
      reason: `expedition slot ${i+1}/${available} → galaxy ${galaxy}`,
    });
  }
}

// astrophysics → expedition slots
function computeExpeditionSlots(astro: number): number {
  // ogame 公式: floor(sqrt(astrophysics))
  // astro=1 → 1, astro=4 → 2, astro=9 → 3, astro=16 → 4, astro=25 → 5
  return Math.floor(Math.sqrt(astro));
}
```

#### Galaxy 切换算法

```
每次 expedition_returned 事件触发：
   ↓
解析战报 → 落 ExpeditionOutcome 到 IndexedDB
   ↓
Auditor 算:
   - black_hole_rate(galaxy, 24h)  = blackHoles/总数
   - avg_resource_yield(galaxy, 24h) = 总 m+c+d / 总数
   - loss_rate(template, 24h)      = 损失 ships / 派出 ships
   ↓
if black_hole_rate(current_galaxy) > threshold:
   ↓ if sample_size >= 20
   audit.condition_unmet → ws → plugin
   ↓
plugin 找其他 galaxy 历史 stats:
   - 选 black_hole_rate 最低 + avg_yield 不输 50% 的 galaxy
   - 如果你跨星球，优先用与那个 galaxy 同坐标的本星球（省 deut）
   ↓
LLM (or 直接规则) 产 strategy_patch:
   { "daily.expedition.galaxy_strategy.preferred_galaxies": [G1, G2, ...] }
   ↓
userscript 热替换 → 下次 fillExpeditionSlots 用新 galaxy
   ↓
Discord 通告:
   "📊 远征 galaxy 切换：原 G3 黑洞率 7% → 改 G2 (黑洞率 1.2%, 产出持平)"
```

#### Template 自适应

类似 galaxy，但维度是编队：

```
if loss_rate(current_template, 24h) > 10%:
   降级到 conservative
if loss_rate(current_template, 24h) < 2% AND avg_yield > target:
   升级到 aggressive
```

切换由 used_when 条件式自动执行（不走 LLM），因为是简单数值比较。LLM 仅在条件配置本身需要调整时（如阈值 5% 太严了）介入。

#### Audit 规则（远征专属）

在 §8 audit_rules 新增：

| rule_id | 检查 | 触发 |
|---|---|---|
| `expedition_black_hole_rate` | 当前 galaxy 24h 黑洞率 ≥ 5% (sample ≥ 20) | 上报 → 切换 galaxy |
| `expedition_template_loss_rate` | 当前 template 24h 损失率 ≥ 10% | 上报 → 降级 template |
| `expedition_yield_drop` | 24h 均产出 vs 上 7d 跌 50%+ | 上报 → 提示用户/换 galaxy |
| `expedition_slot_underuse` | 24h 内空槽 > 20% 时长 | 上报 → 查 fill 逻辑 bug |
| `expedition_report_parse_fail` | 战报解析失败率 > 5% | 上报 → 修 extractor |

#### 战报解析

```
fleet_returned event (mission=expedition) 触发
   ↓
打开 messages 页 (ajaxNavigation)
   ↓
按 messageId 定位本次战报
   ↓
extractExpeditionReport(html) → ExpeditionOutcome
   ↓
落 IndexedDB.expedition_outcomes
   ↓
emit("expedition_data_updated") → 触发 audit
```

战报 DOM 选择器在 fixture 测试里维护（M3 覆盖）。无法解析的战报落 raw_report_html_sample 上报 plugin → Discord，便于人工 review + 维护 extractor。

#### Discord 周报模板

每天 06:00 输出（节流）：

```
📊 远征日报 2026-05-19
──────────────────────────
昨日 32 次远征（4 slots × 24h ÷ 3h 平均周期）

资源产出: M 3.2M / C 2.1M / D 0.4M = 5.7M 总
舰船获得: 12 SC, 8 LC, 3 LF
舰船损失: 0 (无黑洞)
黑洞率: 0% (24h) / 1.5% (7d)
当前 galaxy: G2 (主要) + G3 (跨星系尝试)
当前 template: standard

⚙️ 上次自动调整: 2026-05-18 03:14
   原因: G3 黑洞率 24h 跳到 7% → 切回 G2
```

---

### 3.2 目标任务（OpenClaw plugin 内）

支持的目标类型：

| 类型 | 含义 |
|---|---|
| `research` | 某科技堆到 N 级（自动选 lab 最高星球） |
| `build` | 单星球某建筑到 N 级 |
| `build_universal` | 所有星球都建到 N 级 |
| `colonize` | 占领指定坐标 |
| `build_ships` | 堆某种舰到 N 艘 |
| `build_defense` | 堆某种防御到 N 件 |
| `terraformer_to` | 行星格数堆到 N |

**Planner**：backward-chaining decomposer，根据 `tech_tree.ts` 静态数据库倒推先决条件，每个 tick 重新规划（不缓存路径，应对状态变化）。

**优先级合并**：
```
0   Emergency
5   Hard maintenance (能源负 / 即将溢出)
10  日常 hard
20-100  用户目标（按 goal.priority）
150 日常 soft
200 默认建造兜底
```

### 3.3 紧急任务（userscript 内）

5 个紧急类型，全 in-page 处理：

| 类型 | 触发 | 自动处理 |
|---|---|---|
| `attack` | hostile event 进入 SAVE_WINDOW (默认 30min) | fleet save 决策树执行（API 直发） |
| `spy` | 被侦察 | 记录 + 上报，默认不反侦察 |
| `fleet_anomaly` | 状态 diff 异常（舰队消失等）| 暂停该星球自动化 + 上报 |
| `resource_critical` | 即将溢出且调运失败 | 暂停该星球建造 + 上报 |
| `extractor_failure` | DOM/XHR 解析失败 | 暂停受影响功能 + 上报原 HTML |

#### 紧急任务的绝对优先级（硬规则）

紧急任务（尤其 `attack` → fleet save）是系统中**唯一不可抢占的优先级**：

- **优先级 0**：所有其它任务（含日常/目标/默认建造/资源调运）必须让位
- **不受 `/pause` 限制**：用户 `/pause all` 时紧急仍照跑（除非显式 `/pause --include-emergency`）
- **不受 `USER_AT_KEYBOARD` 模式限制**：用户正在浏览器里操作时，紧急仍可抢占点击（fleet save 不让座）
- **不等待动作速率限制**：§5.2 RATE_LIMITS 在紧急路径上失效（最小间隔 0ms）
- **不等待人类活动 idle 窗口**：直接执行
- **不等待 `require_confirm`**：所有 fleet save 的 confirm 流程绕过

> 这是系统的"红线"：紧急任务一旦触发，**所有抑制信号失效**。Owner 意识：宁可误触发被你回头抱怨，不可被打没保住。

#### Fleet Save 战术（核心命门，玩家级 know-how）

**底层逻辑**：用"飞行中"这个**第四状态**绕开三件事——攻击命中地面（planet/moon）、月球矩阵 phalanx 扫描飞行轨迹、敌人推测我们归位时间。**实现手段**：10% 速度拉长飞行时长 + 不真正到达 + 威胁消散后主动 recall。

##### 三 case 决策（按舰队当前所在地）

```
hostile_event arrives_in ≤ save_window_minutes
   ↓
[Case 决策器]
   ├─ Case A: 舰队当前在【月球】(coords=G:S:P, type=moon)
   │  → mission = 8 (recycle), dest = debris (G:S:P, type=2)
   │  → speed = 1 (10%)
   │  → 必带 recycler ≥ 1
   │  → 资源全带
   │  → 理由：月-废墟距离极短，10% 飞行时间 ~20-40min，
   │          phalanx 从攻击者月球扫不到本地月球出发的航线
   │
   ├─ Case B: 舰队在【星球】+ 同坐标存在【月球】
   │  → mission = 3 (transport), dest = moon (G:S:P, type=3)
   │  → speed = 10 (100%)
   │  → 必带 recycler ≥ 1
   │  → 资源全带
   │  → 理由：月球是独立目标，攻击者打 planet 不会命中 moon 上的舰队
   │          全速上月球秒级到达，避开攻击窗口
   │  → 注：到月球后舰队"停"在月球上；下次再有威胁时按 Case A 处理
   │
   └─ Case C: 舰队在【星球】+ 同坐标无【月球】
      → mission = 8 (recycle), dest = debris (G:S:P, type=2)
      → speed = 1 (10%)
      → 必带 recycler ≥ 1
      → 资源全带
      → 理由：2026 版废墟不存在也允许 recycle mission 起飞
              10% 速度单程 30-60min，足够覆盖攻击 + 余量窗口
```

##### Recycler 强制规则

**每个紧急起飞编队必须包含至少 1 艘 recycler**。日常远征任务豁免（用 `daily.expedition.fleet_template` 配置）。

理由：
1. recycle mission 服务端要求至少 1 recycler
2. Case B 虽然是 transport mission 不强制 recycler，但**保留一致性**——舰队到月球后下次可能进入 Case A，预装 recycler 省一步
3. 若星球无可用 recycler，**降级方案**：先排队造 1 艘 recycler（非紧急时段），紧急时若没有 → 改 mission=3 transport 到月球（仅 Case B 可用）；其他 case 失败 → 上报

##### Recall 闭环（命门中的命门）

```
LAUNCHING → IN_FLIGHT
       ↓
   持续监听 events_incoming
       ↓
   所有 hostile 事件 (源攻击 + 同源后续波) 全部完成 / 取消？
       ├─ NO  → 继续等
       └─ YES → 进入 RECALL_READY
                ↓
            等 safety_margin (默认 5min, 防新增攻击)
                ↓
            POST /game/index.php?page=ingame&component=movement
                 &return=<fleetId>&token=<...>
                ↓
            RECALL_CONFIRMED → 舰队 U-turn 回家
                ↓
            recall 后飞行时间 = launch 到 recall 的累计时间
                ↓
            到家时间 = 现在 + 已飞时间，比原计划到达 destination 更早
```

**关键不变量**：舰队必须在攻击命中前**已起飞** + 在威胁消散前**未到达 destination**。

- 起飞时机：检测到 hostile 即刻发（≤ 500ms 完成 API 调用）
- 不真到达：选 10% 速度（Case A、C）让飞行足够长；选月球 100%（Case B）目标是独立坐标，到达不被攻击命中
- 不提前回：recall 只在所有威胁解除后 + safety_margin 后触发

**Case B 特殊**：100% 飞月球，可能在攻击命中前就到了月球——这是 OK 的，因为月球本身是安全的（不同 target）。这里不 recall（除非月球本身随后被攻击）。

##### Phalanx 反检测策略

> Phalanx（月球矩阵）能扫到敌方月球范围内的舰队 origin/dest/eta。**真正到达 debris 后**舰队 stationary，敌人下次能 phalanx 看到舰队位置 → 月球被锁定 → 后续连环攻击。所以必须 **recall before arrival**。

舰队飞行中也能被 phalanx，但仅当攻击者月球能覆盖到飞行航线时。本地（同坐标）出发到本地废墟的航线极短，**通常不在攻击者 phalanx 半径内**——这是 Case A、C 的核心安全假设。

##### Save 失败降级

```
Case 决策失败 → 降级链:
   Case A 失败 (例: 月球无 recycler) → 跑 Case B 备选 (送舰队到本月球——但已经在月球) → 失败
       → 最后兜底: 抛 spy mission 到任意远端坐标 + 全速 + 仍带 recycler
   Case B 失败 (例: 无月球) → 自动落到 Case C
   Case C 失败 (例: deut 不足以 10% 推到正常 deut 消耗) → 降速到能跑的最低档
   所有降级都失败 → 推 Discord 高危报警 + 暂停该星球自动化 + 等 /resume
```

##### Save 状态机

```
WATCHING ──hostile_in_window──► THREAT_DETECTED ──案例选定──► SAVE_PLANNED
                                                                 │
                                              ┌──────api 失败───┤
                                              ↓                  │
                                         FALLBACK            LAUNCHING ── api 成功 ──► IN_FLIGHT
                                                                                          │
                                                                       all clear + margin │
                                                                                          ↓
                                                                                  RECALL_READY
                                                                                          │
                                                                          api recall      │
                                                                                          ↓
                                                                                   RECALLING
                                                                                          │
                                                                                 fleet @ home
                                                                                          ↓
                                                                                    RETURNED
```

**关键性能指标**：
- THREAT_DETECTED → LAUNCHING(api success) **≤ 500ms**
- IN_FLIGHT 持续监听 events 频率 ≥ 1Hz
- RECALL_READY → RECALLING(api success) ≤ 1s（不及时可能错过窗口）

---

## 4. State 抓取层（userscript 内）

### 4.1 Schema

```ts
type WorldState = {
  server: { universe: string, speed: number },
  player: { id: string, name: string, alliance: string | null },
  planets: Planet[],
  research: { levels: Record<string, number>, queue: ResearchQueue | null },
  fleets_outbound: Fleet[],
  events_incoming: Event[],
  last_update: number,
  page_snapshots: Record<string, number>  // page -> ts of last scrape
}

type Planet = {
  id: string, name: string, coords: [number, number, number], 
  type: "planet" | "moon",
  resources: { m: number, c: number, d: number, e: number },
  storage: { m_max: number, c_max: number, d_max: number },
  production: { m_h: number, c_h: number, d_h: number },
  buildings: Record<string, number>,
  queue: { item: string, level: number, ends_at: number } | null,
  shipyard_q: ShipyardQueue | null,
  defense_q: DefenseQueue | null,
  ships: Record<string, number>,
  defense: Record<string, number>,
}
```

### 4.2 三种探针

```
[A] MutationObserver
    监听 #eventContent, #resources_*, .fleet_movement
    → 页内变化 0 延迟感知

[B] XHR/fetch hook
    hook window.fetch + XMLHttpRequest.prototype.send
    拦截 ogame ajax 响应（fetchResources / eventList / fleetdispatch）
    → 比 DOM 解析更稳

[C] 定时主动巡航
    复用 ogame 自带 ajaxNavigation() 做 SPA 跳转
    覆盖 [A][B] 抓不到的页（research / shipyard）
```

### 4.3 抓取频率（拟人化）

| 数据 | 间隔 | 抖动 |
|---|---|---|
| overview / events | 5-15 min | ±60s |
| planet rotation | 30-90 min | ±10min |
| fleetmovement (有舰队在外) | 10 min | ±2min |
| research | 6 hr | ±30min |
| 深夜模式 00:00-07:00 | 频率减半 | 更长抖动 |

### 4.4 兜底策略

每个 extractor 是纯函数 `extract(html|xhr) -> Slice | null`：
- 失败不抛异常
- 返回 null + 写 IndexedDB `extract_failures` 表
- 上报 plugin → Discord "⚠️ XX 抓取失败"
- 受影响功能降级，其他照跑

---

## 5. 执行层（DirectiveExecutor，userscript 内）

### 5.1 Directive 生命周期

```
Directive 进入队列 (来自 daily / emergency / plugin push)
   ↓
[Validate]   类型/参数 schema 校验
   ↓
[Feasibility] 检查 preconds（资源/队列/冷却）
   ├─ 不满足 → 标记 blocked，next tick 重试
   └─ 满足 → 继续
   ↓
[Navigate]   ogame.ajaxNavigation(target_page)
              等待 page_ready signal（DOMContentLoaded + key element 出现）
   ↓
[Locate]     选择器链：data-* → id → class → text
              失败 → extractor_failure 事件，3 次重试后放弃
   ↓
[Humanize]   随机延迟 300-800ms（β 分布偏短）
              dispatch MouseEvent (move + over + down + up + click)
   ↓
[Act]        执行（点击/表单 submit/select）
   ↓
[Verify]     轮询 DOM 变化或 XHR 响应，确认动作生效
              超时 5s → 失败
   ↓
[Ack]        WS 上报 directive.completed | directive.failed
              同步更新本地 StateStore（不等下次抓取）
```

### 5.2 速率限制

```ts
const RATE_LIMITS = {
  minIntervalBetweenActions: 3000,    // ms, 任何两个动作之间至少 3s
  clickDelayMin: 300, clickDelayMax: 800,
  navigationDelayMin: 1500, navigationDelayMax: 3500,
  maxActionsPerMinute: 12,            // 硬上限
  maxActionsPerHour: 300,
}
```

**特殊场景**：emergency 时上述限制全部放宽到 0（紧急保命优先），其他时段严格遵守。

### 5.3 重试策略

```
attempt 1 → fail → wait 5s
attempt 2 → fail → wait 30s
attempt 3 → fail → 上报 event.daily_failure，本 directive 不再重试
```

连续 3 个同类 failure → 暂停该子任务 + 上报。

紧急路径独立重试策略：fleet save 失败 → 立即重试 2 次（无延迟）→ 仍失败则降级方案（如目标星不可达换次优）→ 全部失败上报。

### 5.4 Fleet 操作走 ogame 内部 API（不走 UI）

**所有发射舰队的动作** (`mission`-driven 操作) 通过直接 `fetch` 调用 ogame 的 ajax 端点完成，**不**走 fleetdispatch 页 UI 点击。这是紧急保命的命门，也是日常远征/调运的效率抓手。

#### 适用范围

| 动作 | 方式 | 理由 |
|---|---|---|
| Fleet save (emergency) | **API** | 50ms 完成 vs UI 3-5s，0 容错 |
| Expedition (daily) | **API** | 高频循环，UI 流程重 |
| Resource transport (daily) | **API** | 同上 |
| Colonize (goal) | **API** | 一次性，稳定性优先 |
| Deploy / Attack (goal/user) | **API** | 一致性 |
| Build / Research / Defense 队列 | UI 点击 | 非时间敏感，保留拟人化 |

#### 端点（实测后填充确切路径）

```
POST /game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
credentials: same-origin   ← 自动带 session cookie

body (URLSearchParams):
  token=<CSRF, 从当前页 DOM 或 ogame 内部 JS 状态抓>
  galaxy=<int>  system=<int>  position=<int>
  type=<1=planet | 2=debris | 3=moon>
  mission=<1=attack | 3=transport | 4=deploy | 5=adsd | 15=expedition | ...>
  speed=<1..10, 10=100%>
  metal=<int>  crystal=<int>  deuterium=<int>
  am202=<smallCargo count>  am203=<largeCargo>  am204=<lightFighter>
  am205=<heavyFighter>  am206=<cruiser>  am207=<battleship>
  am215=<battlecruiser>  am211=<bomber>  am213=<destroyer>
  am214=<deathstar>  am218=<reaper>  am219=<pathfinder>
  am208=<colonyShip>  am209=<recycler>  am210=<espionageProbe>

response: JSON
  { success: bool, message: string, fleetIdToReturn?: number, ... }
```

#### TS 实现骨架

```ts
async function sendFleetDirect(params: SendFleetParams): Promise<SendFleetResult> {
  const token = await getFreshToken();   // 从 DOM 或 ogame 内部 JS state
  const body = new URLSearchParams();
  body.set('token', token);
  body.set('galaxy', String(params.coords[0]));
  body.set('system', String(params.coords[1]));
  body.set('position', String(params.coords[2]));
  body.set('type', String(params.destType));
  body.set('mission', String(params.mission));
  body.set('speed', String(params.speed));
  body.set('metal', String(params.cargo.m || 0));
  body.set('crystal', String(params.cargo.c || 0));
  body.set('deuterium', String(params.cargo.d || 0));
  for (const [shipId, count] of Object.entries(params.ships)) {
    body.set(`am${shipId}`, String(count));
  }
  
  const res = await fetch(
    '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
      credentials: 'same-origin',
    }
  );
  if (!res.ok) throw new FleetApiError(`http ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new FleetApiError(json.message || 'unknown');
  return { fleetId: json.fleetIdToReturn, raw: json };
}
```

#### Token 管理

- ogame 的 CSRF token 在登录会话内通常静态，但**ogame 偶尔轮转**，过期返回 4xx + 特定 message
- 策略：
  - **缓存**：每次抓取页面时把 token 落 IndexedDB
  - **失败自愈**：API 调用 401/token expired → 静默触发一次 `ajaxNavigation("fleetdispatch")` → 重抓 token → 重试 1 次
  - **预热**：日常每小时随机一次访问 fleetdispatch 页保 token 新鲜（也增加"人类访问该页"的行为指纹）

#### 反检测视角

直接 API 在指纹上**比 UI 点击更可疑**（少了鼠标 trace、page navigation）。但在 fleet save 这个场景下：
1. 真人玩家紧急保命时也会"狂飙手速"，单次 API 调用 vs 多次 UI 点击的时间差 GameForge 难判定
2. 我们日常已经定期访问 fleetdispatch 页（token 预热），有"该用户最近在看这个页"的访问 trace
3. 比起被打损失，可疑性是次要风险

**只用 ajax API 不用 raw HTTP**：ogame 服务端会用 `X-Requested-With` 区分 ajax 来源，伪装比直发更危险。我们走 ajax 端点（`ajax=1` 参数）+ 浏览器标准 fetch + 同源 credentials，**和页内 ogame 自己的 JS 行为完全一致**。

#### Fleet recall（紧急 save 闭环命门，本期必须实现）

```
POST /game/index.php?page=ingame&component=movement&return=<fleetId>&token=<...>
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
credentials: same-origin

response: JSON { success: bool, message: string, ... }
```

调用时机由 §3.3 状态机的 `RECALL_READY → RECALLING` 转移控制，**不在本期延后**。

#### 其他可 API 化的动作（后续可加，非本期目标）

```
建造队列:   POST ?page=ingame&component=supplies&modus=1&token=...&type=N
研究队列:   POST ?page=ingame&component=research&modus=1&token=...&type=N
舰船队列:   POST ?page=ingame&component=shipyard&modus=1&token=...&type=N&menge=N
防御队列:   POST ?page=ingame&component=defenses&modus=1&token=...&type=N&menge=N
```

本期 M0-M8 仅强制 **fleet send + fleet recall** 走 API（紧急保命闭环），其它仍走 UI（保拟人化）。后续如需提速可逐步扩展。

---

## 6. 观测层

### 6.1 报告类型与节流

| 类型 | 触发 | 节流 | 通道 |
|---|---|---|---|
| `emergency.attack.*` | 立即 | 无 | Discord 立推 |
| `emergency.anomaly` | 立即 | 无 | Discord 立推 |
| `goal.progress` | 每个子步骤完成 | 每目标 1h 至多 1 次 | Discord |
| `goal.completed` | 全完成 | 无 | Discord |
| `goal.blocked` | 卡资源/prereq | 每目标 24h 至多 1 次 | Discord |
| `daily.expedition_digest` | 06:00 cron | 每日 1 次 | Discord 日报 |
| `strategy.updated` | LLM 改完 | 无 | Discord（关键参数 🔴 高亮）|
| `extractor.failure` | 解析失败 | 每选择器 1h 1 次 | Discord |
| `audit.condition_unmet` | userscript 上报 | 同 audit rule 1h 1 次 | 内部，触发 LLM |

### 6.2 Markdown 模板

每条 Discord 消息双格式：
- `data` 字段：结构化 JSON（如未来要 forward 到其他系统）
- `markdown_report` 字段：预格式化人话

模板存 `~/.openclaw/workspace/skills/ogamex/templates/*.md`，支持 strategy patch 时变更。

### 6.3 健康指标

- userscript heartbeat: 每 30s ping plugin
- plugin heartbeat: 每 60s 检查 userscript 心跳，断超 2min 标记 disconnected
- `GET /ogamex/v1/health` 返回:
  - userscript: connected/disconnected, last_seen_ts
  - chrome_session: ogame_logged_in (true/false), current_page
  - sidecar: uptime, last_strategy_version, active_goals_count
  - llm: last_call_ts, monthly_cost_estimate

---

## 7. 反检测

### 7.1 指纹层（基础）

- 复用用户真实 Chrome session（CDP attach via OpenClaw `browser` ext 的 user profile）
- 不注入 `navigator.webdriver=true`
- 不开 headless 模式
- 不用独立 profile（除非用户真实 profile 无法用）

### 7.2 时序层

- 所有定时任务带 ±20% 抖动
- 动作间隔 ≥ 3s（emergency 例外）
- 深夜模式（00:00-07:00 UTC）：频率减半 + 更大抖动
- 24h 内动作分布大致符合正态/泊松，不出现均匀脉冲

### 7.3 行为层

- 检测到用户活动（鼠标/键盘）→ `USER_AT_KEYBOARD` 模式，**bot 让座**：
  - 暂停 daily + goal 下发（不再点击）
  - 紧急仍处理
  - 用户 idle 15min 后恢复
- 多个 directive 顺序可交换时随机打乱（避免固定 pattern）
- 不连续访问同一页 > 5 次

### 7.4 兜底层

- 检测到 Cloudflare 挑战页 → 立即暂停所有动作 + 推 Discord
- 检测到 CAPTCHA → 同上
- 检测到 ogame 出现"操作过于频繁"等限速提示 → 退避 30min + 上报

---

## 8. 自适应策略层

### 8.1 策略版本化

```ts
type Strategy = {
  version: number,                  // 单调递增
  updated_at: number,
  updated_by: "openclaw-llm" | "user-discord" | "userscript-bootstrap",
  reason: string,
  daily: { expedition, resource_balance, default_build, defense_replenish, heartbeat },
  emergency: { attack, spy, anomaly, resource_critical },
  audit_rules_thresholds: Record<string, number>,
}
```

userscript 启动 WS 时同步 `strategy.full`，运行中收 `strategy.update` 热替换（不打断当前 directive）。

### 8.2 失败上报 → LLM 改策略闭环

```
userscript 失败 (3 次重试后)
   ↓ ws
plugin 累计同类失败计数
   ↓ 达到阈值 (e.g., 3次/24h)
plugin 调内部 tool: analyze_daily_failure(task, history, state)
   ↓ LLM 通过 OpenClaw 给出 patch JSON
plugin 校验类型/范围 → 应用 → version++ → git commit
   ↓ ws
userscript 热替换 → 用新策略继续
   ↓
plugin → Discord 通告
```

LLM 改动**不设白名单**，但必须通过：
- typebox schema 验证
- 数值合理性范围（每个字段预设 [min, max]）
- git commit + Discord 通告

### 8.3 事件驱动审计（取消定时）

```ts
EventBus.subscribe("resource_arrived",   () => runAudits(["resource_overflow_24h", "fleet_save_coverage_24h"]))
EventBus.subscribe("building_completed", () => runAudits(["queue_filler_efficiency"]))
EventBus.subscribe("research_completed", () => runAudits(["research_progress_rate"]))
EventBus.subscribe("fleet_returned",     () => runAudits(["expedition_loss_rate_50"]))
EventBus.subscribe("attack_resolved",    () => runAudits(["fleet_save_coverage_24h", "defense_minimum_breach"]))
EventBus.subscribe("directive_failed",   () => runAudits(["directive_failure_rate"]))
EventBus.subscribe("day_boundary",       () => runAudits([/* all */]))
```

审计函数体硬编码在 userscript（不被 LLM 修改），只有 thresholds 通过 strategy.audit_rules_thresholds 远程可调。

### 8.4 回滚

```
/strategy history     最近 20 个版本 + commit 摘要
/strategy diff v40 v42  对比
/strategy rollback v40  回到指定版本
```

git repo at `~/.openclaw/workspace/memory/.git-ogamex/`。

---

## 9. OpenClaw 记忆集成

### 9.1 记忆文件路径

```
~/.openclaw/workspace/memory/ogamex-live-state.md   ← 自动生成
```

在 `~/.openclaw/workspace/MEMORY.md` 索引追加：
```
- [OgameX live state](memory/ogamex-live-state.md) — 当前目标 / 日常任务 / 策略版本
```

### 9.2 记忆内容（自动维护）

包含 active goals、daily task status、当前 strategy、recent failures（24h）、recent emergencies（7d）、self-audit status、pending user actions。完整模板见附录 A。

### 9.3 写入策略

- 5s debounce（多个事件合并）
- 强制 60s 至少一次
- 触发条件：goal 变化 / 策略版本变 / 紧急事件 / failure 上报 / day_boundary
- LLM 在 OpenClaw 对话中自动看到，无需主动 query

---

## 10. WS 通信协议

### 10.1 连接

```
URL: ws://127.0.0.1:18790
Headers: Authorization: Bearer <OGAMEX_BRIDGE_TOKEN>
```

PNA preflight 响应：
```
Access-Control-Allow-Origin: https://*.ogame.org
Access-Control-Allow-Private-Network: true
```

### 10.2 消息 schema

```ts
// userscript → plugin
type Upstream =
  | { type: "hello", strategy_version: number, userscript_version: string }
  | { type: "state.snapshot", ts: number, snapshot: WorldState, strategy_version: number }
  | { type: "event.emergency", subtype: string, data: any, markdown_report: string }
  | { type: "event.daily_failure", task: string, attempts: number, last_error: string, context: any }
  | { type: "event.directive_completed", directive_id: string, result: any }
  | { type: "event.extractor_failure", extractor: string, raw_html_sample: string }
  | { type: "audit.condition_unmet", rule_id: string, evidence: any }
  | { type: "pong", ts: number }

// plugin → userscript
type Downstream =
  | { type: "strategy.full", strategy: Strategy }
  | { type: "strategy.update", version: number, patch: Record<string, any>, reason: string }
  | { type: "directive.dispatch", directive: Directive }
  | { type: "directive.cancel", id: string, reason: string }
  | { type: "config.set", key: string, value: any }
  | { type: "ping", ts: number }
```

### 10.3 兜底降级

WS 连不上时（PNA 拦截等）→ HTTP long-polling via `GM_xmlhttpRequest`：
```
POST /ogamex/v1/poll        body: {since_ts, ack_ids}
                            响应 hang 30s 或新消息
POST /ogamex/v1/push        body: { type, ...payload }
```

---

## 11. OgameX plugin 工具（LLM-facing）

注册在 `defineToolPlugin` 里的工具，LLM 可调：

| Tool name | 作用 | 默认 require_confirm |
|---|---|---|
| `ogame_query_state` | 查当前状态 | false |
| `ogame_query_goals` | 列目标 | false |
| `ogame_add_goal` | 新增目标 | true |
| `ogame_cancel_goal` | 取消目标 | true |
| `ogame_pause_automation` | 暂停（scope）| false |
| `ogame_resume_automation` | 恢复 | false |
| `ogame_query_events` | 事件流 | false |
| `ogame_force_action` | 直接动作 | true |
| `ogame_explain_directive` | 看 directive 推理 | false |
| `ogame_get_eta` | 重算 ETA | false |

`require_confirm=true` 的工具：LLM 调用返回 `pending_action_id`，用户 Discord 回 yes/no 才真正落地。

---

## 12. 文件结构

```
~/Sync/Works/ogamex/
├─ packages/
│  ├─ runtime-userscript/              # Tampermonkey 脚本
│  │  ├─ src/
│  │  │  ├─ main.ts                    # @match ogame.org 入口
│  │  │  ├─ probes/
│  │  │  │  ├─ mutation_observer.ts
│  │  │  │  ├─ xhr_hook.ts
│  │  │  │  └─ extractors/
│  │  │  ├─ event_bus.ts
│  │  │  ├─ daily/
│  │  │  │  ├─ expedition.ts
│  │  │  │  ├─ resource_balance.ts
│  │  │  │  ├─ defense_replenish.ts
│  │  │  │  └─ default_build.ts
│  │  │  ├─ emergency/
│  │  │  │  ├─ attack.ts
│  │  │  │  ├─ spy.ts
│  │  │  │  └─ anomaly.ts
│  │  │  ├─ goal_runner.ts
│  │  │  ├─ auditor.ts
│  │  │  ├─ directive_executor.ts
│  │  │  ├─ store/
│  │  │  │  └─ indexed_db.ts
│  │  │  ├─ bridge/
│  │  │  │  ├─ ws_client.ts
│  │  │  │  └─ http_fallback.ts
│  │  │  └─ activity_tracker.ts
│  │  ├─ rollup.config.js              # 打包成单文件 .user.js
│  │  └─ dist/ogame-runtime.user.js
│  │
│  ├─ openclaw-plugin/                 # OpenClaw 插件
│  │  ├─ src/
│  │  │  ├─ index.ts                   # defineToolPlugin 入口
│  │  │  ├─ tools/
│  │  │  │  ├─ add_goal.ts
│  │  │  │  ├─ cancel_goal.ts
│  │  │  │  ├─ query_state.ts
│  │  │  │  └─ ...                     # 共 10 个工具
│  │  │  ├─ sidecar/
│  │  │  │  ├─ goal_engine.ts
│  │  │  │  ├─ planner.ts              # backward chaining
│  │  │  │  ├─ ws_server.ts            # ws://127.0.0.1:18790
│  │  │  │  ├─ http_server.ts          # /ogamex/v1/*
│  │  │  │  ├─ reporter.ts             # Discord push
│  │  │  │  ├─ memory_writer.ts        # ogamex-live-state.md
│  │  │  │  └─ strategy_manager.ts     # 版本化 + git commit
│  │  │  ├─ llm/
│  │  │  │  └─ strategy_analyzer.ts    # 失败 → LLM patch
│  │  │  └─ skill/SKILL.md             # 教 LLM 使用工具
│  │  ├─ openclaw.plugin.json
│  │  └─ package.json
│  │
│  └─ shared/                          # 共享类型
│     ├─ types.ts                      # WorldState/Goal/Directive/Strategy
│     ├─ tech_tree.ts                  # Ogame 静态数据库
│     └─ schemas/                      # typebox schemas
│
├─ docs/
│  └─ superpowers/specs/
│     └─ 2026-05-19-ogamex-design.md   # 本文档
├─ scripts/
│  ├─ install_userscript.sh            # 推送到 Tampermonkey
│  └─ register_plugin.sh               # openclaw plugins install
├─ test/
│  ├─ fixtures/ogame_html/             # 真实 ogame 页面快照（脱敏）
│  └─ ...
├─ package.json (monorepo, pnpm workspace)
├─ pnpm-workspace.yaml
└─ README.md
```

---

## 13. 实现阶段（粗略）

| 阶段 | 范围 | 验收 |
|---|---|---|
| **M0** | 项目骨架、shared/types、tech_tree.ts | 类型完整、可编译 |
| **M1** | userscript probes + state extraction + token 抓取 | 能从 ogame 页抓出 WorldState JSON + 持有 token |
| **M2** | **userscript emergency handler + Fleet API 直发**（提前到 M2，命门） | 模拟攻击触发 fleet save，API 调用成功 |
| **M3** | userscript daily loop: 远征自适应循环（数据收集 + 黑洞率统计 + galaxy/template 切换 + 战报解析 + Discord 日报）走 Fleet API | 远征槽位 100% 占用率、24h 报表跑通、galaxy 切换条件触发可演示 |
| **M4** | plugin scaffold + WS server + Discord push | Discord 收到 hello |
| **M5** | plugin goal engine + planner | "/build nanite 6" 跑通 |
| **M6** | strategy versioning + LLM analyzer + memory writer | 失败上报闭环走通 |
| **M7** | reliability hardening: 重连/断网/降级/PNA fallback/token 失效自愈 | 各种故障注入测试 |
| **M8** | observability + audit rules | Discord 日报、健康检查 |

**M2 提前的理由**：紧急保命是用户最不可妥协的能力。先做紧急路径意味着：项目早期就能给玩家"被打不亏"的安全网；M3 以后的日常/目标都建立在"被打能跑"的前提下；fleet API 路径在 M2 打通，后续日常 fleet 操作直接复用。

---

## 14. 待定项 / 风险

- **OpenClaw `browser` extension 的 `profile="user"` 实际行为**：文档说 attach 到用户 Chrome，但具体 CDP 连接方式、是否支持 userscript 注入需要 spike 验证（M1 第一周）
- **Tampermonkey 与 OpenClaw CDP 的共存**：理论上 Tampermonkey 是 Chrome 扩展，独立于 CDP，应该不冲突，但需要实测
- **ogame 改版频率**：extractor 维护成本未知。先做完整 fixture 自动化测试，方便快速修
- **alibaba 服 vs 国际服 DOM 差异**：tech_tree.ts 数值可能需要按 universe.speed 调整
- **systemd 守护 Chrome**：openclaw 用户已有 GNOME session，Chrome 怎么被监控/重启需要确定（GUI 进程 vs xdotool 还是别的）

---

## 附录 A — OpenClaw 记忆文件模板

```markdown
---
name: ogamex-live-state
description: 实时 Ogame 自动化状态
metadata:
  type: project
  auto_generated: true
  source: ogamex-openclaw-plugin
---

# OgameX Live State
*Last updated: {{ts}}*

## Active Goals ({{count}})
{{#each goals}}
- **[P{{priority}} {{status}}]** `{{type}} {{target}}` on {{planet}}
  - 进度 {{progress_pct}}% · ETA {{eta}}
  - 当前步：{{current_step}}
  {{#if blocked}}- blocked_on: {{blocked_reason}}{{/if}}
{{/each}}

## Daily Tasks Status
- **expedition**: {{expedition_status}}
- **resource_balance**: {{rb_status}}
- **default_build**: {{db_status}}
- **defense_replenish**: {{dr_status}}
- **heartbeat**: {{hb_status}}

## Current Strategy
- 版本 **v{{version}}**, 改动者 `{{updated_by}}`, 时间 {{updated_at}}
- 最近原因：{{reason}}
- 关键参数：...

## Recent Failures (24h)
{{...}}

## Recent Emergencies (7d)
{{...}}

## Self-Audit Status
- {{satisfied_count}}/{{total_count}} rules satisfied

## Pending User Actions
{{...}}
```

---

## 附录 B — 关键决策日志

| 决策 | 选择 | 备注 |
|---|---|---|
| 目标服务端 | ogame.org 官方 | ToS 风险已对齐 |
| 自动化范围 | 资源/舰队/信息辅助，**不包括** farming/攻击 | 风险最小化 |
| AI 自主度 | 全自动 + LLM 仲裁策略 | 用户离线值守 |
| 部署 | openclaw 主机 + 真实 Chrome session | 指纹一致 |
| 交互 | OpenClaw plugin + Discord | OpenClaw 已通 Discord |
| LLM | OpenClaw 已配，默认 gemma-4-31b-it + fallback chain | 0 配置 |
| 通信 | WS 主 + HTTP long-poll fallback | 实时 + PNA 兜底 |
| 拉取频率 | 10s state push + 实时 directive | 用户拍板 |
| 审计触发 | 事件驱动（不定时）| 用户拍板 |
| LLM 改策略 | 不设白名单 + schema/范围校验 | 用户拍板 |
| 状态持久化 | OpenClaw memory file | 用户拍板 |
| 紧急任务优先级 | 绝对最高，不可抢占、不受 /pause、不受 USER_AT_KEYBOARD 限制 | 用户拍板 |
| Fleet 操作执行 | 全部走 ogame ajax API (`fetch sendFleet`)，不走 UI 点击 | 用户拍板，命门级提速 |
| M2 提前 | emergency + fleet API → M2，先于 daily loop | 保命能力优先 |
| Fleet save 战术 | 三 case 决策（月球→废墟 10%，星球+月→月 100%，星球无月→本地废墟 10%），强制带 recycler，不真到达 + recall | 玩家级 know-how，§3.3 完整状态机 |
| Recycle to 无废墟 | 2026 版废墟不存在也允许 recycle mission 起飞 | Case C 核心假设 |
| Fleet recall | M2 本期强制实现（紧急闭环不可少） | 不延后到后续 milestone |
| 日常远征 fleet template | **豁免** recycler 强制规则 | 远征自有编队配置 |
| 远征任务模型 | 数据驱动自适应循环（解析战报 → 黑洞率/损失率/产出率统计 → galaxy/template 自动切换） | 用户拍板，§3.1.1 完整闭环 |
| 远征 galaxy 切换 | 阈值触发（黑洞率 ≥5%, sample ≥20）→ LLM 选最优 galaxy → 通过 strategy patch 热切换 | 数据驱动，非人工干预 |
| 远征 template 切换 | 条件式自动（loss_rate / yield 比较）— **不需要 LLM** | 简单规则即可 |
| 远征 slot 占用 | `floor(sqrt(astrophysics))`，fleet_returned 即刻补位 + 5min cron 兜底 | 100% slot 利用率 |
| 远征战报解析失败兜底 | 落 raw_report_html_sample 上报 plugin + Discord，不阻断流水线 | DOM 改版兼容 |
