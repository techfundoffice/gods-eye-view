import assert from 'node:assert/strict';
import test from 'node:test';
import { createYoutubeOAuthMiddleware } from './youtubeOAuth.js';

function invoke(middleware, {
  method = 'GET',
  url = '/status',
  cookie = '',
  host = 'app.example',
  forwardedProto = 'https',
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const req = {
      method,
      url,
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
  assert.deepEqual(response.json, { authenticated: false, account: null, configured: true });
  assert.doesNotMatch(response.body, /client-secret|session-secret|access_token|refresh_token/);
});

test('OAuth start uses state, PKCE, offline access, and exact callback URI', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const response = await invoke(oauth.middleware, { url: '/start' });
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
});

test('OAuth cookie permits insecure transport only on localhost development', async () => {
  const oauth = createYoutubeOAuthMiddleware({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: 'session-secret-long-enough',
    fetchImpl: async () => { throw new Error('not expected'); },
  });
  const response = await invoke(oauth.middleware, {
    url: '/start',
    host: 'localhost:5000',
    forwardedProto: '',
  });
  assert.equal(response.status, 302);
  assert.doesNotMatch(response.headers['set-cookie'], /Secure/);
  assert.equal(new URL(response.headers.location).searchParams.get('redirect_uri'), 'http://localhost:5000/api/youtube/auth/callback');

  const ipv6 = await invoke(oauth.middleware, {
    url: '/start',
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
  const start = await invoke(oauth.middleware, { url: '/start' });
  const cookie = start.headers['set-cookie'].split(';')[0];
  const response = await invoke(oauth.middleware, {
    url: '/callback?code=code&state=forged.invalid',
    cookie,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/?youtube_auth=invalid_state');
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
  const start = await invoke(oauth.middleware, { url: '/start' });
  const cookie = start.headers['set-cookie'].split(';')[0];
  const state = new URL(start.headers.location).searchParams.get('state');
  const callback = await invoke(oauth.middleware, {
    url: `/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    cookie,
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, '/?youtube_auth=success');

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
