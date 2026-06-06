#!/bin/bash
# Architecture enforcement gate — per-uid TenantContext invariant.
#
# Owner directive 2026-06-06 (verbatim):
#   "全部用 per-uid，统一架构 避免以后再来回补丁"
#
# Incidents that shaped this gate:
#   v0.0.857  — expLastSeen / firedDebrisCheckFor module-level Maps keyed by
#               bare fleetId, cross-tenant overwrite of fleet observations.
#               Symptom-fixed via `${uid}::${fid}` key prefix.
#   v0.0.858  — per-uid world_state persist (timer + pending snap globals
#               cross-tenant corrupted each other's PG row).
#   v0.0.860  — Sprint 1: 3 worst offenders migrated into TenantContext.
#   v0.0.861  — Sprint 2: worldState mirror + 4 more directive/goal Maps
#               migrated into TenantContext.
#   v0.0.862  — Sprint 3: last 2 surviving Maps migrated
#               (planner.ts:fieldsFullCache real cross-tenant bug,
#               expedition.ts:failureCoolOff v0.0.857 anti-pattern cleanup).
#
# Forbids NEW module-level `const … = new Map<…>` declarations under
# src/sidecar/ outside tenant_context.ts. Per-uid Maps belong inside the
# TenantContext registry — see docs/architecture/multi-tenant.md §5 for the
# migration recipe (extend TenantContext interface, mint in newContext(),
# rewrite consumers as tenantRegistry.get(uid).<field>).
#
# Tight regex by design: matches only column-0 `const NAME = new Map<` —
# function-local declarations get indented and are correctly ignored.
# tenant_context.ts is excluded because its own internal `Map<uid, ctx>`
# (the registry's backing storage) is legitimate.

set -euo pipefail
cd "$(dirname "$0")/.."

# ALLOW_LIST — intentionally empty after v0.0.862 cleanup.
# If you must add a cross-tenant-safe Map at module scope (e.g. process-wide
# cache that genuinely has no per-uid dimension), document the rationale in
# the commit message and add the file:line here as `path/to/file.ts:LINE`.
# Reviewer will ask: "why not in TenantContext?"
ALLOW_LIST=$(cat <<'EOF'
EOF
)

VIOLATIONS=$(grep -rnE '^const\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*new\s+Map<' src/sidecar/ \
  --include='*.ts' \
  | grep -v '^src/sidecar/tenant_context.ts:' \
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
  echo "❌ NEW module-level Map<...> declaration in src/sidecar/ (not in ALLOW_LIST):"
  echo
  printf '%s' "$NEW_VIOLATIONS"
  echo
  echo "Per-uid Maps belong in TenantContext (src/sidecar/tenant_context.ts)."
  echo "See docs/architecture/multi-tenant.md §5 (migration recipe):"
  echo "  1. Extend the TenantContext interface with the new field."
  echo "  2. Lazy-mint it in newContext()."
  echo "  3. Rewrite consumers as tenantRegistry.get(uid).<field>."
  echo
  echo "Owner directive 2026-06-06: \"全部用 per-uid，统一架构 避免以后再来回补丁\"."
  echo "If you genuinely need a process-wide Map (no per-uid dimension), add the"
  echo "file:line to ALLOW_LIST with rationale in the commit message."
  exit 1
fi

echo "✅ no module-level Map<...> outside tenant_context.ts (per-uid invariant holds)"
