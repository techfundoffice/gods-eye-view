import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  YOUTUBE_LIVE_REQUEST_HEADER,
  YouTubePanelController,
  buildOperatorLiveStartBody,
  canStartLive,
  computePollDelay,
  createYoutubeLiveClient,
  defaultLiveCaptureUrl,
  formatLiveUptime,
  liveStatusLabel,
  mergeUniqueById,
  normalizeCommentThread,
  normalizeLiveChatMessage,
  provisionYoutubeIngest,
  summarizeCommentsPanel,
  summarizeOperatorLive,
} from './youtubeLive.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./youtubeLive.js', import.meta.url), 'utf8');
const KEY = 'abcd-1234-efgh-5678';

test('comment threads normalize plain text and nested replies', () => {
  const comment = normalizeCommentThread({
    id: 'thread-1',
    snippet: {
      totalReplyCount: 1,
      topLevelComment: {
        id: 'comment-1',
        snippet: {
          authorDisplayName: 'Operator',
          textOriginal: 'Hello <world>',
          publishedAt: '2026-08-28T12:00:00Z',
          likeCount: 4,
        },
      },
    },
    replies: {
      comments: [{
        id: 'reply-1',
        snippet: {
          authorDisplayName: 'Viewer',
          textDisplay: 'Reply',
          publishedAt: '2026-08-28T12:01:00Z',
        },
      }],
    },
  });
  assert.deepEqual(comment, {
    id: 'thread-1',
    author: 'Operator',
    text: 'Hello <world>',
    publishedAt: '2026-08-28T12:00:00Z',
    likeCount: 4,
    replyCount: 1,
    replies: [{
      id: 'reply-1',
      author: 'Viewer',
      text: 'Reply',
      publishedAt: '2026-08-28T12:01:00Z',
      likeCount: 0,
    }],
  });
});

test('live chat normalization preserves author role and text variants', () => {
  const message = normalizeLiveChatMessage({
    id: 'message-1',
    snippet: {
      type: 'textMessageEvent',
      displayMessage: 'Status update',
      publishedAt: '2026-08-28T12:00:00Z',
    },
    authorDetails: {
      displayName: 'Host',
      isChatOwner: true,
      isChatModerator: true,
    },
  });
  assert.equal(message.text, 'Status update');
  assert.equal(message.owner, true);
  assert.equal(message.moderator, true);
});

test('feed merging deduplicates continuation pages and caps history', () => {
  const merged = mergeUniqueById(
    [{ id: 'old', text: 'old' }, { id: 'same', text: 'old version' }],
    [{ id: 'new', text: 'new' }, { id: 'same', text: 'new version' }],
    3,
  );
  assert.deepEqual(merged.map((item) => item.id), ['new', 'same', 'old']);
  assert.equal(merged[1].text, 'new version');
});

test('polling delay honors provider cadence with safe bounds and backoff', () => {
  assert.equal(computePollDelay(1000), 5000);
  assert.equal(computePollDelay(10000, 5000), 15000);
  assert.equal(computePollDelay(120000), 60000);
});

test('rail comments summary reflects connection, selection, and paging', () => {
  assert.deepEqual(summarizeCommentsPanel(), {
    count: 0,
    subject: 'NO VIDEO SELECTED',
    status: 'CONNECT YOUTUBE TO LOAD COMMENTS',
    canLoadMore: false,
  });
  assert.equal(summarizeCommentsPanel({ connection: 'unavailable' }).status, 'YOUTUBE UNAVAILABLE');
  assert.equal(
    summarizeCommentsPanel({ connection: 'reconnect' }).status,
    'RECONNECT YOUTUBE TO LOAD COMMENTS',
  );
  assert.equal(
    summarizeCommentsPanel({ connection: 'connected' }).status,
    'SELECT A VIDEO IN YOUTUBE SETTINGS',
  );

  const video = { snippet: { title: 'Orbit pass' } };
  assert.equal(
    summarizeCommentsPanel({ connection: 'connected', video }).status,
    'NO COMMENTS ON THIS VIDEO',
  );
  // A load in flight outranks the empty state so the panel never reads as
  // "no comments" while the first page is still on the wire.
  assert.equal(
    summarizeCommentsPanel({ connection: 'connected', video, loading: true }).status,
    'LOADING COMMENTS',
  );

  const loaded = summarizeCommentsPanel({
    connection: 'connected',
    video: { ...video, liveStreamingDetails: { activeLiveChatId: 'chat-1' } },
    comments: [{ id: 'a', replyCount: 2 }, { id: 'b', replyCount: 0 }],
    nextPageToken: 'page-2',
  });
  assert.deepEqual(loaded, {
    count: 2,
    subject: 'Orbit pass · LIVE',
    status: '2 THREADS · 2 REPLIES',
    canLoadMore: true,
  });
  assert.equal(
    summarizeCommentsPanel({ connection: 'connected', video, comments: [{ id: 'a' }] }).status,
    '1 THREAD',
  );
});

