#!/bin/bash
# OgameX Chrome session keeper
# Usage:
#   ogamex-chrome.sh           — start + monitor (foreground, suitable for systemd Type=simple)
#   ogamex-chrome.sh stop      — request graceful stop
#   ogamex-chrome.sh status    — show current state + exit
#
# Env vars (optional):
#   OPENCLAW_PROFILE   — browser profile name. Default "openclaw".
#   OGAMEX_LOG_FILE    — log path. Default ~/.cache/ogamex/chrome-monitor.log.

set -euo pipefail

PROFILE="${OPENCLAW_PROFILE:-openclaw}"
LOG_FILE="${OGAMEX_LOG_FILE:-$HOME/.cache/ogamex/chrome-monitor.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"; }

cmd_status() {
  if openclaw browser --browser-profile "$PROFILE" status 2>/dev/null | grep -q 'running: true'; then
    echo "running"
    exit 0
  else
    echo "stopped"
    exit 1
  fi
}

cmd_stop() {
  log "stop requested"
  openclaw browser --browser-profile "$PROFILE" stop 2>&1 | tee -a "$LOG_FILE" || true
}

cmd_run() {
  log "starting OgameX Chrome session keeper (profile=$PROFILE)"

  trap 'log "received SIGTERM, stopping"; cmd_stop; exit 0' TERM INT

  # First start
  if ! cmd_status >/dev/null 2>&1; then
    log "starting browser"
    openclaw browser --browser-profile "$PROFILE" start 2>&1 | tee -a "$LOG_FILE" || {
      log "openclaw browser start exited non-zero"
      exit 1
    }
  else
    log "browser already running"
  fi

  # Health check loop
  while true; do
    sleep 30
    if ! cmd_status >/dev/null 2>&1; then
      log "browser is not running — restarting"
      openclaw browser --browser-profile "$PROFILE" start 2>&1 | tee -a "$LOG_FILE" || {
        log "restart failed"
        exit 1
      }
    fi
  done
}

case "${1:-run}" in
  run)    cmd_run ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)      echo "Usage: $0 [run|stop|status]"; exit 2 ;;
esac
