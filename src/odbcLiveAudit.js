/**
 * Optional ODBC health/audit persistence for ADMIN Go Live.
 *
 * This is never on the FFmpeg, Chromium, RTMP, or comment-command path.
 * The intended ODBC GitHub driver/repository is not present in this checkout
 * or the operator's related sources, so the adapter stays degraded unless
 * `ODBC_CONNECTION_STRING` is set *and* a real `odbc` package can be loaded.
 * A persistence failure never throws into the live session.
 *
 * @module odbcLiveAudit
 */

/** Statuses that may be written as lifecycle events. Never includes secrets. */
export const ODBC_AUDIT_STATUSES = Object.freeze([
  'idle',
  'starting',
  'encoding',
  'ingesting',
  'waiting-for-youtube',
  'live',
  'stopping',
  'stopped',
  'error',
]);

/**
 * Redact a live-session snapshot down to audit-safe metadata.
 *
 * @param {object} [input]
 * @returns {object}
 */
export function redactLiveAuditRecord(input = {}) {
  const live = input.live && typeof input.live === 'object' ? input.live : input;
  const broadcast = live.broadcast && typeof live.broadcast === 'object' ? live.broadcast : {};
  const status = ODBC_AUDIT_STATUSES.includes(String(live.status || ''))
    ? String(live.status)
    : 'idle';
  return {
    at: String(input.at || new Date().toISOString()),
    event: String(input.event || status).slice(0, 40),
    status,
    broadcastId: String(broadcast.id || input.broadcastId || '').slice(0, 80),
    watchUrl: String(broadcast.watchUrl || input.watchUrl || '').slice(0, 240),
    framesSent: Number.isFinite(Number(live.framesSent)) ? Number(live.framesSent) : 0,
    target: String(live.target || '').slice(0, 120),
    youtubeReady: Boolean(live.phases?.youtube?.ready),
    error: live.error ? String(live.error).slice(0, 160) : '',
  };
}

/**
 * Whether a value looks like a secret that must never be persisted.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function auditRecordLooksSecret(value) {
  const text = JSON.stringify(value || {});
  if (!text) return false;
  return /streamKey|refresh_token|"1\/\/|ya29\.|rtmps?:\/\/[^\s]+\/live2\/[A-Za-z0-9_-]{8,}/i.test(text);
}

/**
 * Operator-facing ODBC readiness row.
 *
 * @param {object} [input]
 * @returns {{ready: boolean, available: boolean, message: string}}
 */
export function describeOdbcPersistence({
  env = process.env,
  driverAvailable = false,
} = {}) {
  const dsn = String(env?.ODBC_CONNECTION_STRING || env?.ODBC_DSN || '').trim();
  if (!dsn) {
    return {
      ready: false,
      available: false,
      message: 'ODBC audit is optional and not configured. Go Live continues without it.',
    };
  }
  if (!driverAvailable) {
    return {
      ready: false,
      available: false,
      message: 'ODBC connection string is set, but no ODBC driver package is installed. Go Live continues without audit writes.',
    };
  }
  return {
    ready: true,
    available: true,
    message: 'ODBC audit persistence is available.',
  };
}

/**
 * Best-effort dynamic import of the `odbc` package. Missing module is normal.
 *
 * @returns {Promise<object|null>}
 */
export async function loadOdbcDriver() {
  try {
    const loaded = await import('odbc');
    return loaded?.default || loaded || null;
  } catch {
    return null;
  }
}

/**
 * Write one redacted lifecycle event. Never throws; never blocks the encoder.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>}
 */
export async function recordLiveAuditEvent(input, {
  env = process.env,
  timeoutMs = 1500,
  connect = null,
} = {}) {
  const record = redactLiveAuditRecord(input);
  if (auditRecordLooksSecret(record)) {
    return { ok: false, skipped: true, error: 'Refusing to persist a record that looks like a secret.' };
  }
  const phase = describeOdbcPersistence({ env, driverAvailable: Boolean(connect) });
  if (!phase.available && typeof connect !== 'function') {
    return { ok: false, skipped: true, error: phase.message };
  }
  const writer = typeof connect === 'function' ? connect : null;
  if (!writer) return { ok: false, skipped: true, error: phase.message };

  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve(writer(record)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ODBC audit write timed out')), timeoutMs);
      }),
    ]);
    return result && result.ok === false ? result : { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || 'ODBC audit write failed').slice(0, 160) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
