#!/bin/sh
# Stdio MCP launcher for antigravity-mcp-structured-content bridge server.
# Resolves Node.js and user-local binaries even when Antigravity runs from macOS Dock/Finder GUI.

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE_BIN="$(ls -1d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | tail -n 1)"
  if [ -n "$LATEST_NODE_BIN" ]; then
    export PATH="$LATEST_NODE_BIN:$PATH"
  fi
fi

exec node "$SCRIPT_DIR/bridge_mcp.mjs"
