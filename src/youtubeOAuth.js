/**
 * Server-side Google OAuth 2.0 + PKCE session handling for YouTube.
 *
 * Access and refresh tokens live only in this process' session store. The
 * browser receives an opaque, HttpOnly session id and a minimal account view.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const YOUTUBE_API_URL = 'https://www.googleapis.com';
const SESSION_COOKIE = 'gev_youtube_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;
const YOUTUBE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/youtube.readonly',
];

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
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('YouTube OAuth requires fetch');
  const configured = Boolean(clientId && clientSecret && sessionSecret);

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
        getAccessToken: () => getAccessToken(current.value),
      };
    } catch {
      return null;
    }
  }

  async function proxy(_connectorName, requestPath, _req, auth) {
    if (!auth?.getAccessToken) throw authError('YouTube sign-in required.');
    const token = await auth.getAccessToken();
    return fetchImpl(`${YOUTUBE_API_URL}${requestPath}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
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
      scope: YOUTUBE_SCOPES.join(' '),
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
      session.tokenExpiresAt = now() + Math.max(0, Number(token.expires_in || 3600) * 1000);
      session.expiresAt = now() + sessionTtlMs;
      setSessionCookie(req, res, current.id);
      redirect(res, callbackErrorLocation('success'));
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
      });
    }
    if (url.pathname === '/signout') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: { kind: 'method-not-allowed', message: 'Sign out requires POST.' } });
      const current = getSession(req);
      if (current) sessions.delete(current.id);
      clearSessionCookie(req, res);
      return sendJson(res, 200, { authenticated: false });
    }
    if (typeof next === 'function') return next();
    sendJson(res, 404, { error: { kind: 'not-found', message: 'YouTube auth route not found.' } });
  }

  return {
    middleware,
    authorizeRequest,
    proxy,
    sessions,
    oauthStates,
    configured,
  };
}
