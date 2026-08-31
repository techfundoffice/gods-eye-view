import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGevActionRunner } from './voice/gevActions.js';
import {
  createNextchatStore,
  initNextchat,
  publishNextChatMessage,
} from './voice/nextchat.js';
import {
  boundedViewSummary,
  createEmptyCounters,
  createYoutubeCommentHarness,
  detectUnsafeInterpretation,
  HARNESS_LABEL,
  HARNESS_MAX_QUEUE,
  HARNESS_MAX_TEXT,
  normalizeIncomingMessage,
  parseTaskMarker,
  rejectInterpretation,
  resolveGevActionRunner,
  toolIsolationState,
  harnessOperatorStatus,
  validateHarnessInterpretation,
} from './youtubeCommentHarness.js';
import { createYoutubeCommentHarnessMiddleware } from './youtubeCommentHarnessServer.js';

const CRUISE_COMMENT = '#Task view the street view of the Ensenada Port where a Royal Caribbean cruise ship is docked';

function memoryStorage(seed) {
  const data = new Map(Object.entries(seed || {}));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
  };
}

function stubViewer() {
  return {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      positionWC: { x: 1, y: 1, z: 1 },
    },
    clock: { onTick: { addEventListener() { return () => {}; } } },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, addEventListener() {}, removeEventListener() {} },
      requestRender() {},
    },
    trackedEntity: null,
  };
}

function makeHarness(overrides = {}) {
  const published = [];
  const statuses = [];
  const runnerCalls = [];
  let now = overrides.nowValue ?? 10_000;
  const harness = createYoutubeCommentHarness({
    now: () => now,
    supportsToolIsolation: true,
    nextChat: {
      queue: [],
      available: () => true,
      publish(payload) {
        published.push(payload);
        return { ok: true };
      },
      setStatus(text) { statuses.push(text); },
    },
    runner: async (action, args, opts) => {
      runnerCalls.push({ action, args, opts });
      return { ok: true, action, label: args?.query || action };
    },
    interpret: async (comment) => ({
      kind: 'view_request',
      intent: { action: 'zoom_to_globe', args: {} },
      reason: `Interpreted ${comment.taskBody}`,
      confidence: 0.9,
    }),
    ...overrides,
  });
  return {
    harness,
    published,
    statuses,
    runnerCalls,
    advance(ms) { now += ms; },
    get now() { return now; },
    set now(value) { now = value; },
  };
}

test('incoming YouTube items normalize to schemaVersion 1 and keep the author', () => {
  const message = normalizeIncomingMessage({
    id: 'yt-comment-1',
    author: 'CruiseWatcher',
    text: `Hello\u0000 ${'x'.repeat(700)}`,
    publishedAt: '2026-08-30T12:00:00.000Z',
    authorChannelId: 'UC123',
  }, { source: 'comment', videoId: 'video-1' });
  assert.equal(message.schemaVersion, 1);
  assert.equal(message.source, 'comment');
  assert.equal(message.commentId, 'yt-comment-1');
  assert.equal(message.videoId, 'video-1');
  assert.equal(message.author.displayName, 'CruiseWatcher');
  assert.equal(message.author.channelId, 'UC123');
  assert.equal(message.text.includes('\u0000'), false);
  assert.equal(message.text.length, HARNESS_MAX_TEXT);
  assert.equal(message.receivedAt, '2026-08-30T12:00:00.000Z');
});

test('live chat source and nested YouTube payloads preserve provider ids', () => {
  const message = normalizeIncomingMessage({
    id: 'lc-9',
    snippet: { displayMessage: 'Ahoy!', publishedAt: '2026-08-30T12:01:00Z' },
    authorDetails: { displayName: 'DockHand', channelId: 'UC9' },
  }, { source: 'chat', videoId: 'video-2' });
  assert.equal(message.source, 'liveChat');
  assert.equal(message.commentId, 'lc-9');
  assert.equal(message.author.displayName, 'DockHand');
  assert.equal(message.author.channelId, 'UC9');
  assert.equal(message.text, 'Ahoy!');
});

