/**
 * Server-side Google OAuth 2.0 + PKCE session handling for YouTube.
 *
 * Access and refresh tokens live only in this process' session store. The
 * browser receives an opaque, HttpOnly session id and a minimal account view.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const YOUTUBE_API_URL = 'https://www.googleapis.com';
const SESSION_COOKIE = 'gev_youtube_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;
const PERSISTED_SESSION_ID = 'persisted-youtube';
const YOUTUBE_IDENTITY_SCOPES = ['openid', 'email', 'profile'];
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube';

/**
 * Live control -- creating a broadcast, binding it to an ingest stream, reading
 * that stream's ingest key, and transitioning it live -- needs the read-write
 * YouTube scope. Everything else stays read-only, so the write scope is only
 * requested when live control is actually enabled.
 *
 * @param {boolean} writeEnabled
 * @returns {string[]}
 */
export function resolveYoutubeScopes(writeEnabled) {
  return [
    ...YOUTUBE_IDENTITY_SCOPES,
    YOUTUBE_READONLY_SCOPE,
    ...(writeEnabled ? [YOUTUBE_MANAGE_SCOPE] : []),
  ];
}

/**
 * Live control is on by default; set YOUTUBE_WRITE_ENABLED=0 to keep the old
 * read-only consent screen and refuse every mutation at the proxy.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
export function youtubeWriteEnabledFromEnv(env = process.env) {
  const raw = String(env?.YOUTUBE_WRITE_ENABLED ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * @param {string[]|undefined} scopes
 * @returns {boolean}
 */
export function hasYoutubeManageScope(scopes) {
  return Array.isArray(scopes) && scopes.includes(YOUTUBE_MANAGE_SCOPE);
}

/**
 * True when the TCP peer is this host. Used to keep operator-ready / go-now
 * off the public internet — they read in-process OAuth sessions without a cookie.
 *
 * @param {string} [address]
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  const ip = String(address || '').trim().toLowerCase();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function parseScopes(value) {
  return String(value || '').split(/\s+/).filter(Boolean);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createVerifier() {
  return base64url(randomBytes(32));
}

function createChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return cookies;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function serializeCookie(value, maxAge, secure) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function requestOrigin(req) {
  const host = String(req.headers?.host || '').trim();
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto === 'https' || process.env.NODE_ENV === 'production'
    ? 'https'
    : 'http';
  return host ? `${protocol}://${host}` : '';
}

function requiresSecureCookie(req) {
  const authority = String(req.headers?.host || '').trim();
  let host = authority.toLowerCase();
  try {
    host = new URL(`http://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    // An invalid public Host header must never receive the localhost exception.
    host = '';
  }
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return forwardedProto === 'https' || !local;
}

function callbackErrorLocation(code) {
  return `/?youtube_auth=${encodeURIComponent(code)}`;
}

function publicAccount(session) {
  if (!session?.googleSub) return null;
  return {
    name: session.name || 'YouTube account',
    email: session.email || '',
    picture: session.picture || '',
  };
}

function authError(message, cause) {
  const error = new Error(message);
  error.youtubeAuth = true;
  error.cause = cause;
  return error;
}

function derivePersistKey(secret) {
  return createHash('sha256').update(`gev-youtube-session:${secret}`).digest();
}

/**
 * Encrypt a refresh-token record for the operator session file.
 * The file is local-only (.local/, gitignored); this keeps a disk copy from
 * being readable as plaintext if the workspace is copied.
 *
 * @param {string} sessionSecret
 * @param {object} record
 * @returns {string}
 */
export function encodePersistedYoutubeSession(sessionSecret, record) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivePersistKey(sessionSecret), iv);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(record), 'utf8')),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  });
}

/**
 * @param {string} sessionSecret
 * @param {string} raw
 * @returns {object|null}
 */
export function decodePersistedYoutubeSession(sessionSecret, raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    if (parsed?.v !== 1 || !parsed.iv || !parsed.tag || !parsed.data) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      derivePersistKey(sessionSecret),
      Buffer.from(parsed.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const record = JSON.parse(plain);
    return record?.refreshToken ? record : null;
  } catch {
    return null;
  }
}

