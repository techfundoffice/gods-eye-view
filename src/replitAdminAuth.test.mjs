import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPLIT_ADMIN_SESSION_COOKIE,
  REPLIT_AUTH_FLOW_COOKIE,
  createReplitAdminAuth,
  openAuthPayload,
  safeReturnTo,
  sealAuthPayload,
} from './replitAdminAuth.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value = '') { this.body = value; },
  };
}

function request(url = '/login', cookie = '') {
  return {
    url,
    headers: {
      host: 'app.example',
      'x-forwarded-proto': 'https',
      ...(cookie ? { cookie } : {}),
    },
  };
}

function cookieValue(setCookie, name) {
  const rows = Array.isArray(setCookie) ? setCookie : [setCookie];
  const row = rows.find((value) => String(value).startsWith(`${name}=`));
  return decodeURIComponent(String(row).split(';')[0].slice(name.length + 1));
}

function fakeOidc(subject = 'owner-1') {
  return {
    discovery: async () => ({ issuer: 'test' }),
    randomPKCECodeVerifier: () => 'verifier',
    calculatePKCECodeChallenge: async () => 'challenge',
    randomState: () => 'state',
    randomNonce: () => 'nonce',
    buildAuthorizationUrl: (_config, parameters) => {
      const url = new URL('https://replit.com/oidc/auth');
      Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
      return url;
    },
    authorizationCodeGrant: async (_config, _url, checks) => {
      assert.deepEqual(checks, {
        pkceCodeVerifier: 'verifier',
        expectedState: 'state',
        expectedNonce: 'nonce',
      });
      return { claims: () => ({ sub: subject, username: 'operator', exp: 2_000_000_000 }) };
    },
  };
}

const env = {
  REPL_ID: 'client-id',
  SESSION_SECRET: 'test-secret-that-never-leaves-the-server',
  REPLIT_DOMAINS: 'app.example',
  REPL_OWNER_ID: 'owner-1',
};

test('encrypted auth payloads reject tampering and unsafe return locations', () => {
  const sealed = sealAuthPayload({ value: 1 }, env.SESSION_SECRET, () => Buffer.alloc(12, 7));
  assert.deepEqual(openAuthPayload(sealed, env.SESSION_SECRET), { value: 1 });
  assert.equal(openAuthPayload(`${sealed}x`, env.SESSION_SECRET), null);
  assert.equal(safeReturnTo('//attacker.example'), '/?admin=1');
  assert.equal(safeReturnTo('/?admin=1'), '/?admin=1');
});

test('native login uses Replit OIDC with PKCE, state, nonce, and no credential response body', async () => {
  const auth = createReplitAdminAuth({ env, oidc: fakeOidc(), now: () => 1_000 });
  const res = response();
  await auth.login(request(), res, '/?admin=1');
  assert.equal(res.statusCode, 302);
  const redirect = new URL(res.headers.Location);
  assert.equal(redirect.origin, 'https://replit.com');
  assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(redirect.searchParams.get('state'), 'state');
  assert.equal(redirect.searchParams.get('nonce'), 'nonce');
  assert.equal(res.body, '');
  const flow = cookieValue(res.headers['Set-Cookie'], REPLIT_AUTH_FLOW_COOKIE);
  assert.ok(flow);
  assert.doesNotMatch(String(res.headers.Location), /test-secret|verifier/);
});

test('verified owner callback creates an HttpOnly ADMIN session accepted server-side', async () => {
  const auth = createReplitAdminAuth({ env, oidc: fakeOidc(), now: () => 1_000 });
  const loginRes = response();
  await auth.login(request(), loginRes, '/?admin=1');
  const flow = cookieValue(loginRes.headers['Set-Cookie'], REPLIT_AUTH_FLOW_COOKIE);

  const callbackRes = response();
  await auth.callback(request('/callback?code=abc&state=state', `${REPLIT_AUTH_FLOW_COOKIE}=${encodeURIComponent(flow)}`), callbackRes);
  assert.equal(callbackRes.statusCode, 302);
  assert.equal(callbackRes.headers.Location, '/?admin=1');
  const session = cookieValue(callbackRes.headers['Set-Cookie'], REPLIT_ADMIN_SESSION_COOKIE);
  const authenticated = auth.authenticate(request('/session', `${REPLIT_ADMIN_SESSION_COOKIE}=${encodeURIComponent(session)}`));
  assert.equal(authenticated.sub, 'owner-1');
  assert.equal(authenticated.username, 'operator');
});

test('a different Replit account cannot become an ADMIN session', async () => {
  const auth = createReplitAdminAuth({ env, oidc: fakeOidc('someone-else'), now: () => 1_000 });
  const loginRes = response();
  await auth.login(request(), loginRes, '/?admin=1');
  const flow = cookieValue(loginRes.headers['Set-Cookie'], REPLIT_AUTH_FLOW_COOKIE);
  const callbackRes = response();
  await auth.callback(request('/callback?code=abc&state=state', `${REPLIT_AUTH_FLOW_COOKIE}=${encodeURIComponent(flow)}`), callbackRes);
  assert.equal(callbackRes.statusCode, 403);
  assert.equal(auth.authenticate(request('/session')), null);
});

test('logout clears the local ADMIN session cookie', () => {
  const auth = createReplitAdminAuth({ env, oidc: fakeOidc() });
  const res = response();
  auth.logout(request('/logout'), res);
  assert.match(res.headers['Set-Cookie'], new RegExp(`^${REPLIT_ADMIN_SESSION_COOKIE}=;`));
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});