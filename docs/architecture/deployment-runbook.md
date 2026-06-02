# 部署 / 运维 Runbook

ogamex 三进程在 `ddxs@192.168.2.100` 上通过 systemd user units 管理。

## 拓扑

| 进程 | 用途 | systemd unit | 端口 |
|---|---|---|---|
| openclaw-gateway | 浏览器 RPC 网关 (chrome 注入 + 截图等) | `openclaw-gateway.service` | 18789 |
| ogamex-sidecar | PriorityMerger + WS bridge + HTTP API (`/v1/*`) | `ogamex-sidecar.service` | 28790 ws / 28791 http |
| ogamex-discord-bridge | planner + optimizer + LLM + expedition tick | `ogamex-discord-bridge.service` | — |

externally 由 cloudflared + nginx + `/tmp/ogamex_cf_router.mjs` 反代到 `https://ogame.anyfq.com/ogamex/v1/*`。

## 文件位置

| 用途 | 路径 |
|---|---|
| sidecar launcher | `/home/ddxs/.openclaw/extensions/ogamex/runtime/run_sidecar.mjs` |
| sidecar 主代码 (compiled) | `/home/ddxs/.openclaw/extensions/ogamex/dist/sidecar/*.js` |
| bridge bundle | `/home/ddxs/.openclaw/extensions/ogamex/runtime/ogamex_discord_bridge.mjs` |
| systemd unit files | `/home/ddxs/.config/systemd/user/ogamex-*.service` |
| credentials (env vars) | `/home/ddxs/.openclaw/openclaw.json` (sidecar launcher 读取) |
| goals DB | `~/.openclaw/workspace/ogamex/goals.db` |
| world-state DB (v0.0.635+) | `~/.openclaw/workspace/ogamex/world.db` |
| event audit log (v0.0.635+) | `~/.openclaw/workspace/ogamex/world.db` 内 `events` 表 |
| strategy repo | `~/.openclaw/workspace/ogamex/strategy/` |
| memory dir | `~/.openclaw/workspace/ogamex/memory/` |

✅ v0.0.635 (2026-06-01) 把所有 sidecar 持久化目录从 `/tmp/ogamex-smoke/` 迁到 `~/.openclaw/workspace/ogamex/`，跨主机 reboot 不丢。run_sidecar.mjs 里 4 个 `*DbPath / *Dir` config 同步改了。老 `/tmp` 目录保留 24h 作 safety net，之后可手动 `rm -rf`。

### world.db schema (v0.0.635+)

| 表 | 用途 |
|---|---|
| `world_state` | 单行 JSON blob (`id=1`)，每次 `state.snapshot` 抵达后 1s debounce upsert |
| `events` | append-only audit log (type / payload JSON / created_at)。记录 4 类: `event.emergency`、`event.daily_failure`、`directive.dispatch`、`directive.completed`。boot 时 `trimEvents(10_000)` + 每 1000 次 append 自检剪枝，2MB 上限 |
| `save_records` (v0.0.637+) | SaveCoordinator FSM (planet_id PK)。`pending_event_ids` 序列化为 JSON 数组。每次 launch / 部分清零 / IN_FLIGHT → RECALLING / recall-confirmed 都 mirror |
| `failure_cooldowns` (v0.0.638+) | FailureAggregator 每 task LLM 分析冷却 (task PK, last_analysis_at)。重启不再 prematurely re-fire |

sidecar 启动时 `worldStateStore.hydrate()` 从 `world_state` 行读回，喂给 `stateRef.current` — `priorityMerger` 不再需要等 userscript 首次 snapshot 才能干活。同样 `SaveCoordinator.rehydrate()` + `FailureAggregator` 构造时拉 `listCooldowns()` 都跨重启续接。

### WAL 维护 (v0.0.637+)

`startSidecar` 起 5min 定时 `worldStateStore.checkpoint()` → `PRAGMA wal_checkpoint(TRUNCATE)`。better-sqlite3 自带的 1000-page 自动 checkpoint 在状态推送 + directive 流量下会让 WAL 涨到几百 MB，5min 周期把它拉回低水位。`stop()` 时还做一次 final checkpoint。

### HTTP 端点全景