test('#Task marker parsing is case-insensitive and strips only the marker', () => {
  assert.deepEqual(parseTaskMarker('#Task fly to Ensenada'), { isTask: true, body: 'fly to Ensenada', marker: '#Task' });
  assert.equal(parseTaskMarker('#task: street view please').body, 'street view please');
  assert.equal(parseTaskMarker('#TASK - zoom out').body, 'zoom out');
  assert.equal(parseTaskMarker('  #Task:  hello').isTask, true);
  assert.equal(parseTaskMarker('please #Task fly there').isTask, false);
  assert.equal(parseTaskMarker('Nice stream').isTask, false);
  assert.equal(parseTaskMarker('#Taskview the port').isTask, false);
});

test('structured interpretation rejects prose, fences, URLs, shell, files, and unknown actions', () => {
  assert.equal(validateHarnessInterpretation('sure, I will fly there').ok, false);
  assert.equal(validateHarnessInterpretation('```json\n{"kind":"view_request"}\n```').ok, false);
  assert.equal(validateHarnessInterpretation({
    kind: 'view_request',
    intent: { action: 'fly_to_location', args: { query: 'https://evil.example' } },
    reason: 'link',
    confidence: 0.9,
  }).ok, false);
  assert.equal(validateHarnessInterpretation('{"kind":"view_request","intent":{"action":"fly_to_location"},"reason":"rm -rf /","confidence":1}').ok, false);
  assert.equal(validateHarnessInterpretation({
    kind: 'view_request',
    intent: { action: 'edit_file', args: { path: 'src/main.js' } },
    reason: 'hack',
    confidence: 0.9,
  }).ok, false);
  assert.equal(validateHarnessInterpretation({
    kind: 'view_request',
    intent: { action: 'fly_to_location', args: { query: 'Ensenada Port' } },
    reason: 'ok',
    confidence: 0.2,
  }).ok, false);
  const good = validateHarnessInterpretation({
    kind: 'view_request',
    intent: { action: 'fly_to_location', args: { query: 'Ensenada Port' } },
    reason: 'Port view',
    confidence: 0.91,
  });
  assert.equal(good.ok, true);
  assert.equal(good.reason, 'Port view');
  assert.deepEqual(good.intent.args, { query: 'Ensenada Port', viewMode: 'close' });
  assert.equal(detectUnsafeInterpretation('call tool_calls now'), 'Hidden tool calls are rejected');
  assert.equal(rejectInterpretation('nope').kind, 'reject');
});

test('CruiseWatcher Ensenada #Task displays, strips the marker, validates, and dispatches once', async () => {
  const { harness, published, runnerCalls } = makeHarness({
    interpret: async (comment) => {
      assert.equal(comment.author.displayName, 'CruiseWatcher');
      assert.equal(comment.commentId, 'yt-ensenada');
      assert.doesNotMatch(comment.taskBody, /#Task/i);
      assert.match(comment.taskBody, /Ensenada Port/);
      assert.match(comment.text, /#Task/);
      return {
        kind: 'view_request',
        intent: { action: 'fly_to_location', args: { query: 'Ensenada Port' } },
        reason: 'Close view of Ensenada Port',
        confidence: 0.93,
      };
    },
  });
  harness.setEnabled(true);
  harness.setVideo({ id: 'video-live', title: 'Go live' });
  await harness.ingest([{
    id: 'yt-ensenada',
    author: 'CruiseWatcher',
    text: CRUISE_COMMENT,
  }], { source: 'comment', videoId: 'video-live' });

  assert.equal(published.length, 1);
  assert.equal(published[0].role, 'viewer');
  assert.equal(published[0].author, 'CruiseWatcher');
  assert.equal(published[0].text, CRUISE_COMMENT);
  assert.equal(published[0].metadata.commentId, 'yt-ensenada');
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].action, 'fly_to_location');
  assert.equal(runnerCalls[0].args.query, 'Ensenada Port');
  assert.equal(runnerCalls[0].args.viewMode, 'close');
  const snap = harness.getSnapshot();
  assert.equal(snap.counters.received, 1);
  assert.equal(snap.counters.displayed, 1);
  assert.equal(snap.counters.accepted, 1);
  assert.match(snap.recentTasks[0].decision, /accepted/);
  assert.match(snap.status, /APPLIED/);
});

