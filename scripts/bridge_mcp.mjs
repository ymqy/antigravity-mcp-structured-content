/**
 * Minimal stdio JSON-RPC 2.0 MCP bridge server for antigravity-mcp-structured-content.
 *
 * Exposes `get_structured_result`, routed automatically by PreToolUse for adapted
 * MCP servers/tools. Calls the target server through mcp_pool_daemon.mjs over a
 * unified persistent connection (pinned by a zero-CPU socket lease tied to this
 * bridge server's process lifetime) and appends deduplicated `[structuredContent] <JSON>`
 * natively inside CallToolResult.content while preserving inline images and isError.
 */
import { attachDaemonLease, ensureDaemonRunning, sendDaemonRequest } from './daemon_client.mjs';
import { JsonLineReader } from './json_line_reader.mjs';
import { loadRegistryAndAdapter, resolveCallTimeoutMs } from './registry_config.mjs';

const BRIDGE_TOOL = {
  name: 'get_structured_result',
  description:
    'Internal bridge invoked automatically by antigravity-mcp-structured-content PreToolUse hook to preserve MCP structuredContent over a unified persistent transport. Do not call directly; call the original MCP server tool instead.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Target MCP server name in mcp_config.json' },
      tool: { type: 'string', description: 'Target MCP tool name' },
      arguments: { type: 'object', description: 'Arguments object to forward' },
      workspacePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace paths for workspace-scoped MCP configs',
      },
    },
    required: ['server', 'tool'],
  },
};

let daemonLease = null;

function ensureLeaseAttached() {
  if (!daemonLease) {
    daemonLease = attachDaemonLease({ role: 'bridge_mcp' });
  } else {
    daemonLease.ensureAttached();
  }
}

function sendJsonRpc(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendJsonRpc({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendJsonRpc({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(args) {
  const server = typeof args?.server === 'string' ? args.server : '';
  const tool = typeof args?.tool === 'string' ? args.tool : '';
  const toolArgs =
    args?.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
      ? args.arguments
      : {};
  const workspacePaths = Array.isArray(args?.workspacePaths) ? args.workspacePaths : [];

  if (!server || !tool) {
    return {
      content: [{ type: 'text', text: '[MCP Bridge Error] Missing required fields: server and tool' }],
      isError: true,
    };
  }

  const ready = await ensureDaemonRunning();
  if (!ready) {
    return {
      content: [{ type: 'text', text: '[MCP Bridge Error] Failed to start mcp_pool_daemon' }],
      isError: true,
    };
  }
  ensureLeaseAttached();

  const { adapter } = loadRegistryAndAdapter(server);
  const callTimeoutMs = resolveCallTimeoutMs(adapter, toolArgs);
  let resp;
  try {
    resp = await sendDaemonRequest(
      {
        action: 'call',
        serverName: server,
        toolName: tool,
        arguments: toolArgs,
        timeoutMs: callTimeoutMs,
        workspacePaths,
      },
      callTimeoutMs + 5000,
    );
  } catch (err) {
    return {
      content: [{ type: 'text', text: `[MCP Bridge Error] ${err.message}` }],
      isError: true,
    };
  }

  if (!resp?.ok || !resp.result) {
    return {
      content: [{ type: 'text', text: `[MCP Bridge Error] ${resp?.error || 'Daemon call failed'}` }],
      isError: true,
    };
  }

  const content = Array.isArray(resp.result.content) ? [...resp.result.content] : [];
  const sc = resp.result.structuredContent;
  if (sc !== undefined && sc !== null) {
    content.push({
      type: 'text',
      text: `[structuredContent] ${JSON.stringify(sc)}`,
    });
  }

  return {
    content,
    isError: Boolean(resp.result.isError),
  };
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const hasId = Object.hasOwn(msg, 'id') && id !== undefined && id !== null;
  if (!hasId || (typeof method === 'string' && method.startsWith('notifications/'))) {
    return;
  }

  try {
    if (method === 'initialize') {
      sendResult(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'antigravity-mcp-structured-content-bridge', version: '1.1.0' },
      });
    } else if (method === 'ping') {
      sendResult(id, {});
    } else if (method === 'tools/list') {
      sendResult(id, { tools: [BRIDGE_TOOL] });
    } else if (method === 'resources/list') {
      sendResult(id, { resources: [] });
    } else if (method === 'prompts/list') {
      sendResult(id, { prompts: [] });
    } else if (method === 'tools/call') {
      if (params?.name !== BRIDGE_TOOL.name) {
        sendError(id, -32602, `Unknown tool: ${String(params?.name)}`);
        return;
      }
      const res = await handleToolCall(params?.arguments || {});
      sendResult(id, res);
    } else {
      sendError(id, -32601, `Method not found: ${String(method)}`);
    }
  } catch (err) {
    sendError(id, -32603, err?.message || 'Internal bridge error');
  }
}

const stdinReader = new JsonLineReader((line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg && typeof msg === 'object') {
    void handleRequest(msg);
  }
});

process.stdin.on('data', (chunk) => stdinReader.push(chunk));

function shutdown() {
  stdinReader.reset();
  if (daemonLease) {
    daemonLease.close();
    daemonLease = null;
  }
  process.exit(0);
}

process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
