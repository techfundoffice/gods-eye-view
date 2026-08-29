/**
 * `GET /api/admin/menu` — the route the dashboard reads generated plugins
 * from. Kept in its own file, with its own doubles, so it stays readable
 * beside the broader `adminServer` suite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ADMIN_SESSION_COOKIE } from './adminAuth.js';
import { ADMIN_REQUEST_HEADER, createAdminMiddleware } from './adminServer.js';

/** A signed-in operator, unless `configured` says otherwise. */
function fakeAuth({ configured = true } = {}) {
  return {
    configured,
    login: () => ({ ok: true, sessionId: 'token', expiresAt: Date.now() + 1000 }),
    authenticate: (id) => (id === 'token' ? { id, expiresAt: Date.now() + 1000 } : null),
    logout: () => true,
    createApiKey: () => ({ token: '', record: {} }),
    listApiKeys: () => [],
    revokeApiKey: () => true,
    verifyApiKey: () => null,
    mcpEnabled: () => false,
    setMcpEnabled: () => false,
  };
}

/** Builder double: the menu route must not touch the agent at all. */
function fakeBuilder() {
  return {
    command: 'claude',
    list: () => [],
    start: () => ({ id: 'job' }),
    get: () => null,
    send: () => null,
    cancel: () => false,
  };
}

const fakeLive = { status: () => ({ status: 'idle' }), start: async () => ({}), stop: async () => ({}) };

/** Minimal Node response double. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(chunk) { this.body = chunk ? String(chunk) : ''; this.writableEnded = true; },
  };
}

/**
 * Node request double. The body is delivered on a later tick, the way a real
 * socket would, so routes that read one actually complete.
 *
 * @param {string} url Path under the `/api/admin` mount.
 * @param {object} [options]
 * @returns {object}
 */
function fakeReq(url, { method = 'GET', cookie = `${ADMIN_SESSION_COOKIE}=token`, headers = {}, body } = {}) {
  const request = new EventEmitter();
  Object.assign(request, {
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    socket: { remoteAddress: '::1' },
    destroy() {},
  });
  const payload = body === undefined ? '' : JSON.stringify(body);
  setImmediate(() => {
    if (payload) request.emit('data', Buffer.from(payload));
    request.emit('end');
  });
  return request;
}

/**
 * @param {object} [options]
 * @returns {{middleware: Function, calls: {manifest: number}}}
 */
function harness({ readManifest = () => [], configured = true } = {}) {
  const calls = { manifest: 0 };
  const middleware = createAdminMiddleware({
    auth: fakeAuth({ configured }),
    builder: fakeBuilder(),
    live: fakeLive,
    readManifest: (...args) => { calls.manifest += 1; return readManifest(...args); },
  });
  return { middleware, calls };
}

/**
 * @param {Function} middleware
 * @param {object} req
 * @returns {Promise<{status: number, body: object, cookie: string}>}
 */
async function call(middleware, req) {
  const res = fakeRes();
  await middleware(req, res, () => {});
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : {},
    cookie: String(res.headers['set-cookie'] || ''),
  };
}

test('the menu route reports the manifest entries the dashboard should load', async () => {
  const { middleware } = harness({
    readManifest: () => [
      { id: 'fleet-watchlist', label: 'Fleet Watchlist', description: 'Watch a fleet.', module: './fleet-watchlist.js' },
    ],
  });
  const { status, body } = await call(middleware, fakeReq('/menu'));
  assert.equal(status, 200);
  assert.deepEqual(body.plugins, [{
    id: 'fleet-watchlist',
    label: 'Fleet Watchlist',
    description: 'Watch a fleet.',
    module: './fleet-watchlist.js',
  }]);
});

test('the menu route normalizes what the agent wrote instead of trusting it', async () => {
  const { middleware } = harness({
    readManifest: () => [
      { id: 'Fleet Watchlist' },
      { id: 'traffic-notes', label: '  Traffic Notes  ', extra: 'dropped' },
      'garbage',
    ],
  });
  const { body } = await call(middleware, fakeReq('/menu'));
  assert.deepEqual(body.plugins, [{
    id: 'traffic-notes',
    label: 'Traffic Notes',
    description: '',
    module: './traffic-notes.js',
  }]);
});

test('the manifest is re-read per request, so a finished build needs no restart', async () => {
  let manifest = [];
  const { middleware, calls } = harness({ readManifest: () => manifest });
  assert.deepEqual((await call(middleware, fakeReq('/menu'))).body.plugins, []);
  manifest = [{ id: 'fleet-watchlist', label: 'Fleet Watchlist' }];
  assert.equal((await call(middleware, fakeReq('/menu'))).body.plugins.length, 1);
  assert.equal(calls.manifest, 2);
});

test('the menu is operator-only, and never reaches disk for a stranger', async () => {
  const { middleware, calls } = harness();
  const { status, body } = await call(middleware, fakeReq('/menu', { cookie: '' }));
  assert.equal(status, 401);
  assert.equal(body.error.kind, 'auth');
  assert.equal(calls.manifest, 0);
});

test('an unconfigured console reports itself rather than listing plugins', async () => {
  const { middleware, calls } = harness({
    configured: false,
    readManifest: () => [{ id: 'fleet-watchlist' }],
  });
  const { status, body } = await call(middleware, fakeReq('/menu'));
  assert.equal(status, 503);
  assert.equal(body.error.kind, 'unconfigured');
  assert.equal(calls.manifest, 0);
});

test('a manifest read that throws surfaces as a server error, not a crash', async () => {
  const { middleware } = harness({ readManifest: () => { throw new Error('disk gone'); } });
  const { status, body } = await call(middleware, fakeReq('/menu'));
  assert.equal(status, 500);
  assert.equal(body.error.message, 'disk gone');
});

test('the menu route is read-only', async () => {
  const { middleware } = harness();
  const { status, body } = await call(middleware, fakeReq('/menu', {
    method: 'POST',
    headers: { [ADMIN_REQUEST_HEADER]: '1' },
  }));
  assert.equal(status, 404);
  assert.equal(body.error.kind, 'route');
});

test('a successful login reports the session it just minted', async () => {
  const { middleware } = harness();
  // The password request carries no session cookie of its own, so the reply
  // has to describe the session just created — otherwise the console shows a
  // successful sign-in as still signed out and never opens the dashboard.
  const { status, body, cookie } = await call(middleware, fakeReq('/login', {
    method: 'POST',
    cookie: '',
    headers: { [ADMIN_REQUEST_HEADER]: '1' },
    body: { password: 'correct horse' },
  }));
  assert.equal(status, 200);
  assert.equal(body.authenticated, true);
  assert.ok(body.expiresAt, 'the console shows when the session lapses');
  assert.match(cookie, /gev_admin_session=token/);
});