test('paging is offered only when a selected video has a further page', () => {
  const video = { snippet: { title: 'Orbit pass' } };
  assert.equal(summarizeCommentsPanel({ video, nextPageToken: '   ' }).canLoadMore, false);
  assert.equal(summarizeCommentsPanel({ video: null, nextPageToken: 'page-2' }).canLoadMore, false);
  assert.equal(summarizeCommentsPanel({ video, nextPageToken: 'page-2' }).canLoadMore, true);
});

test('the comments panel lives in the right rail and exposes every hook the view reads', () => {
  const rail = html.slice(
    html.indexOf('<aside id="right-context-rail">'),
    html.indexOf('<div id="scene-runtime">'),
  );
  assert.ok(rail.includes('id="youtube-comments-panel"'), 'comments panel is not in the right rail');
  assert.ok(rail.includes('data-panel-id="youtube-comments-panel"'), 'panel is not rail-layout managed');
  assert.ok(
    rail.includes('data-collapse-target="youtube-comments-panel"'),
    'panel has no collapse control for StyleManager to bind',
  );
  for (const id of [
    'youtube-comments-video',
    'youtube-comments-status',
    'youtube-comments-count',
    'youtube-comments-list',
    'youtube-comments-refresh',
    'youtube-comments-more',
  ]) {
    assert.ok(rail.includes(`id="${id}"`), `${id} is missing from the rail panel`);
  }
  // Connection and video selection stay with the left settings panel: two
  // sign-in surfaces could disagree about which video is loaded.
  assert.ok(!rail.includes('id="youtube-connect-btn"'), 'rail panel duplicates sign-in');
  assert.ok(!rail.includes('id="youtube-video-select"'), 'rail panel duplicates video selection');
});

test('the operator YouTube Settings panel ships go-live start/stop/create controls', () => {
  const panel = html.slice(
    html.indexOf('<div id="youtube-panel"'),
    html.indexOf('<!-- Scene Director Panel -->'),
  );
  assert.match(panel, /id="youtube-go-live"/);
  for (const id of [
    'youtube-live-start',
    'youtube-live-stop',
    'youtube-live-provision',
    'youtube-live-ingest',
    'youtube-live-key',
    'youtube-live-title',
    'youtube-live-state',
    'youtube-live-summary',
  ]) {
    assert.ok(panel.includes(`id="${id}"`), `${id} is missing from YouTube Settings`);
  }
  assert.match(panel, /type="password"/);
  assert.match(panel, /CREATE ON YOUTUBE/);
  assert.match(panel, /START BROADCAST/);
  // ADMIN-only is not the operator front.
  assert.ok(!panel.includes('id="admin-live-start"'), 'operator panel must not be the ADMIN live pane');
});

