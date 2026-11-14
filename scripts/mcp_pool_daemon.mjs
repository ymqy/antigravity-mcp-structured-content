/**
 * On-demand background MCP client pool daemon for antigravity-mcp-structured-content.
 *
 * Maintains persistent stdio or Streamable HTTP connections to configured MCP servers
 * across separate hook invocations so stateful sessions (e.g. cua-driver browser tabs
 * and implicit sessions) persist while Antigravity hooks run as short-lived scripts.
 * Auto-exits cleanly after IDLE_TIMEOUT_MS without activity.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDir, getRuntimeDir, getSocketPath, sendDaemonRequest } from './daemon_client.mjs';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CALL_TIMEOUT_MS = 38000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const STDERR_TAIL_LIMIT = 4096;

/**
 * Persistent stdio JSON-RPC 2.0 MCP client using Buffer line framing so
 * multibyte UTF-8 chunks never split across read events.
 */
class StdioMcpClient {
  constructor(serverName, spec, specHash) {
    this.serverName = serverName;
    this.spec = spec;
    this.specHash = specHash;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = '';
    this.closed = false;
    this.initPromise = null;
    this.rxBuffer = Buffer.alloc(0);

    const env = { ...process.env, ...(spec.env && typeof spec.env === 'object' ? spec.env : {}) };
    const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const cwd = typeof spec.cwd === 'string' && spec.cwd ? spec.cwd : undefined;

    this.proc = spawn(spec.command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => this.#onStdoutData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });
    this.proc.on('exit', (code, signal) => {
      this.#failAll(new Error(`MCP server '${this.serverName}' exited (code=${code}, signal=${signal})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`));
    });
    this.proc.on('error', (err) => {
      this.#failAll(new Error(`Failed to spawn MCP server '${this.serverName}': ${err.message}`));
    });
  }

  isAlive() {
    return !this.closed && this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  #failAll(err) {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  #onStdoutData(chunk) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    while (true) {
      const nl = this.rxBuffer.indexOf(0x0a);
      if (nl === -1) break;
      const lineBuf = this.rxBuffer.subarray(0, nl);
      this.rxBuffer = this.rxBuffer.subarray(nl + 1);
      const line = lineBuf.toString('utf8').replace(/\r$/, '').trim();
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== 'object') continue;
      if (Object.hasOwn(msg, 'id') && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) {
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(`JSON-RPC ${msg.error.code ?? ''}: ${msg.error.message || JSON.stringify(msg.error)}`));
        } else {
          entry.resolve(msg.result);
        }
      } else if (Object.hasOwn(msg, 'id') && msg.method) {
        // Answer server-initiated requests (e.g. ping) so servers never block.
        this.#writeMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    }
  }

  #writeMessage(obj) {
    if (!this.isAlive() || !this.proc.stdin.writable) {
      throw new Error(`MCP server '${this.serverName}' stdin is not writable`);
    }
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    if (!this.isAlive()) {
      return Promise.reject(new Error(`MCP server '${this.serverName}' is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${this.serverName}' ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#writeMessage({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#writeMessage(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  async ensureInitialized() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'antigravity-mcp-structured-content', version: '1.0.0' },
          },
          15000,
        );
        this.notify('notifications/initialized', {});
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  async callTool(name, args, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    await this.ensureInitialized();
    return this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      const killTimer = setTimeout(() => {
        try {
          this.proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        resolve();
      }, 1500);
      this.proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }
}

/**
 * Streamable HTTP MCP client supporting application/json and text/event-stream responses.
 */
class HttpMcpClient {
  constructor(serverName, spec, specHash) {
    this.serverName = serverName;
    this.spec = spec;
    this.specHash = specHash;
    this.url = spec.url || spec.serverUrl;
    this.nextId = 1;
    this.sessionId = null;
    this.initPromise = null;
    this.closed = false;
  }

  isAlive() {
    return !this.closed && Boolean(this.url);
  }

  async #postRpc(payload, timeoutMs) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.spec.headers && typeof this.spec.headers === 'object' ? this.spec.headers : {}),
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from MCP server '${this.serverName}'`);
      err.httpStatus = res.status;
      throw err;
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    if (!text.trim()) return null;

    if (ct.includes('text/event-stream')) {
      return this.#parseSseResponse(text, payload.id);
    }
    return JSON.parse(text);
  }

  #parseSseResponse(body, targetId) {
    const blocks = body.split(/\r?\n\r?\n/);
    let lastJson = null;
    for (const block of blocks) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (!dataLines.length) continue;
      try {
        const msg = JSON.parse(dataLines.join('\n'));
        lastJson = msg;
        if (targetId !== undefined && msg?.id === targetId) return msg;
      } catch {
        // skip non-JSON keepalive comments
      }
    }
    return lastJson;
  }

  async request(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    const id = this.nextId++;
    const msg = await this.#postRpc({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    if (msg?.error) {
      throw new Error(`JSON-RPC ${msg.error.code ?? ''}: ${msg.error.message || JSON.stringify(msg.error)}`);
    }
    return msg?.result ?? {};
  }

  async ensureInitialized() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'antigravity-mcp-structured-content', version: '1.0.0' },
          },
          15000,
        );
        await this.#postRpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 5000).catch(() => {});
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  async callTool(name, args, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    await this.ensureInitialized();
    try {
      return await this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
    } catch (err) {
      if (err.httpStatus === 404) {
        this.sessionId = null;
        this.initPromise = null;
        await this.ensureInitialized();
        return this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
      }
      throw err;
    }
  }

  async close() {
    this.closed = true;
  }
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveMcpServerSpec(serverName, workspacePaths = []) {
  const candidates = [join(homedir(), '.gemini', 'config', 'mcp_config.json')];
  if (Array.isArray(workspacePaths)) {
    for (const ws of workspacePaths) {
      if (typeof ws !== 'string' || !ws) continue;
      candidates.push(join(ws, '.mcp.json'));
      candidates.push(join(ws, '.gemini', 'mcp_config.json'));
    }
  }
  for (const cfgPath of candidates) {
    const doc = readJsonSafe(cfgPath);
    const spec = doc?.mcpServers?.[serverName];
    if (spec && typeof spec === 'object') {
      return { spec, source: cfgPath };
    }
  }
  return null;
}

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function createClient(serverName, spec) {
  const specHash = JSON.stringify(spec);
  if (typeof spec.command === 'string' && spec.command) {
    const normalizedSpec = {
      ...spec,
      command: expandTilde(spec.command),
      cwd: spec.cwd ? expandTilde(spec.cwd) : spec.cwd,
    };
    return new StdioMcpClient(serverName, normalizedSpec, specHash);
  }
  if (typeof (spec.url || spec.serverUrl) === 'string') {
    return new HttpMcpClient(serverName, spec, specHash);
  }
  throw new Error(`Unsupported MCP transport config for server '${serverName}'`);
}

