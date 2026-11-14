/**
 * Shared Unix-domain-socket IPC client and daemon launcher for
 * antigravity-mcp-structured-content.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAEMON_SCRIPT_PATH = join(__dirname, 'mcp_pool_daemon.mjs');

/**
 * Keep socket under /tmp with 0700 dir permissions to stay well below
 * macOS's 104-byte sun_path limit for Unix domain sockets.
 */
export function getRuntimeDir() {
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
 */
export function sendDaemonRequest(request, timeoutMs = 40000) {
  const sockPath = getSocketPath();
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
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

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      try {
        finish(resolve, JSON.parse(line));
      } catch (err) {
        finish(reject, new Error(`Invalid daemon JSON reply: ${err.message}`));
      }
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

/**
 * Ping an existing pool daemon, or spawn a detached background daemon and wait until ready.
 */
export async function ensureDaemonRunning() {
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

  for (let i = 0; i < 30; i++) {
    await delay(40);
    try {
      const res = await sendDaemonRequest({ action: 'ping' }, 500);
      if (res?.ok) return true;
    } catch {
      // Wait for socket bind.
    }
  }
  return false;
}
