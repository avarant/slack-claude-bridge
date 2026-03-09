#!/usr/bin/env bash
# PreToolUse hook script — called by Claude Code before every tool use
# Reads the hook payload from stdin, POSTs to the local IPC server,
# and outputs the decision JSON to stdout.

set -euo pipefail

PERMISSION_URL="http://127.0.0.1:${PERMISSION_PORT:-19276}/permission"
TIMEOUT=120

# Debug: log that the hook was called
echo "[permission-hook] called at $(date)" >> /tmp/permission-hook.log

# Read stdin (the tool use JSON from Claude Code)
INPUT=$(cat)
echo "[permission-hook] input: $INPUT" >> /tmp/permission-hook.log

# POST to the permission IPC server and capture the response
RESPONSE=$(echo "$INPUT" | curl -s --max-time "$TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -d @- \
  "$PERMISSION_URL" 2>/dev/null) || {
  echo "[permission-hook] curl failed" >> /tmp/permission-hook.log
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Timeout or connection error"}}'
  exit 0
}

echo "[permission-hook] response: $RESPONSE" >> /tmp/permission-hook.log

# Output the decision JSON
echo "$RESPONSE"
