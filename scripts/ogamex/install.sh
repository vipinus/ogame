#!/bin/bash
# Install OgameX Chrome session keeper into user systemd.
set -euo pipefail

mkdir -p "$HOME/.config/ogamex"
mkdir -p "$HOME/.config/systemd/user"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_SRC="$REPO_ROOT/ogamex/ogamex-chrome.sh"
UNIT_SRC="$REPO_ROOT/ogamex/ogamex-chrome.service"

install -m 0755 "$SCRIPT_SRC" "$HOME/.config/ogamex/ogamex-chrome.sh"
install -m 0644 "$UNIT_SRC" "$HOME/.config/systemd/user/ogamex-chrome.service"

systemctl --user daemon-reload
systemctl --user enable ogamex-chrome.service

echo "Installed. Start with: systemctl --user start ogamex-chrome"
echo "Logs:                  journalctl --user -u ogamex-chrome -f"
