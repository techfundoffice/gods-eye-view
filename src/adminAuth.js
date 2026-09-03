/**
 * Password login, session handling, and MCP API keys for the ADMIN console.
 *
 * The console can drive an agent that edits this repository, so its front door
 * is deliberately narrow:
 *
 *   - There is no default password. With neither `ADMIN_PASSWORD_HASH` nor
 *     `ADMIN_PASSWORD` set, the whole admin surface reports itself
 *     unconfigured and every route refuses — an unconfigured deployment is
 *     never an open one.
 *   - Passwords are compared against a scrypt hash with a per-install salt,
 *     using a constant-time comparison.
 *   - Failed logins back off exponentially per client, so a reachable console
 *     cannot be brute-forced at network speed.
 *   - Browser sessions are opaque ids in an HttpOnly, SameSite=Strict cookie;
 *     the token itself never reaches page JavaScript.
 *   - MCP API keys are shown exactly once at creation and stored only as
 *     SHA-256 hashes, so a leaked state file yields no usable key.
 *
 * @module adminAuth
 */

import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/** Opaque browser session cookie name. */
export const ADMIN_SESSION_COOKIE = 'gev_admin_session';
/** Human-recognizable prefix so a leaked key is identifiable in logs. */
export const ADMIN_API_KEY_PREFIX = 'gev_admin_';
/** Sessions expire eight hours after login. */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** scrypt work factor. Cost is paid once per login attempt, not per request. */
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_BYTES = 32;
/** Backoff ceiling: five minutes between attempts once an attacker is stuck. */
export const ADMIN_LOGIN_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Attempts allowed at full speed before backoff engages. */
export const ADMIN_LOGIN_FREE_ATTEMPTS = 3;

/**
 * Encode a password as `scrypt$N$r$p$salt$hash`, all binary parts base64url.
 *
 * @param {string} password Plaintext password.
 * @param {object} [options]
 * @param {Buffer} [options.salt] Explicit salt (tests supply a fixed one).
 * @returns {string} Storable hash string.
 */
export function hashAdminPassword(password, { salt = nodeRandomBytes(16) } = {}) {
  const text = String(password ?? '');
  if (!text) throw new TypeError('Admin password must not be empty');
  const derived = scryptSync(text, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  });
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    Buffer.from(salt).toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * @param {unknown} value
 * @returns {boolean} Whether the value looks like a `hashAdminPassword` output.
 */
export function isAdminPasswordHash(value) {
  return /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(String(value ?? ''));
}

/**
 * Constant-time password check. Any malformed stored value is a failed login,
 * never a thrown error that a caller might mistake for a server fault.
 *
 * @param {string} password Submitted plaintext.
 * @param {string} stored Value produced by {@link hashAdminPassword}.
 * @returns {boolean}
 */
