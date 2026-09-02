/**
 * Session/thread reducers plus homepage chrome structure pins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NEXTCHAT_STORAGE_KEY,
  NEXTCHAT_MAX_ACTIONS,
  NEXTCHAT_MAX_LIVE_COMMENTS,
  NEXTCHAT_MAX_PAIRED_ROWS,
  ACTION_REPLY_TYPE_STEP,
  applyActionReplyDelta,
  applyAssistantTranscriptDelta,
  createEmptySession,
  createNextchatState,
  createNextchatStore,
  extractAssistantTranscriptDelta,
  finishAssistantStreaming,
  getActiveSession,
  ingestRealtimePayload,
  isActionLaneMessage,
  isLiveCommentMessage,
  loadNextchatState,
  orderLiveCommentMessages,
  orderPairedRows,
  newChat,
  persistNextchatState,
  selectSession,
  appendUserMessage,
  appendViewerMessage,
  publishNextChatMessage,
  renderCommandLegend,
  sanitizeAuthorHandle,
  setHarnessStatus,
  setLiveBroadcast,
  typeActionReply,
  updateAgentReplyRow,
  upsertLiveCommentRow,
} from './nextchat.js';
import { PUBLIC_COMMAND_REGISTRY, PUBLIC_HELP_REPLY } from '../youtubePublicCommandPolicy.js';

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

test('LIVE COMMENTS display order is newest-first after chronological ingest', () => {
  let state = createNextchatState();
  state = appendViewerMessage(state, {
    author: 'FirstViewer',
    text: 'older comment',
    metadata: {
      source: 'youtube',
      commentId: 'c-old',
      videoId: 'vid',
      receivedAt: '2026-09-01T12:00:00.000Z',
      actionState: 'chat',
    },
  });
  state = appendViewerMessage(state, {
    author: 'SecondViewer',
    text: 'newer comment',
    metadata: {
      source: 'youtube',
      commentId: 'c-new',
      videoId: 'vid',
      receivedAt: '2026-09-01T12:00:05.000Z',
      actionState: 'chat',
    },
  });
  const ingested = getActiveSession(state).messages;
  assert.equal(ingested[0].content, 'older comment');
  assert.equal(ingested[1].content, 'newer comment');
  const displayed = orderLiveCommentMessages(ingested, { limit: NEXTCHAT_MAX_LIVE_COMMENTS });
  assert.equal(displayed.length, 2);
  assert.equal(displayed[0].content, 'newer comment');
  assert.equal(displayed[0].author, 'SecondViewer');
  assert.equal(displayed[1].content, 'older comment');
  assert.equal(isLiveCommentMessage(displayed[0]), true);
  assert.equal(isActionLaneMessage(displayed[0]), false);
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

test('broadcast overlay bounds comments/actions and renders the injected registry as text', () => {
  assert.equal(NEXTCHAT_MAX_LIVE_COMMENTS, 7);
  assert.equal(NEXTCHAT_MAX_ACTIONS, 3);
  assert.equal(NEXTCHAT_MAX_PAIRED_ROWS, 3);

  class FakeElement {
    constructor(ownerDocument, tagName = 'span') {
      this.ownerDocument = ownerDocument;
      this.tagName = tagName;
      this.children = [];
      this.attributes = new Map();
      this.className = '';
      this.textContent = '';
    }
    appendChild(child) {
      this.children.push(child);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    toggleAttribute(name, enabled) {
      if (enabled) this.attributes.set(name, '');
      else this.attributes.delete(name);
    }
    closest() {
      return this.legendRoot || null;
    }
  }
  const documentRef = {
    createElement(tagName) {
      return new FakeElement(documentRef, tagName);
    },
  };
  const root = new FakeElement(documentRef, 'nav');
  const target = new FakeElement(documentRef);
  target.legendRoot = root;
  const count = renderCommandLegend([
    { command: '/y', description: 'Analyze <only>' },
    { name: 'z', legend: 'Move camera' },
    { command: '/admin', description: 'hidden', public: false },
  ], target);

  assert.equal(count, 2);
  assert.equal(target.children[0].children[0].textContent, '/y');
  assert.equal(target.children[0].children[1].textContent, 'Analyze <only>');
  assert.equal(target.children[1].children[0].textContent, '/z');
  assert.equal(root.attributes.has('hidden'), false);
  assert.equal(renderCommandLegend([], target), 0);
  assert.equal(root.attributes.has('hidden'), true);
});

test('broadcast presentation keeps reserved comment chrome and a legend above the ticker', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  const commentIndex = html.indexOf('id="gev-nextchat-live-heading"');
  const replyIndex = html.indexOf('id="gev-nextchat-action-heading"');
  const pairsIndex = html.indexOf('id="gev-nextchat-pairs"');
  const legendIndex = html.indexOf('id="gev-command-legend"');
  const tickerIndex = html.indexOf('id="live-news-ticker"');

  assert.ok(commentIndex > 0 && commentIndex < replyIndex, 'LIVE COMMENTS heading is left of GEV AGENT REPLIES');
  assert.ok(pairsIndex > replyIndex, 'paired rows follow the sticky headings');
  assert.ok(legendIndex > pairsIndex && legendIndex < tickerIndex, 'legend is immediately before ticker');

  const liveLaneStart = css.indexOf('.gev-nextchat-live-lane {');
  const liveLane = css.slice(liveLaneStart, css.indexOf('}', liveLaneStart) + 1);
  assert.match(liveLane, /background: rgba\(6, 15, 22, 0\.62\)/);
  assert.doesNotMatch(liveLane, /background:\s*transparent/);
  const liveHeading = css.slice(css.indexOf('.gev-nextchat-live-lane > h3 {'), css.indexOf('.gev-nextchat-heading-legacy'));
  assert.match(liveHeading, /background: rgba\(18, 8, 10, 0\.88\)/);
  assert.match(liveHeading, /flex: 0 0 auto/);
  const liveRole = css.slice(css.indexOf('.gev-nextchat-live-lane .gev-nextchat-role {'), css.indexOf('.gev-nextchat-live-lane .gev-nextchat-text {'));
  assert.match(liveRole, /display: block/);
  assert.doesNotMatch(liveRole, /display:\s*inline/);
  const liveText = css.slice(css.indexOf('.gev-nextchat-live-lane .gev-nextchat-text {'), css.indexOf('.gev-nextchat-live-lane .gev-nextchat-timestamp {'));
  assert.match(liveText, /display: block/);
  assert.doesNotMatch(liveText, /display:\s*inline/);
  assert.match(css, /\.gev-nextchat-live-lane \.gev-nextchat-timestamp \{[\s\S]*?display:\s*none/);
  assert.match(css, /\.gev-nextchat-action-lane \{[\s\S]*?background: rgba\(6, 15, 22, 0\.76\)/);
  assert.match(css, /#gev-command-legend[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.gev-command-legend-items[\s\S]*?overflow-x:\s*auto/);
  assert.match(css, /font-size:\s*0\.875rem/);
  assert.match(css, /--broadcast-bottom-safe/);

  const overlayDecl = css.match(/--broadcast-overlay-width:\s*([^;]+);/);
  assert.ok(overlayDecl, 'LIVE COMMENTS overlay width token is defined');
  const overlayWidth = overlayDecl[1].trim();
  assert.match(
    overlayWidth,
    /^min\((\d+(?:\.\d+)?)rem,\s*calc\(100vw - 2rem\)\)$/,
    `desktop overlay width must be a finite rem cap, not full viewport: ${overlayWidth}`,
  );
  const rem = Number(overlayWidth.match(/^min\((\d+(?:\.\d+)?)rem/)[1]);
  assert.ok(Number.isFinite(rem) && rem > 0 && rem < 22, `LIVE COMMENTS must be narrower than 22rem, got ${rem}rem`);
  assert.match(
    css,
    /\.hud-top-right[\s\S]*?right:\s*calc\(var\(--broadcast-overlay-width\)/,
    'HUD right inset tracks the overlay-width token',
  );
  assert.match(
    css,
    /\.hud-right-edge[\s\S]*?right:\s*calc\(var\(--broadcast-overlay-width\)/,
    'HUD right-edge inset tracks the overlay-width token',
  );
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
  assert.doesNotMatch(html, /id="gev-nextchat-sessions"/);
  assert.match(html, /id="gev-nextchat-new"/);
  assert.match(html, /New chat/);
  assert.match(html, /id="gev-nextchat-pairs"/);
  assert.match(html, /YOUTUBE LIVE COMMENTS · ALL/);
  assert.match(html, /GEV AGENT REPLIES/);
  assert.match(html, /OPERATE FROM LIVE COMMENTS/);
  assert.match(css, /html, body \{[\s\S]*?overflow: hidden/);
  const pairsStart = css.indexOf('.gev-nextchat-pairs {');
  assert.ok(pairsStart >= 0, 'paired thread rule exists');
  const pairsBlock = css.slice(pairsStart, css.indexOf('}', pairsStart) + 1);
  assert.match(pairsBlock, /overflow:\s*hidden/);
  assert.doesNotMatch(pairsBlock, /overflow:\s*auto|overflow-y:\s*auto|overflow-x:\s*auto/);
  assert.match(css, /\/\* south-pole LIVE COMMENTS band \*\//);
  assert.match(css, /#command-dock #control-panel\.collapsed \.button-grid \{\s*display:\s*flex !important;/);
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

test('COMMANDS legend from the public registry starts with /help and includes /explore-manually', () => {
  class FakeElement {
    constructor(documentRef, tagName = 'span') {
      this.ownerDocument = documentRef;
      this.tagName = tagName;
      this.children = [];
      this.attributes = new Map();
      this.className = '';
      this.textContent = '';
    }
    appendChild(child) {
      this.children.push(child);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    toggleAttribute(name, enabled) {
      if (enabled) this.attributes.set(name, '');
      else this.attributes.delete(name);
    }
    closest() {
      return this.legendRoot || null;
    }
  }
  const documentRef = {
    createElement(tagName) {
      return new FakeElement(documentRef, tagName);
    },
  };
  const root = new FakeElement(documentRef, 'nav');
  const target = new FakeElement(documentRef);
  target.legendRoot = root;
  const count = renderCommandLegend(PUBLIC_COMMAND_REGISTRY, target);
  assert.equal(count, Object.keys(PUBLIC_COMMAND_REGISTRY).length);
  assert.equal(target.children[0].children[0].textContent, '/help');
  const commands = target.children.map((item) => item.children[0].textContent);
  assert.ok(commands.includes('/explore-manually'));
  assert.equal(commands.indexOf('/help'), 0);
});

test('typeActionReply prints the shipped /help sentence 2 characters at a time', () => {
  const store = createNextchatStore(memoryStorage());
  const queued = [];
  const clock = {
    setTimeout(fn) {
      queued.push(fn);
      return queued.length;
    },
    clearTimeout() {},
  };
  const result = typeActionReply(PUBLIC_HELP_REPLY, { store, clock });
  assert.equal(result.ok, true);
  assert.equal(getActiveSession(store.getState()).messages.length, 0);
  queued.shift()();
  let content = getActiveSession(store.getState()).messages.at(-1).content;
  assert.equal(content, PUBLIC_HELP_REPLY.slice(0, ACTION_REPLY_TYPE_STEP));
  while (queued.length) queued.shift()();
  const reply = getActiveSession(store.getState()).messages.at(-1);
  assert.equal(reply.content, PUBLIC_HELP_REPLY);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.streaming, false);
  assert.equal(reply.metadata.actionState, 'succeeded');
});

test('LIVE COMMENTS keeps /help viewer text and GEV ACTIONS keeps the typed reply', () => {
  let state = createNextchatState();
  state = appendViewerMessage(state, {
    author: 'ChatViewer',
    text: '/help',
    metadata: { source: 'youtube', actionState: 'chat' },
  });
  state = applyActionReplyDelta(state, {
    delta: PUBLIC_HELP_REPLY,
    actionState: 'succeeded',
  });
  const messages = getActiveSession(state).messages;
  assert.deepEqual(messages.filter(isLiveCommentMessage).map((message) => message.content), ['/help']);
  assert.deepEqual(messages.filter(isActionLaneMessage).map((message) => message.content), [PUBLIC_HELP_REPLY]);
  assert.equal(isLiveCommentMessage(messages[1]), false);
});

test('paired rows share one commentId and update the reply cell in place', () => {
  let state = setLiveBroadcast(createNextchatState(), { videoId: 'vid', generation: 3 });
  state = upsertLiveCommentRow(state, {
    commentId: 'c1',
    videoId: 'vid',
    generation: 3,
    author: 'marcusmanagementservices488',
    text: '/help',
    replyState: 'interpreting',
  }, 1000);
  assert.equal(state.pairedRows.length, 1);
  assert.equal(state.pairedRows[0].commentText, '/help');
  assert.equal(state.pairedRows[0].replyText, 'Interpreting request…');
  state = updateAgentReplyRow(state, {
    commentId: 'c1',
    videoId: 'vid',
    generation: 3,
    replyState: 'replied',
    replyText: PUBLIC_HELP_REPLY,
  }, 2000);
  assert.equal(state.pairedRows.length, 1);
  assert.match(state.pairedRows[0].replyText, /^marcusmanagementservices488\n/);
  assert.match(state.pairedRows[0].replyText, /\/live-contacts/);
  state = updateAgentReplyRow(state, {
    commentId: 'c1',
    videoId: 'other',
    generation: 3,
    replyState: 'replied',
    replyText: 'stale',
  }, 3000);
  assert.doesNotMatch(state.pairedRows[0].replyText, /stale/);
  state = upsertLiveCommentRow(state, {
    commentId: 'c2',
    videoId: 'vid',
    generation: 3,
    author: 'Ordinary',
    text: 'love the stream',
  }, 4000);
  assert.equal(state.pairedRows[0].commentText, 'love the stream');
  assert.equal(state.pairedRows[0].replyState, 'display');
  assert.equal(sanitizeAuthorHandle(''), '');
  assert.equal(sanitizeAuthorHandle('Cool Name'), '');
  assert.equal(sanitizeAuthorHandle('@verifiedHandle'), '@verifiedHandle');
  const ordered = orderPairedRows(state.pairedRows);
  assert.equal(ordered[0].commentId, 'c2');
});


test('a late /help reply moves that pair above a newer ordinary comment', () => {
  let state = setLiveBroadcast(createNextchatState(), { videoId: 'vid', generation: 1 });
  state = upsertLiveCommentRow(state, {
    commentId: 'help-1',
    videoId: 'vid',
    generation: 1,
    author: 'Helper',
    text: '/help',
    replyState: 'interpreting',
  }, 1000);
  state = upsertLiveCommentRow(state, {
    commentId: 'chat-2',
    videoId: 'vid',
    generation: 1,
    author: 'Later',
    text: 'nice stream',
    replyState: 'display',
  }, 2000);
  assert.equal(orderPairedRows(state.pairedRows)[0].commentId, 'chat-2');
  state = updateAgentReplyRow(state, {
    commentId: 'help-1',
    videoId: 'vid',
    generation: 1,
    replyState: 'replied',
    replyText: PUBLIC_HELP_REPLY,
  }, 3000);
  const ordered = orderPairedRows(state.pairedRows);
  assert.equal(ordered[0].commentId, 'help-1');
  assert.equal(ordered[1].commentId, 'chat-2');
});
