import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  ADMIN_REQUEST_HEADER,
  createAdminMiddleware,
  parseAdminRoute,
  readJsonBody,
  requiresSecureCookie,
} from './adminServer.js';
import { ADMIN_SESSION_COOKIE, createAdminAuth, hashAdminPassword } from './adminAuth.js';
import { normalizePluginName } from './adminPluginBuilder.js';

const PASSWORD = 'operator-password';

function memoryStore(initial = {}) {
  let state = { version: 1, apiKeys: [], mcpEnabled: false, ...initial };
  return {
    read: () => state,
    update(mutate) { state = mutate(state); return state; },
  };
}

/** Plugin-builder stand-in: no processes, deterministic ids. */
function stubBuilder() {
  const jobs = new Map();
  let counter = 0;
  return {
    command: 'stub-agent',
    start({ name, instructions }) {
      // Same rejection rule as the real builder, so a 400 here is a real 400.
      normalizePluginName(name);
      counter += 1;
      const job = {
        id: `job-${counter}`,
        name,
        slug: String(name).toLowerCase(),
        status: 'running',
        transcript: [{ role: 'admin', text: instructions || name, at: '2026-08-29T00:00:00.000Z' }],
        error: null,
      };
      jobs.set(job.id, job);
      return job;
    },
    send(id, message) {
      const job = jobs.get(id);
      if (!job) return null;
      job.transcript.push({ role: 'admin', text: message, at: '2026-08-29T00:00:01.000Z' });
      return job;
    },
    get: (id) => jobs.get(id) || null,
    list: () => [...jobs.values()],
    cancel: (id) => jobs.has(id),
  };
}

/** Live-stream stand-in so these tests never touch ffmpeg or a browser. */
function stubLive() {
  return {
    status: () => ({ status: 'idle' }),
    start: async () => ({ status: 'idle' }),
    stop: async () => ({ status: 'stopped' }),
  };
}

/**
 * Drive the middleware once and collect the response.
 *
 * @returns {Promise<{status: number, headers: object, body: object|null, cookies: string[]}>}
 */
function call(middleware, {
  method = 'GET',
  url = '/session',
  headers = {},
  body,
  cookie = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(payload ? [Buffer.from(payload)] : []);
    req.method = method;
    req.url = url;
    req.headers = { ...headers };
    if (cookie) req.headers.cookie = cookie;
    req.socket = { remoteAddress: '127.0.0.1' };

    const responseHeaders = {};
    const cookies = [];
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name, value) {
        responseHeaders[name] = value;
        if (name.toLowerCase() === 'set-cookie') cookies.push(value);
      },
      end(text) {
        this.writableEnded = true;
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: this.statusCode, headers: responseHeaders, body: parsed, cookies });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

/** Build a middleware with a known password and stub dependencies. */
function harness({ store = memoryStore(), builder = stubBuilder() } = {}) {
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword(PASSWORD), source: 'hash' },
    store,
  });
  return {
    auth,
    store,
    builder,
    middleware: createAdminMiddleware({ store, auth, builder, live: stubLive(), version: '1.2.3' }),
  };
}

/** Sign in and return the session cookie header value. */
async function signIn(middleware) {
  const response = await call(middleware, {
    method: 'POST',
    url: '/login',
    headers: { [ADMIN_REQUEST_HEADER]: '1' },
    body: { password: PASSWORD },
  });
  assert.equal(response.status, 200);
  return response.cookies[0].split(';')[0];
}

const WRITE = { [ADMIN_REQUEST_HEADER]: '1' };

test('routes split into segments regardless of the query string', () => {
  assert.deepEqual(parseAdminRoute('/plugins/abc/messages?x=1').segments, ['plugins', 'abc', 'messages']);
  assert.deepEqual(parseAdminRoute('/').segments, []);
  assert.equal(parseAdminRoute('/plugins?limit=5').query.get('limit'), '5');
});

