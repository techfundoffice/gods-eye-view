import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { adminConsoleApi } from '../vite.config.js';
import { ADMIN_SESSION_COOKIE } from './adminAuth.js';
import { createComposioAdminService } from './composioAdminServer.js';

function adminFacade() {
  return {
    configured: true,
    authenticate: (sessionId) => sessionId === 'test-session'
      ? { id: sessionId, expiresAt: Date.now() + 60_000 }
      : null,
    mcpEnabled: () => false,
    listApiKeys: () => [],
  };
}

function mountedMiddleware(composio) {
  let middleware = null;
  adminConsoleApi({
    version: 'test',
    admin: { store: null, auth: adminFacade(), replitAuth: null },
    composio,
    live: { status: () => ({ status: 'idle' }) },
    youtubeAuth: { authorizeRequest: async () => null, proxy: null },
  }).configureServer({
    middlewares: {
      use(path, handler) {
        assert.equal(path, '/api/admin');
        middleware = handler;
      },
    },
  });
  assert.equal(typeof middleware, 'function');
  return middleware;
}

function call(middleware, url) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = url;
    req.headers = { cookie: `${ADMIN_SESSION_COOKIE}=test-session` };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) {
        resolve({
          status: this.statusCode,
          body: text ? JSON.parse(text) : null,
        });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

test('the production ADMIN plugin injects and reaches its configured Composio facade', async () => {
  let calls = 0;
  const composio = {
    configured: true,
    status: async () => {
      calls += 1;
      return {
        configured: true,
        state: 'connected',
        health: 'healthy',
        accounts: [],
        tools: [],
        capabilities: [],
      };
    },
  };
  const response = await call(mountedMiddleware(composio), '/composio/status');
  assert.equal(response.status, 200);
  assert.equal(response.body.composio.state, 'connected');
  assert.equal(calls, 1);
});

test('the production ADMIN plugin reports an absent Composio key as unconfigured metadata', async () => {
  const composio = createComposioAdminService({
    apiKey: '',
    allowedTools: [],
    fetchImpl: async () => { throw new Error('must not call upstream'); },
  });
  const response = await call(mountedMiddleware(composio), '/composio/status');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.composio, {
    configured: false,
    state: 'unconfigured',
    health: 'not-configured',
    accounts: [],
    tools: [],
    capabilities: [],
  });
});