| 端点 | 方法 | 用途 |
|---|---|---|
| `/ogamex/v1/health` | GET | 健康 + 含 `persistence: { db_path, db_size_bytes, wal_size_bytes, row_counts: { events, save_records, failure_cooldowns, world_state_present } }` 段 (v0.0.638+) |
| `/ogamex/v1/state` | GET | 全 WorldState JSON |
| `/ogamex/v1/goals[?all=true]` | GET | 默认只非 terminal goal (operator 2026-05-31 内存炸过) |
| `/ogamex/v1/events?limit=N&type=foo` | GET | 持久化 audit log，默认 limit=100，硬上限 1000 (v0.0.636+) |
| `/ogamex/v1/expedition` | GET | 远征 slot 状态 |
| `/ogamex/v1/save/active` | GET | 当前活跃 SaveCoordinator FSM 行 |
| `/ogamex/v1/push` | POST | Authorization Bearer token，UpstreamMsg envelope |
| `/ogamex/v1/poll` | POST | body `{ since_ts, ack_ids }`，long-poll downstream queue |
| `/dl/ogame-runtime.user.js` | GET | 从 `/tmp/ogame-runtime.user.js` serve userscript bundle |

### 操作员面板 audit UI (v0.0.639+)

panel 头部 📋 按钮 → audit modal：

- type 下拉过滤：`all` / `directive.dispatch` / `directive.completed` / `event.emergency` / `event.daily_failure`
- limit 输入 1-500，默认 100
- refresh 按钮 + 打开即抓
- 时间戳 + 类型颜色 (directive 蓝 / emergency 红 / failure 黄) + payload preview (240 字截断)

无需 ssh + curl 即可看 sidecar audit log。后端走标准 `GET /v1/events` 端点。

## 操作命令

```bash
# 状态
systemctl --user status ogamex-sidecar ogamex-discord-bridge

# 重启 (改了 dist/sidecar/*.js 之后必走)
systemctl --user restart ogamex-sidecar

# 看实时日志
journalctl --user -u ogamex-sidecar -f
journalctl --user -u ogamex-discord-bridge -f

# 看最近错误
journalctl --user -u ogamex-sidecar -p err -n 50 --no-pager

# 全停
systemctl --user stop ogamex-sidecar ogamex-discord-bridge
```

## 部署流程

### sidecar (priority_merger / planner / WS handler 等)

1. 本地改 `packages/openclaw-plugin/src/sidecar/*.ts`
2. `cd packages/openclaw-plugin && npx tsc`  (dist/ 必须更新)
3. `scp dist/sidecar/<file>.js ddxs@192.168.2.100:/home/ddxs/.openclaw/extensions/ogamex/dist/sidecar/<file>.js`
4. `ssh ddxs@192.168.2.100 'systemctl --user restart ogamex-sidecar'`
5. `curl https://ogame.anyfq.com/ogamex/v1/health` 验 uptime 重置

### userscript (runtime-userscript)

1. 本地改 `packages/runtime-userscript/src/*.ts`
2. `cd packages/runtime-userscript && npx tsc --noEmit` (typecheck 必通, rollup 不 fail-fast)
3. `npm run build` (会产出 `dist/ogame-runtime.user.js`)
4. `scp dist/ogame-runtime.user.js ddxs@192.168.2.100:/tmp/ogame-runtime.user.js`
5. anyfq `/dl/ogame-runtime.user.js` 自动 serve, TM 检查更新即可
6. `rollup.config.js` banner 和 `src/boot.ts` 里的 `RUNTIME_VERSION` 常量两处版本号必须同步

### discord-bridge (老 .mjs daemon)

历史包袱: 单文件 `ogamex_discord_bridge.mjs` 没有 TS source, 也不在本仓库里 (canonical 是远端 `/home/ddxs/.openclaw/extensions/ogamex/runtime/ogamex_discord_bridge.mjs`)。改动靠 ssh `sed`/直接 edit 远端, 或 scp 覆盖。

```bash
# 改完远端文件后
ssh ddxs@192.168.2.100 'systemctl --user restart ogamex-discord-bridge'
# 或直接 kill, openclaw gateway (PPID 6201) 会自动拉
ssh ddxs@192.168.2.100 'kill -TERM <PID>'
```

**⚠️ 重要**: daemon 在 line 25 硬编 `const DB_PATH = "<path>/goals.db"`, 自己用 better-sqlite3 直接打开同一份 goals.db 跟 sidecar 共享。每次迁移 sidecar 持久化路径 (`run_sidecar.mjs` 的 `goalsDbPath` 等), 必须 **同步改 daemon 的 DB_PATH 并重启 daemon**。否则:

