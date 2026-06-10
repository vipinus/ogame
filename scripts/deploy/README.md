# OgameX cloud-host deploy (v1.0.17 实证闭环)

`deploy.sh` 把 uk4 部署一天踩的 silent-fail 全部 internal 化。fresh root host 一条命令到位:

```bash
export AUTH_SECRET='<strong-random>'       # default fanq-fs-secret-change-me, 强烈建议改
export BRIDGE_TOKEN='<strong-random>'      # default smoke-test-token, 强烈建议改
export GEMINI_API_KEY='<key>'              # optional
export NEXT_REPO=/path/to/ogame-next       # ogame-next 仓库根, 含 .next/standalone

./scripts/deploy/deploy.sh all \
  root@uk4.fanq.in:2222 \
  fs.7x24hrs.com \
  4baba0e2-17ab-4275-a8eb-d642ba8d969f \
  daigang0701@gmail.com
```

跑完 `🟢 SMOKE OK` = 真闭环, owner 浏览器 hard refresh `https://fs.7x24hrs.com/flagship` 立刻绿。

## 拓扑

```
Cloudflare → host:80 (nginx)
              ├─ /ogamex/*    → 127.0.0.1:28791 (sidecar)
              ├─ /ws          → 127.0.0.1:28791 (WS upgrade)
              ├─ /dl/         → 127.0.0.1:28791/dl/  (userscript bundle)
              ├─ /_next/static/ → /var/www/ogame-next/static/  (nginx serve)
              └─ /            → 127.0.0.1:3002 (Next.js standalone)

PG 5432 (postgres://ogamex:ogamex@127.0.0.1) — sidecar + next 共享
```

## 文件 (本目录)

| 文件 | 用途 |
|---|---|
| `deploy.sh` | 主 driver, sub-commands: `build / push / nginx / systemd / seed / smoke / all` |
| `templates/ogamex-sidecar.service` | systemd unit, HOME 显式设防 fs persist 落错路径 |
| `templates/ogame-next.service` | systemd unit, 加载 .env.production |
| `templates/nginx-site.conf` | nginx server block, 含关键 `/_next/static/` alias |
| `templates/run_sidecar.mjs` | sidecar bootstrap, 用 ${REMOTE_HOME} 不硬编 /home/ddxs |
| `templates/env.production` | Next.js .env, AUTH_SECRET (v5 真名) 而非 NEXTAUTH_SECRET |

## sub-command

```bash
./deploy.sh build                                    # local build (sidecar+next+userscript+typecheck)
./deploy.sh push  <host> <domain>                    # rsync 全套 → host (不动 PG / systemd)
./deploy.sh nginx <host> <domain>                    # 写 nginx site + reload
./deploy.sh systemd <host>                           # 写 systemd unit + restart
./deploy.sh seed  <host> <owner_uid> <owner_email>   # PG users INSERT + section_settings 默认 row (idempotent)
./deploy.sh smoke <host> <domain>                    # verify endpoints + chunks 真 200
./deploy.sh all   <host> <domain> <owner_uid> <owner_email>  # 一把梭 build→push→nginx→systemd→seed→smoke
```

`<host>` 格式: `user@host[:port]` (port 可选, 默认 22)

## 今天踩的坑全部 internal 化