/**
 * Check if a daemon is already bound to the socket before unlinking stale files.
 */
async function isExistingDaemonAlive() {
  try {
    const res = await sendDaemonRequest({ action: 'ping' }, 400);
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function runDaemon() {
  ensurePrivateDir(getRuntimeDir());
  const sockPath = getSocketPath();
  const pidPath = join(getRuntimeDir(), 'daemon.pid');

  if (existsSync(sockPath)) {
    if (await isExistingDaemonAlive()) {
      return;
    }
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  }

  const clients = new Map();
  let idleTimer = null;
  let shuttingDown = false;

  const cleanupAndExit = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(idleTimer);
    try {
      server.close();
    } catch {
      // ignore
    }
    await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    clients.clear();
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch {
      // ignore
    }
    try {
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch {
      // ignore
    }
    process.exit(code);
  };

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      cleanupAndExit(0);
    }, IDLE_TIMEOUT_MS);
  };

  async function getOrCreateClient(serverName, workspacePaths) {
    const resolved = resolveMcpServerSpec(serverName, workspacePaths);
    if (!resolved) {
      throw new Error(`MCP server '${serverName}' not found in mcp_config.json`);
    }
    if (resolved.spec.disabled === true) {
      throw new Error(`MCP server '${serverName}' is disabled`);
    }
    const newHash = JSON.stringify(resolved.spec);
    const existing = clients.get(serverName);
    if (existing && existing.isAlive() && existing.specHash === newHash) {
      return existing;
    }
    if (existing) {
      clients.delete(serverName);
      await existing.close().catch(() => {});
    }
    const created = createClient(serverName, resolved.spec);
    clients.set(serverName, created);
    return created;
  }

  async function handleRequest(req) {
    resetIdleTimer();
    const action = req?.action;
    if (action === 'ping') {
      return { ok: true, pid: process.pid };
    }
    if (action === 'status') {
      const active = {};
      for (const [name, client] of clients.entries()) {
        active[name] = { alive: client.isAlive(), type: client.constructor.name };
      }
      return { ok: true, pid: process.pid, activeServers: active };
    }
    if (action === 'stop') {
      setTimeout(() => cleanupAndExit(0), 20);
      return { ok: true, stopping: true };
    }
    if (action === 'call' || action === 'sync') {
      const serverName = String(req.serverName || '');
      const toolName = String(req.toolName || '');
      const args = req.arguments && typeof req.arguments === 'object' && !Array.isArray(req.arguments) ? req.arguments : {};
      if (!serverName || !toolName) {
        return { ok: false, error: 'serverName and toolName are required' };
      }
      if (action === 'sync' && req.onlyIfActive) {
        const current = clients.get(serverName);
        if (!current || !current.isAlive()) {
          return { ok: true, skipped: true };
        }
      }
      const client = await getOrCreateClient(serverName, req.workspacePaths);
      const result = await client.callTool(toolName, args, req.timeoutMs || DEFAULT_CALL_TIMEOUT_MS);
      return { ok: true, result };
    }
    return { ok: false, error: `Unknown action: ${String(action)}` };
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch (err) {
          socket.write(`${JSON.stringify({ ok: false, error: `Invalid request JSON: ${err.message}` })}\n`);
          continue;
        }
        handleRequest(req)
          .then((res) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
          })
          .catch((err) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
          });
      }
    });
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE' && (await isExistingDaemonAlive())) {
      process.exit(0);
    }
    process.exit(1);
  });

  server.listen(sockPath, () => {
    writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
    resetIdleTimer();
  });

  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('SIGINT', () => cleanupAndExit(0));
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--status') {
    try {
      const res = await sendDaemonRequest({ action: 'status' }, 1500);
      console.log(JSON.stringify(res, null, 2));
    } catch {
      console.log(JSON.stringify({ ok: true, running: false }, null, 2));
    }
    return;
  }
  if (arg === '--stop') {
    try {
      const res = await sendDaemonRequest({ action: 'stop' }, 1500);
      console.log(JSON.stringify(res, null, 2));
    } catch {
      console.log(JSON.stringify({ ok: true, running: false }, null, 2));
    }
    return;
  }
  await runDaemon();
}

main().catch(() => process.exit(1));
