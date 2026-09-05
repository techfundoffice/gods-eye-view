import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  YOUTUBE_MANAGE_SCOPE,
  createYoutubeOAuthMiddleware,
  decodePersistedPayload,
  decodePersistedYoutubeSession,
  encodePersistedYoutubeSession,
  hasYoutubeManageScope,
  isLoopbackAddress,
  resolveYoutubeScopes,
  youtubeWriteEnabledFromEnv,
} from './youtubeOAuth.js';

function invoke(middleware, {
  method = 'GET',
  url = '/status',
  cookie = '',
  host = 'app.example',
  forwardedProto = 'https',
  remoteAddress = '127.0.0.1',
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const req = {
      method,
      url,
      socket: { remoteAddress },
      headers: {
        host,
        cookie,
        ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
      },
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      end(body = '') {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* redirects have no JSON body */ }
        resolve({ status: this.statusCode, headers, body, json });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

test('OAuth status is minimal and reports configuration without exposing credentials', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const response = await invoke(oauth.middleware);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    authenticated: false,
    account: null,
    configured: true,
    writeEnabled: true,
    canWrite: false,
    autoGoLive: true,
  });
  assert.doesNotMatch(response.body, /client-secret|session-secret|access_token|refresh_token/);
});

test('GET /start without go=1 is an interstitial and does not create PKCE', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const response = await invoke(oauth.middleware, { url: '/start' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /Continue to Google Allow/);
  assert.match(response.body, /start\?go=1/);
  assert.equal(oauth.oauthStates.size, 0);
  assert.doesNotMatch(response.body, /client-secret|code_verifier|accounts\.google\.com/);
});

test('a second go=1 start reuses the in-flight PKCE so a preview tap cannot invalidate Allow', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const first = await invoke(oauth.middleware, { url: '/start?go=1' });
  const second = await invoke(oauth.middleware, { url: '/start?go=1' });
  assert.equal(first.status, 302);
  assert.equal(second.status, 302);
  assert.equal(first.headers.location, second.headers.location);
  assert.equal(oauth.oauthStates.size, 1);
});

test('OAuth start uses state, PKCE, offline access, and exact callback URI', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const response = await invoke(oauth.middleware, { url: '/start?go=1' });
  assert.equal(response.status, 302);
  assert.match(response.headers['set-cookie'], /HttpOnly/);
  assert.match(response.headers['set-cookie'], /SameSite=Lax/);
  assert.match(response.headers['set-cookie'], /Secure/);
  const target = new URL(response.headers.location);
  assert.equal(target.origin, 'https://accounts.google.com');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://app.example/api/youtube/auth/callback');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('access_type'), 'offline');
  assert.match(target.searchParams.get('scope'), /youtube\.readonly/);
  assert.ok(target.searchParams.get('state'));
  assert.equal(target.searchParams.get('login_hint'), null);
});

test('OAuth start sends login_hint when configured', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    loginHint: 'operator@example.com',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const response = await invoke(oauth.middleware, { url: '/start?go=1' });
  assert.equal(new URL(response.headers.location).searchParams.get('login_hint'), 'operator@example.com');
});

test('OAuth cookie permits insecure transport only on localhost development', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const response = await invoke(oauth.middleware, {
    url: '/start?go=1',
    host: 'localhost:5000',
    forwardedProto: '',
  });
  assert.equal(response.status, 302);
  assert.doesNotMatch(response.headers['set-cookie'], /Secure/);
  assert.equal(new URL(response.headers.location).searchParams.get('redirect_uri'), 'http://localhost:5000/api/youtube/auth/callback');

  const ipv6 = await invoke(oauth.middleware, {
    url: '/start?go=1',
    host: '[::1]:5000',
    forwardedProto: '',
  });
  assert.equal(ipv6.status, 302);
  assert.doesNotMatch(ipv6.headers['set-cookie'], /Secure/);
  assert.equal(new URL(ipv6.headers.location).searchParams.get('redirect_uri'), 'http://[::1]:5000/api/youtube/auth/callback');
});

test('OAuth callback rejects mismatched state before token exchange', async () => {
  let calls = 0;
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { calls += 1; throw new Error('must not run'); },
  });
  const start = await invoke(oauth.middleware, { url: '/start?go=1' });
  const cookie = start.headers['set-cookie'].split(';')[0];
  const response = await invoke(oauth.middleware, {
    url: '/callback?code=code&state=forged.invalid',
    cookie,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/?admin=1&youtube_auth=invalid_state');
  assert.equal(calls, 0);
});

