#!/bin/bash
# Smoke test for ogamex-chrome.sh — runs without actually invoking openclaw.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/ogamex-chrome.sh"

# Test: --help / unknown arg returns usage
if [ -f "$SCRIPT" ]; then
  out="$("$SCRIPT" unknown-arg 2>&1 || true)"
  if echo "$out" | grep -q "Usage:"; then
    echo "✓ usage banner on unknown arg"
  else
    echo "✗ usage banner missing"
    exit 1
  fi
else
  echo "✗ script missing"
  exit 1
fi

echo "All smoke tests passed."
