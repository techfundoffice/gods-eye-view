/**
 * Supervised JSON-lines stdio bridge for the GEV YouTube Hermes harness.
 *
 * @module hermesStdioBridge
 */

import { PassThrough } from 'node:stream';
import { spawn as defaultSpawn } from 'node:child_process';

export const HERMES_BRIDGE_VERSION = 1;
export const HERMES_MAX_FRAME_BYTES = 64_000;
export const HERMES_TURN_TIMEOUT_MS = 90_000;

const SECRET = /bb_live_[A-Za-z0-9]+|sk-or-[A-Za-z0-9_-]+|gev_[A-Za-z0-9_-]+|Bearer\s+\S+/gi;

export function redactSecrets(value) {
  return String(value ?? '').replace(SECRET, '[redacted]');
}

export function parseHermesFrame(line) {
  const raw = String(line || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(raw) > HERMES_MAX_FRAME_BYTES) return { ok: false, reason: 'frame-too-large' };
  let payload;
  try { payload = JSON.parse(raw); }
  catch { return { ok: false, reason: 'malformed-json' }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'malformed-json' };
  }
  const type = String(payload.type || '');
  if (!type) return { ok: false, reason: 'missing-type' };
  return { ok: true, frame: payload };
}

export function encodeHermesFrame(frame) {
  const line = JSON.stringify({ v: HERMES_BRIDGE_VERSION, ...frame });
  if (Buffer.byteLength(line) > HERMES_MAX_FRAME_BYTES) {
    throw new Error('Hermes frame exceeds size limit');
  }
  return `${line}\n`;
}

/**
 * In-process child that speaks JSONL — used when the Hermes CLI is absent
 * or in tests. `handler` receives a parsed inbound frame and may return an
 * outbound frame (or a Promise of one).
 *
 * @param {(frame: object) => (object|Promise<object|null|undefined>)} handler
 */
export function createInProcessHermesChild(handler) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  let killed = false;
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    if (killed) return;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const parsed = parseHermesFrame(line);
      if (!parsed.ok) {
        stdout.write(encodeHermesFrame({
          type: 'error',
          reason: parsed.reason,
          message: 'Malformed Hermes frame',
        }));
        continue;
      }
      Promise.resolve(handler(parsed.frame)).then((out) => {
        if (killed || !out) return;
        stdout.write(encodeHermesFrame(out));
      }).catch((error) => {
        if (killed) return;
        stdout.write(encodeHermesFrame({
          type: 'error',
          turnId: parsed.frame?.turnId,
          message: redactSecrets(error?.message || 'Hermes handler failed'),
        }));
      });
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    pid: 1,
    killed: false,
    kill() {
      killed = true;
      this.killed = true;
      stdin.end();
      stdout.end();
      stderr.end();
    },
  };
}

/**
 * @param {object} [options]
 */
export function createHermesStdioBridge({
  spawnImpl = defaultSpawn,
  command = '',
  args = [],
  env = {},
  handler = null,
  now = Date.now,
  timeoutMs = HERMES_TURN_TIMEOUT_MS,
  onLog = () => {},
} = {}) {
  let child = null;
  let startedAt = 0;
  let lastError = '';
  let buffer = '';
  const pending = new Map();

  function log(message) {
    try { onLog(redactSecrets(message)); } catch { /* ignore */ }
  }

  function failPending(reason) {
    const error = new Error(reason);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function onStdout(chunk) {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const parsed = parseHermesFrame(line);
      if (!parsed.ok) {
        lastError = parsed.reason;
        log(`bad frame: ${parsed.reason}`);
        continue;
      }
      const frame = parsed.frame;
      const turnId = String(frame.turnId || '');
      const waiter = pending.get(turnId);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(turnId);
      waiter.resolve(frame);
    }
  }

  function start() {
    if (child && !child.killed) return status();
    buffer = '';
    if (typeof handler === 'function') {
      child = createInProcessHermesChild(handler);
    } else if (command) {
      child = spawnImpl(command, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      lastError = 'Hermes command is not configured';
      throw new Error(lastError);
    }
    startedAt = now();
    lastError = '';
    child.stdout.setEncoding?.('utf8');
    child.stdout.on?.('data', onStdout);
    child.stderr.setEncoding?.('utf8');
    child.stderr.on?.('data', (chunk) => log(String(chunk)));
    child.on?.('exit', (code) => {
      lastError = lastError || `Hermes exited (${code ?? 'unknown'})`;
      failPending(lastError);
      child = null;
    });
    return status();
  }

  function stop(reason = 'stopped') {
    failPending(reason);
    child?.kill?.();
    child = null;
    startedAt = 0;
    return status();
  }

  function write(frame) {
    if (!child || child.killed) throw new Error('Hermes bridge is not running');
    child.stdin.write(encodeHermesFrame(frame));
  }

  function request(frame) {
    const turnId = String(frame.turnId || '');
    if (!turnId) return Promise.reject(new Error('turnId is required'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(turnId);
        reject(new Error('Hermes turn timed out'));
      }, timeoutMs);
      pending.set(turnId, { resolve, reject, timer });
      try {
        write(frame);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(turnId);
        reject(error);
      }
    });
  }

  function status() {
    return {
      running: Boolean(child && !child.killed),
      pid: child?.pid || 0,
      startedAt,
      lastError: redactSecrets(lastError),
      pendingTurns: pending.size,
    };
  }

  return { start, stop, write, request, status, redactSecrets };
}
