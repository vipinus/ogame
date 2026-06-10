#!/usr/bin/env bash
#
# OgameX cloud-host deploy driver (uk4 等 "fresh root host" 部署模式).
#
# 一次性把今天 v1.0.17 deploy 踩的 N 个 silent-fail 闭环进自动化:
#   1. .next/static MUST 跟 .next/standalone 同 BUILD_ID, scp + chown www-data
#   2. nginx /_next/static alias → /var/www/ogame-next/static (从 /root 复制)
#   3. .env.production 用 AUTH_SECRET (v5 真名), 不是 NEXTAUTH_SECRET
#   4. run_sidecar.mjs 用 ${REMOTE_HOME} 不硬编 /home/ddxs (memory
#      [[audit-all-db-consumers]] 命中过 5 次)
#   5. systemd HOME= 显式设, 让 sidecar internal fs persist 真态写 /root/.openclaw
#   6. PG seed: users INSERT 满足 FK 后, section_settings 注入 expedition_config
#   7. userscript build + scp /tmp/ogame-runtime.user.js
#   8. smoke test: chunks 200 + bridge-status JSON + runtime-version JSON
#
# Usage:
#   $0 build                                            # local build (sidecar+next+userscript)
#   $0 push   <host> <domain>                           # rsync 全套 → host, 不动 .env / PG / systemd
#   $0 env    <host> <domain> <owner_uid>               # render + 推 .env.production + run_sidecar.mjs
#                                                       # (覆盖已有, owner 自行备份再跑)
#   $0 nginx  <host> <domain>                           # 渲染 + 推 nginx site, reload
#   $0 systemd <host>                                   # 推 systemd unit + restart
#   $0 seed   <host> <owner_uid> <owner_email>          # users INSERT + section_settings 默认
#   $0 paypal-bootstrap <host> <domain>                 # 一键创 PayPal Product/Plans/Webhook
#                                                       # (需 PAYPAL_CLIENT_ID + _SECRET env)
#   $0 smoke  <host> <domain>                           # verify 真 200
#   $0 all    <host> <domain> <owner_uid> <owner_email> # build + push + env (first time) + nginx
#                                                       # + systemd + seed + smoke
#
# Args:
#   <host>       — ssh target, e.g. root@uk4.fanq.in:2222 (port 可选, 默认 22)
#   <domain>     — https domain, e.g. fs.7x24hrs.com
#   <owner_uid>  — ogame-next users.id (UUID), e.g. 4baba0e2-17ab-4275-a8eb-d642ba8d969f
#   <owner_email>— ogame-next users.email, e.g. daigang0701@gmail.com
#
# Env knobs (override defaults at call site):
#   AUTH_SECRET       — Auth.js secret (default: fanq-fs-secret-change-me, 强烈建议改强随机)
#   BRIDGE_TOKEN      — sidecar global bearer (default: smoke-test-token, 强烈建议改)
#   PG_DSN            — postgres URL (default: postgres://ogamex:ogamex@127.0.0.1:5432/ogamex)
#   DISCORD_CHANNEL_ID— optional, "channel:<id>"
#   GEMINI_API_KEY    — passed through to sidecar service env

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATES="$REPO_ROOT/scripts/deploy/templates"
NEXT_REPO="${NEXT_REPO:-$(cd "$REPO_ROOT/../ogame-next" 2>/dev/null && pwd)}"

# defaults — owner can override at call site
: "${AUTH_SECRET:=fanq-fs-secret-change-me}"
: "${BRIDGE_TOKEN:=smoke-test-token}"
: "${PG_DSN:=postgres://ogamex:ogamex@127.0.0.1:5432/ogamex}"
: "${DISCORD_CHANNEL_ID:=}"
: "${GEMINI_API_KEY:=}"
: "${REMOTE_HOME:=/root}"
: "${REMOTE_REPO_DIR:=/root/ogamex}"
# Stripe 订阅 (v1.0.18) — owner 在 Stripe Dashboard 拿真值后 export, 否则留
# 空 deploy 仍跑通, Checkout 调用时再 fail-fast.
: "${STRIPE_SECRET_KEY:=}"
: "${STRIPE_WEBHOOK_SECRET:=}"
: "${STRIPE_PRICE_ID_MONTHLY:=}"
: "${STRIPE_PRICE_ID_YEARLY:=}"
: "${STRIPE_BILLING_PORTAL_CONFIGURATION_ID:=}"
# PayPal Subscriptions (v1.0.18). owner Developer Dashboard 拿:
# 1. Apps & Credentials → Live → Create App → Client ID + Secret
# PAYPAL_PRODUCT_ID / PLAN_{MONTHLY,YEARLY}_ID / WEBHOOK_ID 由 cmd_paypal_bootstrap
# 用 API 自动创 + 写 .env.production. owner 0 Dashboard 操作.
: "${PAYPAL_CLIENT_ID:=}"
: "${PAYPAL_CLIENT_SECRET:=}"
: "${PAYPAL_ENV:=live}"