test('non-#Task, duplicate, rate-limited, and reject intents display without running GEV', async () => {
  const { harness, published, runnerCalls, advance } = makeHarness({
    interpret: async () => ({
      kind: 'reject',
      intent: null,
      reason: 'Ambiguous request',
      confidence: 0,
    }),
  });
  harness.setEnabled(true);
  harness.setVideo({ id: 'video-1' });
  await harness.ingest([{ id: 'c1', author: 'Ada', text: 'hello from chat' }], { videoId: 'video-1' });
  assert.equal(published.length, 1);
  assert.equal(runnerCalls.length, 0);

  await harness.ingest([{ id: 'c1', author: 'Ada', text: 'hello from chat' }], { videoId: 'video-1' });
  assert.equal(published.length, 1);
  assert.equal(harness.getSnapshot().counters.received, 2);

  await harness.ingest([{ id: 'c2', author: 'Ada', text: '#Task do something vague' }], { videoId: 'video-1' });
  assert.equal(published[1].author, 'Ada');
  assert.equal(runnerCalls.length, 0);
  assert.equal(harness.getSnapshot().counters.rejected, 1);

  advance(100);
  await harness.ingest([{ id: 'c3', author: 'Ada', text: '#Task fly to Ensenada' }], { videoId: 'video-1' });
  assert.equal(runnerCalls.length, 0);
  assert.ok(harness.getSnapshot().counters.rateLimited >= 1);
});

test('queue bounds drop extra #Task items as rate-limited', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { harness, runnerCalls } = makeHarness({
    interpret: async () => {
      await gate;
      return { kind: 'reject', reason: 'later', confidence: 0 };
    },
  });
  harness.setEnabled(true);
  const items = Array.from({ length: HARNESS_MAX_QUEUE + 2 }, (_, index) => ({
    id: `q${index}`,
    author: `Viewer${index}`,
    text: `#Task item ${index}`,
  }));
  const pending = harness.ingest(items, { videoId: 'video-1' });
  release();
  await pending;
  const snap = harness.getSnapshot();
  assert.equal(snap.counters.displayed, HARNESS_MAX_QUEUE + 2);
  assert.ok(snap.counters.rateLimited >= 1);
  assert.equal(runnerCalls.length, 0);
});

test('missing tool isolation leaves the harness disabled and never starts interpret', async () => {
  let interpretCalls = 0;
  const { harness, runnerCalls, published } = makeHarness({
    supportsToolIsolation: false,
    interpret: async () => {
      interpretCalls += 1;
      throw new Error('must not start an agent session');
    },
  });
  const isolation = toolIsolationState(false, true);
  assert.equal(isolation.ok, false);
  harness.setEnabled(true);
  const snap = harness.getSnapshot();
  assert.equal(snap.enabled, false);
  assert.match(snap.status, /tool-less|DISABLED/i);
  await harness.ingest([{ id: 't1', author: 'Ada', text: '#Task fly to Ensenada' }]);
  assert.equal(published.length, 1);
  assert.equal(interpretCalls, 0);
  assert.equal(runnerCalls.length, 0);
});

test('an unconfigured unsafe adapter still names the empty tool surface', () => {
  const state = toolIsolationState(false, false);
  assert.equal(state.ok, false);
  assert.match(state.reason, /not configured/i);
  assert.match(state.reason, /tool-less/i);
  assert.match(harnessOperatorStatus({
    isolationOk: false,
    isolationReason: state.reason,
    status: 'YOUTUBE DISCONNECTED',
  }), /tool-less/i);
});

