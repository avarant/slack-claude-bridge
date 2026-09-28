#!/usr/bin/env bash
# Send an image to this session's Slack thread via the bridge's IPC server.
# The thread comes from BRIDGE_CHANNEL_ID / BRIDGE_THREAD_TS, which the bridge
# sets when it spawns the Claude subprocess.
# Usage: send-image.sh /path/to/image.png ["optional caption"]

set -euo pipefail

IMAGE_PATH="${1:?Usage: send-image.sh /path/to/image.png [caption]}"
CAPTION="${2:-}"
SEND_IMAGE_URL="http://127.0.0.1:${PERMISSION_PORT:-19276}/send-image"

if [ ! -f "$IMAGE_PATH" ]; then
  echo "Error: File not found: $IMAGE_PATH" >&2
  exit 1
fi

JSON=$(jq -n --arg path "$IMAGE_PATH" --arg caption "$CAPTION" \
  --arg channelId "${BRIDGE_CHANNEL_ID:-}" --arg threadTs "${BRIDGE_THREAD_TS:-}" \
  '{path: $path, caption: $caption, channelId: $channelId, threadTs: $threadTs}')

# The bridge replies only after the Slack upload finishes, and videos run ~80 MB,
# so allow far longer than the old 30 s.
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT
STATUS=$(curl -s --max-time 600 -o "$BODY_FILE" -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$JSON" \
  "$SEND_IMAGE_URL" 2>/dev/null) || {
  echo "Error: Failed to connect to bridge IPC server" >&2
  exit 1
}

cat "$BODY_FILE"; echo
if [ "$STATUS" != "200" ]; then
  echo "Error: bridge returned HTTP $STATUS — the file was NOT delivered" >&2
  exit 1
fi