log()  { printf '\033[1;36m[deploy]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[die]\033[0m %s\n' "$*" >&2; exit 1; }

# Parse "user@host[:port]" → SSH_USER_HOST + SSH_PORT + SCP_PORT
parse_host() {
  local raw="$1"
  if [[ "$raw" == *:* ]]; then
    SSH_USER_HOST="${raw%:*}"
    SSH_PORT="${raw##*:}"
  else
    SSH_USER_HOST="$raw"
    SSH_PORT=22
  fi
  SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -p "$SSH_PORT")
  SCP_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -P "$SSH_PORT")
  RSYNC_SSH="ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new"
}

# Render template (envsubst) → stdout
render() {
  local tmpl="$1"
  AUTH_SECRET="$AUTH_SECRET" \
  BRIDGE_TOKEN="$BRIDGE_TOKEN" \
  PG_DSN="$PG_DSN" \
  DOMAIN="$DOMAIN" \
  OPERATOR_USER_ID="${OPERATOR_USER_ID:-}" \
  DISCORD_CHANNEL_ID="$DISCORD_CHANNEL_ID" \
  REMOTE_HOME="$REMOTE_HOME" \
  REMOTE_REPO_DIR="$REMOTE_REPO_DIR" \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
  STRIPE_PRICE_ID_MONTHLY="$STRIPE_PRICE_ID_MONTHLY" \
  STRIPE_PRICE_ID_YEARLY="$STRIPE_PRICE_ID_YEARLY" \
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID="$STRIPE_BILLING_PORTAL_CONFIGURATION_ID" \
    envsubst < "$TEMPLATES/$tmpl"
}

# ────────────────────────────────────────────────────────────── stage: build

cmd_build() {
  log "building sidecar (pnpm --filter @ogamex/openclaw-plugin build)"
  (cd "$REPO_ROOT" && pnpm --filter @ogamex/openclaw-plugin -s build)
  log "sidecar dist OK: $(ls "$REPO_ROOT/packages/openclaw-plugin/dist/sidecar/" | wc -l) files"

  log "building shared types (pnpm --filter @ogamex/shared build)"
  (cd "$REPO_ROOT" && pnpm --filter @ogamex/shared -s build)

  log "typechecking userscript src (memory [[typecheck-before-build]])"
  (cd "$REPO_ROOT/packages/runtime-userscript" && pnpm -s tsc --noEmit | grep -E 'error TS' | grep -vE 'goal_runner|wire_runtime|goals_panel' || true)
  log "building userscript bundle"
  (cd "$REPO_ROOT/packages/runtime-userscript" && pnpm -s build)
  local ver
  ver=$(grep -oE '@version\s+\S+' "$REPO_ROOT/packages/runtime-userscript/dist/ogame-runtime.user.js" | head -1)
  log "userscript $ver"

  if [[ -n "$NEXT_REPO" && -d "$NEXT_REPO" ]]; then
    log "building Next.js standalone ($NEXT_REPO)"
    (cd "$NEXT_REPO" && pnpm -s build)
    local bid
    bid=$(cat "$NEXT_REPO/.next/BUILD_ID")
    log "next BUILD_ID=$bid (standalone + static will be rsynced from THIS same build)"
  else
    warn "NEXT_REPO not found ($NEXT_REPO); skipping next.js build. Set NEXT_REPO=/path/to/ogame-next."
  fi
}

# ────────────────────────────────────────────────────────── stage: push (rsync)