| v1.0.x 真事故 | 闭环点 |
|---|---|
| `NEXTAUTH_SECRET` ≠ Auth.js v5 真期待 `AUTH_SECRET` → JWT silent fail | `templates/env.production` 用 v5 真名, 顺手 alias NEXTAUTH_URL 兼容 |
| AUTH_SECRET = placeholder, owner 已经签了 cookie 改 secret 解不开 | `cmd_seed` 不覆盖, 第一次 deploy 设, 后续 owner rotate 后必 clear sessions |
| `.next/static` 跟 `.next/standalone` 不同 BUILD_ID → chunk hash mismatch | `cmd_push` 从同一 `$NEXT_REPO/.next/` 一致 rsync, **不**在 host 上重 build |
| `.next/static` 在 /root 下, nginx (www-data) 403 | `cmd_push` rsync 到 `/var/www/ogame-next/static` + chown www-data |
| nginx 0 `location /_next/static/` → 全 fallback 到 next 进程 → 404 | `templates/nginx-site.conf` 含 alias + 1y immutable cache |
| sidecar `expedition.ts` 硬编 `/home/ddxs/.openclaw/...` → uk4 root ENOENT | v1.0.17 改 PG (commit fdee10e), `templates/run_sidecar.mjs` 显式 `${REMOTE_HOME}` |
| `EXP_PERSIST_PATH` 用 `process.env.HOME ?? "/tmp"` → 落 /tmp (systemd unit 不带 HOME) | systemd unit `Environment=HOME=${REMOTE_HOME}`, sidecar `os.homedir()` 真 = /root |
| PG seed 漏 `users` INSERT → `user_settings` FK violation | `cmd_seed` 双 INSERT, ON CONFLICT DO NOTHING (idempotent) |
| userscript dist 跟 sidecar 不同步 (TM 装老版本) | `cmd_build` 一次性 sidecar+shared+userscript, version 双源 sync 由 rollup banner + boot.ts 保证 |

## smoke test 真态

`cmd_smoke` 真做的 5 项 + 1 个动态:

1. `GET /ogamex/v1/runtime-version` → 200, body 含 `"version"`
2. `GET /dl/ogame-runtime.user.js` → 200, body 含 `@version`
3. `GET /login` → 200, body 含 `<html`
4. `GET /flagship` → 307 (redirect /login, owner 未登录时)
5. 动态: scrape `/login` HTML 引用的全部 `_next/static/chunks/*.js`, 真 verify 每个 200

任何一项失败 → `🔴 SMOKE FAILED` 退非 0; 全过 → `🟢 SMOKE OK`。

## PG 真态依赖

deploy.sh 假设 host 上已经:
- 装好 PostgreSQL (DSN: `postgres://ogamex:ogamex@127.0.0.1:5432/ogamex`)
- 跑过 drizzle migration 建好 `users`, `user_settings`, `ogame_world_state`, `ogame_goals`, `sessions` 等表
- 装好 nginx + Node 20+

bootstrap host (装这些) 是独立步骤, **不**在本 deploy.sh 范围内 (避免覆盖 owner 已 customize 的系统)。

## 远征 config 真迁移 (PG seed)

v1.0.17 起远征 config 在 PG `user_settings.section_settings.ogamex.expedition_config` (jsonb).
`cmd_seed` 只 INSERT 默认空 settings, **不**写 `expedition_config`. owner 在 panel 配 enabled_planets / template 后:
- panel POST `/v1/expedition/config` → `sectionSettingsWrite` callback → PG UPSERT
- tenantCtx.sectionSettings 即时刷新, daemon next tick 拿到配置

从 europa 老 file 迁移到新 host 时, 用 (一次性):

```bash
ssh ddxs@europa "cat ~/.openclaw/workspace/ogamex/runtime/ogamex-expedition-${UID8}.json | jq -c . | base64 -w 0" \
  | ssh root@<host> "B64=\$(cat); PGPASSWORD=ogamex psql -U ogamex -d ogamex -h 127.0.0.1 -c \"
UPDATE user_settings
SET section_settings = section_settings
    || jsonb_build_object('ogamex.expedition_config', convert_from(decode('\$B64','base64'),'UTF8')::jsonb)
WHERE user_id = '<owner_uid>';\""
```

## 后续 hardening (owner 拍板再做)

- AUTH_SECRET + BRIDGE_TOKEN 默认 placeholder 真弱, 强烈建议改强随机:
  - `AUTH_SECRET=$(openssl rand -base64 32)`
  - `BRIDGE_TOKEN="bk_operator_$(openssl rand -hex 16)"`
  - 改完后 owner 浏览器必须 clear cookie + 重登
- cloudflared/tunnel 配置不在本脚本 (owner 自己用 cf dashboard 设 DNS + tunnel)
- PG strong password + listen_addresses 限本机 / WireGuard
- nginx TLS 终止 (当前是 80 cleartext, 由 CF tunnel 加 TLS; 本机直连不安全)