test('OAuth callback stores tokens server-side and exposes only account identity', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/token')) {
      return new Response(JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({
        sub: 'google-user',
        name: 'Test Creator',
        email: 'creator@example.test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl,
  });
  const start = await invoke(oauth.middleware, { url: '/start?go=1' });
  const cookie = start.headers['set-cookie'].split(';')[0];
  const state = new URL(start.headers.location).searchParams.get('state');
  const callback = await invoke(oauth.middleware, {
    url: `/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    cookie,
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, '/?admin=1&youtube_auth=success');

  const status = await invoke(oauth.middleware, { cookie });
  assert.equal(status.json.authenticated, true);
  assert.deepEqual(status.json.account, {
    name: 'Test Creator',
    email: 'creator@example.test',
    picture: '',
  });
  assert.doesNotMatch(status.body, /access-secret|refresh-secret|google-user/);

  const authorization = await oauth.authorizeRequest({ headers: { cookie } });
  assert.ok(authorization?.sessionId);
  assert.equal(await authorization.getAccessToken(), 'access-secret');
  const tokenRequest = requests.find((request) => request.url.includes('/token'));
  assert.match(String(tokenRequest.options.body), /code_verifier=/);
  assert.match(String(tokenRequest.options.body), /redirect_uri=https%3A%2F%2Fapp\.example%2Fapi%2Fyoutube%2Fauth%2Fcallback/);
});

test('OAuth callback can finish without the start cookie if state is valid', async () => {
  const requests = [];
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 3600,
          scope: `openid email ${YOUTUBE_MANAGE_SCOPE}`,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        sub: 'google-user',
        name: 'Test Creator',
        email: 'creator@example.test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const start = await invoke(oauth.middleware, { url: '/start?go=1' });
  const state = new URL(start.headers.location).searchParams.get('state');
  const callback = await invoke(oauth.middleware, {
    url: `/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    cookie: '',
    host: 'other-host.example',
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, '/?admin=1&youtube_auth=success');
  const tokenRequest = requests.find((request) => String(request.url).includes('/token'));
  assert.match(String(tokenRequest.options.body), /redirect_uri=https%3A%2F%2Fapp\.example%2Fapi%2Fyoutube%2Fauth%2Fcallback/);
  const ready = await invoke(oauth.middleware, { url: '/operator-ready' });
  assert.equal(ready.json.ready, true);
});

test('a successful callback notifies onSignedIn without exposing tokens', async () => {
  const signedIn = [];
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async (url) => {
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 3600,
          scope: `openid email ${YOUTUBE_MANAGE_SCOPE}`,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        sub: 'google-user',
        name: 'Test Creator',
        email: 'creator@example.test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    onSignedIn: (authorization) => { signedIn.push(authorization); },
  });
  const start = await invoke(oauth.middleware, { url: '/start?go=1' });
  const cookie = start.headers['set-cookie'].split(';')[0];
  const state = new URL(start.headers.location).searchParams.get('state');
  await invoke(oauth.middleware, {
    url: `/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    cookie,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(signedIn.length, 1);
  assert.equal(signedIn[0].canWrite, true);
  assert.equal(await signedIn[0].getAccessToken(), 'access-secret');
});

test('live control adds the manage scope and read-only mode withholds it', () => {
  assert.deepEqual(resolveYoutubeScopes(false), [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/youtube.readonly',
  ]);
  assert.ok(resolveYoutubeScopes(true).includes(YOUTUBE_MANAGE_SCOPE));
  assert.ok(hasYoutubeManageScope([YOUTUBE_MANAGE_SCOPE]));
  assert.equal(hasYoutubeManageScope(['https://www.googleapis.com/auth/youtube.readonly']), false);
  assert.equal(hasYoutubeManageScope(undefined), false);
});

test('write mode is on unless explicitly disabled', () => {
  assert.equal(youtubeWriteEnabledFromEnv({}), true);
  assert.equal(youtubeWriteEnabledFromEnv({ YOUTUBE_WRITE_ENABLED: '1' }), true);
  for (const value of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(youtubeWriteEnabledFromEnv({ YOUTUBE_WRITE_ENABLED: value }), false, value);
  }
});

test('OAuth start requests the manage scope only when live control is enabled', async () => {
  const options = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  };
  const writable = await invoke(
    createYoutubeOAuthMiddleware({ ...options, writeEnabled: true }).middleware,
    { url: '/start?go=1' },
  );
  const scope = new URL(writable.headers.location).searchParams.get('scope');
  assert.ok(scope.split(' ').includes(YOUTUBE_MANAGE_SCOPE));

  const readOnly = await invoke(
    createYoutubeOAuthMiddleware({ ...options, writeEnabled: false }).middleware,
    { url: '/start?go=1' },
  );
  const readOnlyScope = new URL(readOnly.headers.location).searchParams.get('scope');
  assert.equal(readOnlyScope.split(' ').includes(YOUTUBE_MANAGE_SCOPE), false);
  assert.match(readOnlyScope, /youtube\.readonly/);
});

test('a read-only grant cannot write even when live control is enabled', async () => {
  const sessions = new Map([['session-1', {
    googleSub: 'sub-1',
    accessToken: 'token',
    tokenExpiresAt: Date.now() + 600_000,
    expiresAt: Date.now() + 600_000,
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
  }]]);
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
    sessions,
    writeEnabled: true,
  });
  const authorization = await oauth.authorizeRequest({
    headers: { cookie: 'gev_youtube_session=session-1' },
  });
  assert.equal(authorization.canWrite, false);

  sessions.get('session-1').scopes = [YOUTUBE_MANAGE_SCOPE];
  const upgraded = await oauth.authorizeRequest({
    headers: { cookie: 'gev_youtube_session=session-1' },
  });
  assert.equal(upgraded.canWrite, true);
});

test('the OAuth proxy forwards live-control method and JSON body', async () => {
  const calls = [];
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const auth = { getAccessToken: async () => 'token-abc' };
  await oauth.proxy('youtube', '/youtube/v3/liveBroadcasts?part=snippet', {}, auth, {
    method: 'POST',
    body: { snippet: { title: 'God\u2019s Eye View' } },
  });
  const [call] = calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer token-abc');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), { snippet: { title: 'God\u2019s Eye View' } });

  calls.length = 0;
  await oauth.proxy('youtube', '/youtube/v3/liveStreams?id=x', {}, auth, { method: 'DELETE' });
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.body, undefined);
});

test('loopback addresses are recognized and operator-ready stays off the public internet', async () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('8.8.8.8'), false);

  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const remote = await invoke(oauth.middleware, {
    url: '/operator-ready',
    remoteAddress: '203.0.113.9',
  });
  assert.equal(remote.status, 403);
  assert.equal(remote.json.error.kind, 'forbidden');

  const local = await invoke(oauth.middleware, { url: '/operator-ready' });
  assert.equal(local.status, 200);
  assert.deepEqual(local.json, { authenticated: false, canWrite: false, ready: false });
});

test('persisted session file round-trips without exposing the refresh token in plaintext', () => {
  const encoded = encodePersistedYoutubeSession('session-secret-long-enough', {
    refreshToken: 'refresh-secret',
    googleSub: 'sub-1',
    scopes: [YOUTUBE_MANAGE_SCOPE],
  });
  assert.doesNotMatch(encoded, /refresh-secret/);
  const decoded = decodePersistedYoutubeSession('session-secret-long-enough', encoded);
  assert.equal(decoded.refreshToken, 'refresh-secret');
  assert.equal(decodePersistedYoutubeSession('wrong-secret', encoded), null);
});

test('OAuth callback writes an encrypted session file and restore hydrates go-live', async () => {
  const persistPath = path.join(await mkdtemp(path.join(tmpdir(), 'gev-yt-')), 'youtube-oauth.json');
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
        scope: `openid email ${YOUTUBE_MANAGE_SCOPE}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      sub: 'google-user',
      name: 'Test Creator',
      email: 'creator@example.test',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const first = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl,
    persistPath,
  });
  const start = await invoke(first.middleware, { url: '/start?go=1' });
  const cookie = start.headers['set-cookie'].split(';')[0];
  const state = new URL(start.headers.location).searchParams.get('state');
  await invoke(first.middleware, {
    url: `/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    cookie,
  });
  const raw = await readFile(persistPath, 'utf8');
  assert.doesNotMatch(raw, /refresh-secret|access-secret/);
  assert.ok(decodePersistedYoutubeSession('session-secret-long-enough', raw)?.refreshToken);

  const restored = [];
  const second = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl,
    persistPath,
    onSignedIn: (authorization) => { restored.push(authorization); },
  });
  const ready = await invoke(second.middleware, { url: '/operator-ready' });
  assert.equal(ready.json.ready, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].canWrite, true);
  assert.equal(await restored[0].getAccessToken(), 'access-secret');
});

test('OAuth start persists PKCE pending state so callback survives a process restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-yt-'));
  const persistPath = path.join(dir, 'youtube-oauth.json');
  const pendingPath = path.join(dir, 'youtube-oauth-pending.json');
  const fetchImpl = async (url) => {
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
        scope: `openid email ${YOUTUBE_MANAGE_SCOPE}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      sub: 'google-user',
      name: 'Test Creator',
      email: 'creator@example.test',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const first = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl,
    persistPath,
  });
  const start = await invoke(first.middleware, { url: '/start?go=1' });
  const state = new URL(start.headers.location).searchParams.get('state');
  const deadline = Date.now() + 1000;
  let pendingRaw = '';
  while (Date.now() < deadline) {
    try {
      pendingRaw = await readFile(pendingPath, 'utf8');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  if (!pendingRaw) throw new Error('pending PKCE file was not written');
  assert.doesNotMatch(pendingRaw, /codeVerifier|refresh-secret/);
  const pending = decodePersistedPayload('session-secret-long-enough', pendingRaw);
  assert.equal(pending.pending.length, 1);

  const second = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl,
    persistPath,
  });
  const callback = await invoke(second.middleware, {
    url: `/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
  });
  assert.match(callback.headers.location, /youtube_auth=success/);
  const ready = await invoke(second.middleware, { url: '/operator-ready' });
  assert.equal(ready.json.ready, true);
});

test('YOUTUBE_REFRESH_TOKEN seeds a writable session when no file exists', async () => {
  const persistPath = path.join(await mkdtemp(path.join(tmpdir(), 'gev-yt-')), 'missing.json');
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    persistPath,
    refreshToken: 'env-refresh-secret',
    fetchImpl: async (url) => {
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({
          access_token: 'access-from-refresh',
          expires_in: 3600,
          scope: YOUTUBE_MANAGE_SCOPE,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        sub: 'google-user',
        name: 'Seeded',
        email: 'seeded@example.test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const ready = await invoke(oauth.middleware, { url: '/operator-ready' });
  assert.equal(ready.json.ready, true);
  const found = await oauth.findWritableAuthorization();
  assert.equal(await found.getAccessToken(), 'access-from-refresh');
});

test('findWritableAuthorization returns the first manage-scope session', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  assert.equal(await oauth.findWritableAuthorization(), null);
  oauth.sessions.set('sess-1', {
    googleSub: 'sub-1',
    accessToken: 'tok',
    tokenExpiresAt: Date.now() + 10 * 60_000,
    expiresAt: Date.now() + 60 * 60_000,
    scopes: [YOUTUBE_MANAGE_SCOPE],
  });
  const found = await oauth.findWritableAuthorization();
  assert.equal(found.sessionId, 'sess-1');
  assert.equal(found.canWrite, true);
  assert.equal(await found.getAccessToken(), 'tok');
});

test('findOwnerAuthorization selects only the ADMIN-designated Google identity', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const base = {
    googleSub: 'sub',
    accessToken: 'tok',
    tokenExpiresAt: Date.now() + 10 * 60_000,
    expiresAt: Date.now() + 60 * 60_000,
    scopes: [],
  };
  oauth.sessions.set('visitor', { ...base, email: 'visitor@example.test' });
  oauth.sessions.set('owner', { ...base, googleSub: 'owner-sub', accessToken: 'owner-token', email: 'owner@example.test' });

  assert.equal(await oauth.findOwnerAuthorization({ emails: ['missing@example.test'] }), null);
  const found = await oauth.findOwnerAuthorization({ emails: [' OWNER@example.test '] });
  assert.equal(found.sessionId, 'owner');
  assert.equal(await found.getAccessToken(), 'owner-token');
});