cmd_push() {
  parse_host "$1"
  DOMAIN="$2"

  log "push sidecar source + dist → $SSH_USER_HOST:$REMOTE_REPO_DIR"
  ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "mkdir -p '$REMOTE_REPO_DIR/packages/openclaw-plugin' '$REMOTE_REPO_DIR/packages/shared' '$REMOTE_HOME/.openclaw/workspace/ogamex'/{strategy,memory,runtime}"
  rsync -aq --delete \
    -e "$RSYNC_SSH" \
    --include='dist/***' --include='package.json' --exclude='*' \
    "$REPO_ROOT/packages/openclaw-plugin/" "$SSH_USER_HOST:$REMOTE_REPO_DIR/packages/openclaw-plugin/"
  rsync -aq --delete \
    -e "$RSYNC_SSH" \
    --include='dist/***' --include='package.json' --exclude='*' \
    "$REPO_ROOT/packages/shared/" "$SSH_USER_HOST:$REMOTE_REPO_DIR/packages/shared/"

  log "push userscript bundle → /tmp/ogame-runtime.user.js"
  scp -q "${SCP_OPTS[@]}" "$REPO_ROOT/packages/runtime-userscript/dist/ogame-runtime.user.js" "$SSH_USER_HOST:/tmp/ogame-runtime.user.js"

  if [[ -n "$NEXT_REPO" && -d "$NEXT_REPO/.next/standalone" ]]; then
    log "push Next.js standalone → $REMOTE_HOME/ogame-next/"
    ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "mkdir -p '$REMOTE_HOME/ogame-next/.next/standalone' /var/www/ogame-next"
    rsync -aq --delete \
      -e "$RSYNC_SSH" \
      "$NEXT_REPO/.next/standalone/" "$SSH_USER_HOST:$REMOTE_HOME/ogame-next/.next/standalone/"

    log "push .next/static → /var/www/ogame-next/static (chown www-data) — 真同步 BUILD_ID"
    rsync -aq --delete \
      -e "$RSYNC_SSH" \
      "$NEXT_REPO/.next/static/" "$SSH_USER_HOST:/var/www/ogame-next/static/"

    if [[ -d "$NEXT_REPO/public" ]]; then
      log "push public/ → /var/www/ogame-next/public"
      rsync -aq --delete \
        -e "$RSYNC_SSH" \
        "$NEXT_REPO/public/" "$SSH_USER_HOST:/var/www/ogame-next/public/"
    fi

    ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "chown -R www-data:www-data /var/www/ogame-next"
    log "/var/www/ogame-next 真态 www-data 拥, nginx 真可读"
  else
    warn "skipping next.js push (no $NEXT_REPO/.next/standalone)"
  fi

  # NOTE: .env.production + run_sidecar.mjs 由 cmd_env 单独推 — 默认 push 不
  # 动它们, 防覆盖 owner 已配 secret / Stripe key. 首次 deploy 或更新 ENV 时
  # 显式 `./deploy.sh env <host> <domain> <uid>`.
}

# ──────────────────────────────────────────────────────── stage: env (render)

cmd_env() {
  parse_host "$1"
  DOMAIN="$2"
  OPERATOR_USER_ID="$3"
  log "render + push .env.production → $REMOTE_HOME/ogame-next/"
  log "  (覆盖已有! 改 secret 会让 owner cookie 解不开, 改前 backup)"
  ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "
    mkdir -p '$REMOTE_HOME/ogame-next'
    [[ -f '$REMOTE_HOME/ogame-next/.env.production' ]] && cp -a '$REMOTE_HOME/ogame-next/.env.production' '$REMOTE_HOME/ogame-next/.env.production.bak.\$(date +%s)' || true
  "
  render env.production | ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "cat > '$REMOTE_HOME/ogame-next/.env.production'"
  log "render + push run_sidecar.mjs"
  render run_sidecar.mjs | ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "cat > '$REMOTE_HOME/run_sidecar.mjs'"
}

# ──────────────────────────────────────────────────────────── stage: nginx