test('setConfigured on an unsafe adapter keeps the empty tool-surface explanation', () => {
  const harness = createYoutubeCommentHarness({
    supportsToolIsolation: false,
    configured: true,
    interpret: async () => { throw new Error('must not start an agent session'); },
    runner: async () => { throw new Error('must not run'); },
  });
  const snap = harness.setConfigured(false);
  assert.equal(snap.isolationOk, false);
  assert.equal(snap.enabled, false);
  assert.match(snap.isolationReason, /not configured/i);
  assert.match(snap.isolationReason, /tool-less/i);
  assert.match(snap.status, /not configured/i);
  assert.match(snap.status, /tool-less/i);
  assert.doesNotMatch(snap.status, /YOUTUBE DISCONNECTED/);
});

test('refreshYoutube keeps the tool-isolation explanation when YouTube is disconnected', async () => {
  const isolation = toolIsolationState(false, true);
  let statusCalls = 0;
  const harness = createYoutubeCommentHarness({
    supportsToolIsolation: false,
    interpret: async () => { throw new Error('must not start an agent session'); },
    runner: async () => { throw new Error('must not run'); },
    youtubeSource: {
      async status() {
        statusCalls += 1;
        return { connected: false, configured: true };
      },
    },
  });
  assert.match(harness.getSnapshot().status, /tool-less/i);
  const snap = await harness.refreshYoutube();
  assert.equal(statusCalls, 1);
  assert.equal(snap.isolationOk, false);
  assert.equal(snap.enabled, false);
  assert.equal(snap.connection, 'disconnected');
  assert.equal(snap.status, `DISABLED · ${isolation.reason}`);
  assert.doesNotMatch(snap.status, /YOUTUBE DISCONNECTED/);
  assert.equal(harnessOperatorStatus({
    isolationOk: false,
    isolationReason: isolation.reason,
    status: 'YOUTUBE DISCONNECTED',
  }), `DISABLED · ${isolation.reason}`);
});

test('refreshYoutube keeps the tool-isolation explanation when YouTube is unavailable', async () => {
  const isolation = toolIsolationState(false, true);
  const harness = createYoutubeCommentHarness({
    supportsToolIsolation: false,
    interpret: async () => { throw new Error('must not start an agent session'); },
    runner: async () => { throw new Error('must not run'); },
    youtubeSource: {
      async status() {
        return { connected: false, configured: false };
      },
    },
  });
  const snap = await harness.refreshYoutube();
  assert.equal(snap.isolationOk, false);
  assert.equal(snap.enabled, false);
  assert.equal(snap.connection, 'unavailable');
  assert.equal(snap.status, `DISABLED · ${isolation.reason}`);
  assert.doesNotMatch(snap.status, /YOUTUBE UNAVAILABLE/);
});

test('refreshYoutube reports disconnected on STATUS when isolation is ok', async () => {
  const harness = createYoutubeCommentHarness({
    supportsToolIsolation: true,
    interpret: async () => { throw new Error('must not interpret while disabled'); },
    runner: async () => { throw new Error('must not run'); },
    youtubeSource: {
      async status() {
        return { connected: false, configured: true };
      },
    },
  });
  const snap = await harness.refreshYoutube();
  assert.equal(snap.isolationOk, true);
  assert.equal(snap.connection, 'disconnected');
  assert.equal(snap.status, 'YOUTUBE DISCONNECTED');
});