test('the shipped controller binds those controls to the live client, not a second encoder', () => {
  assert.match(source, /this\.liveClient\.startLive\(/);
  assert.match(source, /this\.liveClient\.stopLive\(/);
  assert.match(source, /youtube-live-provision/);
  assert.match(source, /provisionYoutubeIngest\(/);
  assert.match(source, /buildOperatorLiveStartBody\(/);
  assert.equal(source.includes('/api/admin/live'), false, 'operator go-live must not call the ADMIN live routes');
});

test('broadcast status maps to a panel label and gates the start button', () => {
  assert.equal(liveStatusLabel('live'), 'LIVE');
  assert.equal(liveStatusLabel('starting'), 'STARTING');
  assert.equal(liveStatusLabel('error'), 'ERROR');
  assert.equal(liveStatusLabel(''), 'OFFLINE');
  assert.equal(canStartLive({ status: 'idle' }), true);
  assert.equal(canStartLive({ status: 'stopped' }), true);
  assert.equal(canStartLive({ status: 'live' }), false);
  assert.equal(canStartLive({ status: 'starting' }), false);
});

test('operator live summary never reprints the stream key', () => {
  const idle = summarizeOperatorLive({}, { connected: false });
  assert.equal(idle.canStart, false);
  assert.match(idle.summary, /Sign in/);

  const live = summarizeOperatorLive({
    status: 'live',
    target: `rtmp://a.rtmp.youtube.com/live2/***`,
    framesSent: 12,
    startedAt: '2026-08-29T00:00:00.000Z',
    settings: { width: 1280, height: 720, fps: 24, videoBitrateKbps: 2500, audioSource: 'silent' },
    error: null,
    log: [`Publishing to rtmp://a.rtmp.youtube.com/live2/${KEY}`],
  }, { connected: true });
  assert.equal(live.label, 'LIVE');
  assert.equal(live.canStart, false);
  assert.equal(live.canStop, true);
  assert.ok(!live.summary.includes(KEY));
  assert.match(live.summary, /\*\*\*/);
});

test('uptime formatting matches the ADMIN console helper', () => {
  const base = Date.parse('2026-08-29T00:00:00.000Z');
  assert.equal(formatLiveUptime('2026-08-29T00:00:00.000Z', base + 65_000), '1:05');
  assert.equal(formatLiveUptime(null), '');
});

test('the operator live client posts to /api/youtube/live with the CSRF header', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 202,
      json: async () => ({ live: { status: 'live', target: 'rtmp://a.rtmp.youtube.com/live2/***' } }),
    };
  };
  const client = createYoutubeLiveClient({ fetchImpl });
  const started = await client.startLive(buildOperatorLiveStartBody({
    ingestUrl: 'rtmp://a.rtmp.youtube.com/live2',
    streamKey: KEY,
    origin: 'http://localhost:4173',
  }));
  assert.equal(calls[0].url, '/api/youtube/live/start');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers[YOUTUBE_LIVE_REQUEST_HEADER], '1');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.streamKey, KEY);
  assert.equal(body.captureUrl, 'http://localhost:4173/');
  assert.equal(started.live.status, 'live');
  assert.ok(!JSON.stringify(started).includes(KEY));

  await client.stopLive();
  assert.equal(calls[1].url, '/api/youtube/live/stop');
  assert.equal(calls[1].options.headers[YOUTUBE_LIVE_REQUEST_HEADER], '1');
});

test('an unauthenticated live start surfaces as an error from the shipped client', async () => {
  const client = createYoutubeLiveClient({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { kind: 'authentication', message: 'Sign in to YouTube to go live.' } }),
    }),
  });
  await assert.rejects(
    () => client.startLive({ ingestUrl: 'rtmp://x/live2', streamKey: KEY }),
    (error) => error.status === 401 && error.kind === 'authentication',
  );
});

test('the capture URL is this origin, never a file path', () => {
  assert.equal(defaultLiveCaptureUrl('http://localhost:4173'), 'http://localhost:4173/');
  assert.equal(defaultLiveCaptureUrl(''), 'http://localhost:5000/');
});

function installDomStub() {
  if (globalThis.document?.__gevLiveTest) return;
  globalThis.document = {
    __gevLiveTest: true,
    createElement() {
      return {
        textContent: '',
        value: '',
        hidden: false,
        disabled: false,
        className: '',
        children: [],
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        append(...nodes) { this.children.push(...nodes); },
      };
    },
  };
}

function makeEl(extra = {}) {
  const listeners = {};
  return {
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    href: '#',
    className: '',
    dataset: {},
    children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(event, handler) { listeners[event] = handler; },
    setAttribute() {},
    replaceChildren() { this.children = []; },
    append(...nodes) { this.children.push(...nodes); },
    click() { listeners.click?.(); },
    submit(event) { listeners.submit?.(event || { preventDefault() {} }); },
    ...extra,
  };
}

function makeYoutubeRoot() {
  const els = {};
  const ids = [
    'youtube-connect-btn', 'youtube-signout-btn', 'youtube-refresh-btn',
    'youtube-chat-toggle', 'youtube-view-agent-toggle',
    'youtube-channel-select', 'youtube-video-select', 'youtube-poll-select',
    'youtube-chat-tab', 'youtube-comments-tab', 'youtube-api-tab',
    'youtube-resource-select', 'youtube-api-load-btn', 'youtube-comments-next',
    'youtube-feed-status', 'youtube-connection-state', 'youtube-account',
    'youtube-channel-summary', 'youtube-video-summary', 'youtube-feed-list',
    'youtube-api-view', 'youtube-feed-view', 'youtube-view-agent-status',
    'youtube-live-title', 'youtube-live-privacy', 'youtube-live-provision',
    'youtube-live-ingest', 'youtube-live-key', 'youtube-live-start',
    'youtube-live-stop', 'youtube-live-form', 'youtube-live-state',
    'youtube-live-watch', 'youtube-live-summary', 'youtube-live-log',
    'youtube-api-output',
  ];
  for (const id of ids) els[id] = makeEl({ id });
  els['youtube-live-ingest'].value = 'rtmp://a.rtmp.youtube.com/live2';
  els['youtube-live-key'].value = KEY;
  els['youtube-live-title'].value = 'Globe live';
  els['youtube-live-privacy'].value = 'unlisted';
  return {
    els,
    classList: { toggle() { return false; }, add() {}, remove() {} },
    querySelector(sel) {
      if (sel.startsWith('#')) return els[sel.slice(1)] || null;
      if (sel.includes('data-collapse-target')) return makeEl({ dataset: { collapseBound: 'true' } });
      return null;
    },
  };
}