cmd_nginx() {
  parse_host "$1"
  DOMAIN="$2"
  log "render + push nginx site → /etc/nginx/sites-enabled/$DOMAIN"
  render nginx-site.conf | ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" \
    "mkdir -p /etc/nginx/sites-enabled /etc/nginx/sites-available
     cat > '/etc/nginx/sites-available/$DOMAIN'
     ln -sf '/etc/nginx/sites-available/$DOMAIN' '/etc/nginx/sites-enabled/$DOMAIN'
     # remove apt default if present (would shadow our default_server)
     rm -f /etc/nginx/sites-enabled/default
     # ensure conf.d includes sites-enabled
     grep -q sites-enabled /etc/nginx/nginx.conf || sed -i 's|http {|http {\n    include /etc/nginx/sites-enabled/*;|' /etc/nginx/nginx.conf
     nginx -t && systemctl reload nginx
     systemctl is-active nginx"
}

# ──────────────────────────────────────────────────────── stage: systemd

cmd_systemd() {
  parse_host "$1"
  log "render + push systemd units, daemon-reload, restart"
  render ogamex-sidecar.service | ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "cat > /etc/systemd/system/ogamex-sidecar.service"
  render ogame-next.service     | ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "cat > /etc/systemd/system/ogame-next.service"
  ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "
    systemctl daemon-reload
    systemctl enable ogamex-sidecar.service ogame-next.service
    systemctl restart ogamex-sidecar.service
    sleep 3
    systemctl restart ogame-next.service
    sleep 3
    echo '--- sidecar ---'; systemctl is-active ogamex-sidecar.service
    echo '--- next  ---'; systemctl is-active ogame-next.service
  "
}

# ──────────────────────────────────────────── stage: paypal subscriptions bootstrap

