/**
 * Persistent background MCP client pool daemon for antigravity-mcp-structured-content.
 *
 * Maintains unified single-connection stdio or Streamable HTTP transports to configured
 * MCP servers (scoped per resolved config source so distinct workspace overrides coexist)
 * so stateful context (named/implicit sessions, screenshot coordinate frames, snapshot tokens,
 * `since="latest"` baselines, cursor settings, and isolated browsers) never splits.
 *
 * Lifecycle:
 * - Never disconnects while any `bridge_mcp.mjs` lease socket is attached or a tool call
 *   is in flight (even if the user pauses a conversation for hours).
 * - Automatically shuts down MCP child servers cleanly after LEASE_RELEASE_GRACE_MS once
 *   all bridge leases close (e.g. when Antigravity exits or the plugin is disabled).
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ensurePrivateDir, getRuntimeDir, getSocketPath, sendDaemonRequest } from './daemon_client.mjs';
import { JsonLineReader } from './json_line_reader.mjs';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  compactStructuredContent,
  loadRegistryAndAdapter,
  resolveCallTimeoutMs,
} from './registry_config.mjs';

const FALLBACK_IDLE_TIMEOUT_MS =
  Number(process.env.AGY_MCP_SC_IDLE_TIMEOUT_MS) || 12 * 60 * 60 * 1000;
const LEASE_RELEASE_GRACE_MS =
  Number(process.env.AGY_MCP_SC_LEASE_GRACE_MS) || 30 * 1000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const STDERR_TAIL_LIMIT = 4096;

function buildAugmentedEnv(extraEnv) {
  const merged = {
    ...process.env,
    ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
  };
  const basePath = typeof merged.PATH === 'string' ? merged.PATH : '';
  const segments = basePath.split(delimiter).filter(Boolean);
  for (const extraDir of [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!segments.includes(extraDir)) {
      segments.push(extraDir);
    }
  }
  merged.PATH = segments.join(delimiter);
  return merged;
}

/**
 * Persistent stdio JSON-RPC 2.0 MCP client using O(N) JsonLineReader framing so
 * multi-MB screenshots and multi-byte UTF-8 chunks stream cleanly without O(N^2) copies.
 */
class StdioMcpClient {
  constructor(serverName, spec, specHash, configSource, scopeKey) {
    this.serverName = serverName;
    this.spec = spec;
    this.specHash = specHash;
    this.configSource = configSource;
    this.scopeKey = scopeKey || configSource;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = '';
    this.closed = false;
    this.initPromise = null;
    this.lineReader = new JsonLineReader((line) => this.#onStdoutLine(line));

    const env = buildAugmentedEnv(spec.env);
    const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const cwd = typeof spec.cwd === 'string' && spec.cwd ? spec.cwd : undefined;

    this.proc = spawn(spec.command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => this.lineReader.push(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });
    this.proc.on('exit', (code, signal) => {
      this.#failAll(
        new Error(
          `MCP server '${this.serverName}' exited (code=${code}, signal=${signal})${
            this.stderrTail ? `: ${this.stderrTail.trim()}` : ''
          }`,
        ),
      );
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
    this.lineReader.reset();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  #onStdoutLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (Object.hasOwn(msg, 'id') && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          new Error(
            `JSON-RPC ${msg.error.code ?? ''}: ${msg.error.message || JSON.stringify(msg.error)}`,
          ),
        );
      } else {
        entry.resolve(msg.result);
      }
    } else if (Object.hasOwn(msg, 'id') && msg.method) {
      // Answer server-initiated requests (e.g. ping) so servers never block.
      try {
        this.#writeMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
      } catch {
        // ignore
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
    this.#writeMessage(
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params },
    );
  }

  async ensureInitialized() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'antigravity-mcp-structured-content', version: '1.1.0' },
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
  constructor(serverName, spec, specHash, configSource, scopeKey) {
    this.serverName = serverName;
    this.spec = spec;
    this.specHash = specHash;
    this.configSource = configSource;
    this.scopeKey = scopeKey || configSource;
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
      throw new Error(
        `JSON-RPC ${msg.error.code ?? ''}: ${msg.error.message || JSON.stringify(msg.error)}`,
      );
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
            clientInfo: { name: 'antigravity-mcp-structured-content', version: '1.1.0' },
          },
          15000,
        );
        await this.#postRpc(
          { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
          5000,
        ).catch(() => {});
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
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function expandConfigString(str, primaryWorkspace) {
  if (typeof str !== 'string') return str;
  const home = homedir();
  let out = str;
  if (out === '~') {
    out = home;
  } else if (out.startsWith('~/')) {
    out = join(home, out.slice(2));
  }
  out = out
    .replace(/\$\{userHome\}|\$\{HOME\}/g, home)
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
  if (primaryWorkspace) {
    out = out.replace(/\$\{workspaceFolder\}/g, primaryWorkspace);
  }
  return out;
}

