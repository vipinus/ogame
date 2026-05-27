#!/bin/bash
# Architecture enforcement gate (operator 2026-05-27: "架构层缺乏 enforcement").
#
# Status (post v0.0.352 full migration sprint):
# - All active cp= fetch sites go through src/api/safe_fetch.ts
# - 2 remaining sites are DEAD code in src/directive_executor.ts (legacy
#   UiDirectiveExecutor, unwired per wire_runtime.ts:209). Kept in ALLOW_LIST
#   pending separate cleanup commit (delete entire file).
#
# Any new `&cp=` / `?cp=` literal in fetch URLs → fail build, force the author
# to use fetchWithCp / fetchWithCpBypassBusy / restoreSessionCp.

set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW_LIST=$(cat <<'EOF'
src/directive_executor.ts:125
src/directive_executor.ts:562
EOF
)

VIOLATIONS=$(grep -rnE '&cp=|\?cp=' src/ \
  --include='*.ts' \
  --exclude-dir='__tests__' \
  | grep -v 'src/api/safe_fetch.ts' \
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
  echo "❌ NEW raw cp= fetch (not in ALLOW_LIST):"
  echo
  printf '%s' "$NEW_VIOLATIONS"
  echo
  echo "Use fetchWithCp() / fetchWithCpBypassBusy() / restoreSessionCp()"
  echo "from src/api/safe_fetch.ts"
  echo "OR add the line to ALLOW_LIST in scripts/check-no-raw-cp.sh with rationale."
  exit 1
fi

echo "✅ no NEW raw &cp= (grandfathered sites in ALLOW_LIST unchanged)"
echo "    Total grandfathered: $(echo "$ALLOW_LIST" | wc -l) sites (legacy dead code)"