cmd_paypal_bootstrap() {
  parse_host "$1"
  DOMAIN="$2"
  [[ -n "$PAYPAL_CLIENT_ID" && -n "$PAYPAL_CLIENT_SECRET" ]] \
    || die "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET env first"
  local base="https://api-m.paypal.com"
  [[ "$PAYPAL_ENV" == "sandbox" ]] && base="https://api-m.sandbox.paypal.com"
  log "PayPal env: $PAYPAL_ENV  base: $base"

  # 1) Get access token
  local token
  token=$(curl -sS -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
    -d grant_type=client_credentials "$base/v1/oauth2/token" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))')
  [[ -n "$token" ]] || die "PayPal access_token failed (check CLIENT_ID/_SECRET, PAYPAL_ENV=$PAYPAL_ENV)"
  log "PayPal token ✓ (len=${#token})"

  # 2) Create Product (idempotent: if env has PAYPAL_PRODUCT_ID, reuse)
  local product_id="${PAYPAL_PRODUCT_ID:-}"
  if [[ -z "$product_id" ]]; then
    product_id=$(curl -sS -X POST "$base/v1/catalogs/products" \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
      -d '{"name":"OgameX","description":"ogame full-stack automation subscription","type":"SERVICE","category":"SOFTWARE"}' \
      | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id",""))')
    [[ -n "$product_id" ]] || die "PayPal createProduct failed"
  fi
  log "PayPal product_id: $product_id"

  # 3) Create Billing Plans (monthly $20 + yearly $200)
  local plan_monthly plan_yearly
  plan_monthly=$(curl -sS -X POST "$base/v1/billing/plans" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d "{\"product_id\":\"$product_id\",\"name\":\"OgameX Monthly\",\"description\":\"OgameX Monthly\",\"status\":\"ACTIVE\",\"billing_cycles\":[{\"frequency\":{\"interval_unit\":\"MONTH\",\"interval_count\":1},\"tenure_type\":\"REGULAR\",\"sequence\":1,\"total_cycles\":0,\"pricing_scheme\":{\"fixed_price\":{\"value\":\"20.00\",\"currency_code\":\"USD\"}}}],\"payment_preferences\":{\"auto_bill_outstanding\":true,\"setup_fee_failure_action\":\"CONTINUE\",\"payment_failure_threshold\":3}}" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id",""))')
  [[ -n "$plan_monthly" ]] || die "PayPal createBillingPlan(monthly) failed"
  log "PayPal monthly plan_id: $plan_monthly"

  plan_yearly=$(curl -sS -X POST "$base/v1/billing/plans" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d "{\"product_id\":\"$product_id\",\"name\":\"OgameX Yearly\",\"description\":\"OgameX Yearly\",\"status\":\"ACTIVE\",\"billing_cycles\":[{\"frequency\":{\"interval_unit\":\"YEAR\",\"interval_count\":1},\"tenure_type\":\"REGULAR\",\"sequence\":1,\"total_cycles\":0,\"pricing_scheme\":{\"fixed_price\":{\"value\":\"200.00\",\"currency_code\":\"USD\"}}}],\"payment_preferences\":{\"auto_bill_outstanding\":true,\"setup_fee_failure_action\":\"CONTINUE\",\"payment_failure_threshold\":3}}" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id",""))')
  [[ -n "$plan_yearly" ]] || die "PayPal createBillingPlan(yearly) failed"
  log "PayPal yearly plan_id: $plan_yearly"

  # 4) Create Webhook
  local webhook_id
  webhook_id=$(curl -sS -X POST "$base/v1/notifications/webhooks" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"url\":\"https://$DOMAIN/api/webhooks/paypal\",\"event_types\":[{\"name\":\"BILLING.SUBSCRIPTION.ACTIVATED\"},{\"name\":\"BILLING.SUBSCRIPTION.UPDATED\"},{\"name\":\"BILLING.SUBSCRIPTION.CANCELLED\"},{\"name\":\"BILLING.SUBSCRIPTION.SUSPENDED\"},{\"name\":\"BILLING.SUBSCRIPTION.EXPIRED\"},{\"name\":\"PAYMENT.SALE.COMPLETED\"}]}" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id",""))')
  [[ -n "$webhook_id" ]] || die "PayPal createWebhook failed"
  log "PayPal webhook_id: $webhook_id"

  # 5) Push 7 envs to host .env.production (overwrite + restart)
  log "Pushing 7 PAYPAL_* envs → $SSH_USER_HOST:$REMOTE_HOME/ogame-next/.env.production"
  ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "
    cp -a '$REMOTE_HOME/ogame-next/.env.production' '$REMOTE_HOME/ogame-next/.env.production.bak.\$(date +%s)'
    sed -i '/^PAYPAL_/d' '$REMOTE_HOME/ogame-next/.env.production'
    cat >> '$REMOTE_HOME/ogame-next/.env.production' <<EOF
PAYPAL_CLIENT_ID=$PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET=$PAYPAL_CLIENT_SECRET
PAYPAL_ENV=$PAYPAL_ENV
PAYPAL_PUBLIC_CLIENT_ID=$PAYPAL_CLIENT_ID
PAYPAL_PRODUCT_ID=$product_id
PAYPAL_PLAN_MONTHLY_ID=$plan_monthly
PAYPAL_PLAN_YEARLY_ID=$plan_yearly
PAYPAL_WEBHOOK_ID=$webhook_id
EOF
    chmod 600 '$REMOTE_HOME/ogame-next/.env.production'
    systemctl restart ogame-next
    sleep 4
    systemctl is-active ogame-next
  "
  log "✓ PayPal bootstrap complete. owner refresh https://$DOMAIN/pricing → PayPal button 真切 subscription mode"
}

# ──────────────────────────────────────────────────────── stage: pg seed

cmd_seed() {
  parse_host "$1"
  local uid="$2"
  local email="$3"
  log "PG seed: ensure users($uid, $email) row exists (FK satisfier)"
  # idempotent ON CONFLICT — does NOT clobber owner password_hash if already present.
  ssh "${SSH_OPTS[@]}" "$SSH_USER_HOST" "PGPASSWORD=\$(echo '$PG_DSN' | sed -n 's|.*://[^:]*:\\([^@]*\\)@.*|\\1|p') psql -U \$(echo '$PG_DSN' | sed -n 's|.*://\\([^:]*\\):.*|\\1|p') -h 127.0.0.1 -d \$(echo '$PG_DSN' | sed -n 's|.*/||;s|?.*||p') -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users (id, email, name)
VALUES ('$uid', '$email', 'owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_settings (user_id, section_settings, updated_at)
VALUES ('$uid',
        jsonb_build_object(
          'ogamex.global.paused', 'false',
          'ogamex.emergency.paused', 'false',
          'ogamex.expedition.paused', 'false',
          'ogamex.auto_build_mine', 'false',
          'ogamex.auto_build_storage', 'false',
          'OGAMEX_SPY_TRIGGERS_SAVE', 'on'
        ),
        NOW())
ON CONFLICT (user_id) DO NOTHING;
SQL"
}

# ──────────────────────────────────────────────────────────── stage: smoke

cmd_smoke() {
  parse_host "$1"
  DOMAIN="$2"
  local fail=0
  log "smoke test → https://$DOMAIN"

  check_eq() {
    local label="$1" url="$2" want_code="$3" want_grep="${4:-}"
    local code body
    body=$(curl -sS -o /tmp/smoke-body.$$ -w '%{http_code}' --max-time 10 "$url" || echo 000)
    code="$body"
    if [[ "$code" != "$want_code" ]]; then
      warn "✗ $label: HTTP $code (want $want_code) — $url"
      fail=1
      return
    fi
    if [[ -n "$want_grep" ]] && ! grep -qE "$want_grep" /tmp/smoke-body.$$; then
      warn "✗ $label: body missing /$want_grep/ — $(head -c 200 /tmp/smoke-body.$$)"
      fail=1
      return
    fi
    log "✓ $label: HTTP $code"
  }

  check_eq "sidecar /v1/runtime-version" "https://$DOMAIN/ogamex/v1/runtime-version" 200 '"version"'
  check_eq "sidecar /dl/ userscript"      "https://$DOMAIN/dl/ogame-runtime.user.js" 200 '@version'
  check_eq "next /login page"             "https://$DOMAIN/login" 200 '<html'
  check_eq "next /flagship (auth 307→login)" "https://$DOMAIN/flagship" 307 ''

  log "verify _next/static chunks 真同步 BUILD_ID (login HTML 引用的全 200)"
  local refs
  refs=$(curl -sS "https://$DOMAIN/login" 2>/dev/null | grep -oE '_next/static/chunks/[a-zA-Z0-9_-]+\.js' | sort -u | head -8)
  local n_ok=0 n_miss=0
  while IFS= read -r r; do
    [[ -z "$r" ]] && continue
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/$r")
    if [[ "$code" == "200" ]]; then ((n_ok++)); else ((n_miss++)); warn "✗ static 404: /$r"; fi
  done <<< "$refs"
  log "static chunks OK=$n_ok MISS=$n_miss"
  [[ "$n_miss" == 0 ]] || fail=1

  rm -f /tmp/smoke-body.$$
  if [[ "$fail" == 0 ]]; then
    log "🟢 SMOKE OK — owner refresh https://$DOMAIN/flagship 应该 BridgeStatusDot 绿"
  else
    die "🔴 SMOKE FAILED — see warnings above"
  fi
}

# ─────────────────────────────────────────────────────────────── stage: all

cmd_all() {
  local host="$1" domain="$2" uid="$3" email="$4"
  OPERATOR_USER_ID="$uid"
  cmd_build
  cmd_push    "$host" "$domain"
  # ENV — first-time deploy 必须跑; 后续 update code 不动 ENV. 想 force 改:
  #   ./deploy.sh env <host> <domain> <uid>
  cmd_env     "$host" "$domain" "$uid"
  cmd_nginx   "$host" "$domain"
  cmd_systemd "$host"
  cmd_seed    "$host" "$uid" "$email"
  sleep 5
  cmd_smoke   "$host" "$domain"
}

# ──────────────────────────────────────────────────────────────── dispatch

usage() {
  sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

cmd="${1:-}"; shift || true
case "$cmd" in
  build)   cmd_build ;;
  push)    [[ $# -ge 2 ]] || usage; cmd_push    "$@" ;;
  env)     [[ $# -ge 3 ]] || usage; cmd_env     "$@" ;;
  nginx)   [[ $# -ge 2 ]] || usage; cmd_nginx   "$@" ;;
  systemd) [[ $# -ge 1 ]] || usage; cmd_systemd "$@" ;;
  seed)    [[ $# -ge 3 ]] || usage; cmd_seed    "$@" ;;
  paypal-bootstrap) [[ $# -ge 2 ]] || usage; cmd_paypal_bootstrap "$@" ;;
  smoke)   [[ $# -ge 2 ]] || usage; cmd_smoke   "$@" ;;
  all)     [[ $# -ge 4 ]] || usage; cmd_all     "$@" ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command: $cmd" ;;
esac
