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
| goals DB | `/tmp/ogamex-smoke/goals.db` |
| strategy repo | `/tmp/ogamex-smoke/strategy/` |

⚠️ `/tmp/` 在主机重启清空 — goals.db 跨重启**会丢**, 这是已知风险, 等后续把存储路径搬到 `~/.openclaw/state/`。

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

历史包袱: 单文件 `ogamex_discord_bridge.mjs` 没有 TS source, 改动靠 Python AST 替换或直接 edit。

```bash
# 改完
scp ogamex_discord_bridge.mjs ddxs@192.168.2.100:/home/ddxs/.openclaw/extensions/ogamex/runtime/ogamex_discord_bridge.mjs
ssh ddxs@192.168.2.100 'systemctl --user restart ogamex-discord-bridge'
```

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