function expandSpecMap(obj, primaryWorkspace) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? expandConfigString(v, primaryWorkspace) : v;
  }
  return out;
}

function normalizeServerSpec(rawSpec, primaryWorkspace) {
  const rawJson = JSON.stringify(rawSpec);
  const usesWorkspaceVar = rawJson.includes('${workspaceFolder}');
  const spec = { ...rawSpec };
  if (typeof spec.command === 'string') {
    spec.command = expandConfigString(spec.command, primaryWorkspace);
  }
  if (Array.isArray(spec.args)) {
    spec.args = spec.args.map((a) =>
      typeof a === 'string' ? expandConfigString(a, primaryWorkspace) : String(a),
    );
  }
  if (typeof spec.cwd === 'string') {
    spec.cwd = expandConfigString(spec.cwd, primaryWorkspace);
  }
  if (typeof spec.url === 'string') {
    spec.url = expandConfigString(spec.url, primaryWorkspace);
  }
  if (typeof spec.serverUrl === 'string') {
    spec.serverUrl = expandConfigString(spec.serverUrl, primaryWorkspace);
  }
  if (spec.env && typeof spec.env === 'object') {
    spec.env = expandSpecMap(spec.env, primaryWorkspace);
  }
  if (spec.headers && typeof spec.headers === 'object') {
    spec.headers = expandSpecMap(spec.headers, primaryWorkspace);
  }
  return { spec, usesWorkspaceVar };
}

/**
 * Resolve MCP server transport spec following Antigravity's loading priority:
 * workspace configs (`.mcp.json` / `.agents/mcp_config.json` / `.gemini/mcp_config.json`)
 * -> global `~/.gemini/config/mcp_config.json` -> legacy fallback `~/.gemini/antigravity/mcp_config.json`
 * (or `AGY_MCP_SC_MCP_CONFIG` in place of global configs when set for isolated tests).
 */
function resolveMcpServerSpec(serverName, workspacePaths = []) {
  const wsList = Array.isArray(workspacePaths)
    ? workspacePaths.filter((w) => typeof w === 'string' && w)
    : [];
  const primaryWorkspace = wsList[0] || '';

  const candidates = [];
  for (const ws of wsList) {
    candidates.push({ cfgPath: join(ws, '.mcp.json'), workspace: ws });
    candidates.push({ cfgPath: join(ws, '.agents', 'mcp_config.json'), workspace: ws });
    candidates.push({ cfgPath: join(ws, '.gemini', 'mcp_config.json'), workspace: ws });
  }
  if (process.env.AGY_MCP_SC_MCP_CONFIG) {
    candidates.push({ cfgPath: process.env.AGY_MCP_SC_MCP_CONFIG, workspace: primaryWorkspace });
  } else {
    candidates.push({
      cfgPath: join(homedir(), '.gemini', 'config', 'mcp_config.json'),
      workspace: primaryWorkspace,
    });
    candidates.push({
      cfgPath: join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
      workspace: primaryWorkspace,
    });
  }

  for (const { cfgPath, workspace } of candidates) {
    const doc = readJsonSafe(cfgPath);
    const rawSpec = doc?.mcpServers?.[serverName];
    if (rawSpec && typeof rawSpec === 'object') {
      const { spec, usesWorkspaceVar } = normalizeServerSpec(rawSpec, workspace);
      const scopeKey = usesWorkspaceVar && workspace ? `${cfgPath}::${workspace}` : cfgPath;
      return { spec, source: cfgPath, scopeKey };
    }
  }
  return null;
}