test('stale completion after disable, video change, or destroy does not call the runner', async () => {
  let resolveIntent;
  const { harness, runnerCalls } = makeHarness({
    interpret: () => new Promise((resolve) => { resolveIntent = resolve; }),
  });
  harness.setEnabled(true);
  const pending = harness.ingest([{ id: 'stale', author: 'Ada', text: '#Task zoom to the globe' }], { videoId: 'v1' });
  for (let i = 0; i < 10 && typeof resolveIntent !== 'function'; i += 1) await Promise.resolve();
  assert.equal(typeof resolveIntent, 'function');
  harness.setEnabled(false);
  resolveIntent({
    kind: 'view_request',
    intent: { action: 'zoom_to_globe', args: {} },
    reason: 'late',
    confidence: 1,
  });
  await pending;
  assert.equal(runnerCalls.length, 0);

  let resolveTwo;
  const second = makeHarness({
    interpret: () => new Promise((resolve) => { resolveTwo = resolve; }),
  });
  second.harness.setEnabled(true);
  second.harness.setVideo({ id: 'v1' });
  const pendingTwo = second.harness.ingest([{ id: 'vchange', author: 'Ada', text: '#Task zoom to the globe' }], { videoId: 'v1' });
  for (let i = 0; i < 10 && typeof resolveTwo !== 'function'; i += 1) await Promise.resolve();
  assert.equal(typeof resolveTwo, 'function');
  second.harness.setVideo({ id: 'v2', title: 'Other' });
  resolveTwo({
    kind: 'view_request',
    intent: { action: 'zoom_to_globe', args: {} },
    reason: 'late',
    confidence: 1,
  });
  await pendingTwo;
  assert.equal(second.runnerCalls.length, 0);

  let resolveThree;
  const third = makeHarness({
    interpret: () => new Promise((resolve) => { resolveThree = resolve; }),
  });
  third.harness.setEnabled(true);
  const pendingThree = third.harness.ingest([{ id: 'dead', author: 'Ada', text: '#Task zoom to the globe' }]);
  for (let i = 0; i < 10 && typeof resolveThree !== 'function'; i += 1) await Promise.resolve();
  assert.equal(typeof resolveThree, 'function');
  third.harness.destroy();
  resolveThree({
    kind: 'view_request',
    intent: { action: 'zoom_to_globe', args: {} },
    reason: 'late',
    confidence: 1,
  });
  await pendingThree;
  assert.equal(third.runnerCalls.length, 0);
});

test('accepted allowlisted intent dispatches through createGevActionRunner', async () => {
  const enabledCalls = [];
  const enabledLayers = new Set();
  const dataManager = {
    layers: new Map([['earthquakes', { module: {} }]]),
    isEnabled: (layerId) => enabledLayers.has(layerId),
    async setEnabled(layerId, enabled) {
      enabledCalls.push({ layerId, enabled });
      if (enabled) enabledLayers.add(layerId);
      else enabledLayers.delete(layerId);
      return true;
    },
    getAll: () => [{ id: 'earthquakes', name: 'Earthquakes', enabled: enabledLayers.has('earthquakes') }],
  };
  const inner = createGevActionRunner({
    viewer: stubViewer(),
    styleManager: {},
    dataManager,
  });
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const prior = globalThis.window;
  globalThis.window = {
    __godsEyeView: { voiceCommands: { runner: inner } },
    setTimeout,
    clearTimeout,
  };
  try {
    assert.equal(resolveGevActionRunner(), inner);
    const { harness } = makeHarness({
      runner: undefined,
      interpret: async () => ({
        kind: 'view_request',
        intent: { action: 'set_layer_visibility', args: { layerId: 'earthquakes', enabled: true } },
        reason: 'Show quakes',
        confidence: 0.9,
      }),
    });
    harness.setEnabled(true);
    const snap = await harness.ingest([{ id: 'layer-1', author: 'Ada', text: '#Task show earthquakes' }]);
    assert.equal(snap.status, snap.status);
    assert.deepEqual(enabledCalls, [{ layerId: 'earthquakes', enabled: true }], snap.status);
    assert.equal(snap.counters.accepted, 1, `${snap.status} ${JSON.stringify(snap.recentTasks)}`);
  } finally {
    if (hadWindow) globalThis.window = prior;
    else delete globalThis.window;
  }
});

test('NextChat unavailable keeps a bounded local queue and still runs GEV checks', async () => {
  const queue = [];
  const { harness, runnerCalls } = makeHarness({
    nextChat: {
      queue,
      available: () => false,
      publish(payload) {
        queue.push(payload);
        if (queue.length > 50) queue.shift();
        return { ok: false, reason: 'unavailable', queued: queue.length };
      },
      setStatus() {},
    },
    interpret: async () => ({
      kind: 'view_request',
      intent: { action: 'zoom_to_globe', args: {} },
      reason: 'Globe',
      confidence: 0.9,
    }),
  });
  harness.setEnabled(true);
  await harness.ingest([{ id: 'n1', author: 'Ada', text: '#Task zoom to the globe' }]);
  assert.equal(queue.length, 1);
  assert.equal(runnerCalls.length, 1);
  assert.match(harness.getSnapshot().status, /NEXTCHAT UNAVAILABLE|APPLIED/);
});

