/**
 * Antigravity lifecycle hook handler for MCP structuredContent preservation.
 *
 * Driven strictly by the Explicit Adapter Registry (adapters/registry.json + optional
 * user overrides at ~/.gemini/config/mcp_structured_content.json). Unaffected tools and
 * desktop/screenshot tools bypass with zero interception (~2ms).
 *
 * PreToolUse rewrites intercepted calls to the plugin's bundled bridge MCP server tool
 * (`antigravity-mcp-structured-content_bridge:get_structured_result`), which executes the
 * real call in mcp_pool_daemon.mjs and appends `[structuredContent] {...}` directly to
 * CallToolResult.content. PostToolUse mirrors session lifecycle tools (`syncAfterTools`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDaemonRunning, sendDaemonRequest } from './daemon_client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || dirname(__dirname);
const BUILTIN_REGISTRY_PATH = join(PLUGIN_ROOT, 'adapters', 'registry.json');
const USER_OVERRIDE_PATH = join(homedir(), '.gemini', 'config', 'mcp_structured_content.json');

const eventName = process.argv[2] || 'Unknown';

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
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

function loadRegistryAndAdapter(serverName) {
  const builtin = readJsonFile(BUILTIN_REGISTRY_PATH) || {};
  const user = readJsonFile(USER_OVERRIDE_PATH) || {};
  const bridgeServerName =
    user.bridgeServerName || builtin.bridgeServerName || 'antigravity-mcp-structured-content_bridge';
  const bridgeToolName =
    user.bridgeToolName || builtin.bridgeToolName || 'get_structured_result';

  const base = builtin.servers?.[serverName];
  const extra = user.servers?.[serverName];
  if (!base && !extra) {
    return { bridgeServerName, bridgeToolName, adapter: null };
  }
  const merged = { ...(base || {}), ...(extra || {}) };
  return {
    bridgeServerName,
    bridgeToolName,
    adapter: merged.enabled === false ? null : merged,
  };
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
  const interceptList = Array.isArray(adapter?.interceptTools) ? adapter.interceptTools : [];
  if (!adapter || !interceptList.includes(toolName)) {
    return { decision: 'allow' };
  }

  const toolArgs = decodeToolArg(rawArgs.Arguments, true);
  const bridgeArgs = {
    server: serverName,
    tool: toolName,
    arguments: toolArgs,
    workspacePaths: Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [],
  };

  const stringifiedMode = typeof rawArgs.ToolName === 'string' && rawArgs.ToolName.trim().startsWith('"');
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

async function handlePostToolUse(payload) {
  if (process.env.AGY_MCP_SC_DISABLE === '1') return {};
  if (payload?.toolCall?.name !== 'call_mcp_tool' || payload?.error) return {};

  const rawArgs = payload?.toolCall?.args || {};
  const serverName = decodeToolArg(rawArgs.ServerName, false);
  const toolName = decodeToolArg(rawArgs.ToolName, false);
  if (!serverName || !toolName) return {};

  const { adapter } = loadRegistryAndAdapter(serverName);
  const syncCfg = adapter?.syncAfterTools?.[toolName];
  if (!syncCfg) return {};

  const onlyIfActive = Boolean(syncCfg.onlyIfActive);
  if (!onlyIfActive) {
    const ready = await ensureDaemonRunning();
    if (!ready) return {};
  }

  const toolArgs = decodeToolArg(rawArgs.Arguments, true);
  try {
    await sendDaemonRequest(
      {
        action: 'sync',
        serverName,
        toolName,
        arguments: toolArgs,
        onlyIfActive,
        workspacePaths: payload.workspacePaths || [],
      },
      15000,
    );
  } catch {
    // Non-blocking sync: never fail PostToolUse.
  }
  return {};
}

async function main() {
  const raw = readStdinSync();
  const payload = raw.trim() ? JSON.parse(raw) : {};

  let out;
  if (eventName === 'PreToolUse') {
    out = handlePreToolUse(payload);
  } else if (eventName === 'PostToolUse') {
    out = await handlePostToolUse(payload);
  } else {
    out = {};
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch(() => {
  const fallback = eventName === 'PreToolUse' ? '{"decision":"allow"}\n' : '{}\n';
  process.stdout.write(fallback);
});
