#!/bin/bash
# Claude Code on the web: install dependencies and build dist/ so the edgar MCP server in .mcp.json can start.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

node "$CLAUDE_PROJECT_DIR/scripts/mcp-launch.mjs" --prepare