export function verifyAdminPassword(password, stored) {
  if (!isAdminPasswordHash(stored)) return false;
  const [, cost, blockSize, parallelization, salt, digest] = String(stored).split('$');
  try {
    const expected = Buffer.from(digest, 'base64url');
    const actual = scryptSync(String(password ?? ''), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(cost),
      r: Number(blockSize),
      p: Number(parallelization),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Resolve the configured admin credential.
 *
 * `ADMIN_PASSWORD_HASH` is the deployment-grade form and wins. `ADMIN_PASSWORD`
 * is the convenience form for a local checkout and is hashed at startup so the
 * plaintext is never held beyond that call.
 *
 * @param {object} [env]
 * @returns {{hash: string, source: 'hash'|'password'}|null} Null when unconfigured.
 */
export function resolveAdminPasswordHash(env = process.env) {
  const configuredHash = String(env?.ADMIN_PASSWORD_HASH || '').trim();
  if (configuredHash) {
    if (isAdminPasswordHash(configuredHash)) {
      return { hash: configuredHash, source: 'hash' };
    }
    // A stale or dotenv-expanded hash must not mask a usable local password.
    // Keep the warning actionable, then continue to the password fallback.
    console.warn('[Admin] ADMIN_PASSWORD_HASH is not a scrypt$... value; falling back to ADMIN_PASSWORD.');
  }
  const plaintext = String(env?.ADMIN_PASSWORD || '').trim();
  if (!plaintext) return null;
  return { hash: hashAdminPassword(plaintext), source: 'password' };
}

/**
 * Delay before the next login attempt from a client is accepted.
 *
 * @param {number} failures Consecutive failures recorded for that client.
 * @returns {number} Milliseconds to wait; 0 while under the free-attempt count.
 */
export function loginBackoffMs(failures) {
  const count = Math.max(0, Math.floor(Number(failures) || 0));
  if (count <= ADMIN_LOGIN_FREE_ATTEMPTS) return 0;
  const steps = count - ADMIN_LOGIN_FREE_ATTEMPTS;
  return Math.min(ADMIN_LOGIN_MAX_BACKOFF_MS, 1000 * 2 ** (steps - 1));
}

/**
 * Trim an operator-supplied API-key label to something safe to render.
 *
 * @param {unknown} label
 * @returns {string}
 */
export function normalizeApiKeyLabel(label) {
  const text = String(label ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, 64) : 'MCP client';
}

/**
 * @param {(size: number) => Buffer} [randomBytes]
 * @returns {string} A fresh, prefixed API key.
 */
export function generateApiKey(randomBytes = nodeRandomBytes) {
  return `${ADMIN_API_KEY_PREFIX}${Buffer.from(randomBytes(32)).toString('base64url')}`;
}

/**
 * @param {string} token
 * @returns {string} SHA-256 hex digest — the only form kept at rest.
 */
export function hashApiKey(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

/**
 * The last four characters, shown in the key list so an operator can tell two
 * keys apart without either being recoverable.
 *
 * @param {string} token
 * @returns {string}
 */
export function apiKeyPreview(token) {
  const text = String(token ?? '');
  return text.length <= 4 ? text : `…${text.slice(-4)}`;
}

/**
 * Parse a `Cookie` header into a plain object.
 *
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return cookies;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

/**
 * Serialize the admin session cookie.
 *
 * SameSite=Strict (stricter than the YouTube session's Lax): no cross-site
 * navigation should ever arrive already authenticated at a console that can
 * write to the codebase.
 *
 * @param {string} value Session id, or '' to clear.
 * @param {number} maxAgeSeconds
 * @param {boolean} secure Whether to mark the cookie Secure.
 * @returns {string}
 */
export function serializeAdminCookie(value, maxAgeSeconds, secure) {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

/**
 * Extract the bearer token or `X-API-Key` value from a request's headers.
 *
 * @param {Record<string, string|string[]>} headers
 * @returns {string}
 */
export function extractApiKey(headers = {}) {
  const authorization = String(headers.authorization || headers.Authorization || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) return bearer[1].trim();
  const direct = headers['x-api-key'] ?? headers['X-API-Key'];
  return String(Array.isArray(direct) ? direct[0] : direct || '').trim();
}

/**
 * Admin authentication state machine.
 *
 * @param {object} [options]
 * @param {{hash: string, source: string}|null} [options.credential] Resolved credential.
 * @param {{read: () => object, update: (fn: (state: object) => object) => object}} [options.store] Durable state.
 * @param {() => number} [options.now] Clock injection.
 * @param {(size: number) => Buffer} [options.randomBytes] Entropy injection.
 * @param {number} [options.sessionTtlMs]
 * @returns {object} Auth facade used by the admin middleware.
 */
export function createAdminAuth({
  credential = resolveAdminPasswordHash(),
  store = null,
  now = () => Date.now(),
  randomBytes = nodeRandomBytes,
  sessionTtlMs = ADMIN_SESSION_TTL_MS,
} = {}) {
  /** @type {Map<string, {id: string, createdAt: number, expiresAt: number}>} */
  const sessions = new Map();
  /** @type {Map<string, {failures: number, nextAttemptAt: number}>} */
  const attempts = new Map();
  const memoryState = { apiKeys: [], mcpEnabled: false, hermesYoutubeAdmin: null };

  function readState() {
    if (store) return store.read();
    return memoryState;
  }

  function updateState(mutate) {
    if (store) return store.update((state) => mutate(state));
    const next = mutate(memoryState);
    memoryState.apiKeys = next.apiKeys;
    memoryState.mcpEnabled = next.mcpEnabled;
    memoryState.hermesYoutubeAdmin = next.hermesYoutubeAdmin;
    return memoryState;
  }

  function pruneSessions() {
    const time = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= time) sessions.delete(id);
    }
  }

  /**
   * @param {string} clientId Caller identity used only for rate limiting.
   * @returns {{blocked: boolean, retryAfterMs: number}}
   */
  function loginThrottle(clientId) {
    const record = attempts.get(clientId);
    if (!record) return { blocked: false, retryAfterMs: 0 };
    const remaining = record.nextAttemptAt - now();
    return remaining > 0
      ? { blocked: true, retryAfterMs: remaining }
      : { blocked: false, retryAfterMs: 0 };
  }

  /**
   * Verify a password and, on success, mint a session.
   *
   * @param {string} password
   * @param {object} [options]
   * @param {string} [options.clientId] Rate-limit bucket (remote address).
   * @returns {{ok: true, sessionId: string, expiresAt: number}|{ok: false, reason: string, retryAfterMs?: number}}
   */
  function login(password, { clientId = 'unknown' } = {}) {
    if (!credential) return { ok: false, reason: 'unconfigured' };
    const throttle = loginThrottle(clientId);
    if (throttle.blocked) return { ok: false, reason: 'throttled', retryAfterMs: throttle.retryAfterMs };

    if (!verifyAdminPassword(password, credential.hash)) {
      const record = attempts.get(clientId) || { failures: 0, nextAttemptAt: 0 };
      record.failures += 1;
      record.nextAttemptAt = now() + loginBackoffMs(record.failures);
      attempts.set(clientId, record);
      return { ok: false, reason: 'invalid', retryAfterMs: Math.max(0, record.nextAttemptAt - now()) };
    }

    attempts.delete(clientId);
    pruneSessions();
    const id = randomUUID();
    const session = { id, createdAt: now(), expiresAt: now() + sessionTtlMs };
    sessions.set(id, session);
    return { ok: true, sessionId: id, expiresAt: session.expiresAt };
  }

  /**
   * @param {string|undefined} sessionId
   * @returns {{id: string, createdAt: number, expiresAt: number}|null}
   */
  function authenticate(sessionId) {
    if (!sessionId) return null;
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  /**
   * @param {string|undefined} sessionId
   * @returns {boolean} Whether a session was actually removed.
   */
  function logout(sessionId) {
    return sessionId ? sessions.delete(sessionId) : false;
  }

  /**
   * Mint an MCP API key. The plaintext is returned once and never stored.
   *
   * @param {string} label
   * @returns {{token: string, record: object}}
   */
  function createApiKey(label) {
    const token = generateApiKey(randomBytes);
    const record = {
      id: randomUUID(),
      label: normalizeApiKeyLabel(label),
      hash: hashApiKey(token),
      preview: apiKeyPreview(token),
      createdAt: new Date(now()).toISOString(),
      lastUsedAt: null,
    };
    updateState((state) => ({ ...state, apiKeys: [...(state.apiKeys || []), record] }));
    return { token, record: publicApiKey(record) };
  }

  /** @returns {object[]} Key metadata with hashes stripped. */
  function listApiKeys() {
    return (readState().apiKeys || []).map(publicApiKey);
  }

  /**
   * @param {string} id
   * @returns {boolean} Whether a key was removed.
   */
  function revokeApiKey(id) {
    const before = (readState().apiKeys || []).length;
    updateState((state) => ({
      ...state,
      apiKeys: (state.apiKeys || []).filter((key) => key.id !== id),
    }));
    return (readState().apiKeys || []).length < before;
  }

  /**
   * Verify a presented API key and stamp its last-used time.
   *
   * @param {string} token
   * @returns {object|null} Public key metadata, or null when unknown.
   */
  function verifyApiKey(token) {
    const text = String(token ?? '').trim();
    if (!text.startsWith(ADMIN_API_KEY_PREFIX)) return null;
    const digest = hashApiKey(text);
    const match = (readState().apiKeys || []).find((key) => safeHashEqual(key.hash, digest));
    if (!match) return null;
    const usedAt = new Date(now()).toISOString();
    updateState((state) => ({
      ...state,
      apiKeys: (state.apiKeys || []).map((key) => (
        key.id === match.id ? { ...key, lastUsedAt: usedAt } : key
      )),
    }));
    return publicApiKey({ ...match, lastUsedAt: usedAt });
  }

  /** @returns {boolean} Whether the external MCP endpoint is switched on. */
  function mcpEnabled() {
    return Boolean(readState().mcpEnabled);
  }

  /**
   * @param {boolean} enabled
   * @returns {boolean} The stored value.
   */
  function setMcpEnabled(enabled) {
    updateState((state) => ({ ...state, mcpEnabled: Boolean(enabled) }));
    return mcpEnabled();
  }

  return {
    configured: Boolean(credential),
    credentialSource: credential?.source || null,
    login,
    authenticate,
    logout,
    createApiKey,
    listApiKeys,
    revokeApiKey,
    verifyApiKey,
    mcpEnabled,
    setMcpEnabled,
    hermesYoutubeAdmin: () => readState().hermesYoutubeAdmin || null,
    setHermesYoutubeAdmin: (value) => {
      updateState((state) => ({ ...state, hermesYoutubeAdmin: value }));
      return readState().hermesYoutubeAdmin;
    },
    sessionCount: () => {
      pruneSessions();
      return sessions.size;
    },
  };
}

/**
 * Strip the stored hash before a key record crosses a response boundary.
 *
 * @param {object} record
 * @returns {{id: string, label: string, preview: string, createdAt: string, lastUsedAt: string|null}}
 */
function publicApiKey(record) {
  return {
    id: String(record?.id || ''),
    label: String(record?.label || ''),
    preview: String(record?.preview || ''),
    createdAt: String(record?.createdAt || ''),
    lastUsedAt: record?.lastUsedAt ? String(record.lastUsedAt) : null,
  };
}

/**
 * Constant-time comparison of two hex digests of equal expected length.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function safeHashEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
