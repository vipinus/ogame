#!/bin/bash
# Architecture enforcement gate (operator 2026-06-01 拍板:
# "directive 的 cp= 用统一入口的保护方法，以后不许用 directive 的 cp=
# 用统一入口的保护方法").
#
# Forbid NEW direct `fetchWithCp(...)` / `fetchWithCpBypassBusy(...)` calls
# in src/ outside fleet_api.ts / safe_fetch.ts. Use cpPostWithRetry(...) or
# sendFleet(...) instead — see docs/architecture/cp-token-protected-access.md.
#
# Companion to scripts/check-no-raw-cp.sh (which blocks raw `&cp=` string
# concat). This one blocks the SECOND escape hatch: bypassing the standard
# wrapper's retry / token-refresh / transient-race handling by calling the
# low-level helper directly.

set -euo pipefail
cd "$(dirname "$0")/.."

# Sites grandfathered as of 2026-06-01. Each is documented in
# docs/architecture/cp-token-protected-access.md §4 audit table and slated
# for migration in a separate sprint. Adding new entries here without
# operator approval = violating the policy.
ALLOW_LIST=$(cat <<'EOF'
src/api_executor.ts:545
src/api_executor.ts:635
src/api_executor.ts:725
src/api_executor.ts:774
src/api_executor.ts:1018
src/api_executor.ts:1201
src/api_executor.ts:1280
src/api_executor.ts:1326
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
  echo "to ALLOW_LIST in scripts/check-no-direct-cp-fetch.sh with rationale."
  exit 1
fi

echo "✅ no NEW direct fetchWithCp[BypassBusy] callers"
echo "    Grandfathered: $(echo "$ALLOW_LIST" | wc -l) sites pending migration"
