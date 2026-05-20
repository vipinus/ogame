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

---

# OgameX OpenClaw Plugin — Deploy Gotchas

Verified empirically against OpenClaw `2026.5.18` on `2026-05-19`. Each
item below is an actual issue we hit during the first real-server smoke;
list them all up front so future deploys don't re-discover them.

## Pre-deploy config (one-time, on the OpenClaw host)

### 1. Gemini API key — read from the **right** place

`openclaw models status` prints **redacted previews** (e.g.
`AIzaSyC6...XwD06I1c`). **Do not** copy those literal strings — the `...`
is real, not a continuation. The actual key lives in:

```bash
jq -r '.env.GEMINI_API_KEY' ~/.openclaw/openclaw.json
```

Pass it through to the sidecar via the `GEMINI_API_KEY` environment
variable (or `SidecarConfig.geminiApiKey`). The plugin's health endpoint
will report `llm.error: "HTTP 400: ... API key not valid"` if a redacted
preview slipped through.

### 2. Discord TTS auto-mode — opt out for the reporter

If `messages.tts.auto = "always"` (the OpenClaw default for some setups),
every Discord send is converted to a TTS voice message. Discord then
rejects the request with:

```
Error: Voice messages cannot include text content (Discord limitation).
```

Per-message `--delivery` JSON does **not** override this in current
OpenClaw — the auto-mode is read at channel level. Fix with:

```bash
openclaw config set messages.tts.auto tagged   # TTS only when caller tags
# OR
openclaw config set messages.tts.auto off      # disables TTS entirely
```

Recommended: `tagged` — preserves opt-in TTS for normal user replies while
letting the OgameX reporter send plain text.

### 3. OpenClaw config keys that matter

| Key                          | Source                            | Used for                  |
| ---------------------------- | --------------------------------- | ------------------------- |
| `env.GEMINI_API_KEY`         | `~/.openclaw/openclaw.json`       | LLM ping + strategy LLM   |
| `messages.tts.auto`          | `~/.openclaw/openclaw.json`       | Discord reporter TTS opt  |
| `channels.discord.enabled`   | `~/.openclaw/openclaw.json`       | reporter delivery target  |

Set / inspect via:

```bash
openclaw config get <key>
openclaw config set <key> <value>
```

## Plugin install — known sharp edges

### 4. `package.json` must declare `openclaw.extensions`

OpenClaw plugin installer requires this field. The OgameX plugin package
already declares:

```json
"openclaw": { "extensions": ["./dist/index.js"] }
```

Without it the installer fails with
`package.json missing openclaw.extensions`.

### 5. `child_process` triggers the unsafe-install gate

The current sidecar calls `child_process.spawn` for (a) `git` (in
`strategy_manager.ts`) and (b) `openclaw message send` (in
`defaultDiscordSend`). OpenClaw's installer scans for dangerous code
patterns and **blocks the install**. Until those calls are replaced with
SDK equivalents you must install with:

```bash
openclaw plugins install --force --dangerously-force-unsafe-install <path>
```

### 6. `workspace:*` dependency on `@ogamex/shared` does not survive

`npm install` from the installed plugin directory fails with
`EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`, and even if you
strip the workspace dep first, npm will then wipe any manually-injected
`node_modules/@ogamex/shared/`. Sequence that works:

```bash
# 1. Remove the workspace: dep from the installed package.json
sed -i '/"@ogamex\/shared":/d' ~/.openclaw/extensions/ogamex/package.json

# 2. Install third-party deps (no peer deps to avoid the openclaw symlink trip-up)
cd ~/.openclaw/extensions/ogamex
npm install --omit=dev --omit=peer

# 3. Inject @ogamex/shared from the local build AFTER npm install
mkdir -p node_modules/@ogamex/shared
tar xzf /tmp/ogamex-shared.tgz -C node_modules/@ogamex/shared   # contains shared/dist
cat > node_modules/@ogamex/shared/package.json <<'JSON'
{"name":"@ogamex/shared","version":"0.0.0","type":"module",
 "main":"./dist/index.js","types":"./dist/index.d.ts",
 "exports":{".":{"import":"./dist/index.js","types":"./dist/index.d.ts"}}}
JSON
```

Long-term fix: bundle `@ogamex/shared` into the plugin's `dist/` via a
rollup pass instead of leaving it as a workspace dep.

### 7. Port conflict with the gateway

OpenClaw's gateway listens on `127.0.0.1:18791`. Our sidecar's **default**
HTTP port was also `18791` — direct collision. Override:

```bash
export OGAMEX_WS_PORT=28790
export OGAMEX_HTTP_PORT=28791   # or any other free pair
```

(Alternative: pick distinct defaults in the plugin source itself.)

## Smoke-test sequence

After install, verify in this order:

```bash
# 1. Sidecar listens
lsof -iTCP:28790,28791 | head

# 2. Health endpoint (no auth required)
curl -sS http://127.0.0.1:28791/ogamex/v1/health | jq

# 3. WS subprotocol auth round-trip — hello → strategy.full
node -e '
const W = require("ws");
const w = new W("ws://127.0.0.1:28790", "bearer.smoke-test-token");
w.on("open", () => { console.log("WS-open"); w.send(JSON.stringify(
  {type:"hello", strategy_version:0, userscript_version:"0.0.1"})); });
w.on("message", d => { console.log("WS-recv:", String(d).slice(0,200)); process.exit(0); });
w.on("error", e => { console.log("WS-err:", e.message); process.exit(1); });
setTimeout(() => { console.log("WS-timeout"); process.exit(2); }, 5000);'

# 4. Discord reporter (banner-shaped message)
node -e '
import("/path/to/ogamex/dist/sidecar/index.js").then(m =>
  m.defaultDiscordSend("channel:<your-channel-id>",
    "OgameX online — smoke verify"))
  .then(() => console.log("DISCORD-OK"))
  .catch(e => console.log("DISCORD-ERR:", e.message));'
```

If `/v1/health` returns `ok: false` with `userscript.connected: false`,
that's expected before the userscript connects — make sure
`bridge.openConnections > 0` is what flips it.

## What this README does NOT cover (yet)

- Tampermonkey installation in the OpenClaw browser profile
- userscript token + URL config via `GM_setValue` (or build-time bake-in)
- Running the sidecar as a systemd user service (current smoke uses
  foreground `node` invocations — promote when ready)

These are tracked in the implementation plan's "real-server smoke"
section and will land before the production rollout.

