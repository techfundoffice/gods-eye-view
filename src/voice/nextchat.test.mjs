/**
 * Session/thread reducers plus homepage chrome structure pins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NEXTCHAT_STORAGE_KEY,
  applyAssistantTranscriptDelta,
  createEmptySession,
  createNextchatState,
  createNextchatStore,
  extractAssistantTranscriptDelta,
  finishAssistantStreaming,
  getActiveSession,
  ingestRealtimePayload,
  loadNextchatState,
  newChat,
  persistNextchatState,
  selectSession,
  appendUserMessage,
  appendViewerMessage,
  publishNextChatMessage,
  setHarnessStatus,
} from './nextchat.js';

function memoryStorage(seed) {
  const data = new Map(Object.entries(seed || {}));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

test('new chat creates an empty active session distinct from the previous thread', () => {
  let state = createNextchatState();
  const firstId = state.activeId;
  state = appendUserMessage(state, 'zoom to the globe');
  assert.equal(getActiveSession(state).messages[0].content, 'zoom to the globe');
  state = newChat(state);
  assert.notEqual(state.activeId, firstId);
  assert.equal(getActiveSession(state).messages.length, 0);
  assert.equal(getActiveSession(state).title, 'New chat');
  const previous = state.sessions.find((session) => session.id === firstId);
  assert.equal(previous.messages[0].content, 'zoom to the globe');
});

test('selecting a session exposes its user/assistant messages', () => {
  let state = createNextchatState();
  const firstId = state.activeId;
  state = appendUserMessage(state, 'zoom to the globe');
  state = applyAssistantTranscriptDelta(state, 'Framing Earth.');
  state = newChat(state);
  state = appendUserMessage(state, 'show earthquakes');
  assert.equal(getActiveSession(state).messages[0].content, 'show earthquakes');
  state = selectSession(state, firstId);
  const messages = getActiveSession(state).messages;
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'zoom to the globe');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'Framing Earth.');
});

test('assistant transcript deltas append incrementally before any done event', () => {
  let state = createNextchatState();
  state = appendUserMessage(state, 'zoom to the globe');
  state = applyAssistantTranscriptDelta(state, 'Fram');
  const afterFirst = getActiveSession(state).messages.at(-1);
  assert.equal(afterFirst.role, 'assistant');
  assert.equal(afterFirst.content, 'Fram');
  assert.equal(afterFirst.streaming, true);
  state = applyAssistantTranscriptDelta(state, 'ing Earth.');
  const afterSecond = getActiveSession(state).messages.at(-1);
  assert.equal(afterSecond.content, 'Framing Earth.');
  assert.equal(afterSecond.streaming, true);
  const done = { type: 'response.done' };
  assert.equal(extractAssistantTranscriptDelta(done), '');
  assert.equal(getActiveSession(state).messages.at(-1).content, 'Framing Earth.');
});

test('ingestRealtimePayload applies live transcript event names without waiting for done', () => {
  const store = createNextchatStore(memoryStorage());
  store.appendUserMessage('show earthquakes');
  ingestRealtimePayload(store, {
    type: 'response.output_audio_transcript.delta',
    delta: 'Enabling',
  });
  assert.equal(store.getActiveSession().messages.at(-1).content, 'Enabling');
  ingestRealtimePayload(store, {
    type: 'response.audio_transcript.delta',
    delta: ' earthquakes.',
  });
  assert.equal(store.getActiveSession().messages.at(-1).content, 'Enabling earthquakes.');
  ingestRealtimePayload(store, { type: 'response.output_audio_transcript.done' });
  assert.equal(store.getActiveSession().messages.at(-1).streaming, false);
  ingestRealtimePayload(store, { type: 'response.done' });
  assert.equal(store.getActiveSession().messages.at(-1).content, 'Enabling earthquakes.');
});

test('finishAssistantStreaming is not required to see the first delta', () => {
  let state = createNextchatState();
  state = applyAssistantTranscriptDelta(state, 'Hello');
  assert.equal(getActiveSession(state).messages[0].content, 'Hello');
  const beforeDone = getActiveSession(state).messages[0].content;
  state = finishAssistantStreaming(state);
  assert.equal(getActiveSession(state).messages[0].content, beforeDone);
});

test('persist fails open when storage is blocked', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const loaded = loadNextchatState(blocked);
  assert.ok(loaded.sessions.length >= 1);
  assert.equal(getActiveSession(loaded).messages.length, 0);
  assert.equal(persistNextchatState(loaded, blocked), false);
  const store = createNextchatStore(blocked);
  store.appendUserMessage('zoom to the globe');
  assert.equal(store.getActiveSession().messages[0].content, 'zoom to the globe');
});

test('a working store round-trips sessions under godsEyeView.nextchat.sessions.v1', () => {
  const storage = memoryStorage();
  const store = createNextchatStore(storage);
  store.appendUserMessage('zoom to the globe');
  const raw = storage.getItem(NEXTCHAT_STORAGE_KEY);
  assert.ok(raw);
  const restored = createNextchatStore(storage);
  assert.equal(restored.getActiveSession().messages[0].content, 'zoom to the globe');
});

test('extractAssistantTranscriptDelta ignores non-transcript events', () => {
  assert.equal(extractAssistantTranscriptDelta(null), '');
  assert.equal(extractAssistantTranscriptDelta({ type: 'response.done' }), '');
  assert.equal(extractAssistantTranscriptDelta({
    type: 'response.function_call_arguments.done',
    delta: 'nope',
  }), '');
  assert.equal(extractAssistantTranscriptDelta({
    type: 'response.output_text.delta',
    delta: 'Hi',
  }), 'Hi');
});

test('viewer comments keep the author and are not treated as the operator', () => {
  let state = createNextchatState();
  state = appendViewerMessage(state, {
    author: 'CruiseWatcher',
    text: '#Task view Ensenada Port',
    metadata: { source: 'comment', commentId: 'yt-1', videoId: 'v1', receivedAt: '2026-08-30T00:00:00.000Z' },
  });
  const message = getActiveSession(state).messages[0];
  assert.equal(message.role, 'viewer');
  assert.equal(message.author, 'CruiseWatcher');
  assert.equal(message.content, '#Task view Ensenada Port');
  state = setHarnessStatus(state, 'APPLIED · Close view of Ensenada Port');
  assert.match(state.harnessStatus, /APPLIED/);
});

test('publishNextChatMessage refuses HTML injection by storing plain text', () => {
  const store = createNextchatStore(memoryStorage());
  const result = publishNextChatMessage({
    author: 'CruiseWatcher',
    text: '<img src=x onerror=alert(1)> **bold**',
  }, store);
  assert.equal(result.ok, true);
  assert.equal(store.getActiveSession().messages[0].content, '<img src=x onerror=alert(1)> **bold**');
  assert.equal(publishNextChatMessage({ author: 'x', text: 'hi' }, null).ok, false);
});

test('createEmptySession starts with no messages to replay', () => {
  const session = createEmptySession(1);
  assert.equal(session.messages.length, 0);
  assert.equal(session.title, 'New chat');
});

test('homepage chrome keeps the globe, GEV MIC, and NextChat controls', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const nextchat = readFileSync(new URL('./nextchat.js', import.meta.url), 'utf8');
  const realtime = readFileSync(new URL('./gevRealtime.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');

  assert.match(html, /id="cesiumContainer"/);
  assert.match(realtime, /id="gev-voice-button"/);
  assert.match(realtime, /gev-mic-label/);
  assert.match(realtime, /command-dock/);

  assert.match(html, /id="gev-nextchat"/);
  assert.match(html, /id="gev-nextchat-sessions"/);
  assert.match(html, /session list/i);
  assert.match(html, /id="gev-nextchat-new"/);
  assert.match(html, /New chat/);
  assert.match(html, /id="gev-nextchat-thread"/);
  assert.match(html, /user\/assistant thread/i);
  assert.match(html, /id="gev-nextchat-composer"/);
  assert.match(html, /<textarea[^>]*id="gev-nextchat-composer"/);
  assert.match(html, /id="gev-nextchat-send"/);
  assert.match(html, />Send</);

  assert.match(nextchat, /sendTextCommand/);
  assert.match(nextchat, /submitNextchatSend/);
  assert.doesNotMatch(nextchat, /\/api\/chat/);
  assert.match(main, /initNextchat/);
  assert.match(css, /#gev-nextchat/);
});

test('GEV_REALTIME_TOOLS stays a literal array and chat is not a /api/chat backend', () => {
  const vite = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
  assert.match(vite, /const GEV_REALTIME_TOOLS = \[/);
  assert.doesNotMatch(vite, /['"`]\/api\/chat\b/);
  const nextchat = readFileSync(new URL('./nextchat.js', import.meta.url), 'utf8');
  assert.match(nextchat, /voice\.sendTextCommand\(text\)/);
});
