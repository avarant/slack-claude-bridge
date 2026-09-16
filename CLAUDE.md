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
          spawned with: claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions
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
- `claude-settings.json` — **Currently inert.** `claude-process.ts` reads it and
  rewrites the hook path in memory, but never passes `--settings` to the CLI, and
  `~/.claude-bridge/settings.json` defines no hooks either. Combined with
  `--dangerously-skip-permissions`, the PreToolUse → Slack-buttons permission flow
  described below does not fire in practice. The IPC server still matters — it is
  what `send-image.sh` posts to.

### Key Technical Details

- **Stream-JSON input format**: Messages sent as `{"type":"user","session_id":"...","message":{"role":"user","content":"text"},"parent_tool_use_id":null}`
- **Hooks**: Uses `PreToolUse` (not `PermissionRequest`) — only PreToolUse fires in `-p` headless mode
- **No streaming**: the reply is collected in full and posted when the turn ends.
  Progress is signalled by Slack's native working indicator instead (below).
- **Concurrency**: the message handler runs the Claude interaction in the
  background so Bolt can process button callbacks concurrently. A **per-thread**
  lock (`withChatLock(threadTs)`) serializes messages — per thread, not per channel.
- **Env filtering**: all `CLAUDE*` env vars are stripped from the subprocess to
  avoid the "nested session" error, except `CLAUDE_API_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN`.

## Turns, background tasks, and idle

The subprocess is a long-lived stream that can run **several turns off one user
message**. When a background task (an `Agent` call, a `/loop` wakeup) finishes,
Claude Code re-inits in the same process and runs another turn.

- **One collector per subprocess**, registered at spawn in `getOrSpawnClaude` and
  never removed. It owns every `result` event and either hands it to a waiting
  user turn (`s.waiter`) or posts it into the thread unprompted. Exactly one
  owner per result, so nothing is dropped and nothing double-posts. A
  per-message listener was the previous design and silently lost every
  post-first-result turn.
- **A resumed session emits a no-op result first** (`num_turns: 0`,
  `duration_api_ms: 0`, empty `result`) to flush background-task notifications
  orphaned by the idle kill, then re-inits and runs the real turn. It is skipped
  explicitly; treating it as the answer posts "(No response from Claude)" over a
  turn that has not started.
- **Unprompted replies are gated** on `UNPROMPTED_CUTOFF_DAYS` (default 7) so a
  stranded task cannot resurrect a months-old thread.
- **Idle is not the same as quiet.** Claude's events bump `lastActivityAt`, but a
  background task emits nothing between `task_started` and its terminal
  `task_notification`. The sweep therefore skips any thread with outstanding
  tasks or a turn in flight, bounded by `MAX_WORKING_HOURS` (default 4) so a
  wedged turn cannot pin a subprocess forever.
- **Working indicator**: `assistant.threads.setStatus` renders "<App> is
  working..." in the thread. This needs only `chat:write` — not `assistant:write`
  — and works in an ordinary channel thread. It replaced an `:eyes:` reaction
  plus a blinking-hourglass heartbeat. Nothing uses `reactions:write` any more.

## Files & Images

- **Slack → Claude (images)**: `image/*` mimetypes are downloaded via `url_private_download` (bot token auth), base64-encoded, and passed inline to Claude as `image` content blocks.
- **Slack → Claude (other files)**: CSVs, PDFs, text, etc. are downloaded once and saved to `${BRIDGE_UPLOADS_DIR:-~/.slack-claude-bridge-uploads}/<thread_ts>/<filename>`. Their absolute paths are appended to the user's caption (as `[Slack upload: file saved to disk at: ...]`) so Claude can `Read` them. Filenames are sanitized; collisions within a thread overwrite. Files are NOT auto-cleaned — the dir grows over time.
- **Claude → Slack**: Claude runs `src/send-image.sh /path/to/image.png "caption"` which POSTs to the bridge's IPC server (`/send-image` endpoint). The bridge uploads the file via `filesUploadV2`.

## Environment

- **`SLACK_BRIDGE`**: Set to `"1"` in the Claude subprocess env so Claude can detect it's running via Slack
- All other `CLAUDE*` env vars are stripped from the subprocess to avoid "nested
  session" errors, except `CLAUDE_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`

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

**There is no build step.** The service runs TypeScript directly
(`node --import tsx src/index.ts`, and `npm start` is `tsx src/index.ts`), so a
pull plus a restart is the whole deploy:

```bash
cd /home/ubuntu/slack-claude-bridge
git pull --ff-only origin main
systemctl --user restart slack-claude-bridge
```

Typecheck before pushing with `npx tsc --noEmit`. Any `dist/` on a box is a
leftover from the old build-based deploy and is not used by anything.

Restarting is safe for existing conversations — `thread_ts → session_id` is
persisted, so threads resume. It does kill any turn in flight, and it kills every
subprocess, which means the next message in any thread is a `--resume`.

### Manual start (if systemd isn't set up)

```bash
cd /home/ubuntu/slack-claude-bridge
source .env && export SLACK_BOT_TOKEN SLACK_APP_TOKEN ALLOWED_CHANNEL_IDS PERMISSION_PORT
nohup npm start > bridge.log 2>&1 &
```

**Don't run nohup-bridge alongside systemd.** Both try to bind `PERMISSION_PORT` (19276) and the loser hits `EADDRINUSE`. systemd has no visibility into a nohup-spawned bridge, so a `systemctl --user restart` with a stale nohup process around will spin in `auto-restart` forever. Kill any lingering process first (`lsof -ti :19276`).

### State file

Thread-to-session mappings persist at `~/.slack-claude-bridge-state.json`. The path is based on `$HOME`, so if `HOME` is wrong (e.g. `/root` when running as root via SSM), the bridge won't find existing threads.

## Config (.env)

- `SLACK_BOT_TOKEN` — Bot token (`xoxb-...`)
- `SLACK_APP_TOKEN` — App-level token for Socket Mode (`xapp-...`)
- `ALLOWED_CHANNEL_IDS` — Comma-separated list of authorized channel IDs
- `PERMISSION_PORT` — IPC server port (default: 19276)
- `BRIDGE_STATE_FILE` — Override path for the thread-to-session JSON (default: `~/.slack-claude-bridge-state.json`)
- `BRIDGE_UPLOADS_DIR` — Override path where non-image Slack uploads are saved (default: `~/.slack-claude-bridge-uploads/`)
- `IDLE_TIMEOUT_MINUTES` — Per-thread subprocess idle kill threshold (default: 30). Only applies to a thread with no outstanding background task and no turn in flight.
- `MAX_WORKING_HOURS` — Backstop: reap a "still working" thread that has been totally silent this long (default: 4)
- `UNPROMPTED_CUTOFF_DAYS` — Only post a background-task reply into a thread a human touched this recently (default: 7)
- `WORKING_STATUS` — Text for Slack's working indicator (default: `is working...`, rendered as "Clank is working...")
- `POST_INTERMEDIATE_TEXT` — Post every intermediate assistant text block instead of just the final message. Off by default; diagnostic only.
