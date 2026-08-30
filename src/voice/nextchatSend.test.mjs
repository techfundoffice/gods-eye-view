/**
 * Pins homepage composer send against the live GevRealtimeController.sendTextCommand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GevRealtimeController } from './gevRealtime.js';
import {
  createNextchatStore,
  ensureVoiceReady,
  ingestRealtimePayload,
  submitNextchatSend,
} from './nextchat.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

/**
 * Same open-channel stub style as src/voice/gevRealtime.test.mjs typed-command tests.
 * sendTextCommand is the real prototype method — only the data channel and
 * sendRealtimeEvent are stubbed so Node can observe the wire events.
 */
function textCommandController() {
  const sent = [];
  const controller = new GevRealtimeController({
    ui: {},
    runner: async () => ({}),
  });
  controller.dc = { readyState: 'open' };
  controller.sendRealtimeEvent = (event, label) => {
    sent.push({ label: label || event?.type, event });
    return true;
  };
  controller.debugLog = () => {};
  controller.cancelRadioHandoff = () => {};
  return { controller, sent };
}

function userTextFromSent(sent) {
  const item = sent.find((entry) => entry.label === 'client.user_text');
  return item?.event?.item?.content?.[0]?.text || null;
}

function assistantMessages(store) {
  return (store.getActiveSession()?.messages || []).filter((message) => message.role === 'assistant');
}

test('non-empty composer send calls live sendTextCommand with the typed text', async () => {
  const { controller, sent } = textCommandController();
  assert.equal(
    controller.sendTextCommand,
    GevRealtimeController.prototype.sendTextCommand,
    'the send helper must invoke the shipped method, not a stand-in',
  );
  const store = createNextchatStore(memoryStorage());
  const result = await submitNextchatSend({
    text: 'zoom to the globe',
    store,
    voice: controller,
  });
  assert.equal(result.ok, true);
  assert.equal(userTextFromSent(sent), 'zoom to the globe');
  assert.ok(sent.some((entry) => entry.label === 'client.response_create.user_text'));
  const user = store.getActiveSession().messages.find((message) => message.role === 'user');
  assert.equal(user.content, 'zoom to the globe');
  assert.equal(assistantMessages(store).length, 0);
});

test('empty and whitespace send do not call sendTextCommand', async () => {
  const { controller, sent } = textCommandController();
  const store = createNextchatStore(memoryStorage());
  const empty = await submitNextchatSend({ text: '', store, voice: controller });
  const space = await submitNextchatSend({ text: '   \n\t', store, voice: controller });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
  assert.equal(space.ok, false);
  assert.equal(space.reason, 'empty');
  assert.equal(sent.length, 0);
  assert.equal(store.getActiveSession().messages.length, 0);
});

