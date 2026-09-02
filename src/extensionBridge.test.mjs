import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevExtensionBridge } from './extensionBridge.js';

function fakeWindow() {
  const listeners = new Map();
  return {
    location: { origin: 'https://gev.example' },
    sent: [],
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    postMessage(data, origin) { this.sent.push({ data, origin }); },
    emit(data, origin = 'https://gev.example') {
      listeners.get('message')?.({ source: this, origin, data });
    },
  };
}

const command = (overrides = {}) => ({
  id: 'comment-1',
  author: 'Viewer',
  text: '/x globe',
  command: '/x',
  kind: 'action',
  actions: [{ action: 'zoom_to_globe', args: {} }],
  ...overrides,
});

test('extension bridge forwards only policy-valid structured actions to the runner', async () => {
  const windowRef = fakeWindow();
  const calls = [];
  const nextchat = {
    publishViewerMessage() {},
    upsertLiveComment() {},
    updateAgentReply(payload) { this.reply = payload; },
    setHarnessStatus(message) { this.status = message; },
  };
  const bridge = createGevExtensionBridge({
    windowRef,
    nextchat,
    runner: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    now: () => 1_700_000_000_000,
  });
  bridge.start();
  windowRef.emit({ source: 'gev-chrome-extension', type: 'GEV_EXTENSION_COMMAND', payload: command() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ name: 'zoom_to_globe', args: {} }]);
  assert.equal(nextchat.reply.replyState, 'replied');
  assert.match(nextchat.status, /showing/);
  assert.equal(windowRef.sent[0].data.type, 'GEV_EXTENSION_RESULT');
});

test('extension bridge rejects arbitrary action names and ignores foreign origins', async () => {
  const windowRef = fakeWindow();
  const calls = [];
  const bridge = createGevExtensionBridge({
    windowRef,
    runner: async (...args) => { calls.push(args); return { ok: true }; },
    nextchat: { updateAgentReply(payload) { this.reply = payload; } },
  });
  bridge.start();
  windowRef.emit({ source: 'gev-chrome-extension', type: 'GEV_EXTENSION_COMMAND', payload: command({
    actions: [{ action: 'execute_javascript', args: { code: 'alert(1)' } }],
  }) });
  windowRef.emit({ source: 'gev-chrome-extension', type: 'GEV_EXTENSION_COMMAND', payload: command() }, 'https://evil.example');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('stop disables later commands until a new extension command arrives', async () => {
  const windowRef = fakeWindow();
  let calls = 0;
  const bridge = createGevExtensionBridge({
    windowRef,
    runner: async () => { calls += 1; return { ok: true }; },
  });
  bridge.start();
  windowRef.emit({ source: 'gev-chrome-extension', type: 'GEV_EXTENSION_STOP' });
  windowRef.emit({ source: 'gev-chrome-extension', type: 'GEV_EXTENSION_COMMAND', payload: command() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  windowRef.emit({ source: 'gev-chrome-extension', type: 'GEV_EXTENSION_STOP' });
  windowRef.emit({ source: 'gev-chrome-extension', type: 'GEV_EXTENSION_COMMAND', payload: command() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});