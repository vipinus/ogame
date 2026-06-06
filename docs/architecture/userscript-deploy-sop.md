# Userscript / Sidecar 部署 SOP

> 2026-06-05 — operator "部署写文档". 把这一波 deploy 全链路踩坑收口成 SOP, 下次不再返工。

## 顶层流程

任何改动都走 6 步:

1. **改源码** (sidecar `packages/openclaw-plugin/src/sidecar/*.ts` 或 userscript `packages/runtime-userscript/src/**`)
2. **bump 版本两处** (必须同步)
3. **typecheck + build**
4. **deploy 双路径** (sidecar dist + userscript 双 path)
5. **重启 sidecar**
6. **验证 CDN + 端点 + owner panel modal 弹**

## Step 2: bump 版本两处

每次发布 (无论 userscript 改动还是只改 sidecar) 必须同步:

```bash
# 1. rollup banner @version (TM 自动检测靠这条)
packages/runtime-userscript/rollup.config.js  →  // @version      0.0.X

# 2. boot.ts 常量 (panel header 显示 + 上报 hello envelope)
packages/runtime-userscript/src/boot.ts       →  const USERSCRIPT_VERSION = "0.0.X";
```

⚠ 两处不同步 = panel 显示 "v0.0.X" 但跑的是另一版 → 排错地狱 (操作员 2026-06-05 实证踩过)。

**sidecar-only 改动也必须 bump**, 否则:
- panel poll `/v1/runtime-version` 看 `latest == current` → modal 不弹
- owner 看不到新版, 一直怀疑 deploy 没生效

## Step 3: build

```bash
# sidecar
cd packages/openclaw-plugin
npx tsc --noEmit          # 必须先 typecheck, rollup TS plugin 不 fail-fast
npm run build

# userscript
cd packages/runtime-userscript
npm run build             # prebuild 跑 check-no-raw-cp + check-no-direct-cp-fetch
```

prebuild gate 触发时 (e.g. ALLOW_LIST 行号 shift), 更新 `scripts/check-no-direct-cp-fetch.sh` 内 `ALLOW_LIST_INFRA` 行号匹配新 `boot.ts`。

## Step 4: deploy 双路径

### sidecar

```bash
scp -q packages/openclaw-plugin/dist/sidecar/*.js \
  root@europa:/home/ddxs/.openclaw/extensions/ogamex/dist/sidecar/
```

### userscript (双路径必须**两条都跑**)

```bash
# Path A — sidecar /dl/ serve (TM @updateURL 自动 fetch)
scp -q packages/runtime-userscript/dist/ogame-runtime.user.js \
  root@europa:/tmp/ogame-runtime.user.js

# Path B — ogame-next /install.user.js per-user template (operator "Reinstall" 走)
scp -q packages/runtime-userscript/dist/ogame-runtime.user.js \
  ddxs@europa:/home/ddxs/.openclaw/workspace/ogamex/runtime/ogame-runtime.user.js
```

⚠ **漏 Path B = `/install.user.js` 仍 serve 旧版**, owner 点 TM "Reinstall" 拿到旧 banner + 新 body 的怪 build (operator 2026-06-05 实证踩过)。

## Step 5: 重启 sidecar

```bash
ssh root@europa "SP=\$(pgrep -f run_sidecar | head -1); kill -TERM \$SP; sleep 5; pgrep -af run_sidecar | head -1"
```

systemd user unit `ogamex-sidecar.service` 自动拉起。

如果新代码仍没生效 (反复 `kill -TERM` 后行为不变), 升级到 `kill -9` — Node 偶发不释放 dist 缓存。

## Step 6: 验证

### CDN serve 真版本

```bash
curl -s https://ogame.anyfq.com/dl/ogame-runtime.user.js | grep @version
# 期望: // @version      0.0.X
```

### sidecar runtime-version 端点

```bash
ssh ddxs@europa "curl -s http://127.0.0.1:28791/ogamex/v1/runtime-version"
# 期望: {"version":"0.0.X","downloadURL":"https://ogame.anyfq.com/install.user.js"}
```

### subscription / 其他端点 (per-user Bearer 走 PG 的)

需要 user Bearer:

```bash
ssh ddxs@europa "curl -s -H 'Authorization: Bearer <bk_xxx>' \
  http://127.0.0.1:28791/ogamex/v1/subscription-status"
```

cold/无 auth → 返 `{active:true,...}` fallback (legacy operator 不锁)。

### owner panel modal

owner panel 60s 内 poll `/v1/runtime-version` → `latest > current` → 红色 always-on modal 自动弹 "0.0.A → 0.0.B"。

**dismiss 不持久 (v0.0.801 always-on)** — 下次 poll 又弹直到 owner 立即安装。

## 踩坑清单 (按时间倒序)

### 1. `@updateURL` 撞 next-auth 401 (v0.0.792)
- 老 banner: `@updateURL https://ogame.anyfq.com/install.user.js`
- TM 自动 update 是 anonymous fetch, 无 cookie → next-auth 401 → TM 永远拿不到新版
- 修法: `@updateURL https://ogame.anyfq.com/dl/ogame-runtime.user.js` (public no-auth)。`@downloadURL` 可 keep `/install.user.js` (per-user init install 需 auth 是对的)

### 2. 双路径漏 workspace (v0.0.797 → 0.0.799)
- 只 scp `/tmp/`, 漏 `~/.openclaw/workspace/ogamex/runtime/`
- TM "Reinstall" 走 `/install.user.js`, ogame-next 读 workspace path
- 修法: 双路径同 scp, 一步不可省

### 3. HttpServer 构造器 whitelist 漏字段 (v0.0.804.1)
- v0.0.804 加了 `subscriptionProvider` interface + wire, 但 `http_server.ts:254-285` constructor 显式 whitelist 复制 opts 字段, 漏一行 `...(opts.subscriptionProvider !== undefined ? ...)` → `this.opts.subscriptionProvider = undefined` → endpoint 永远 fallback
- 修法: 每加新 opts 字段必须同步 whitelist 行

### 4. multi-tenant stateRef vs currentState 串号 (v0.0.788, 0.0.809, 0.0.810)
- simulate / planner 用 `stateRef.current` (global last-push tenant) → 跨账号串号
- 凡 listGoals scope 内必须用 `currentState` (per-tenant), `stateRef.current` 是 cold-state 兜底, 一般禁用

### 5. version 不 bump 后果
- sidecar 改动也必 bump userscript version, 否则 panel modal 不弹, owner 反复怀疑 deploy 没生效
- 历史: v0.0.794 → 0.0.806 间多次 sidecar fix 后 owner 看不到改变, 一行 bump 就解开

## 当 ALLOW_LIST 行号 shift

userscript prebuild gate `check-no-direct-cp-fetch.sh` 内 `ALLOW_LIST_INFRA` 是按行号 ban grandfathered `fetchWithCp` 调用站点。boot.ts 改动加行 → 老站点行号偏移 → build fail "NEW direct fetchWithCp"。

修法: 改 `scripts/check-no-direct-cp-fetch.sh` 里 `ALLOW_LIST_INFRA` 行号匹配新位置。

```bash
# 验证当前实际行号
grep -n "fetchWithCp" packages/runtime-userscript/src/boot.ts | head -10
```

## 一键 deploy 脚本草案

```bash
#!/usr/bin/env bash
# scripts/deploy-userscript.sh
set -euo pipefail
cd packages/runtime-userscript
npm run build
scp -q dist/ogame-runtime.user.js root@europa:/tmp/ogame-runtime.user.js
scp -q dist/ogame-runtime.user.js ddxs@europa:/home/ddxs/.openclaw/workspace/ogamex/runtime/ogame-runtime.user.js
curl -s https://ogame.anyfq.com/dl/ogame-runtime.user.js | grep @version

cd ../openclaw-plugin
npm run build
scp -q dist/sidecar/*.js root@europa:/home/ddxs/.openclaw/extensions/ogamex/dist/sidecar/
ssh root@europa "SP=\$(pgrep -f run_sidecar | head -1); kill -TERM \$SP; sleep 5; pgrep -af run_sidecar | head -1"
ssh ddxs@europa "curl -s http://127.0.0.1:28791/ogamex/v1/runtime-version"
```

TODO: 这个脚本还没真写进 repo, 第一次实际跑前 review 一遍。