test('unconnected send does not append a fake assistant message', async () => {
  const { controller, sent } = textCommandController();
  controller.dc = { readyState: 'closed' };
  controller.status = 'idle';
  controller.start = async () => {};
  const store = createNextchatStore(memoryStorage());
  const result = await submitNextchatSend({
    text: 'show earthquakes',
    store,
    voice: controller,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unconnected');
  assert.equal(sent.length, 0);
  assert.equal(assistantMessages(store).length, 0);
  assert.match(store.getState().unavailable || '', /not connected|unavailable/i);
});

test('HTTP 503 / start failure does not invent an assistant reply', async () => {
  const { controller, sent } = textCommandController();
  controller.dc = { readyState: 'closed' };
  controller.start = async () => {
    throw new Error('Realtime token failed: HTTP 503');
  };
  const store = createNextchatStore(memoryStorage());
  const result = await submitNextchatSend({
    text: 'annotate downtown Austin',
    store,
    voice: controller,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
  assert.equal(sent.length, 0);
  assert.equal(assistantMessages(store).length, 0);
  assert.match(store.getState().unavailable, /503|unavailable/i);
});

/**
 * Mirrors the shipped start() contract: dc exists after SDP but readyState
 * stays `connecting` until the later `open` event.
 */
function connectingDataChannel() {
  const listeners = { open: [], error: [], close: [] };
  return {
    readyState: 'connecting',
    addEventListener(type, fn) {
      listeners[type]?.push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    open() {
      this.readyState = 'open';
      for (const fn of listeners.open.slice()) fn();
    },
  };
}

function armConnectingStart(controller, dc) {
  controller.dc = dc;
  controller.status = 'idle';
  controller.start = async () => {
    controller.status = 'connecting';
    controller.dc = dc;
    setTimeout(() => {
      dc.open();
      controller.status = 'listening';
    }, 30);
  };
}

test('ensureVoiceReady waits for dc open after start returns connecting', async () => {
  const { controller } = textCommandController();
  const dc = connectingDataChannel();
  armConnectingStart(controller, dc);
  const readyPromise = ensureVoiceReady(controller);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dc.readyState, 'connecting', 'start() must return before the open event');
  const ready = await readyPromise;
  assert.equal(ready.ok, true);
  assert.equal(dc.readyState, 'open');
});

test('idle send waits for data-channel open after start before sendTextCommand', async () => {
  const { controller, sent } = textCommandController();
  const dc = connectingDataChannel();
  armConnectingStart(controller, dc);
  assert.equal(
    controller.sendTextCommand,
    GevRealtimeController.prototype.sendTextCommand,
    'the send helper must invoke the shipped method, not a stand-in',
  );
  const store = createNextchatStore(memoryStorage());
  const sendPromise = submitNextchatSend({
    text: 'show earthquakes',
    store,
    voice: controller,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dc.readyState, 'connecting');
  assert.equal(sent.length, 0, 'sendTextCommand must not run before dc open');
  const result = await sendPromise;
  assert.equal(result.ok, true);
  assert.equal(dc.readyState, 'open');
  assert.equal(userTextFromSent(sent), 'show earthquakes');
});

test('handleRealtimeEvent forwards assistant transcript deltas to onRealtimeEvent', async () => {
  const { controller } = textCommandController();
  const seen = [];
  controller.onRealtimeEvent = (payload) => seen.push(payload);
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.output_audio_transcript.delta',
      delta: 'Framing Earth.',
    }),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'response.output_audio_transcript.delta');
  assert.equal(seen[0].delta, 'Framing Earth.');
});

test('handleRealtimeEvent incremental deltas land in the active thread before done', async () => {
  const { controller } = textCommandController();
  const store = createNextchatStore(memoryStorage());
  controller.onRealtimeEvent = (payload) => ingestRealtimePayload(store, payload);
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.output_audio_transcript.delta',
      delta: 'Fram',
    }),
  });
  assert.equal(store.getActiveSession().messages.at(-1).content, 'Fram');
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.output_audio_transcript.delta',
      delta: 'ing Earth.',
    }),
  });
  assert.equal(store.getActiveSession().messages.at(-1).content, 'Framing Earth.');
  assert.equal(store.getActiveSession().messages.at(-1).streaming, true);
});

test('new chat does not replay the previous thread into sendTextCommand', async () => {
  const { controller, sent } = textCommandController();
  const store = createNextchatStore(memoryStorage());
  const first = await submitNextchatSend({
    text: 'zoom to the globe',
    store,
    voice: controller,
  });
  assert.equal(first.ok, true);
  const previous = store.newChat();
  assert.notEqual(previous.activeId, previous.previousId);
  assert.equal(store.getActiveSession().messages.length, 0);
  assert.ok(previous.previousMessages.some((message) => message.content === 'zoom to the globe'));
  sent.length = 0;
  const second = await submitNextchatSend({
    text: 'show earthquakes',
    store,
    voice: controller,
  });
  assert.equal(second.ok, true);
  assert.equal(userTextFromSent(sent), 'show earthquakes');
  assert.equal(sent.filter((entry) => entry.label === 'client.user_text').length, 1);
  const contents = sent
    .filter((entry) => entry.label === 'client.user_text')
    .map((entry) => entry.event.item.content[0].text);
  assert.deepEqual(contents, ['show earthquakes']);
});
