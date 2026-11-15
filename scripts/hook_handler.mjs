/**
 * Antigravity PreToolUse lifecycle hook handler for MCP structuredContent preservation.
 *
 * Driven strictly by the Explicit Adapter Registry (`adapters/registry.json` + optional
 * user overrides at `~/.gemini/config/mcp_structured_content.json`).
 *
 * Supports both:
 * - Full-server single-connection mode (`"interceptTools": "*"`), eliminating dual-connection
 *   transport split for stateful servers like `cua-driver`.
 * - Selective tool mode (`"interceptTools": [...]`) for stateless servers, bypassing
 *   unaffected servers/tools in ~2ms.
 */
import { readFileSync } from 'node:fs';
import { loadRegistryAndAdapter, shouldInterceptTool } from './registry_config.mjs';

const eventName = process.argv[2] || 'Unknown';

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Antigravity may deliver toolCall.args fields either as native JSON values or
 * JSON-encoded string tokens; decode strings that look like JSON literals cleanly.
 */
function decodeToolArg(raw, expectObject = false) {
  if (raw == null) return expectObject ? {} : '';
  let val = raw;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('[')
    ) {
      try {
        val = JSON.parse(trimmed);
      } catch {
        // Keep original string if not valid JSON.
      }
    }
  }
  if (expectObject) {
    if (typeof val === 'string') {
      try {
        val = JSON.parse(val);
      } catch {
        val = {};
      }
    }
    return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
  }
  return typeof val === 'string' ? val : String(val);
}

function collectWorkspacePaths(payload) {
  const paths = [];
  if (Array.isArray(payload?.workspacePaths)) {
    for (const p of payload.workspacePaths) {
      if (typeof p === 'string' && p && !paths.includes(p)) paths.push(p);
    }
  }
  if (typeof payload?.cwd === 'string' && payload.cwd && !paths.includes(payload.cwd)) {
    paths.push(payload.cwd);
  }
  return paths;
}

function handlePreToolUse(payload) {
  if (process.env.AGY_MCP_SC_DISABLE === '1') {
    return { decision: 'allow' };
  }
  if (payload?.toolCall?.name !== 'call_mcp_tool') {
    return { decision: 'allow' };
  }

  const rawArgs = payload?.toolCall?.args || {};
  const serverName = decodeToolArg(rawArgs.ServerName, false);
  const toolName = decodeToolArg(rawArgs.ToolName, false);
  if (!serverName || !toolName) {
    return { decision: 'allow' };
  }

  const { bridgeServerName, bridgeToolName, adapter } = loadRegistryAndAdapter(serverName);
  if (serverName === bridgeServerName) {
    return { decision: 'allow' };
  }
  if (!shouldInterceptTool(adapter, toolName)) {
    return { decision: 'allow' };
  }

  const toolArgs = decodeToolArg(rawArgs.Arguments, true);
  const bridgeArgs = {
    server: serverName,
    tool: toolName,
    arguments: toolArgs,
    workspacePaths: collectWorkspacePaths(payload),
  };

  const stringifiedMode =
    typeof rawArgs.ToolName === 'string' && rawArgs.ToolName.trim().startsWith('"');
  return {
    decision: 'allow',
    overwrite: stringifiedMode
      ? {
          ServerName: JSON.stringify(bridgeServerName),
          ToolName: JSON.stringify(bridgeToolName),
          Arguments: JSON.stringify(bridgeArgs),
        }
      : {
          ServerName: bridgeServerName,
          ToolName: bridgeToolName,
          Arguments: bridgeArgs,
        },
  };
}

function main() {
  const raw = readStdinSync();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const out = eventName === 'PreToolUse' ? handlePreToolUse(payload) : {};
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

try {
  main();
} catch {
  const fallback = eventName === 'PreToolUse' ? '{"decision":"allow"}\n' : '{}\n';
  process.stdout.write(fallback);
}
