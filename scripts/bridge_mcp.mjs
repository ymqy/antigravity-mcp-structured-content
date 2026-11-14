/**
 * Minimal stdio JSON-RPC 2.0 MCP bridge server for antigravity-mcp-structured-content.
 *
 * Exposes `get_structured_result`, routed automatically by PreToolUse for adapted
 * MCP tools. Calls the target server through mcp_pool_daemon.mjs and appends
 * `[structuredContent] <JSON>` as a text content block so Antigravity delivers
 * the full structured payload natively inside CallToolResult.content.
 */
import { ensureDaemonRunning, sendDaemonRequest } from './daemon_client.mjs';

const BRIDGE_TOOL = {
  name: 'get_structured_result',
  description:
    'Internal bridge invoked automatically by antigravity-mcp-structured-content PreToolUse hook to preserve MCP structuredContent. Do not call directly; call the original MCP server tool instead.',
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
  const toolArgs = args?.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
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

  let resp;
  try {
    resp = await sendDaemonRequest(
      {
        action: 'call',
        serverName: server,
        toolName: tool,
        arguments: toolArgs,
        workspacePaths,
      },
      42000,
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
        serverInfo: { name: 'antigravity-mcp-structured-content-bridge', version: '1.0.0' },
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

let rxBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  rxBuffer = Buffer.concat([rxBuffer, chunk]);
  while (true) {
    const nl = rxBuffer.indexOf(0x0a);
    if (nl === -1) break;
    const lineBuf = rxBuffer.subarray(0, nl);
    rxBuffer = rxBuffer.subarray(nl + 1);
    const line = lineBuf.toString('utf8').replace(/\r$/, '').trim();
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg && typeof msg === 'object') {
      void handleRequest(msg);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
