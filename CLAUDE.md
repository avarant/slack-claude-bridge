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

## Config (.env)

- `SLACK_BOT_TOKEN` — Bot token (`xoxb-...`)
- `SLACK_APP_TOKEN` — App-level token for Socket Mode (`xapp-...`)
- `ALLOWED_CHANNEL_IDS` — Comma-separated list of authorized channel IDs
- `PERMISSION_PORT` — IPC server port (default: 19276)