test('cookies are Secure everywhere except a plain-HTTP localhost', () => {
  assert.equal(requiresSecureCookie({ headers: { host: 'localhost:5000' } }), false);
  assert.equal(requiresSecureCookie({ headers: { host: '127.0.0.1:5000' } }), false);
  assert.equal(requiresSecureCookie({ headers: { host: 'example.repl.co' } }), true);
  assert.equal(requiresSecureCookie({ headers: { host: 'localhost', 'x-forwarded-proto': 'https' } }), true);
  assert.equal(requiresSecureCookie({ headers: {} }), true, 'an unparseable host is not treated as local');
});

test('an oversized body is refused before it is parsed', async () => {
  const req = Readable.from([Buffer.alloc(64)]);
  await assert.rejects(() => readJsonBody(req, 8), /too large/);
});

test('an unconfigured console answers every route with `unconfigured`', async () => {
  const middleware = createAdminMiddleware({
    store: memoryStore(),
    auth: createAdminAuth({ credential: null, store: memoryStore() }),
    builder: stubBuilder(),
    live: stubLive(),
  });
  const session = await call(middleware, { url: '/session' });
  assert.equal(session.status, 503);
  assert.equal(session.body.configured, false);

  const plugins = await call(middleware, { url: '/plugins' });
  assert.equal(plugins.status, 503);

  const mcp = await call(middleware, { method: 'POST', url: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(mcp.status, 503);
});

test('session reports configuration before anyone signs in', async () => {
  const { middleware } = harness();
  const response = await call(middleware, { url: '/session' });
  assert.equal(response.status, 200);
  assert.deepEqual(
    { configured: response.body.configured, authenticated: response.body.authenticated },
    { configured: true, authenticated: false },
  );
  assert.equal(response.body.agentCommand, 'stub-agent');
});

test('a mutating call without the anti-CSRF header is refused', async () => {
  const { middleware } = harness();
  const response = await call(middleware, { method: 'POST', url: '/login', body: { password: PASSWORD } });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.kind, 'csrf');
});

test('a wrong password never mints a cookie', async () => {
  const { middleware } = harness();
  const response = await call(middleware, {
    method: 'POST', url: '/login', headers: WRITE, body: { password: 'nope' },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(response.cookies, []);
});

test('a correct password sets an HttpOnly, SameSite=Strict session cookie', async () => {
  const { middleware } = harness();
  const response = await call(middleware, {
    method: 'POST', url: '/login', headers: WRITE, body: { password: PASSWORD },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.authenticated, true);
  const cookie = response.cookies[0];
  assert.match(cookie, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('sustained wrong passwords are throttled with a Retry-After', async () => {
  const { middleware } = harness();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await call(middleware, { method: 'POST', url: '/login', headers: WRITE, body: { password: 'nope' } });
  }
  const response = await call(middleware, {
    method: 'POST', url: '/login', headers: WRITE, body: { password: PASSWORD },
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers['Retry-After']) >= 1);
});

test('operator routes are closed to anyone without a session', async () => {
  const { middleware } = harness();
  for (const request of [
    { url: '/plugins' },
    { method: 'POST', url: '/plugins', headers: WRITE, body: { name: 'X' } },
    { url: '/menu' },
    { url: '/mcp/settings' },
    { method: 'POST', url: '/mcp/keys', headers: WRITE, body: { label: 'x' } },
    { url: '/live' },
    { method: 'POST', url: '/live/start', headers: WRITE, body: { ingestUrl: 'rtmp://x/live2' } },
  ]) {
    const response = await call(middleware, request);
    assert.equal(response.status, 401, `${request.method || 'GET'} ${request.url} requires sign-in`);
    assert.equal(response.body.error.kind, 'auth');
  }
});

test('a signed-in operator can start a build and continue its conversation', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);

  const created = await call(middleware, {
    method: 'POST', url: '/plugins', headers: WRITE, cookie, body: { name: 'Watchlist', instructions: 'Track ships' },
  });
  assert.equal(created.status, 202);
  const jobId = created.body.plugin.id;

  const listed = await call(middleware, { url: '/plugins', cookie });
  assert.equal(listed.body.plugins.length, 1);

  const followUp = await call(middleware, {
    method: 'POST', url: `/plugins/${jobId}/messages`, headers: WRITE, cookie, body: { message: 'add CSV export' },
  });
  assert.equal(followUp.status, 202);
  assert.ok(followUp.body.plugin.transcript.some((entry) => entry.text === 'add CSV export'));

  const fetched = await call(middleware, { url: `/plugins/${jobId}`, cookie });
  assert.equal(fetched.body.plugin.id, jobId);
});

test('an unnameable plugin is a 400, and an unknown build is a 404', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);

  const bad = await call(middleware, {
    method: 'POST', url: '/plugins', headers: WRITE, cookie, body: { name: '***' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.kind, 'name');

  assert.equal((await call(middleware, { url: '/plugins/nope', cookie })).status, 404);
  assert.equal((await call(middleware, {
    method: 'POST', url: '/plugins/nope/messages', headers: WRITE, cookie, body: { message: 'hi' },
  })).status, 404);
});

test('signing out invalidates the cookie for the next request', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);
  const out = await call(middleware, { method: 'POST', url: '/logout', headers: WRITE, cookie });
  assert.equal(out.status, 200);
  assert.match(out.cookies[0], /Max-Age=0/);
  assert.equal((await call(middleware, { url: '/plugins', cookie })).status, 401);
});

test('MCP settings toggle, and keys are minted once then listed without the token', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);

  const initial = await call(middleware, { url: '/mcp/settings', cookie });
  assert.deepEqual(
    { enabled: initial.body.enabled, endpoint: initial.body.endpoint, keys: initial.body.keys },
    { enabled: false, endpoint: '/api/admin/mcp', keys: [] },
  );

  const enabled = await call(middleware, {
    method: 'POST', url: '/mcp/settings', headers: WRITE, cookie, body: { enabled: true },
  });
  assert.equal(enabled.body.enabled, true);

  const created = await call(middleware, {
    method: 'POST', url: '/mcp/keys', headers: WRITE, cookie, body: { label: 'Laptop' },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.token.startsWith('gev_admin_'));
  assert.equal(created.body.key.token, undefined);

  const listed = await call(middleware, { url: '/mcp/settings', cookie });
  assert.equal(listed.body.keys.length, 1);
  assert.ok(!JSON.stringify(listed.body).includes(created.body.token), 'the token is never listed again');

  const revoked = await call(middleware, {
    method: 'DELETE', url: `/mcp/keys/${created.body.key.id}`, headers: WRITE, cookie,
  });
  assert.equal(revoked.body.revoked, true);
  assert.deepEqual(revoked.body.keys, []);
});

test('the MCP endpoint refuses GET, refuses while disabled, and refuses a bad key', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);

  assert.equal((await call(middleware, { url: '/mcp' })).status, 405);

  const disabled = await call(middleware, {
    method: 'POST', url: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.body.error.kind, 'disabled');

  await call(middleware, { method: 'POST', url: '/mcp/settings', headers: WRITE, cookie, body: { enabled: true } });

  const unauthenticated = await call(middleware, {
    method: 'POST', url: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers['WWW-Authenticate'], /Bearer/);

  const wrongKey = await call(middleware, {
    method: 'POST',
    url: '/mcp',
    headers: { authorization: 'Bearer gev_admin_not-a-real-key' },
    body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(wrongKey.status, 401);
});

test('an enabled MCP endpoint serves JSON-RPC to a valid API key, cookie or not', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);
  await call(middleware, { method: 'POST', url: '/mcp/settings', headers: WRITE, cookie, body: { enabled: true } });
  const created = await call(middleware, {
    method: 'POST', url: '/mcp/keys', headers: WRITE, cookie, body: { label: 'External' },
  });
  const authorization = `Bearer ${created.body.token}`;

  const tools = await call(middleware, {
    method: 'POST', url: '/mcp', headers: { authorization }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(tools.status, 200);
  assert.ok(tools.body.result.tools.some((tool) => tool.name === 'create_admin_plugin'));

  // The external caller drives a real build through the same builder.
  const call1 = await call(middleware, {
    method: 'POST',
    url: '/mcp',
    headers: { 'x-api-key': created.body.token },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_admin_plugin', arguments: { name: 'From MCP' } },
    },
  });
  assert.equal(call1.status, 200);
  assert.equal(JSON.parse(call1.body.result.content[0].text).name, 'From MCP');

  const listed = await call(middleware, { url: '/plugins', cookie });
  assert.equal(listed.body.plugins.length, 1, 'the browser console sees the externally started build');
});

test('an MCP notification gets 204 and no body', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);
  await call(middleware, { method: 'POST', url: '/mcp/settings', headers: WRITE, cookie, body: { enabled: true } });
  const created = await call(middleware, {
    method: 'POST', url: '/mcp/keys', headers: WRITE, cookie, body: { label: 'External' },
  });
  const response = await call(middleware, {
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${created.body.token}` },
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
});

test('an unknown admin route is a 404', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);
  assert.equal((await call(middleware, { url: '/nowhere', cookie })).status, 404);
});

test('Composio is not an admin route — signed-in /composio 404s, unconfigured still 503s', async () => {
  const { middleware } = harness();
  const cookie = await signIn(middleware);
  const signedIn = await call(middleware, { url: '/composio', cookie });
  assert.equal(signedIn.status, 404);
  assert.equal(signedIn.body.error.kind, 'route');

  const mcpSettings = await call(middleware, { url: '/mcp/settings', cookie });
  assert.equal(mcpSettings.status, 200);
  assert.equal(mcpSettings.body.endpoint, '/api/admin/mcp');

  const unconfigured = createAdminMiddleware({
    store: memoryStore(),
    auth: createAdminAuth({ credential: null, store: memoryStore() }),
    builder: stubBuilder(),
    live: stubLive(),
  });
  const blocked = await call(unconfigured, { url: '/composio' });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error.kind, 'unconfigured');
});

test('native Replit Login routes are delegated while protected ADMIN routes stay server-guarded', async () => {
  const calls = [];
  const replitAuth = {
    configured: true,
    authenticate: () => null,
    login: async (_req, res, returnTo) => {
      calls.push(['login', returnTo]);
      res.statusCode = 302;
      res.setHeader('Location', 'https://replit.com/oidc/auth');
      res.end();
    },
    callback: async (_req, res) => {
      calls.push(['callback']);
      res.statusCode = 302;
      res.setHeader('Location', '/?admin=1');
      res.end();
    },
    logout: () => calls.push(['logout']),
  };
  const middleware = createAdminMiddleware({
    replitAuth,
    auth: createAdminAuth({ credential: null, store: memoryStore() }),
    builder: stubBuilder(),
    live: stubLive(),
  });

  const login = await call(middleware, { url: '/login?returnTo=%2F%3Fadmin%3D1' });
  assert.equal(login.status, 302);
  assert.deepEqual(calls[0], ['login', '/?admin=1']);

  const callback = await call(middleware, { url: '/callback?code=abc&state=state' });
  assert.equal(callback.status, 302);
  assert.deepEqual(calls[1], ['callback']);

  const protectedRoute = await call(middleware, { url: '/plugins' });
  assert.equal(protectedRoute.status, 401);
  assert.equal(protectedRoute.body.error.kind, 'auth');
});

test('a successful login reports the session it just minted', async () => {
  const { middleware } = harness();
  // The request that carried the password has no session cookie on it, so the
  // response must describe the caller from the session just minted — otherwise
  // the console signs in and immediately renders itself signed out.
  const response = await call(middleware, {
    method: 'POST', url: '/login', headers: WRITE, body: { password: PASSWORD },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.authenticated, true);
  assert.ok(response.body.expiresAt, 'the console shows when the session lapses');
  assert.match(response.cookies[0], new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
});