- daemon 句柄绑在被 rename / 移除路径的 inode 上 (Linux open-fd 行为)
- daemon 把新 expedition goal 写到孤儿 inode
- sidecar 在新路径 goals.db 看不到这些 goal, panel /v1/goals 显示 0 expedition
- daemon 自己的 `activeExpInQueue` 算到 5, 触发 backlog full 拒绝 dispatch
- 实际表象: **"远征有空槽没飞"** (2026-06-01 实证, S10 迁路径漏 daemon 同步导致)

修法: ssh sed 替换 line 25 DB_PATH → kill -TERM daemon PID → gateway 自动拉新进程, 10s 后正常 dispatch。

## 历史 — 为什么从 screen 搬到 systemd

2026-05-30 排查 "运输又发了两次" bug (operator 凭 ogame 舰队列表证据: 同源同终的 deploy fleet 间隔 20s 重复出击)。

定位过程:
1. 初判 chain 多 leg 误判 → operator 截图反驳 (拒绝)
2. 看 priority_merger stuck-recovery: `STUCK_DEMOTE_AT_ATOMIC=4 snapshot @ ~5s = 20s window` 跟 evidence 完全对上
3. **根因**: snapshot-count 计数法颗粒度太粗, sendFleet 慢 / state 未刷新时窗口飘动 → 误判 directive 丢失 → re-dispatch → 第二条船
4. **修法 (v0.0.478)**: 弃 snapshot 计数, 改 `dispatchedAt` 时间锚 + 时间阈值 (build/research 30s, 原子舰队操作 90s); ack 路径 6 处 + 3 个 CRUD 端点拉通调 `clearDispatched(goalId)`

修期间发现 sidecar 跑在 `screen -dmS sidecar` 里, `^C` 误杀直接 30s 离线, 无 auto-restart。
顺手补 systemd units 落地 `Restart=always`, launcher 从 `/tmp/run_sidecar.mjs` 搬到 `~/.openclaw/extensions/ogamex/runtime/` 抗主机重启。

## 监控 / 告警 (TODO)

目前无监控。下个迭代要加:
- `/v1/health` 5min 探活到 PagerDuty / 邮件
- journalctl `ogamex-sidecar.service` errored exit → 告警
- duplicate fleet 检测 (snapshot 对比 fleets_outbound, 同源/同终/同 ship-bag 间隔 < 60s 任何一对 → 告警)

## 操作规约 / 设计 invariant

### 4 个独立槽位 — 同 family 一次只跑一个 goal

ogame 物理: 单个 body 有 **3 个相互独立的队列**, 加上 **1 个全局 research 队列**, 总共 4 个 slot family。

| Slot family | 抢这个槽的 goal type | scope |
|---|---|---|
| 常规 build_q (supplies/facilities) | `build` + `build_universal` (技术 ID **不在** 11000-15000 范围) | per body |
| lifeform build_q | `lifeform_building` | per body, **与常规 build_q 独立** |
| shipyard_q | `build_ships` + `build_defense` | per body |
| 全局 research | `research` | per empire (跨 body 单槽) |

**合法并行**: 同 body 同时跑 1 个常规 build + 1 个 lifeform build + 1 个 shipyard build 是 ✅ ok 的, 三个槽互不打架。
**禁止重叠**: 同 family 同 body 多个 goal 同时活, 例:
- 同月球 `jumpgate L2` + `lunarBase L8` 两条 `build` goal → 槽位竞争, panel eta_at 错乱
- 跨星球两条 `research` goal → 全局单槽强冲突
- 同 body 两条 `build_ships` → shipyard_q 抢

**Why panel 会显示错**:
- `eta_at` 只属于正在派的那个 goal, 其余 goal `eta_at=null` → 显示 "waiting resources"
- 但实际 ogame 现场: build_q 被同 family 别的 goal 占, "等资源" 不是真相 — 真相是 "等同 family 那条 goal 完工"
- v0.0.479 panel 加了同 family sibling lookup 缓解, 但根治是**不要创建同 family 多 goal**

**正确做法**: 推一个最终目标 goal, planner 自动展开 `prereq_tree` 推导前置, 不要拆成多个并列 goals。

**Auditor TODO**: 加 invariant: 
```
slotFamily(g) = match g.type:
  build | build_universal where techId∉[11000,15000] → "build:"+g.planet
  lifeform_building                                  → "lf:"+g.planet
  build_ships | build_defense                        → "shipyard:"+g.planet
  research                                           → "research:*"
groupBy(activeGoals, slotFamily).any(arr.length > 1) → 告警
```