test('the YouTube Settings controller start/stop calls the live client and clears the key', async () => {
  installDomStub();
  const calls = [];
  const liveClient = {
    status: async () => ({ live: { status: 'idle', log: [], target: '' } }),
    startLive: async (body) => {
      calls.push(['start', body]);
      return { live: { status: 'live', target: 'rtmp://a.rtmp.youtube.com/live2/***', log: [] } };
    },
    stopLive: async () => {
      calls.push(['stop']);
      return { live: { status: 'stopped', log: [], target: 'rtmp://a.rtmp.youtube.com/live2/***' } };
    },
  };
  const root = makeYoutubeRoot();
  const controller = new YouTubePanelController(root, {
    client: { get: async () => ({ items: [] }), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) },
    liveClient,
    viewAgentClient: { interpret: async () => ({ action: 'ignore' }) },
    captureOrigin: 'http://localhost:4173',
  });
  controller.state.connection = 'connected';
  await controller._startLive();
  assert.equal(calls[0][0], 'start');
  assert.equal(calls[0][1].ingestUrl, 'rtmp://a.rtmp.youtube.com/live2');
  assert.equal(calls[0][1].streamKey, KEY);
  assert.equal(calls[0][1].captureUrl, 'http://localhost:4173/');
  assert.equal(root.els['youtube-live-key'].value, '', 'key field is cleared after start');
  assert.ok(!String(root.els['youtube-live-summary'].textContent).includes(KEY));
  assert.equal(root.els['youtube-live-state'].textContent, 'LIVE');

  await controller._stopLive();
  assert.equal(calls[1][0], 'stop');
  assert.equal(root.els['youtube-live-state'].textContent, 'STOPPED');
  controller.destroy();
});

test('create-on-YouTube fills ingest from the Live API and keeps the key off the summary', async () => {
  installDomStub();
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (String(url).includes('liveStreams') && !String(url).includes('bind')) {
      return {
        ok: true,
        json: async () => ({
          id: 'stream-1',
          cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: KEY } },
        }),
      };
    }
    if (String(url).includes('liveBroadcasts/bind')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ id: 'broadcast-1', snippet: body?.snippet }) };
  };
  const root = makeYoutubeRoot();
  const controller = new YouTubePanelController(root, {
    client: { get: async () => ({ items: [] }), fetchImpl },
    liveClient: { status: async () => ({ live: { status: 'idle' } }), startLive: async () => ({}), stopLive: async () => ({}) },
    viewAgentClient: { interpret: async () => ({ action: 'ignore' }) },
  });
  controller.state.connection = 'connected';
  await controller._provisionLive();
  assert.equal(root.els['youtube-live-ingest'].value, 'rtmp://a.rtmp.youtube.com/live2');
  assert.equal(root.els['youtube-live-key'].value, KEY);
  assert.ok(!String(root.els['youtube-live-summary'].textContent).includes(KEY));
  assert.match(root.els['youtube-live-summary'].textContent, /Broadcast created/);
  controller.destroy();
});

test('provisioning creates a stream, a broadcast, and binds them', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.includes('liveStreams')) {
      return {
        ok: true,
        json: async () => ({
          id: 'stream-1',
          cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' } },
        }),
      };
    }
    if (url.includes('liveBroadcasts/bind')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ id: 'broadcast-1' }) };
  };

  const result = await provisionYoutubeIngest(fetchImpl, { title: 'Globe live' });
  assert.equal(result.ingestUrl, 'rtmp://a.rtmp.youtube.com/live2');
  assert.equal(result.streamKey, 'key-1');
  assert.equal(result.watchUrl, 'https://www.youtube.com/watch?v=broadcast-1');
  assert.deepEqual(seen.map((call) => call.method), ['POST', 'POST', 'POST']);
  assert.equal(seen[1].body.contentDetails.enableAutoStart, true);
});
