#!/bin/bash
# Architecture enforcement gate (operator 2026-06-01 拍板:
# "directive 的 cp= 用统一入口的保护方法，以后不许用 directive 的 cp=
# 直接 fetch；统一入口在 fleet_api.ts cpPostWithRetry / sendFleet").
#
# Forbid NEW direct `fetchWithCp(...)` / `fetchWithCpBypassBusy(...)` calls
# in src/ outside fleet_api.ts / safe_fetch.ts. Use cpPostWithRetry(...) or
# sendFleet(...) instead — see docs/architecture/cp-token-protected-access.md.
#
# Companion to scripts/check-no-raw-cp.sh (which blocks raw `&cp=` string
# concat). This one blocks the SECOND escape hatch: bypassing the standard
# wrapper's retry / token-refresh / transient-race handling by calling the
# low-level helper directly.
#
# ALLOW_LIST is split into 2 buckets (operator A 2026-06-01 拍板"all → 0"):
#   INFRASTRUCTURE (8) — boot-time / userscript-internal data fetches that
#     don't dispatch directives. They go through safe_fetch.ts (mutex +
#     restore + click-lock) but skip cpPostWithRetry's retry+token semantics
#     because they're (a) one-shot, (b) cp=operator's planet (no shift), or
#     (c) read-only data harvesting (no token rotation needed).
#     STATUS: documented permanent allow under separate review.
#   DIRECTIVE-DISPATCH (8) — api_executor.ts multi-stage flows (expedition
#     legacy / colonize / jumpgate / discover-galaxy). These MUST migrate
#     to cpPostWithRetry; complexity is custom-token chaining (overlay
#     token, galaxy token cache) that cpPostWithRetry may need extending
#     (custom token provider hook) to handle.
#     STATUS: pending migration, separate sprint per phase below.

set -euo pipefail
cd "$(dirname "$0")/.."

# --- Bucket 1: INFRASTRUCTURE (permanent allow, doc'd in §4 table) -----
ALLOW_LIST_INFRA=$(cat <<'EOF'
src/boot.ts:854
src/boot.ts:866
src/boot.ts:884
src/boot.ts:1028
src/boot.ts:1597
src/boot.ts:1856
src/boot.ts:2003
src/boot.ts:2697
EOF
)

# --- Bucket 2: DIRECTIVE-DISPATCH (TODO migrate to cpPostWithRetry) -----
# Phase 1 candidate: api_executor.ts:1018 (discover/galaxy single POST)
# Phase 2 candidate: api_executor.ts:725/774 (jumpgate overlay+POST)
# Phase 3 candidate: api_executor.ts:545/635 (expedition 3-stage chain)
# Phase 4 candidate: api_executor.ts:1201/1280/1326 (discover POST + retries)
ALLOW_LIST_DIRECTIVE=$(cat <<'EOF'
src/api_executor.ts:545
src/api_executor.ts:635
src/api_executor.ts:725
src/api_executor.ts:774
src/api_executor.ts:1018
src/api_executor.ts:1201
src/api_executor.ts:1280
src/api_executor.ts:1326
EOF
)

ALLOW_LIST=$(printf '%s\n%s\n' "$ALLOW_LIST_INFRA" "$ALLOW_LIST_DIRECTIVE")

VIOLATIONS=$(grep -rnE 'fetchWithCp(BypassBusy)?\(' src/ \
  --include='*.ts' \
  --exclude-dir='__tests__' \
  | grep -v 'src/api/safe_fetch.ts' \
  | grep -v 'src/api/fleet_api.ts' \
  | grep -v '// \|^\s*\*' \
  | awk -F: '{print $1":"$2"\t"$0}' \
  || true)

NEW_VIOLATIONS=""
while IFS=$'\t' read -r LOC REST; do
  [ -z "$LOC" ] && continue
  if ! echo "$ALLOW_LIST" | grep -qFx "$LOC"; then
    NEW_VIOLATIONS+="$REST"$'\n'
  fi
done <<< "$VIOLATIONS"

if [ -n "$NEW_VIOLATIONS" ]; then
  echo "❌ NEW direct fetchWithCp[BypassBusy](...) call (not in ALLOW_LIST):"
  echo
  printf '%s' "$NEW_VIOLATIONS"
  echo
  echo "Use cpPostWithRetry(...) or sendFleet(...) from src/api/fleet_api.ts."
  echo "See docs/architecture/cp-token-protected-access.md for the unified entry."
  echo
  echo "If you have operator approval for an exception, add the file:line"
  echo "to ALLOW_LIST_INFRA (boot-time non-directive) or ALLOW_LIST_DIRECTIVE"
  echo "(directive flow pending migration) with rationale in commit message."
  exit 1
fi

INFRA_COUNT=$(echo "$ALLOW_LIST_INFRA" | wc -l)
DIRECTIVE_COUNT=$(echo "$ALLOW_LIST_DIRECTIVE" | wc -l)
echo "✅ no NEW direct fetchWithCp[BypassBusy] callers"
echo "    Infrastructure (permanent): $INFRA_COUNT sites"
echo "    Directive-dispatch (TODO):  $DIRECTIVE_COUNT sites pending migration"
