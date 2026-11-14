#!/bin/sh
# Fail-open POSIX wrapper for Antigravity MCP StructuredContent hooks.
# Discovers Node.js even when Antigravity runs from macOS Dock/Finder GUI without interactive shell PATH.

EVENT_NAME="${1:-Unknown}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE_BIN="$(ls -1d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | tail -n 1)"
  if [ -n "$LATEST_NODE_BIN" ]; then
    export PATH="$LATEST_NODE_BIN:$PATH"
  fi
fi

if command -v node >/dev/null 2>&1; then
  OUT="$(node "$SCRIPT_DIR/hook_handler.mjs" "$EVENT_NAME" 2>/dev/null)"
  if [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
    exit 0
  fi
fi

case "$EVENT_NAME" in
  PreToolUse)
    printf '{"decision":"allow"}\n'
    ;;
  Stop)
    printf '{"decision":"stop"}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac
