#!/bin/bash
# oss-agent Stop hook
# Detects PR creation and registers for monitoring
#
# This hook is called when Claude Code completes a turn.
# It scans the transcript for PR URLs and registers them
# with oss-agent for feedback monitoring.

set -e

# Configuration
OSS_AGENT_BIN="${OSS_AGENT_BIN:-node dist/cli/index.js}"
OSS_AGENT_DATA_DIR="${OSS_AGENT_DATA_DIR:-~/.oss-agent}"

# Read input JSON from stdin
INPUT=$(cat)

# Get transcript path from input
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  # No transcript available
  exit 0
fi

# Scan transcript for PR creation
# Look for GitHub PR URLs in the recent output
RESULT=$("$OSS_AGENT_BIN" internal check-pr-created --transcript "$TRANSCRIPT_PATH" 2>/dev/null || echo '{"registered":[]}')

# Log any registered PRs (optional, for debugging)
REGISTERED=$(echo "$RESULT" | jq -r '.registered // []')
COUNT=$(echo "$REGISTERED" | jq 'length')

if [ "$COUNT" -gt 0 ]; then
  # PRs were registered for monitoring
  # This information is logged by the oss-agent CLI
  :
fi

exit 0
