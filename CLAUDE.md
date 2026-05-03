# Slack Claude Bridge

Slack bot that bridges messages to a persistent Claude Code subprocess and posts responses back.

## Quick Start

```bash
cp .env.example .env  # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_CHANNEL_IDS
npm install
npm start
```

## Architecture

```
Slack ←→ Bolt App (Socket Mode) (index.ts)
              ↕
       Claude subprocess (claude-process.ts)
          spawned with: claude -p --input-format stream-json --output-format stream-json --verbose --settings claude-settings.json
              ↕
       PreToolUse hooks → permission-hook.sh → HTTP POST to IPC server
              ↕
       Permission Handler (permission-handler.ts) → Slack Block Kit buttons (Allow/Deny)
```

### Source Files

- `src/index.ts` — Main entry: Bolt app, message handling, permission button callbacks
- `src/claude-process.ts` — Claude Code subprocess lifecycle, stream-json message protocol
- `src/permission-handler.ts` — HTTP IPC server on localhost:19276 for permission request/response flow
- `src/permission-hook.sh` — Shell script called by Claude's PreToolUse hook, forwards to IPC server
- `claude-settings.json` — Passed via `--settings` flag, configures PreToolUse hooks

### Key Technical Details

- **Stream-JSON input format**: Messages sent as `{"type":"user","session_id":"...","message":{"role":"user","content":"text"},"parent_tool_use_id":null}`
- **Hooks**: Uses `PreToolUse` (not `PermissionRequest`) — only PreToolUse fires in `-p` headless mode
- **No streaming**: Responses are collected fully before posting (Slack's streaming APIs require threads)
- **Concurrency**: Message handler runs Claude interaction in background so Bolt can process permission button callbacks concurrently. Per-channel lock serializes messages.
- **Env filtering**: All `CLAUDE*` env vars (except `CLAUDE_API_KEY`) are stripped from subprocess to avoid "nested session" error

## Images

- **Slack → Claude**: Files with image mimetypes are downloaded via `url_private_download` (with bot token auth), converted to base64, and passed to Claude
- **Claude → Slack**: Claude runs `src/send-image.sh /path/to/image.png "caption"` which POSTs to the bridge's IPC server (`/send-image` endpoint). The bridge uploads the file via `filesUploadV2`.

## Environment

- **`SLACK_BRIDGE`**: Set to `"1"` in the Claude subprocess env so Claude can detect it's running via Slack
- All other `CLAUDE*` env vars (except `CLAUDE_API_KEY`) are stripped from the subprocess to avoid "nested session" errors

## Systemd Service

Runs as a **user-level** systemd service at `~/.config/systemd/user/slack-claude-bridge.service`. Linger is enabled so it survives logouts and reboots.

```bash
systemctl --user status slack-claude-bridge   # check status
systemctl --user restart slack-claude-bridge  # restart
systemctl --user stop slack-claude-bridge     # stop
journalctl --user -u slack-claude-bridge -f   # tail logs
```

## Deployment on EC2 (Dev)

The bridge runs on the dev/staging EC2 (`i-06141ec8f53774665`) as the `ubuntu` user.

### CRITICAL: Must run as `ubuntu`, NOT root

Claude CLI refuses `--dangerously-skip-permissions` when running as root. SSM `SendCommand` runs as root by default, so starting the bridge via SSM with `nohup node dist/index.js` will appear to work but crash on the first Slack message with:
```
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

**Preferred method**: Use the systemd user service (see below). If that's not available, use `sudo -u ubuntu` in SSM commands.

### After git pull / code changes

```bash
# Must rebuild TypeScript — dist/ is gitignored
cd /home/ubuntu/slack-claude-bridge
npx tsc

# Then restart
systemctl --user restart slack-claude-bridge
```

### Manual start (if systemd isn't set up)

```bash
cd /home/ubuntu/slack-claude-bridge
source .env && export SLACK_BOT_TOKEN SLACK_APP_TOKEN ALLOWED_CHANNEL_IDS PERMISSION_PORT
nohup node dist/index.js > bridge.log 2>&1 &
```

### State file

Thread-to-session mappings persist at `~/.slack-claude-bridge-state.json`. The path is based on `$HOME`, so if `HOME` is wrong (e.g. `/root` when running as root via SSM), the bridge won't find existing threads.

## Config (.env)

- `SLACK_BOT_TOKEN` — Bot token (`xoxb-...`)
- `SLACK_APP_TOKEN` — App-level token for Socket Mode (`xapp-...`)
- `ALLOWED_CHANNEL_IDS` — Comma-separated list of authorized channel IDs
- `PERMISSION_PORT` — IPC server port (default: 19276)
