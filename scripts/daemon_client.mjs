/**
 * Shared Unix-domain-socket IPC client, lease manager, and daemon launcher for
 * antigravity-mcp-structured-content.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonLineReader } from './json_line_reader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAEMON_SCRIPT_PATH = join(__dirname, 'mcp_pool_daemon.mjs');
export const DEFAULT_IPC_TIMEOUT_MS =
  (Number(process.env.AGY_MCP_SC_CALL_TIMEOUT_MS) || 10 * 60 * 1000) + 10000;

/**
 * Keep socket under /tmp with 0700 dir permissions to stay well below
 * macOS's 104-byte sun_path limit for Unix domain sockets.
 */
export function getRuntimeDir() {
  if (process.env.AGY_MCP_SC_RUNTIME_DIR) {
    return process.env.AGY_MCP_SC_RUNTIME_DIR;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return `/tmp/agy-mcp-sc-${uid}`;
}

export function getSocketPath() {
  return join(getRuntimeDir(), 'pool.sock');
}

export function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

/**
 * Send one newline-delimited JSON request to the pool daemon and wait for one JSON reply.
 * Uses JsonLineReader so multi-megabyte screenshots and multi-byte UTF-8 payloads
 * frame in O(N) without boundary corruption.
 */
export function sendDaemonRequest(request, timeoutMs = DEFAULT_IPC_TIMEOUT_MS) {
  const sockPath = getSocketPath();
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(sockPath);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Daemon request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      fn(val);
    };

    const reader = new JsonLineReader((line) => {
      if (settled) return;
      try {
        finish(resolve, JSON.parse(line));
      } catch (err) {
        finish(reject, new Error(`Invalid daemon JSON reply: ${err.message}`));
      }
    });

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      reader.push(chunk);
    });

    socket.on('error', (err) => {
      finish(reject, err);
    });

    socket.on('close', () => {
      if (!settled) {
        finish(reject, new Error('Daemon closed connection before sending a response'));
      }
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let inFlightEnsure = null;

/**
 * Ping an existing pool daemon, or spawn a detached background daemon and wait until ready.
 * Coalesces concurrent callers within the same process so parallel tool calls never race.
 */
export async function ensureDaemonRunning() {
  if (inFlightEnsure) {
    return inFlightEnsure;
  }
  inFlightEnsure = (async () => {
    ensurePrivateDir(getRuntimeDir());
    try {
      const res = await sendDaemonRequest({ action: 'ping' }, 1000);
      if (res?.ok) return true;
    } catch {
      // Not running yet; spawn detached background daemon below.
    }

    const child = spawn(process.execPath, [DAEMON_SCRIPT_PATH], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();

    for (let i = 0; i < 40; i++) {
      await delay(40);
      try {
        const res = await sendDaemonRequest({ action: 'ping' }, 600);
        if (res?.ok) return true;
      } catch {
        // Wait for socket bind.
      }
    }
    return false;
  })().finally(() => {
    inFlightEnsure = null;
  });

  return inFlightEnsure;
}

/**
 * Maintain a persistent zero-CPU Unix socket lease from long-lived bridge_mcp.mjs
 * to mcp_pool_daemon.mjs. While at least one lease is open, the daemon never idle-kills
 * stateful MCP servers during user pauses; when Antigravity exits and closes bridge_mcp,
 * the kernel closes the lease socket immediately so the daemon can clean up cleanly.
 */
export function attachDaemonLease(meta = {}) {
  let activeSocket = null;
  let closed = false;

  const ensureAttached = () => {
    if (closed || (activeSocket && !activeSocket.destroyed && activeSocket.writable)) return;
    if (activeSocket) {
      try {
        activeSocket.destroy();
      } catch {
        // ignore
      }
      activeSocket = null;
    }
    const sock = net.createConnection(getSocketPath());
    sock.unref();
    // Drain the daemon's lease-ack reply so peer EOF immediately fires 'end'/'close'
    // instead of stalling behind unread bytes in Node's paused stream mode.
    sock.resume();
    activeSocket = sock;

    sock.on('connect', () => {
      if (closed) {
        sock.destroy();
        return;
      }
      sock.write(
        `${JSON.stringify({
          action: 'lease',
          pid: process.pid,
          ppid: process.ppid,
          ...meta,
        })}\n`,
      );
    });

    sock.on('end', () => {
      if (activeSocket === sock) activeSocket = null;
      sock.destroy();
    });

    sock.on('error', () => {
      if (activeSocket === sock) activeSocket = null;
      sock.destroy();
    });

    sock.on('close', () => {
      if (activeSocket === sock) activeSocket = null;
    });
  };

  ensureAttached();

  return {
    ensureAttached,
    close() {
      closed = true;
      if (activeSocket) {
        try {
          activeSocket.destroy();
        } catch {
          // ignore
        }
        activeSocket = null;
      }
    },
  };
}