test('tool-seeking and unknown street-view actions do not change the globe', async () => {
  const { harness, runnerCalls, published } = makeHarness({
    interpret: async () => ({
      kind: 'view_request',
      intent: { action: 'open_street_view', args: { query: 'Ensenada Port' } },
      reason: 'street view',
      confidence: 0.99,
    }),
  });
  harness.setEnabled(true);
  await harness.ingest([{ id: 'sv1', author: 'CruiseWatcher', text: CRUISE_COMMENT }]);
  assert.equal(published.length, 1);
  assert.equal(runnerCalls.length, 0);
  assert.equal(harness.getSnapshot().counters.rejected, 1);
});

function invoke(middleware, { body = {}, method = 'POST', url = '/interpret' } = {}) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const req = {
      method,
      url,
      destroy() {},
      on(event, handler) {
        listeners.set(event, handler);
        if (listeners.has('data') && listeners.has('end')) {
          queueMicrotask(() => {
            listeners.get('data')(Buffer.from(JSON.stringify(body)));
            listeners.get('end')();
          });
        }
        return this;
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(payload) { resolve({ status: this.statusCode, body: JSON.parse(payload) }); },
    };
    Promise.resolve(middleware(req, res)).catch(reject);
  });
}

test('server status is honest when the adapter cannot isolate tools', async () => {
  const response = await invoke(createYoutubeCommentHarnessMiddleware({
    configured: true,
    supportsToolIsolation: false,
  }), { method: 'GET', url: '/status' });
  assert.equal(response.status, 200);
  assert.equal(response.body.supportsToolIsolation, false);
  assert.equal(response.body.disabled, true);
  assert.match(response.body.reason, /tool-less/);
});

