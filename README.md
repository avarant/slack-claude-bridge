# Slack Claude Bridge

A Slack bot that bridges messages to a persistent [Claude Code](https://docs.anthropic.com/en/docs/claude-code) subprocess and posts responses back.

## Features

- **Per-channel sessions** — Each allowed channel gets its own persistent Claude subprocess
- **Interactive permissions** — Tool use prompts via Block Kit buttons (Allow / Session / Always / Deny)
- **Image support** — Send images to Claude and receive images back
- **Socket Mode** — No public URL required, runs behind firewalls

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

## Usage

Send a message in an allowed channel and Claude will respond. The bot processes messages sequentially per channel.

### Commands

Type these as regular messages:

| Command | Description |
|---------|-------------|
| `!new` | Kill the current Claude session and start fresh |

### Permissions

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
                        --settings claude-settings.json
              ↕
       PreToolUse hooks → permission-hook.sh → HTTP POST to IPC server
              ↕
       Permission Handler (permission-handler.ts)
         → Slack Block Kit buttons (Allow/Session/Always/Deny)
```

### Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Bolt app, message handling, permission button callbacks |
| `src/claude-process.ts` | Claude Code subprocess lifecycle, stream-json protocol |
| `src/permission-handler.ts` | HTTP IPC server for permission request/response flow |
| `src/permission-hook.sh` | Shell hook script, forwards PreToolUse events to IPC server |
| `src/send-image.sh` | Send images to Slack via IPC |
| `claude-settings.json` | Claude Code settings: hooks config and permission rules |

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
