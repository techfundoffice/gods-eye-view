import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { youtubeProxy } from '../vite.config.js';
import {
  ADMIN_SESSION_COOKIE,
  createAdminAuth,
  hashAdminPassword,
} from './adminAuth.js';
import { createAdminSessionAuthorizer } from './adminServer.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body = '') { this.body = body ? JSON.parse(body) : null; this.resolve?.(this); },
  };
}

function invoke(middleware, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers });
    const res = response();
    res.resolve = resolve;
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

test('production YouTube plugin explicitly wires verified isolation and ADMIN auth', async () => {
  const mounted = new Map();
  const oauth = {
    writeEnabled: false,
    middleware() {},
    proxy: async () => new Response(JSON.stringify({ items: [{ id: 'abcdefghijk', status: { lifeCycleStatus: 'live' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    authorizeRequest: async () => ({ sessionId: 'youtube', getAccessToken: async () => 'token' }),
  };
  const plugin = youtubeProxy({
    oauth,
    commentHarnessConfigured: true,
    commentHarnessInterpreter: async () => '{"kind":"reject","intent":null,"reason":"No","confidence":0}',
    adminAuthorization: {
      authorizeRequest: (req) => req.headers['x-test-admin'] ? { sub: 'owner' } : null,
    },
  });
  plugin.configureServer({
    middlewares: { use(path, handler) { mounted.set(path, handler); } },
  });

  const harness = mounted.get('/api/youtube-comment-harness');
  assert.equal((await invoke(harness, { url: '/status' })).statusCode, 401);
  const status = await invoke(harness, {
    url: '/status',
    headers: { 'x-test-admin': '1' },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.supportsToolIsolation, true);
  assert.equal(status.body.disabled, false);

  const liveChat = mounted.get('/api/youtube/live-chat');
  assert.equal((await invoke(liveChat, { url: '/?videoId=abcdefghijk' })).statusCode, 404);

  const homepageChat = mounted.get('/api/youtube/homepage-chat');
  assert.equal(typeof homepageChat, 'function');
  const feed = await invoke(homepageChat, { url: '/feed' });
  assert.equal(feed.statusCode, 200);
  assert.notEqual(feed.body?.error?.kind, 'authentication');
  assert.equal(feed.body?.error?.message, undefined);
  assert.equal(Array.isArray(feed.body?.items), true);
});

test('production YouTube routes accept the same valid password ADMIN cookie as the console', async () => {
  const passwordAuth = createAdminAuth({
    credential: {
      hash: hashAdminPassword('correct horse battery staple'),
      source: 'password',
    },
    store: {
      get() { return null; },
      set() {},
    },
  });
  const login = passwordAuth.login('correct horse battery staple', { clientId: 'test' });
  assert.equal(login.ok, true);
  const adminAuthorization = {
    authorizeRequest: createAdminSessionAuthorizer({
      auth: passwordAuth,
      replitAuth: { authenticate: () => null },
    }),
  };
  const mounted = new Map();
  const plugin = youtubeProxy({
    oauth: {
      writeEnabled: false,
      middleware() {},
      proxy: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      authorizeRequest: async () => ({ sessionId: 'youtube', getAccessToken: async () => 'token' }),
    },
    commentHarnessConfigured: true,
    commentHarnessInterpreter: async () => '{"kind":"reject","intent":null,"reason":"No","confidence":0}',
    adminAuthorization,
  });
  plugin.configureServer({
    middlewares: { use(path, handler) { mounted.set(path, handler); } },
  });
  const cookie = `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(login.sessionId)}`;
  const status = await invoke(mounted.get('/api/youtube-comment-harness'), {
    url: '/status',
    headers: { cookie },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.disabled, false);
});

test('production YouTube plugin mounts the unauthenticated homepage live-comment feed', async () => {
  const mounted = new Map();
  const plugin = youtubeProxy({
    oauth: {
      writeEnabled: false,
      middleware() {},
      proxy: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      authorizeRequest: async () => ({ sessionId: 'youtube', getAccessToken: async () => 'token' }),
    },
    commentHarnessConfigured: false,
  });
  plugin.configureServer({
    middlewares: { use(path, handler) { mounted.set(path, handler); } },
  });

  const homepageChat = mounted.get('/api/youtube/homepage-chat');
  assert.equal(typeof homepageChat, 'function');
  const feed = await invoke(homepageChat, { url: '/feed' });
  assert.equal(feed.statusCode, 200);
  assert.notEqual(feed.body?.error?.kind, 'authentication');
  assert.equal(feed.body?.error?.message, undefined);
  assert.equal(Array.isArray(feed.body?.items), true);
  assert.notEqual(mounted.get('/api/youtube'), homepageChat);
});
