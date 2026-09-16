# Slack Claude Bridge

A Slack bot that bridges messages to a persistent [Claude Code](https://docs.anthropic.com/en/docs/claude-code) subprocess and posts responses back.

## Features

- **Per-thread sessions** — each Slack thread gets its own persistent Claude
  subprocess, resumed transparently after an idle kill or a bridge restart
- **Background-task replies** — a turn that finishes after the first answer
  (background agents, scheduled wakeups) posts into the thread on its own
- **Working indicator** — Slack's native "<App> is working..." while a turn runs
- **Image support** — send images to Claude and receive images back
- **Socket Mode** — no public URL required, runs behind firewalls

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` command available)
- A Slack workspace where you can create apps

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From scratch**
2. Name it (e.g. "Claude Bridge") and select your workspace

### 2. Enable Socket Mode

1. In the app settings, go to **Socket Mode** (left sidebar)
2. Toggle **Enable Socket Mode** on
3. Create an app-level token with the `connections:write` scope
4. Copy the token — this is your `SLACK_APP_TOKEN` (starts with `xapp-`)

### 3. Configure Bot Permissions

Go to **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send messages |
| `files:read` | Download files users share |
| `files:write` | Upload files (images from Claude) |
| `channels:history` | Read messages in public channels |
| `groups:history` | Read messages in private channels |
| `im:history` | Read direct messages |
| `mpim:history` | Read group DMs |

`chat:write` also covers `assistant.threads.setStatus`, which renders the
"<App> is working..." indicator. No `assistant:write` scope and no AI-App
configuration are required, and it works in ordinary channel threads.

### 4. Enable Events

1. Go to **Event Subscriptions** (left sidebar)
2. Toggle **Enable Events** on
3. Under **Subscribe to bot events**, add:
   - `message.channels` — Messages in public channels
   - `message.groups` — Messages in private channels
   - `message.im` — Direct messages
   - `message.mpim` — Group DMs

### 5. Install the App

1. Go to **Install App** (left sidebar)
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`)

### 6. Get Channel IDs

Right-click a channel name in Slack → **View channel details** → scroll to the bottom to find the Channel ID (starts with `C`).

For DMs, you can find the conversation ID by right-clicking the DM → **Copy link** — the ID is in the URL.

### 7. Configure and Run

```bash
cd slack-claude-bridge
npm install

cp .env.example .env
# Edit .env with your tokens and channel IDs

npm start
```

There is no build step — `npm start` runs `tsx src/index.ts` directly. Typecheck
with `npx tsc --noEmit`.

### 8. Invite the Bot

In each channel you want to use, invite the bot:

```
/invite @Claude Bridge
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Bot token from OAuth & Permissions (`xoxb-...`) | *(required)* |
| `SLACK_APP_TOKEN` | App-level token from Socket Mode (`xapp-...`) | *(required)* |
| `ALLOWED_CHANNEL_IDS` | Comma-separated list of authorized channel IDs | *(required)* |
| `PERMISSION_PORT` | Port for the local permission IPC server | `19276` |
| `IDLE_TIMEOUT_MINUTES` | Kill idle Claude subprocesses after N minutes (next message auto-resumes) | `30` |
| `POST_INTERMEDIATE_TEXT` | Post every intermediate assistant text block instead of just the final message | *(off)* |
| `MAX_WORKING_HOURS` | Backstop: reap a "still working" thread that has gone completely silent this long | `4` |
| `UNPROMPTED_CUTOFF_DAYS` | Only post a background-task reply into a thread a human touched this recently | `7` |
| `WORKING_STATUS` | Text for the working indicator | `is working...` |
| `BRIDGE_STATE_FILE` | Path for the thread→session map | `~/.slack-claude-bridge-state.json` |
| `BRIDGE_UPLOADS_DIR` | Where non-image Slack uploads are saved | `~/.slack-claude-bridge-uploads/` |

### `POST_INTERMEDIATE_TEXT`

The reply posted to Slack is the **final** assistant message (the `result`
event). A long agentic turn also emits a short line of preamble before most
tool batches ("Now wiring it into the importer."); in a terminal those scroll
past, but nothing posts to Slack until the turn ends, so they would arrive as a
wall of retrospective narration in front of the answer.

Set `POST_INTERMEDIATE_TEXT=1` to get the old behaviour — every text block from
the turn, joined with blank lines. Useful as a diagnostic when you want to see
what Claude did on the way. On an unexpected subprocess exit there is no result
event, so the collected blocks are posted either way.

## Usage

@mention the bot in an allowed channel to start a thread, then reply in that
thread to continue. Messages are processed sequentially **per thread**, so two
threads run concurrently but one thread never overlaps itself.

### Turns and background tasks

A single message can produce **more than one turn**. When a background task
finishes, Claude Code runs another turn in the same subprocess; the bridge posts
that reply into the thread even though nobody asked for it. Those unprompted
replies are gated on `UNPROMPTED_CUTOFF_DAYS` so a stranded task cannot
resurrect a long-dead thread.

Subprocesses are killed after `IDLE_TIMEOUT_MINUTES` of inactivity and resumed
transparently on the next message. A thread with an outstanding background task
or a turn in flight is **not** considered idle, however quiet it looks —
bounded by `MAX_WORKING_HOURS` so a wedged turn cannot pin a subprocess forever.

### Permissions

> **Not currently active.** The bridge spawns Claude with
> `--dangerously-skip-permissions`, and `claude-settings.json` is never passed to
> the CLI (see Architecture), so no PreToolUse hook fires and no prompt is ever
> posted. The code below still exists and the IPC server is still required for
> image sending. Wire `--settings` back up in `claude-process.ts` to re-enable it.

When Claude wants to use a tool, the bot posts a permission prompt with four buttons:

- **Allow** — Allow this one time
- **Session** — Auto-allow this tool for the rest of the session
- **Always** — Permanently allow (persists to `~/.claude/settings.local.json`)
- **Deny** — Block the tool call

## Architecture

```
Slack ←→ Bolt App (Socket Mode) (index.ts)
              ↕
       Claude subprocess (claude-process.ts)
          spawned with: claude -p --input-format stream-json
                        --output-format stream-json --verbose
                        --dangerously-skip-permissions
              ↕
       PreToolUse hooks → permission-hook.sh → HTTP POST to IPC server
              ↕                                  (dormant — see Permissions)
       Permission Handler (permission-handler.ts)
         → Slack Block Kit buttons (Allow/Session/Always/Deny)
         → also serves /send-image for send-image.sh  (live)
```

One collector is registered per subprocess and owns every `result` event,
handing it to a waiting user turn or posting it unprompted. The subprocess is a
long-lived stream that can emit several turns per message, so a per-message
listener would silently drop everything after the first result.

### Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Bolt app, message handling, permission button callbacks |
| `src/claude-process.ts` | Claude Code subprocess lifecycle, stream-json protocol |
| `src/permission-handler.ts` | HTTP IPC server for permission request/response flow |
| `src/permission-hook.sh` | Shell hook script, forwards PreToolUse events to IPC server |
| `src/send-image.sh` | Send images to Slack via IPC |
| `claude-settings.json` | **Inert.** Parsed and its hook path rewritten in memory, then never passed to the CLI — no `--settings` flag is in the spawn args. |

## systemd Service

Run the bridge persistently in the background:

```bash
cat > ~/.config/systemd/user/slack-claude-bridge.service << 'EOF'
[Unit]
Description=Slack Claude Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/varant/slack-claude-bridge
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/varant/slack-claude-bridge/.env
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now slack-claude-bridge
```

## License

ISC