export function createYoutubeOAuthMiddleware({
  clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI || '',
  sessionSecret = process.env.SESSION_SECRET || '',
  fetchImpl = globalThis.fetch,
  sessions = new Map(),
  oauthStates = new Map(),
  now = () => Date.now(),
  sessionTtlMs = SESSION_TTL_MS,
  oauthStateTtlMs = OAUTH_STATE_TTL_MS,
  writeEnabled = youtubeWriteEnabledFromEnv(),
  onSignedIn = null,
  persistPath = process.env.YOUTUBE_SESSION_PATH || '',
  refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || '',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('YouTube OAuth requires fetch');
  const configured = Boolean(clientId && clientSecret && sessionSecret);
  const scopes = resolveYoutubeScopes(writeEnabled);
  const persistEnabled = Boolean(persistPath && sessionSecret);

  function persistableRecord(session) {
    if (!session?.refreshToken) return null;
    return {
      refreshToken: session.refreshToken,
      accessToken: session.accessToken || '',
      tokenExpiresAt: Number(session.tokenExpiresAt || 0),
      googleSub: session.googleSub || '',
      email: session.email || '',
      name: session.name || '',
      picture: session.picture || '',
      scopes: Array.isArray(session.scopes) ? session.scopes : [],
      expiresAt: Number(session.expiresAt || 0),
    };
  }

  async function writePersistedSession(session) {
    const record = persistableRecord(session);
    if (!persistEnabled || !record) return;
    await mkdir(dirname(persistPath), { recursive: true });
    await writeFile(persistPath, encodePersistedYoutubeSession(sessionSecret, record), { mode: 0o600 });
  }

  async function clearPersistedSession() {
    if (!persistEnabled) return;
    try {
      await unlink(persistPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function putSessionFromRecord(id, record) {
    const session = {
      createdAt: now(),
      expiresAt: Number(record.expiresAt) || now() + sessionTtlMs,
      googleSub: String(record.googleSub || ''),
      email: String(record.email || ''),
      name: String(record.name || ''),
      picture: String(record.picture || ''),
      accessToken: String(record.accessToken || ''),
      refreshToken: String(record.refreshToken || ''),
      scopes: Array.isArray(record.scopes) ? record.scopes : parseScopes(record.scopes),
      tokenExpiresAt: Number(record.tokenExpiresAt || 0),
    };
    sessions.set(id, session);
    return session;
  }

  async function hydrateSessionIdentity(session) {
    if (session.googleSub && session.accessToken) return session;
    if (!session.accessToken) return session;
    const userResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` },
    });
    const user = await userResponse.json().catch(() => ({}));
    if (!userResponse.ok || !user.sub) return session;
    session.googleSub = String(user.sub);
    session.email = String(user.email || session.email || '');
    session.name = String(user.name || user.email || session.name || 'YouTube account');
    session.picture = String(user.picture || session.picture || '');
    return session;
  }

  async function restorePersistedSession() {
    if (!configured) return;
    let record = null;
    if (persistEnabled) {
      try {
        record = decodePersistedYoutubeSession(sessionSecret, await readFile(persistPath, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') record = null;
      }
    }
    if (!record && refreshToken) {
      record = { refreshToken, scopes };
    }
    if (!record?.refreshToken) return;
    const session = putSessionFromRecord(PERSISTED_SESSION_ID, record);
    try {
      await getAccessToken(session);
      await hydrateSessionIdentity(session);
      session.expiresAt = now() + sessionTtlMs;
      await writePersistedSession(session);
    } catch {
      sessions.delete(PERSISTED_SESSION_ID);
      await clearPersistedSession().catch(() => {});
    }
  }

  const restored = restorePersistedSession();
  let restoreNotified = false;
  async function notifyRestoredOnce() {
    await restored;
    if (restoreNotified || typeof onSignedIn !== 'function') return;
    const authorization = await findWritableAuthorization();
    if (!authorization || restoreNotified) return;
    restoreNotified = true;
    void Promise.resolve(onSignedIn(authorization)).catch(() => {});
  }
  void notifyRestoredOnce();

  function getRedirectUri(req) {
    return redirectUri || `${requestOrigin(req)}/api/youtube/auth/callback`;
  }

  function signedState(state, sessionId) {
    const signature = createHmac('sha256', sessionSecret || 'unconfigured')
      .update(`${state}.${sessionId}`)
      .digest('base64url');
    return `${state}.${signature}`;
  }

  function verifyState(value, sessionId) {
    const [state, signature] = String(value || '').split('.');
    if (!state || !signature) return false;
    return safeEqual(signature, createHmac('sha256', sessionSecret || 'unconfigured')
      .update(`${state}.${sessionId}`)
      .digest('base64url'));
  }

  function cleanup() {
    const cutoff = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= cutoff) sessions.delete(id);
    }
    for (const [state, entry] of oauthStates) {
      if (entry.expiresAt <= cutoff) oauthStates.delete(state);
    }
  }

  function getSession(req) {
    cleanup();
    const sessionId = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session || session.expiresAt <= now()) {
      if (sessionId) sessions.delete(sessionId);
      return null;
    }
    session.expiresAt = now() + sessionTtlMs;
    return { id: sessionId, value: session };
  }

  function setSessionCookie(req, res, sessionId) {
    res.setHeader('Set-Cookie', serializeCookie(sessionId, sessionTtlMs / 1000, requiresSecureCookie(req)));
  }

  function clearSessionCookie(req, res) {
    res.setHeader('Set-Cookie', serializeCookie('', 0, requiresSecureCookie(req)));
  }

  async function exchangeCode({ code, codeVerifier, req }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: getRedirectUri(req),
      grant_type: 'authorization_code',
    });
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw authError('Google authorization code exchange failed.', payload.error);
    }
    return payload;
  }

  async function refreshSession(session) {
    if (!session?.refreshToken) throw authError('YouTube session requires reconnect.');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: session.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      session.accessToken = '';
      session.tokenExpiresAt = 0;
      throw authError('YouTube authorization expired or was revoked.', payload.error);
    }
    session.accessToken = payload.access_token;
    session.tokenExpiresAt = now() + Math.max(0, Number(payload.expires_in || 3600) * 1000);
    if (payload.refresh_token) session.refreshToken = payload.refresh_token;
    // Google may narrow a grant on refresh; trust the response over what we asked for.
    if (payload.scope) session.scopes = parseScopes(payload.scope);
    void writePersistedSession(session).catch(() => {});
    return session.accessToken;
  }

  async function getAccessToken(session) {
    if (session.accessToken && session.tokenExpiresAt > now() + TOKEN_REFRESH_LEEWAY_MS) {
      return session.accessToken;
    }
    return refreshSession(session);
  }

  async function authorizeRequest(req) {
    const current = getSession(req);
    if (!current?.value?.googleSub) return null;
    try {
      await getAccessToken(current.value);
      return {
        sessionId: current.id,
        scopes: current.value.scopes || [],
        canWrite: writeEnabled && hasYoutubeManageScope(current.value.scopes),
        getAccessToken: () => getAccessToken(current.value),
      };
    } catch {
      return null;
    }
  }

  /**
   * First in-process YouTube session that still has a usable access token.
   * Cookie-less callers (loopback go-now) use this after a human signs in
   * through the Settings panel.
   *
   * @returns {Promise<object|null>}
   */
  async function findSignedInAuthorization() {
    await restored;
    cleanup();
    for (const [id, session] of sessions) {
      if (!session?.googleSub) continue;
      try {
        await getAccessToken(session);
      } catch {
        continue;
      }
      return {
        sessionId: id,
        scopes: session.scopes || [],
        canWrite: writeEnabled && hasYoutubeManageScope(session.scopes),
        getAccessToken: () => getAccessToken(session),
      };
    }
    return null;
  }

  async function findWritableAuthorization() {
    const authorization = await findSignedInAuthorization();
    return authorization?.canWrite ? authorization : null;
  }

  async function proxy(_connectorName, requestPath, _req, auth, options = {}) {
    if (!auth?.getAccessToken) throw authError('YouTube sign-in required.');
    const token = await auth.getAccessToken();
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    const init = { method, headers };
    if (options.body != null && method !== 'GET' && method !== 'DELETE') {
      headers['Content-Type'] = 'application/json';
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    return fetchImpl(`${YOUTUBE_API_URL}${requestPath}`, init);
  }

  async function handleStart(req, res) {
    if (!configured) {
      sendJson(res, 503, { error: { kind: 'configuration', message: 'YouTube sign-in is not configured.' } });
      return;
    }
    const existing = getSession(req);
    const sessionId = existing?.id || randomUUID();
    if (!existing) {
      sessions.set(sessionId, {
        createdAt: now(),
        expiresAt: now() + sessionTtlMs,
      });
    }
    const state = base64url(randomBytes(32));
    const codeVerifier = createVerifier();
    oauthStates.set(state, {
      sessionId,
      codeVerifier,
      expiresAt: now() + oauthStateTtlMs,
    });
    setSessionCookie(req, res, sessionId);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: getRedirectUri(req),
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: signedState(state, sessionId),
      code_challenge: createChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    redirect(res, `${GOOGLE_AUTHORIZE_URL}?${params}`);
  }

  async function handleCallback(req, res, url) {
    const params = url.searchParams;
    if (params.get('error')) {
      clearSessionCookie(req, res);
      redirect(res, callbackErrorLocation('denied'));
      return;
    }
    const current = getSession(req);
    const signed = params.get('state');
    const [state] = String(signed || '').split('.');
    const pending = state ? oauthStates.get(state) : null;
    if (!current || !pending || pending.sessionId !== current.id || !verifyState(signed, current.id)
      || pending.expiresAt <= now() || !params.get('code')) {
      clearSessionCookie(req, res);
      redirect(res, callbackErrorLocation('invalid_state'));
      return;
    }
    oauthStates.delete(state);
    try {
      const token = await exchangeCode({ code: params.get('code'), codeVerifier: pending.codeVerifier, req });
      const userResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token.access_token}` },
      });
      const user = await userResponse.json().catch(() => ({}));
      if (!userResponse.ok || !user.sub) throw authError('Google account identity could not be verified.');
      const session = current.value;
      session.googleSub = String(user.sub);
      session.email = String(user.email || '');
      session.name = String(user.name || user.email || 'YouTube account');
      session.picture = String(user.picture || '');
      session.accessToken = String(token.access_token);
      session.refreshToken = String(token.refresh_token || session.refreshToken || '');
      session.scopes = parseScopes(token.scope);
      session.tokenExpiresAt = now() + Math.max(0, Number(token.expires_in || 3600) * 1000);
      session.expiresAt = now() + sessionTtlMs;
      try {
        await writePersistedSession(session);
      } catch {
        // Disk persist is best-effort; the in-memory session still works.
      }
      setSessionCookie(req, res, current.id);
      redirect(res, callbackErrorLocation('success'));
      if (typeof onSignedIn === 'function') {
        const authorization = {
          sessionId: current.id,
          scopes: session.scopes || [],
          canWrite: writeEnabled && hasYoutubeManageScope(session.scopes),
          getAccessToken: () => getAccessToken(session),
        };
        void Promise.resolve(onSignedIn(authorization)).catch(() => {});
      }
    } catch {
      sessions.delete(current.id);
      clearSessionCookie(req, res);
      redirect(res, callbackErrorLocation('error'));
    }
  }

  async function middleware(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/start') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: { kind: 'method-not-allowed', message: 'OAuth start is read-only.' } });
      return handleStart(req, res);
    }
    if (url.pathname === '/callback') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: { kind: 'method-not-allowed', message: 'OAuth callback requires GET.' } });
      return handleCallback(req, res, url);
    }
    if (url.pathname === '/status') {
      const current = getSession(req);
      return sendJson(res, 200, {
        authenticated: Boolean(current?.value?.googleSub),
        account: publicAccount(current?.value),
        configured,
        writeEnabled,
        canWrite: writeEnabled && hasYoutubeManageScope(current?.value?.scopes),
      });
    }
    if (url.pathname === '/signout') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: { kind: 'method-not-allowed', message: 'Sign out requires POST.' } });
      const current = getSession(req);
      if (current) sessions.delete(current.id);
      sessions.delete(PERSISTED_SESSION_ID);
      void clearPersistedSession().catch(() => {});
      clearSessionCookie(req, res);
      return sendJson(res, 200, { authenticated: false });
    }
    if (url.pathname === '/operator-ready') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: { kind: 'method-not-allowed', message: 'Operator-ready is read-only.' } });
      if (!isLoopbackAddress(req.socket?.remoteAddress || req.connection?.remoteAddress)) {
        sendJson(res, 403, { error: { kind: 'forbidden', message: 'Operator-ready is loopback only.' } });
        return;
      }
      const authorization = await findSignedInAuthorization();
      return sendJson(res, 200, {
        authenticated: Boolean(authorization),
        canWrite: Boolean(authorization?.canWrite),
        ready: Boolean(authorization?.canWrite),
      });
    }
    if (typeof next === 'function') return next();
    sendJson(res, 404, { error: { kind: 'not-found', message: 'YouTube auth route not found.' } });
  }

  return {
    middleware,
    authorizeRequest,
    findSignedInAuthorization,
    findWritableAuthorization,
    proxy,
    sessions,
    oauthStates,
    configured,
    writeEnabled,
    setOnSignedIn(handler) {
      onSignedIn = handler;
      void notifyRestoredOnce();
    },
  };
}
