#!/bin/bash
# oss-agent SessionEnd hook
# Saves session state for potential resume
#
# This hook is called when a Claude Code session ends.
# It saves the session state so it can be resumed later
# with full context.

set -e

# Configuration
OSS_AGENT_BIN="${OSS_AGENT_BIN:-node dist/cli/index.js}"
OSS_AGENT_DATA_DIR="${OSS_AGENT_DATA_DIR:-~/.oss-agent}"

# Read input JSON from stdin
INPUT=$(cat)

# Extract session info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$SESSION_ID" ]; then
  # No session ID available
  exit 0
fi

# Save session state
SAVE_ARGS="--session-id $SESSION_ID"
if [ -n "$TRANSCRIPT_PATH" ]; then
  SAVE_ARGS="$SAVE_ARGS --transcript $TRANSCRIPT_PATH"
fi

RESULT=$("$OSS_AGENT_BIN" internal save-session-state $SAVE_ARGS 2>/dev/null || echo '{"saved":false}')

# Log result (optional, for debugging)
SAVED=$(echo "$RESULT" | jq -r '.saved // false')

if [ "$SAVED" = "true" ]; then
  # Session state was saved
  :
fi

exit 0
