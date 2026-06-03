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
src/boot.ts:964
src/boot.ts:976
src/boot.ts:994
src/boot.ts:1138
src/boot.ts:1714
src/boot.ts:1973
src/boot.ts:2133
src/boot.ts:2952
src/boot.ts:3159
EOF
)

# --- Bucket 2: DIRECTIVE-DISPATCH (migration COMPLETE v0.0.560) ----------
# Phase 1 DONE (v0.0.557): extended cpPostWithRetry with tokenProvider /
#   successCheck / refreshTokenOnInvalid hooks.
# Phase 2 DONE (v0.0.558): jumpgate overlay GET + executeJump POST migrated.
# Phase 3 DONE (v0.0.559): discover/galaxy chain migrated.
# Phase 4 DONE (v0.0.560): expedition 3-stage legacy method was dead code
#   (delegate-to-sendFleet since v0.0.439); deleted ~167 unreachable lines
#   that held the last 2 direct bypasses. ALLOW_LIST_DIRECTIVE now empty.
ALLOW_LIST_DIRECTIVE=$(cat <<'EOF'
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

# Count non-empty lines (empty heredoc produces empty string which `wc -l`
# of `echo` would count as 1; use printf + grep -c '.' to skip empties).
INFRA_COUNT=$(printf '%s\n' "$ALLOW_LIST_INFRA" | grep -c '.' || true)
DIRECTIVE_COUNT=$(printf '%s\n' "$ALLOW_LIST_DIRECTIVE" | grep -c '.' || true)
echo "✅ no NEW direct fetchWithCp[BypassBusy] callers"
echo "    Infrastructure (permanent): $INFRA_COUNT sites"
echo "    Directive-dispatch (TODO):  $DIRECTIVE_COUNT sites pending migration"
