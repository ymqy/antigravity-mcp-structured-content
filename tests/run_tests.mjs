/**
 * Automated unit + end-to-end integration test suite for antigravity-mcp-structured-content.
 *
 * Covers:
 * 1. O(N) JsonLineReader multi-byte UTF-8 boundary safety & 5 MB+ screenshot framing
 * 2. Explicit Adapter Registry wildcard ("*") & selective modes, exact path `omitStructuredFields`,
 *    array-element prose deduplication, and `resolveCallTimeoutMs` (short & extended)
 * 3. PreToolUse hook_handler rewriting (native & stringified modes, bypasses, disable flag)
 * 4. End-to-end bridge_mcp + mcp_pool_daemon single-connection concurrency, 5 MB image forwarding,
 *    multi-workspace `.mcp.json` + `${workspaceFolder}` coexistence, short `callTimeoutMs` fail-fast,
 *    lease keepalive across idle periods, and automatic graceful shutdown on bridge exit
 * 5. Daemon shutdown vs concurrent restart race (verifying old daemon never unlinks new `pool.sock`/`daemon.pid`)
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonLineReader } from '../scripts/json_line_reader.mjs';
import {
  compactStructuredContent,
  loadRegistryAndAdapter,
  resolveCallTimeoutMs,
  shouldInterceptTool,
} from '../scripts/registry_config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const HOOK_HANDLER = join(REPO_ROOT, 'scripts', 'hook_handler.mjs');
const BRIDGE_MCP = join(REPO_ROOT, 'scripts', 'bridge_mcp.mjs');
const DAEMON_SCRIPT = join(REPO_ROOT, 'scripts', 'mcp_pool_daemon.mjs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testJsonLineReader() {
  const received = [];
  const reader = new JsonLineReader((line) => received.push(JSON.parse(line)));
  const msg = { text: '剪贴板测试 🎯 窗口状态树', ok: true };
  const raw = Buffer.from(`${JSON.stringify(msg)}\r\n`, 'utf8');
  for (let i = 0; i < raw.length; i++) {
    reader.push(raw.subarray(i, i + 1));
  }
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], msg);

  const bigReceived = [];
  const bigReader = new JsonLineReader((line) => bigReceived.push(JSON.parse(line)));
  const fakePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(220000); // ~5.28 MB
  const bigBuf = Buffer.from(`${JSON.stringify({ mimeType: 'image/png', data: fakePngBase64 })}\n`);
  for (let off = 0; off < bigBuf.length; off += 16384) {
    bigReader.push(bigBuf.subarray(off, Math.min(off + 16384, bigBuf.length)));
  }
  assert.equal(bigReceived.length, 1);
  assert.equal(bigReceived[0].data.length, fakePngBase64.length);
  console.log('✓ JsonLineReader UTF-8 byte-split & 5.28 MB streaming frame test passed');
}

async function testRegistryAndCompaction() {
  const { adapter } = loadRegistryAndAdapter('cua-driver');
  assert.ok(adapter);
  assert.equal(adapter.interceptTools, '*');
  assert.equal(shouldInterceptTool(adapter, 'get_config'), true);
  assert.equal(shouldInterceptTool(adapter, 'clipboard_read'), true);
  assert.equal(shouldInterceptTool(adapter, 'get_window_state'), true);
  assert.equal(shouldInterceptTool(adapter, 'mouse_drag'), true);

  // Timeout resolution: supports shorter fail-fast adapter timeouts AND arg-driven extension
  assert.equal(resolveCallTimeoutMs({ callTimeoutMs: 30000 }, {}), 30000);
  assert.equal(resolveCallTimeoutMs({ callTimeoutMs: 30000 }, { timeout_ms: 50000 }), 65000);
  assert.equal(resolveCallTimeoutMs({ callTimeoutMs: 30000 }, {}, 12000), 12000);

  // Selective & exclude mode
  const selective = { enabled: true, interceptTools: ['a', 'b'], excludeTools: ['b'] };
  assert.equal(shouldInterceptTool(selective, 'a'), true);
  assert.equal(shouldInterceptTool(selective, 'b'), false);
  assert.equal(shouldInterceptTool(selective, 'c'), false);

  // 1. get_window_state (markdown): tree_markdown stripped, metadata preserved
  const treeMd = 'window_id=101 pid=88 elements=3\n[1] AXButton "OK"\n[2] AXTextField "Search"';
  const mdCompacted = compactStructuredContent(
    {
      window_id: 101,
      pid: 88,
      snapshot_id: 's000001',
      tree_format: 'markdown',
      tree_markdown: treeMd,
      truncated: false,
    },
    [{ type: 'text', text: treeMd }],
    adapter,
    'get_window_state',
  );
  assert.equal(mdCompacted.tree_markdown, undefined);
  assert.equal(mdCompacted.snapshot_id, 's000001');
  assert.equal(mdCompacted.window_id, 101);

  // 2. get_window_state (elements): elements[] preserved in full
  const elCompacted = compactStructuredContent(
    {
      window_id: 101,
      snapshot_id: 's000002',
      tree_format: 'elements',
      elements: [{ element_token: 's000002:1', role: 'AXButton', label: 'OK' }],
    },
    [{ type: 'text', text: 'window_id=101 (tree is in structuredContent.elements)' }],
    adapter,
    'get_window_state',
  );
  assert.equal(elCompacted.elements.length, 1);
  assert.equal(elCompacted.elements[0].element_token, 's000002:1');

  // 3. Nested run_steps observation.state.tree_markdown + array-element duplicate prose stripped
  const stepCompacted = compactStructuredContent(
    {
      ok: true,
      executed: 2,
      snapshots: [{ snapshot_id: 's000000', tree_markdown: treeMd }],
      observation: {
        ok: true,
        state: {
          snapshot_id: 's000003',
          tree_markdown: treeMd,
        },
      },
    },
    [{ type: 'text', text: `Executed 2 steps.\n${treeMd}` }],
    adapter,
    'run_steps',
  );
  assert.equal(stepCompacted.observation.state.tree_markdown, undefined);
  assert.equal(stepCompacted.observation.state.snapshot_id, 's000003');
  assert.equal(stepCompacted.snapshots.length, 1);
  assert.equal(stepCompacted.snapshots[0].snapshot_id, 's000000');
  assert.equal(stepCompacted.snapshots[0].tree_markdown, undefined);

  // 4. Exact path omitStructuredFields never deletes nested homonymous keys
  const pathOmitAdapter = {
    enabled: true,
    omitStructuredFields: ['title', 'meta.secret', 'items[].blob', 'my_tool:scoped_only'],
  };
  const omittedRes = compactStructuredContent(
    {
      title: 'drop-root',
      scoped_only: 'drop-scoped',
      nested: { title: 'keep-nested-title' },
      meta: { secret: 'drop-secret', keep: 1 },
      items: [{ title: 'keep-item-title', blob: 'drop-blob' }],
    },
    [],
    pathOmitAdapter,
    'my_tool',
  );
  assert.equal(omittedRes.title, undefined);
  assert.equal(omittedRes.scoped_only, undefined);
  assert.equal(omittedRes.nested.title, 'keep-nested-title');
  assert.equal(omittedRes.meta.secret, undefined);
  assert.equal(omittedRes.meta.keep, 1);
  assert.equal(omittedRes.items[0].title, 'keep-item-title');
  assert.equal(omittedRes.items[0].blob, undefined);

  // 5. Single-key exact echo (e.g. page text) returns undefined
  const pageCompacted = compactStructuredContent(
    { text: '<h1>Hello World</h1>' },
    [{ type: 'text', text: '<h1>Hello World</h1>' }],
    adapter,
    'page',
  );
  assert.equal(pageCompacted, undefined);

  // 6. Empty original nested object (e.g. get_config cursor.motion.effects = {}) preserved
  const cfgCompacted = compactStructuredContent(
    { version: '0.49.3', cursor: { motion: { effects: {}, style: 'arc' } } },
    [{ type: 'text', text: 'cua-driver-rs configuration' }],
    adapter,
    'get_config',
  );
  assert.deepEqual(cfgCompacted.cursor.motion.effects, {});

  console.log('✓ Registry modes, exact omit paths, array dedupe & timeout resolution passed');
}

async function testHookHandler() {
  const runPreHook = (payload, extraEnv = {}) => {
    const out = execFileSync(process.execPath, [HOOK_HANDLER, 'PreToolUse'], {
      input: JSON.stringify(payload),
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
    });
    return JSON.parse(out.trim());
  };

  const r1 = runPreHook({
    cwd: '/tmp/ws1',
    workspacePaths: ['/tmp/ws0'],
    toolCall: {
      name: 'call_mcp_tool',
      args: { ServerName: 'cua-driver', ToolName: 'clipboard_read', Arguments: {} },
    },
  });
  assert.equal(r1.decision, 'allow');
  assert.equal(r1.overwrite.ServerName, 'antigravity-mcp-structured-content_bridge');
  assert.equal(r1.overwrite.ToolName, 'get_structured_result');
  assert.equal(r1.overwrite.Arguments.server, 'cua-driver');
  assert.equal(r1.overwrite.Arguments.tool, 'clipboard_read');
  assert.deepEqual(r1.overwrite.Arguments.workspacePaths, ['/tmp/ws0', '/tmp/ws1']);

  const r2 = runPreHook({
    toolCall: {
      name: 'call_mcp_tool',
      args: {
        ServerName: '"cua-driver"',
        ToolName: '"get_config"',
        Arguments: '{"fast":true}',
      },
    },
  });
  assert.equal(JSON.parse(r2.overwrite.ServerName), 'antigravity-mcp-structured-content_bridge');
  assert.equal(JSON.parse(r2.overwrite.Arguments).tool, 'get_config');
  assert.equal(JSON.parse(r2.overwrite.Arguments).arguments.fast, true);

  const r3 = runPreHook({
    toolCall: {
      name: 'call_mcp_tool',
      args: { ServerName: 'sqlite-helper', ToolName: 'query', Arguments: {} },
    },
  });
  assert.deepEqual(r3, { decision: 'allow' });

  const r4 = runPreHook(
    {
      toolCall: {
        name: 'call_mcp_tool',
        args: { ServerName: 'cua-driver', ToolName: 'get_config', Arguments: {} },
      },
    },
    { AGY_MCP_SC_DISABLE: '1' },
  );
  assert.deepEqual(r4, { decision: 'allow' });

  console.log('✓ PreToolUse hook_handler rewriting & bypass tests passed');
}

async function testEndToEndBridgeAndDaemonLifecycle() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-mcp-sc-test-'));
  const runtimeDir = join(tmpDir, 'rt');
  const wsADir = join(tmpDir, 'wsA');
  const wsBDir = join(tmpDir, 'wsB');
  mkdirSync(wsADir, { recursive: true });
  mkdirSync(wsBDir, { recursive: true });

  const mockServerScript = join(tmpDir, 'mock_mcp_server.mjs');
  const mockMcpConfig = join(tmpDir, 'mcp_config.json');
  const userOverrideConfig = join(tmpDir, 'user_override.json');

  writeFileSync(
    mockServerScript,
    `
const sessions = new Set();
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0' } }
      }) + '\\n');
    } else if (msg.method === 'tools/call') {
      const { name, arguments: a = {} } = msg.params;
      if (name === 'start_session') {
        sessions.add(a.session);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: 'Session started' }],
            structuredContent: {
              session: a.session,
              active: true,
              transportPid: process.pid,
              wsTag: process.env.WS_TAG || 'global'
            }
          }
        }) + '\\n');
      } else if (name === 'get_session') {
        const ok = sessions.has(a.session);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: ok ? 'Session active' : 'Not visible' }],
            structuredContent: {
              session: a.session,
              visible: ok,
              transportPid: process.pid,
              wsTag: process.env.WS_TAG || 'global'
            },
            isError: !ok
          }
        }) + '\\n');
      } else if (name === 'slow_tool') {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'slow done' }], structuredContent: { done: true } }
          }) + '\\n');
        }, 1200);
      } else if (name === 'big_screenshot') {
        const b64 = 'A'.repeat(5 * 1024 * 1024);
        const dupTree = 'window_id=1\\n[1] AXButton "确定"\\n[2] AXStaticText "状态正常"';
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              { type: 'text', text: dupTree },
              { type: 'image', mimeType: 'image/png', data: b64 }
            ],
            structuredContent: {
              capture_id: 'cap_5mb',
              tree_markdown: dupTree,
              utf8_note: '中文与表情 🚀 保真'
            }
          }
        }) + '\\n');
      }
    }
  }
});
`,
    'utf8',
  );

  // Global fallback MCP config + Workspace A override using ${workspaceFolder}
  writeFileSync(
    mockMcpConfig,
    JSON.stringify({
      mcpServers: {
        'cua-driver': {
          command: process.execPath,
          args: [mockServerScript],
        },
        'short-timeout-srv': {
          command: process.execPath,
          args: [mockServerScript],
        },
        'scoped-global-srv': {
          command: process.execPath,
          args: [mockServerScript],
          env: { WS_TAG: '${workspaceFolder}' },
        },
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(wsADir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'cua-driver': {
          command: process.execPath,
          args: [mockServerScript],
          env: { WS_TAG: '${workspaceFolder}' },
        },
      },
    }),
    'utf8',
  );
  writeFileSync(
    userOverrideConfig,
    JSON.stringify({
      servers: {
        'short-timeout-srv': {
          enabled: true,
          interceptTools: '*',
          callTimeoutMs: 180,
        },
        'scoped-global-srv': {
          enabled: true,
          interceptTools: '*',
        },
      },
    }),
    'utf8',
  );

  const testEnv = {
    ...process.env,
    AGY_MCP_SC_RUNTIME_DIR: runtimeDir,
    AGY_MCP_SC_MCP_CONFIG: mockMcpConfig,
    AGY_MCP_SC_USER_CONFIG: userOverrideConfig,
    AGY_MCP_SC_IDLE_TIMEOUT_MS: '150',
    AGY_MCP_SC_LEASE_GRACE_MS: '200',
  };

  const bridge = spawn(process.execPath, [BRIDGE_MCP], {
    env: testEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const bridgeReader = new JsonLineReader((line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  bridge.stdout.on('data', (chunk) => bridgeReader.push(chunk));

  let rpcId = 1;
  const callBridge = (method, params) => {
    const id = rpcId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const extractSc = (res) => {
    const line = res.result.content.find((c) => c.text?.startsWith('[structuredContent] ')).text;
    return JSON.parse(line.slice('[structuredContent] '.length));
  };

  try {
    const initRes = await callBridge('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initRes.result.serverInfo.version, '1.1.0');

    // 1. Parallel cold-start burst on global scope -> must spawn ONLY 1 process
    const burst = await Promise.all([
      callBridge('tools/call', {
        name: 'get_structured_result',
        arguments: {
          server: 'cua-driver',
          tool: 'start_session',
          arguments: { session: 's-global' },
          workspacePaths: [wsBDir],
        },
      }),
      callBridge('tools/call', {
        name: 'get_structured_result',
        arguments: {
          server: 'cua-driver',
          tool: 'start_session',
          arguments: { session: 's-global-2' },
          workspacePaths: [wsBDir],
        },
      }),
    ]);
    const globalPid = extractSc(burst[0]).transportPid;
    assert.equal(extractSc(burst[1]).transportPid, globalPid);
    assert.equal(extractSc(burst[0]).wsTag, 'global');

    // 2. Multi-workspace coexistence: wsA (.mcp.json + ${workspaceFolder}) & wsB (global) must NOT evict each other
    const wsAStart = await callBridge('tools/call', {
      name: 'get_structured_result',
      arguments: {
        server: 'cua-driver',
        tool: 'start_session',
        arguments: { session: 's-wsA' },
        workspacePaths: [wsADir],
      },
    });
    const wsASc = extractSc(wsAStart);
    assert.equal(wsASc.wsTag, wsADir);
    assert.notEqual(wsASc.transportPid, globalPid);

    // Interleave back to wsB then wsA -> both sessions remain alive on their original PIDs!
    const checkGlobal = await callBridge('tools/call', {
      name: 'get_structured_result',
      arguments: {
        server: 'cua-driver',
        tool: 'get_session',
        arguments: { session: 's-global' },
        workspacePaths: [wsBDir],
      },
    });
    assert.equal(checkGlobal.result.isError, false);
    assert.equal(extractSc(checkGlobal).transportPid, globalPid);

    const checkWsA = await callBridge('tools/call', {
      name: 'get_structured_result',
      arguments: {
        server: 'cua-driver',
        tool: 'get_session',
        arguments: { session: 's-wsA' },
        workspacePaths: [wsADir],
      },
    });
    assert.equal(checkWsA.result.isError, false);
    assert.equal(extractSc(checkWsA).transportPid, wsASc.transportPid);

    // 2b. Shared global config with ${workspaceFolder}: wsA & wsB must isolate AND display distinct keys in --status
    const [scopedWsA, scopedWsB] = await Promise.all([
      callBridge('tools/call', {
        name: 'get_structured_result',
        arguments: {
          server: 'scoped-global-srv',
          tool: 'start_session',
          arguments: { session: 's-scoped-a' },
          workspacePaths: [wsADir],
        },
      }),
      callBridge('tools/call', {
        name: 'get_structured_result',
        arguments: {
          server: 'scoped-global-srv',
          tool: 'start_session',
          arguments: { session: 's-scoped-b' },
          workspacePaths: [wsBDir],
        },
      }),
    ]);
    assert.equal(extractSc(scopedWsA).wsTag, wsADir);
    assert.equal(extractSc(scopedWsB).wsTag, wsBDir);
    assert.notEqual(extractSc(scopedWsA).transportPid, extractSc(scopedWsB).transportPid);

    // 3. Short callTimeoutMs (180ms) override fails fast instead of clamping to 10 minutes
    const t0 = Date.now();
    const timeoutRes = await callBridge('tools/call', {
      name: 'get_structured_result',
      arguments: { server: 'short-timeout-srv', tool: 'slow_tool', arguments: {} },
    });
    const elapsed = Date.now() - t0;
    assert.equal(timeoutRes.result.isError, true);
    assert.match(timeoutRes.result.content[0].text, /timed out after 180ms/);
    assert.ok(elapsed < 1000, `Expected fail-fast <1000ms, got ${elapsed}ms`);

    // 4. Lease keepalive across idle period (>2x AGY_MCP_SC_IDLE_TIMEOUT_MS)
    await delay(380);
    const checkAfterIdle = await callBridge('tools/call', {
      name: 'get_structured_result',
      arguments: {
        server: 'cua-driver',
        tool: 'get_session',
        arguments: { session: 's-global' },
        workspacePaths: [wsBDir],
      },
    });
    assert.equal(checkAfterIdle.result.isError, false);
    assert.equal(extractSc(checkAfterIdle).transportPid, globalPid);

    // 5. 5 MB inline screenshot + duplicate tree_markdown removal + UTF-8 preservation
    const bigRes = await callBridge('tools/call', {
      name: 'get_structured_result',
      arguments: { server: 'cua-driver', tool: 'big_screenshot', arguments: {} },
    });
    const imgBlock = bigRes.result.content.find((c) => c.type === 'image');
    assert.ok(imgBlock);
    assert.equal(imgBlock.data.length, 5 * 1024 * 1024);
    const bigSc = extractSc(bigRes);
    assert.equal(bigSc.capture_id, 'cap_5mb');
    assert.equal(bigSc.tree_markdown, undefined);
    assert.equal(bigSc.utf8_note, '中文与表情 🚀 保真');

    // 6. Daemon restart (`--stop`) while bridge_mcp stays alive -> must drain old lease ack,
    // close stale FD, and re-establish `activeLeases === 1` on the newly spawned daemon!
    const sockPath = join(runtimeDir, 'pool.sock');
    const statusBefore = JSON.parse(
      execFileSync(process.execPath, [DAEMON_SCRIPT, '--status'], {
        env: testEnv,
        encoding: 'utf8',
      }),
    );
    assert.equal(statusBefore.activeLeases, 1);
    const scopeKeyA = `${mockMcpConfig}::${wsADir}`;
    const scopeKeyB = `${mockMcpConfig}::${wsBDir}`;
    assert.ok(
      statusBefore.activeServers[`scoped-global-srv (${scopeKeyA})`],
      'Expected distinct --status entry for wsA on shared ${workspaceFolder} global config',
    );
    assert.ok(
      statusBefore.activeServers[`scoped-global-srv (${scopeKeyB})`],
      'Expected distinct --status entry for wsB on shared ${workspaceFolder} global config',
    );
    assert.equal(statusBefore.activeServers[`scoped-global-srv (${scopeKeyA})`].scope, scopeKeyA);
    assert.equal(statusBefore.activeServers[`scoped-global-srv (${scopeKeyB})`].scope, scopeKeyB);

    execFileSync(process.execPath, [DAEMON_SCRIPT, '--stop'], { env: testEnv, encoding: 'utf8' });
    for (let i = 0; i < 20 && existsSync(sockPath); i++) {
      await delay(30);
    }

    const postRestartCall = await callBridge('tools/call', {
      name: 'get_structured_result',
      arguments: {
        server: 'cua-driver',
        tool: 'start_session',
        arguments: { session: 's-after-daemon-restart' },
        workspacePaths: [wsBDir],
      },
    });
    assert.equal(postRestartCall.result.isError, false);
    await delay(50);

    const statusAfter = JSON.parse(
      execFileSync(process.execPath, [DAEMON_SCRIPT, '--status'], {
        env: testEnv,
        encoding: 'utf8',
      }),
    );
    assert.notEqual(statusAfter.pid, statusBefore.pid);
    assert.equal(
      statusAfter.activeLeases,
      1,
      'Long-lived bridge_mcp must re-attach its lease after daemon restart',
    );

    // 7. Close bridge stdin -> re-attached daemon lease closes -> daemon cleans up socket after grace
    assert.equal(existsSync(sockPath), true);
    bridge.stdin.end();
    await new Promise((resolve) => bridge.once('exit', resolve));

    for (let i = 0; i < 30 && existsSync(sockPath); i++) {
      await delay(50);
    }
    assert.equal(existsSync(sockPath), false, 'Daemon should clean up pool.sock after bridge lease exits');
    console.log(
      '✓ End-to-end concurrency, multi-workspace, short timeout, 5 MB image & lease re-attach passed',
    );
  } finally {
    try {
      bridge.kill('SIGTERM');
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testShutdownRestartSocketPreservation() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-mcp-sc-race-'));
  const runtimeDir = join(tmpDir, 'rt');
  const slowExitServer = join(tmpDir, 'slow_exit_mcp.mjs');
  const mockMcpConfig = join(tmpDir, 'mcp_config.json');

  // Upstream server that ignores stdin EOF and takes 650ms to exit after SIGTERM?
  // Wait: StdioMcpClient waits up to 1500ms for stdin EOF before sending SIGTERM!
  // So simply ignoring stdin EOF for 700ms keeps cleanupAndExit inside `await c.close()` for 700ms!
  writeFileSync(
    slowExitServer,
    `
process.stdin.on('data', (chunk) => {
  const lines = chunk.toString('utf8').split('\\n').filter(Boolean);
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1.0' } }
      }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { pid: process.pid } }
      }) + '\\n');
    }
  }
});
// Keep event loop open for 700ms after stdin 'end' so old daemon stays in await c.close()
process.stdin.on('end', () => {
  setTimeout(() => process.exit(0), 700);
});
`,
    'utf8',
  );

  writeFileSync(
    mockMcpConfig,
    JSON.stringify({
      mcpServers: {
        'cua-driver': { command: process.execPath, args: [slowExitServer] },
      },
    }),
    'utf8',
  );

  const prevRuntimeDir = process.env.AGY_MCP_SC_RUNTIME_DIR;
  const prevMcpCfg = process.env.AGY_MCP_SC_MCP_CONFIG;
  process.env.AGY_MCP_SC_RUNTIME_DIR = runtimeDir;
  process.env.AGY_MCP_SC_MCP_CONFIG = mockMcpConfig;

  const { ensureDaemonRunning, sendDaemonRequest } = await import('../scripts/daemon_client.mjs');

  try {
    assert.equal(await ensureDaemonRunning(), true);
    const s1 = await sendDaemonRequest({ action: 'status' }, 1500);
    const pid1 = s1.pid;

    // Spawn the slow-closing upstream MCP child in Daemon 1
    const c1 = await sendDaemonRequest(
      { action: 'call', serverName: 'cua-driver', toolName: 'noop', arguments: {} },
      5000,
    );
    assert.equal(c1.ok, true);

    // Trigger Daemon 1 stop -> after 50ms server.close() has run, while c.close() still waits ~650ms
    await sendDaemonRequest({ action: 'stop' }, 1500);
    await delay(80);

    // Immediately start Daemon 2 during Daemon 1's 700ms child-drain window!
    assert.equal(await ensureDaemonRunning(), true);
    const s2 = await sendDaemonRequest({ action: 'status' }, 1500);
    const pid2 = s2.pid;
    assert.notEqual(pid2, pid1, 'New daemon should have started while old daemon was draining');

    const sockPath = join(runtimeDir, 'pool.sock');
    const pidPath = join(runtimeDir, 'daemon.pid');
    assert.equal(existsSync(sockPath), true);

    // Wait 850ms so Daemon 1 completely finishes cleanupAndExit()
    await delay(850);

    // Verify Daemon 1 did NOT delete Daemon 2's pool.sock or daemon.pid!
    assert.equal(existsSync(sockPath), true, 'Old daemon must NOT unlink new daemon pool.sock');
    assert.equal(existsSync(pidPath), true, 'Old daemon must NOT unlink new daemon daemon.pid');
    assert.equal(Number(readFileSync(pidPath, 'utf8').trim()), pid2);

    const pingAfter = await sendDaemonRequest({ action: 'ping' }, 1500);
    assert.equal(pingAfter.ok, true);
    assert.equal(pingAfter.pid, pid2);

    await sendDaemonRequest({ action: 'stop' }, 1500);
    await delay(100);
    console.log('✓ Daemon shutdown vs concurrent restart race test passed');
  } finally {
    if (prevRuntimeDir === undefined) delete process.env.AGY_MCP_SC_RUNTIME_DIR;
    else process.env.AGY_MCP_SC_RUNTIME_DIR = prevRuntimeDir;
    if (prevMcpCfg === undefined) delete process.env.AGY_MCP_SC_MCP_CONFIG;
    else process.env.AGY_MCP_SC_MCP_CONFIG = prevMcpCfg;
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  await testJsonLineReader();
  await testRegistryAndCompaction();
  await testHookHandler();
  await testEndToEndBridgeAndDaemonLifecycle();
  await testShutdownRestartSocketPreservation();
  console.log('\nALL TESTS PASSED.');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