test('server refuses to start an agent session without tool isolation', async () => {
  let created = false;
  const response = await invoke(createYoutubeCommentHarnessMiddleware({
    configured: true,
    supportsToolIsolation: false,
    authorizeRequest: async () => ({ sessionId: 's' }),
    createAgent: () => { created = true; return {}; },
  }), {
    body: { comment: { taskBody: 'fly to Ensenada', text: '#Task fly to Ensenada' } },
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.kind, 'unsafe-adapter');
  assert.equal(created, false);
});

test('server validates structured output and never returns credentials', async () => {
  const session = { destroy: async () => {} };
  const middleware = createYoutubeCommentHarnessMiddleware({
    configured: true,
    supportsToolIsolation: true,
    authorizeRequest: async () => ({ sessionId: 's' }),
    createAgent: () => ({
      createSession: async () => session,
      generate: async () => ({
        text: JSON.stringify({
          kind: 'view_request',
          intent: { action: 'fly_to_location', args: { query: 'Ensenada Port' } },
          reason: 'Port',
          confidence: 0.9,
        }),
      }),
    }),
  });
  const response = await invoke(middleware, {
    body: {
      comment: { taskBody: 'view Ensenada Port', author: { displayName: 'CruiseWatcher' } },
      context: { videoId: 'v1', videoTitle: 'Live', apiKey: 'secret-key' },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.interpretation.kind, 'view_request');
  assert.equal(response.body.interpretation.intent.args.query, 'Ensenada Port');
  assert.equal(JSON.stringify(response.body).includes('secret-key'), false);
});

test('publishNextChatMessage writes author plus full comment as text', () => {
  const store = createNextchatStore(memoryStorage());
  const result = publishNextChatMessage({
    role: 'viewer',
    author: 'CruiseWatcher',
    text: CRUISE_COMMENT,
    metadata: { source: 'comment', commentId: 'yt-1', videoId: 'v', receivedAt: '2026-08-30T00:00:00.000Z' },
  }, store);
  assert.equal(result.ok, true);
  const message = store.getActiveSession().messages[0];
  assert.equal(message.role, 'viewer');
  assert.equal(message.author, 'CruiseWatcher');
  assert.equal(message.content, CRUISE_COMMENT);
});

test('NextChat renders viewer HTML/script/markdown as text content only', () => {
  class Node {
    constructor(tagName = 'div') {
      this.tagName = String(tagName).toLowerCase();
      this.children = [];
      this.parentNode = null;
      this.attrs = {};
      this._text = '';
      this.id = '';
      this.className = '';
      this.hidden = false;
      this.dataset = {};
      this.listeners = {};
      this.ownerDocument = null;
      this.classList = {
        names: new Set(),
        add: (name) => { this.classList.names.add(name); },
        toggle: (name, force) => {
          const on = force === undefined ? !this.classList.names.has(name) : Boolean(force);
          if (on) this.classList.names.add(name);
          else this.classList.names.delete(name);
          return on;
        },
        contains: (name) => this.classList.names.has(name),
      };
    }
    get textContent() {
      if (this.children.length) return this.children.map((child) => child.textContent).join('');
      return this._text;
    }
    set textContent(value) {
      this._text = String(value ?? '');
      this.children = [];
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === 'id') this.id = String(value);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) {
      node.parentNode = this;
      node.ownerDocument = this.ownerDocument;
      this.children.push(node);
      return node;
    }
    replaceChildren(...nodes) {
      this.children = [];
      for (const node of nodes) this.appendChild(node);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const found = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector.startsWith('[')) {
        const key = selector.slice(1, -1);
        if (key.startsWith('data-')) return Boolean(this.dataset[key.slice(5)]);
      }
      return this.tagName === selector.toLowerCase();
    }
  }

  const byId = new Map();
  const documentRef = {
    createElement(tag) {
      const node = new Node(tag);
      node.ownerDocument = documentRef;
      return node;
    },
    getElementById(id) { return byId.get(id) || null; },
  };
  function attach(id, tag = 'div') {
    const node = documentRef.createElement(tag);
    node.setAttribute('id', id);
    byId.set(id, node);
    return node;
  }
  const root = attach('gev-nextchat');
  root.append(
    attach('gev-nextchat-sessions'),
    attach('gev-nextchat-thread'),
    attach('gev-nextchat-status', 'p'),
    attach('gev-nextchat-form', 'form'),
    attach('gev-nextchat-composer', 'textarea'),
    attach('gev-nextchat-new', 'button'),
    attach('gev-nextchat-toggle', 'button'),
  );

  const api = initNextchat({ documentRef, storage: memoryStorage() });
  const dirty = 'Hi <script>alert(1)</script> and [click](javascript:alert(1))';
  api.publishViewerMessage({
    role: 'viewer',
    author: 'CruiseWatcher',
    text: dirty,
    metadata: { source: 'comment', commentId: 'x', videoId: 'v', receivedAt: '2026-08-30T00:00:00.000Z' },
  });
  const thread = byId.get('gev-nextchat-thread');
  assert.match(thread.textContent, /CruiseWatcher/);
  assert.match(thread.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(thread.querySelectorAll('script').length, 0);
  assert.equal(thread.children.some((child) => child.tagName === 'script'), false);
});

test('bounded view summary drops sensitive fields', () => {
  const summary = boundedViewSummary({
    videoId: 'abc',
    videoTitle: 'Live',
    source: 'liveChat',
    apiKey: 'secret',
    token: 'nope',
  });
  assert.deepEqual(summary, { videoId: 'abc', videoTitle: 'Live', source: 'liveChat' });
});

test('empty counters start at zero', () => {
  assert.deepEqual(createEmptyCounters(), {
    received: 0, displayed: 0, accepted: 0, rejected: 0, rateLimited: 0, failed: 0,
  });
});

test('the plugin label is exactly Youtube AI Comment Harness in the shipped manifest', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'adminPlugins', 'manifest.json'), 'utf8'));
  const entry = raw.find((item) => item.id === 'youtube-ai-comment-harness');
  assert.equal(entry.label, HARNESS_LABEL);
  assert.equal(entry.label, 'Youtube AI Comment Harness');
  assert.equal(entry.module, './youtube-ai-comment-harness.js');
});