function createClient(serverName, spec, specHash, configSource, scopeKey) {
  if (typeof spec.command === 'string' && spec.command) {
    return new StdioMcpClient(serverName, spec, specHash, configSource, scopeKey);
  }
  if (typeof (spec.url || spec.serverUrl) === 'string') {
    return new HttpMcpClient(serverName, spec, specHash, configSource, scopeKey);
  }
  throw new Error(`Unsupported MCP transport config for server '${serverName}'`);
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Acquire startup lock atomically via POSIX hard-link (`linkSync`) from a pre-populated
 * temp file so `lockPath` never exists as a 0-byte file even for a microsecond.
 */
function acquireStartupLock(lockPath) {
  const tmpLock = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmpLock, `${process.pid}\n`, { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmpLock, lockPath);
        return true;
      } catch (err) {
        if (err?.code !== 'EEXIST') return false;
        try {
          const holderPid = Number(readFileSync(lockPath, 'utf8').trim());
          if (holderPid && isProcessAlive(holderPid)) {
            return false;
          }
          unlinkSync(lockPath);
        } catch {
          return false;
        }
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      if (existsSync(tmpLock)) unlinkSync(tmpLock);
    } catch {
      // ignore
    }
  }
}

function releaseStartupLock(lockPath) {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

async function isExistingDaemonAlive() {
  try {
    const res = await sendDaemonRequest({ action: 'ping' }, 400);
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function runDaemon() {
  const runtimeDir = getRuntimeDir();
  ensurePrivateDir(runtimeDir);
  const sockPath = getSocketPath();
  const pidPath = join(runtimeDir, 'daemon.pid');
  const lockPath = join(runtimeDir, 'daemon.lock');

  if (await isExistingDaemonAlive()) {
    return;
  }

  if (!acquireStartupLock(lockPath)) {
    return;
  }

  if (existsSync(sockPath)) {
    if (await isExistingDaemonAlive()) {
      releaseStartupLock(lockPath);
      return;
    }
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  }

  const clients = new Map();
  const pendingClients = new Map();
  const activeLeases = new Map();
  let hadAnyLease = false;
  let inFlightCalls = 0;
  let idleTimer = null;
  let shuttingDown = false;
  let ownsSocket = false;
  let boundSocketIno = null;

  const detachOwnedSocketFilesSync = () => {
    if (!ownsSocket) return;
    ownsSocket = false;
    try {
      if (existsSync(sockPath)) {
        const curIno = statSync(sockPath).ino;
        if (boundSocketIno === null || curIno === boundSocketIno) {
          unlinkSync(sockPath);
        }
      }
    } catch {
      // ignore
    }
    try {
      if (existsSync(pidPath)) {
        const recordedPid = Number(readFileSync(pidPath, 'utf8').trim());
        if (recordedPid === process.pid) {
          unlinkSync(pidPath);
        }
      }
    } catch {
      // ignore
    }
  };

  const cleanupAndExit = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(idleTimer);
    releaseStartupLock(lockPath);

    // Unlink our own socket & pid files SYNCHRONOUSLY right as the listener closes,
    // BEFORE awaiting upstream child shutdown, so a new daemon spawned during our
    // child-drain window never has its newly bound pool.sock or daemon.pid deleted.
    try {
      server.close();
    } catch {
      // ignore
    }
    detachOwnedSocketFilesSync();

    for (const sock of activeLeases.keys()) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    activeLeases.clear();

    await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    clients.clear();
    process.exit(code);
  };

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (shuttingDown || activeLeases.size > 0 || inFlightCalls > 0) {
      return;
    }
    const timeoutMs = hadAnyLease ? LEASE_RELEASE_GRACE_MS : FALLBACK_IDLE_TIMEOUT_MS;
    idleTimer = setTimeout(() => {
      if (activeLeases.size === 0 && inFlightCalls === 0) {
        void cleanupAndExit(0);
      }
    }, timeoutMs);
  };

  async function getOrCreateClient(serverName, workspacePaths) {
    const resolved = resolveMcpServerSpec(serverName, workspacePaths);
    if (!resolved) {
      throw new Error(`MCP server '${serverName}' not found in mcp_config.json`);
    }
    if (resolved.spec.disabled === true) {
      throw new Error(`MCP server '${serverName}' is disabled`);
    }
    const poolKey = `${serverName}::${resolved.scopeKey}`;
    const newHash = JSON.stringify(resolved.spec);
    const existing = clients.get(poolKey);
    if (existing && existing.isAlive() && existing.specHash === newHash) {
      return existing;
    }

    const inflight = pendingClients.get(poolKey);
    if (inflight) {
      return inflight;
    }

    const creation = (async () => {
      const cur = clients.get(poolKey);
      if (cur && cur.isAlive() && cur.specHash === newHash) {
        return cur;
      }
      if (cur) {
        clients.delete(poolKey);
        await cur.close().catch(() => {});
      }
      const created = createClient(
        serverName,
        resolved.spec,
        newHash,
        resolved.source,
        resolved.scopeKey,
      );
      clients.set(poolKey, created);
      return created;
    })().finally(() => {
      pendingClients.delete(poolKey);
    });

    pendingClients.set(poolKey, creation);
    return creation;
  }

  async function handleRequest(req, socket) {
    const action = req?.action;
    if (action === 'lease') {
      hadAnyLease = true;
      activeLeases.set(socket, {
        pid: req?.pid ?? null,
        ppid: req?.ppid ?? null,
        attachedAt: Date.now(),
      });
      resetIdleTimer();
      return { ok: true, leased: true, pid: process.pid };
    }

    resetIdleTimer();

    if (action === 'ping') {
      return { ok: true, pid: process.pid };
    }
    if (action === 'status') {
      const active = {};
      const countsByName = new Map();
      for (const client of clients.values()) {
        countsByName.set(client.serverName, (countsByName.get(client.serverName) || 0) + 1);
      }
      for (const client of clients.values()) {
        const key =
          (countsByName.get(client.serverName) || 0) > 1
            ? `${client.serverName} (${client.scopeKey})`
            : client.serverName;
        active[key] = {
          alive: client.isAlive(),
          type: client.constructor.name,
          source: client.configSource,
          ...(client.scopeKey !== client.configSource ? { scope: client.scopeKey } : {}),
        };
      }
      return {
        ok: true,
        pid: process.pid,
        activeLeases: activeLeases.size,
        inFlightCalls,
        activeServers: active,
      };
    }
    if (action === 'stop') {
      setTimeout(() => void cleanupAndExit(0), 20);
      return { ok: true, stopping: true };
    }
    if (action === 'call') {
      const serverName = String(req.serverName || '');
      const toolName = String(req.toolName || '');
      const args =
        req.arguments && typeof req.arguments === 'object' && !Array.isArray(req.arguments)
          ? req.arguments
          : {};
      if (!serverName || !toolName) {
        return { ok: false, error: 'serverName and toolName are required' };
      }

      const { adapter } = loadRegistryAndAdapter(serverName);
      const timeoutMs = resolveCallTimeoutMs(adapter, args, req.timeoutMs);

      inFlightCalls += 1;
      resetIdleTimer();
      try {
        const client = await getOrCreateClient(serverName, req.workspacePaths);
        const rawResult = await client.callTool(toolName, args, timeoutMs);
        if (req.rawStructuredContent === true || !rawResult) {
          return { ok: true, result: rawResult };
        }

        const content = Array.isArray(rawResult.content) ? rawResult.content : [];
        const compactedSc = compactStructuredContent(
          rawResult.structuredContent,
          content,
          adapter,
          toolName,
        );

        const formattedResult = {
          content,
          ...(compactedSc !== undefined ? { structuredContent: compactedSc } : {}),
          ...(rawResult.isError !== undefined ? { isError: Boolean(rawResult.isError) } : {}),
        };
        return { ok: true, result: formattedResult };
      } finally {
        inFlightCalls = Math.max(0, inFlightCalls - 1);
        resetIdleTimer();
      }
    }
    return { ok: false, error: `Unknown action: ${String(action)}` };
  }

  const server = net.createServer((socket) => {
    const reader = new JsonLineReader((line) => {
      let req;
      try {
        req = JSON.parse(line);
      } catch (err) {
        if (!socket.destroyed) {
          socket.write(
            `${JSON.stringify({ ok: false, error: `Invalid request JSON: ${err.message}` })}\n`,
          );
        }
        return;
      }
      handleRequest(req, socket)
        .then((res) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
        })
        .catch((err) => {
          if (!socket.destroyed) {
            socket.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
          }
        });
    });

    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('close', () => {
      reader.reset();
      if (activeLeases.delete(socket)) {
        resetIdleTimer();
      }
    });
    socket.on('error', () => {
      reader.reset();
    });
  });

  server.on('error', async (err) => {
    releaseStartupLock(lockPath);
    if (err.code === 'EADDRINUSE' && (await isExistingDaemonAlive())) {
      process.exit(0);
    }
    process.exit(1);
  });

  server.listen(sockPath, () => {
    ownsSocket = true;
    try {
      boundSocketIno = statSync(sockPath).ino;
    } catch {
      boundSocketIno = null;
    }
    writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
    releaseStartupLock(lockPath);
    resetIdleTimer();
  });

  process.on('SIGTERM', () => void cleanupAndExit(0));
  process.on('SIGINT', () => void cleanupAndExit(0));
  process.on('SIGHUP', () => void cleanupAndExit(0));
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
