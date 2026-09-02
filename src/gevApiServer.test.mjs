import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createGevApiMiddleware } from './gevApiServer.js';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
  return res;
}

function getReq(url, { key = 'gev_test', method = 'GET', body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = key ? { authorization: `Bearer ${key}` } : {};
  queueMicrotask(() => {
    if (body != null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createAuth() {
  return {
    verifyApiKey(token) {
      return token === 'gev_test' ? { id: 'k1', label: 'test' } : null;
    },
  };
}

test('GET / lists every GEV function when authorized', async () => {
  const middleware = createGevApiMiddleware({ auth: createAuth() });
  const res = mockRes();
  await middleware(getReq('/'), res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.functions.some((fn) => fn.name === 'fly_to_location'));
});

test('missing API key is 401', async () => {
  const middleware = createGevApiMiddleware({ auth: createAuth() });
  const res = mockRes();
  await middleware(getReq('/', { key: '' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.kind, 'auth');
});

test('POST /fly_to_location queues on the live globe', async () => {
  const queued = [];
  const middleware = createGevApiMiddleware({
    auth: createAuth(),
    getBinding: () => ({ videoId: 'abc', generation: 1, commandsEnabled: true }),
    commandRuntime: {
      enqueueTool: async (tool, binding) => {
        queued.push({ tool, binding });
        return { ok: true, command: { id: 'cmd-1', state: 'awaiting-execution' } };
      },
    },
  });
  const res = mockRes();
  await middleware(getReq('/fly_to_location', {
    method: 'POST',
    body: { query: 'Reykjavik Iceland', viewMode: 'close' },
  }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(queued[0].tool.name, 'fly_to_location');
  assert.equal(queued[0].tool.args.query, 'Reykjavik Iceland');
  assert.equal(res.body.command.id, 'cmd-1');
});

test('POST while offline is 409', async () => {
  const middleware = createGevApiMiddleware({
    auth: createAuth(),
    getBinding: () => ({ videoId: '', commandsEnabled: false }),
    commandRuntime: {
      enqueueTool: async () => ({
        ok: false,
        error: { kind: 'offline', message: 'Go live before running GEV actions.' },
      }),
    },
  });
  const res = mockRes();
  await middleware(getReq('/zoom_to_globe', { method: 'POST', body: {} }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.kind, 'offline');
});
