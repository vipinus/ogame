# OgameX Chrome Session Monitor (M7.6)

A systemd **user** service + helper script that keeps the OpenClaw-managed
Chrome session running so the OgameX userscript stays loaded. If Chrome
crashes, systemd + the helper auto-restart it within ~30 seconds.

## What this is

- `ogamex-chrome.sh` — POSIX-bash helper that calls `openclaw browser start`,
  then health-checks every 30s and restarts on crash.
- `ogamex-chrome.service` — systemd user unit (runs in your graphical
  session, so it has access to X/Wayland and your OpenClaw profile dir).
- `install.sh` — copies files into `~/.config/ogamex/` and
  `~/.config/systemd/user/`, then enables the unit.

## Prerequisites

- OpenClaw is installed and `openclaw` is on `PATH`.
- A browser profile is configured (default name: `openclaw`; override with
  `OPENCLAW_PROFILE`).
- A user-level systemd is available (`systemctl --user`).
- A graphical session is running (X11 or Wayland).

## Install

```bash
bash scripts/ogamex/install.sh
```

This will:

1. Create `~/.config/ogamex/` and `~/.config/systemd/user/`.
2. Copy `ogamex-chrome.sh` (mode 0755) and `ogamex-chrome.service` (mode 0644).
3. Run `systemctl --user daemon-reload` and enable the unit.

## Operate

```bash
# Start
systemctl --user start ogamex-chrome

# Status
systemctl --user status ogamex-chrome

# Live logs (from journald)
journalctl --user -u ogamex-chrome -f

# Stop
systemctl --user stop ogamex-chrome

# Disable + stop
systemctl --user disable --now ogamex-chrome
```

The helper also writes its own log to
`~/.cache/ogamex/chrome-monitor.log` (override via `OGAMEX_LOG_FILE`).

## Configuration

Environment variables (set in the unit's `[Service]` section via
`Environment=` if you want them at the systemd level):

| Variable           | Default                                  | Meaning                |
| ------------------ | ---------------------------------------- | ---------------------- |
| `OPENCLAW_PROFILE` | `openclaw`                               | Browser profile name.  |
| `OGAMEX_LOG_FILE`  | `~/.cache/ogamex/chrome-monitor.log`     | Helper log file path.  |

## Restart policy

- `Restart=on-failure` — systemd restarts the unit if the helper exits non-zero.
- `RestartSec=10s` — wait 10s between systemd-level restarts.
- `StartLimitBurst=3` / `StartLimitIntervalSec=300` — at most 3 restarts
  within 5 minutes, then systemd gives up (prevents restart storms).

In addition, the helper itself runs an internal 30s health-check loop and
calls `openclaw browser start` again if the browser is not running. This
gives two layers of resilience.

## Manual smoke test

```bash
bash scripts/ogamex/ogamex-chrome.test.sh
```

The smoke test verifies the script's argument dispatcher works without
actually invoking `openclaw`.

## Troubleshooting

- **"Failed to connect to bus"** when running `systemctl --user`: make sure
  you have a user systemd session. On a headless box you may need
  `loginctl enable-linger $USER`.
- **Unit never starts**: check `journalctl --user -u ogamex-chrome` — most
  likely `openclaw` is not on `PATH` for the user session.
- **Chrome flashes then dies**: run `openclaw browser --browser-profile
  openclaw start` interactively in a terminal to see the underlying error.
