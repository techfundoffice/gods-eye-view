import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createInMemoryPublicCommandLedger } from './youtubePublicCommandLedger.js';
import {
  createYoutubePublicCommandRuntime,
  PUBLIC_EXECUTOR_HEADER,
} from './youtubePublicCommandRuntime.js';

function executorRequest({ method = 'GET', url = '/executor/lease', credential, remoteAddress = '127.0.0.1', host = '127.0.0.1:5000', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress };
  req.headers = { host, ...headers, ...(credential ? { [PUBLIC_EXECUTOR_HEADER]: credential } : {}) };
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
  return { req, res, body };
}

async function invoke(middleware, options) {
  const { req, res, body } = executorRequest(options);
  const pending = middleware(req, res);
  if (body != null) req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await pending;
  return res;
}

test('executor middleware only authorizes exact loopback connections and rejects forwarded or invalid hosts', async () => {
  const runtime = createYoutubePublicCommandRuntime({ ledger: createInMemoryPublicCommandLedger() });
  const session = await runtime.rotateExecutor();
  const middleware = runtime.middleware();
  for (const options of [
    { credential: session.credential, remoteAddress: '127.0.0.1', host: '127.0.0.1:5000' },
    { credential: session.credential, remoteAddress: '::1', host: '[::1]:5000' },
  ]) {
    const res = await invoke(middleware, options);
    assert.equal(res.statusCode, 200);
  }
  for (const options of [
    { credential: session.credential, remoteAddress: '10.0.0.5', host: '127.0.0.1:5000' },
    { credential: session.credential, remoteAddress: '127.0.0.1', host: 'app.example.replit.dev' },
    { credential: session.credential, remoteAddress: '127.0.0.1', host: 'localhost.evil:5000' },
    { credential: session.credential, remoteAddress: '127.0.0.1', host: '127.0.0.1:5000', headers: { 'x-forwarded-for': '127.0.0.1' } },
  ]) {
    const res = await invoke(middleware, options);
    assert.equal(res.statusCode, 403);
  }
});

test('executor lease is redeemed only once by compare-and-set', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({ id: 'comment', text: '/gods-eye-view', author: 'viewer' }, binding);
  const middleware = runtime.middleware({ getBinding: () => binding });
  const [one, two] = await Promise.all([
    invoke(middleware, { credential: session.credential }),
    invoke(middleware, { credential: session.credential }),
  ]);
  assert.equal([one.body.lease, two.body.lease].filter(Boolean).length, 1);
  assert.equal((await ledger.list())[0].state, 'executing');
});

test('executor rejects a result from an old capture epoch', async () => {
  const runtime = createYoutubePublicCommandRuntime({ ledger: createInMemoryPublicCommandLedger() });
  const old = await runtime.rotateExecutor();
  const current = await runtime.rotateExecutor();
  const res = await invoke(runtime.middleware(), {
    method: 'POST',
    url: '/executor/result',
    credential: current.credential,
    body: { commandId: 'anything', captureEpoch: old.captureEpoch, result: { ok: true } },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.kind, 'stale-executor');
});

test('verified to unverified transition cancels queued work before lease issue', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({ id: 'comment', text: '/gods-eye-view', author: 'viewer' }, binding);
  binding.commandsEnabled = false;
  const response = await invoke(runtime.middleware({ getBinding: () => binding }), {
    credential: session.credential,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.lease, null);
  assert.equal((await ledger.list())[0].state, 'cancelled');
});

test('unverified result submission cancels an already redeemed lease', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({ id: 'comment', text: '/gods-eye-view', author: 'viewer' }, binding);
  const middleware = runtime.middleware({ getBinding: () => binding });
  const leased = await invoke(middleware, { credential: session.credential });
  assert.ok(leased.body.lease);
  binding.commandsEnabled = false;
  const result = await invoke(middleware, {
    method: 'POST',
    url: '/executor/result',
    credential: session.credential,
    body: {
      commandId: leased.body.lease.commandId,
      captureEpoch: leased.body.lease.captureEpoch,
      result: { ok: true },
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error.kind, 'not-verified-live');
  assert.equal((await ledger.list())[0].state, 'cancelled');
});

test('video or generation changes cancel old nonterminal records', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  await runtime.rotateExecutor();
  await runtime.registerMessage(
    { id: 'comment', text: '/gods-eye-view', author: 'viewer' },
    { commandsEnabled: true, videoId: 'video-a', generation: 1 },
  );
  await runtime.statuses({ commandsEnabled: true, videoId: 'video-b', generation: 2 });
  assert.equal((await ledger.list())[0].state, 'cancelled');
});