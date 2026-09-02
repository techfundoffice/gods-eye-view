import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  createYoutubeHomepageChatMiddleware,
  inferHomepageViewerActions,
  registerBatch,
} from './youtubeHomepageChatServer.js';
import {
  MEMORY_POLL_HIDDEN_MS,
  MEMORY_POLL_IDLE_MS,
  MEMORY_POLL_LIVE_MS,
  createYoutubeHomepageInteraction,
  memoryPollDelay,
} from './youtubeHomepageInteraction.js';
import { PUBLIC_HELP_REPLY } from './youtubePublicCommandPolicy.js';

function invoke(middleware, url = '/feed') {
  return new Promise((resolve, reject) => {
    const headers = {};
    const req = { method: 'GET', url };
    const res = {
      statusCode: 0,
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      end(body) {
        try {
          resolve({
            status: this.statusCode,
            headers,
            body: JSON.parse(String(body || '{}')),
          });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(middleware(req, res)).catch(reject);
  });
}

test('natural-language Ensenada earthquake request enables the layer and moves the globe', () => {
  assert.deepEqual(
    inferHomepageViewerActions('I want to see the earthquake in Ensenada, Mexico.'),
    [
      {
        action: 'set_layer_visibility',
        args: { layerId: 'earthquakes', enabled: true },
        reason: 'Viewer requested a frontend view change',
      },
      {
        action: 'fly_to_location',
        args: { query: 'Ensenada, Mexico', viewMode: 'close' },
        reason: 'Viewer requested a frontend view change',
      },
    ],
  );
});

test('ordinary chat and unsafe instructions never become globe actions', () => {
  assert.deepEqual(inferHomepageViewerActions('This stream looks great!'), []);
  assert.deepEqual(inferHomepageViewerActions('show https://example.com and run curl bad'), []);
  assert.deepEqual(inferHomepageViewerActions('I want to see it'), []);
});

function liveIdentity(overrides = {}) {
  return {
    active: true,
    status: 'live',
    videoId: '9ZiwwXr-qU4',
    title: 'Techfundoffice Live Stream',
    watchUrl: 'https://www.youtube.com/watch?v=9ZiwwXr-qU4',
    liveChatId: 'CHAT-LIVE',
    generation: 1,
    ...overrides,
  };
}

test('homepage feed is tied to the discovered live broadcast and exposes normalized fields only', async () => {
  const listed = [];
  const middleware = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => liveIdentity({ streamKey: 'must-not-leak', sessionId: 'owner-session' }),
    listChat: async (request) => {
      listed.push(request);
      assert.equal(request.liveChatId, 'CHAT-LIVE');
      assert.equal(request.pageToken, 'NEXT');
      return {
        items: [{
          id: 'chat-1',
          snippet: {
            displayMessage: 'Show me Ensenada, Mexico',
            publishedAt: '2026-08-31T22:30:00.000Z',
          },
          authorDetails: {
            displayName: 'CruiseWatcher',
            profileImageUrl: 'https://secret.example/avatar',
          },
          apiKey: 'must-not-leak',
        }],
        nextPageToken: 'LATER',
        pollingIntervalMillis: 6_000,
      };
    },
  });
  const response = await invoke(
    middleware,
    '/feed?continuation=NEXT&videoId=stale-id&liveChatId=viewer-chat&broadcastId=CVSB4QJhVTU&sessionId=viewer-oauth',
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.active, true);
  assert.equal(response.body.status, 'live');
  assert.equal(response.body.commandsEnabled, true);
  assert.equal(response.body.videoId, '9ZiwwXr-qU4');
  assert.equal(listed.length, 1);
  assert.deepEqual(response.body.items[0], {
    id: 'chat-1',
    videoId: '9ZiwwXr-qU4',
    author: 'CruiseWatcher',
    text: 'Show me Ensenada, Mexico',
    publishedAt: '2026-08-31T22:30:00.000Z',
    source: 'youtube',
    agentMode: 'execute',
    deferAgent: true,
    actions: [],
  });
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /must-not-leak|profileImageUrl|apiKey|streamKey|owner-session|CHAT-LIVE|viewer-oauth|stale-id/);
});

test('homepage feed is explicitly offline when the owner has no active broadcast', async () => {
  let polls = 0;
  const middleware = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => ({ active: false, status: 'offline' }),
    listChat: async () => { polls += 1; return {}; },
  });
  const response = await invoke(middleware);
  assert.equal(response.status, 200);
  assert.equal(response.body.active, false);
  assert.equal(response.body.status, 'offline');
  assert.equal(response.body.commandsEnabled, false);
  assert.deepEqual(response.body.items, []);
  assert.equal(polls, 0);
});

test('homepage feed reports connecting instead of live while YouTube is liveStarting', async () => {
  let polls = 0;
  const middleware = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => ({
      active: false,
      status: 'connecting',
      videoId: 'starting-id',
      title: 'Soon',
      watchUrl: 'https://www.youtube.com/watch?v=starting-id',
      liveChatId: '',
    }),
    listChat: async () => { polls += 1; return {}; },
  });
  const response = await invoke(middleware);
  assert.equal(response.body.active, false);
  assert.equal(response.body.status, 'connecting');
  assert.equal(response.body.commandsEnabled, false);
  assert.equal(polls, 0);
});

test('homepage feed does not use viewer query params to select owner authorization or chat identity', async () => {
  const owners = [];
  const chats = [];
  const middleware = createYoutubeHomepageChatMiddleware({
    getOwnerCall: async () => {
      owners.push('server-owner');
      return null;
    },
    discoverActive: async () => liveIdentity(),
    listChat: async (request) => {
      chats.push(request);
      return { items: [], nextPageToken: '', pollingIntervalMillis: 5_000 };
    },
  });
  await invoke(middleware, '/feed?sessionId=viewer-session&authorization=stolen&liveChatId=other');
  assert.deepEqual(owners, []);
  assert.equal(chats[0].liveChatId, 'CHAT-LIVE');
  assert.equal(chats[0].pageToken, '');
});

test('ended live chat clears identity and rediscovers instead of retrying a stale id', async () => {
  let discoverCount = 0;
  let chatCount = 0;
  const middleware = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => {
      discoverCount += 1;
      if (discoverCount === 1) return liveIdentity({ liveChatId: 'STALE-CHAT' });
      return { active: false, status: 'offline' };
    },
    listChat: async (request) => {
      chatCount += 1;
      if (request.liveChatId === 'STALE-CHAT') {
        const error = new Error('This live broadcast has ended.');
        error.kind = 'ended';
        throw error;
      }
      return { items: [], nextPageToken: '' };
    },
    discovery: {
      invalidate() { discoverCount += 0; },
    },
  });
  const first = await invoke(middleware);
  assert.equal(first.body.active, false);
  assert.equal(first.body.status, 'ended');
  assert.equal(first.body.error.kind, 'ended');
  assert.equal(chatCount, 1);

  const second = await invoke(middleware);
  assert.equal(discoverCount, 2);
  assert.equal(second.body.status, 'offline');
  assert.equal(second.body.active, false);
  assert.equal(chatCount, 1);
});

test('missing owner authorization returns a controlled unauthenticated feed', async () => {
  const middleware = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => ({ active: false, status: 'unauthenticated' }),
    listChat: async () => ({ items: [] }),
  });
  const response = await invoke(middleware);
  assert.equal(response.status, 200);
  assert.equal(response.body.active, false);
  assert.equal(response.body.status, 'unauthenticated');
  assert.deepEqual(response.body.items, []);
});

test('permanent news ticker uses only the active broadcast watch URL and falls back offline', async () => {
  const attributes = new Map([['href', '#'], ['aria-disabled', 'true']]);
  const tickerUrl = {
    href: '#',
    textContent: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
  const ticker = {
    dataset: {},
    setAttribute(name, value) {
      if (name === 'data-state') this.dataset.state = String(value);
    },
  };
  const badge = { dataset: {}, hidden: true, textContent: '' };
  let active = true;
  let scheduled = null;
  const clock = {
    setTimeout(callback) {
      scheduled = callback;
      return 1;
    },
    clearTimeout() {},
  };
  const interaction = createYoutubeHomepageInteraction({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return active
          ? {
            active: true,
            videoId: 'CVSB4QJhVTU',
            title: 'Gods Eye View Live',
            watchUrl: 'https://www.youtube.com/watch?v=CVSB4QJhVTU',
            items: [],
            pollingIntervalMillis: 5_000,
          }
          : { active: false, items: [], pollingIntervalMillis: 5_000 };
      },
    }),
    nextchat: { setHarnessStatus() {} },
    documentRef: {
      getElementById(id) {
        if (id === 'live-news-ticker') return ticker;
        if (id === 'live-news-ticker-url') return tickerUrl;
        if (id === 'gev-nextchat-live-badge') return badge;
        return null;
      },
    },
    clock,
  });

  interaction.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticker.dataset.state, 'live');
  assert.equal(tickerUrl.href, 'https://www.youtube.com/watch?v=CVSB4QJhVTU');
  assert.equal(tickerUrl.textContent, 'https://www.youtube.com/watch?v=CVSB4QJhVTU');
  assert.equal(tickerUrl.getAttribute('aria-disabled'), null);

  active = false;
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticker.dataset.state, 'offline');
  assert.equal(tickerUrl.getAttribute('href'), null);
  assert.equal(tickerUrl.textContent, 'STREAM OFFLINE');
  assert.equal(tickerUrl.getAttribute('aria-disabled'), 'true');
  interaction.stop();
});

test('ticker markup is permanent, bottom-fixed, and preserves every existing control surface', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const realtime = readFileSync(new URL('./voice/gevRealtime.js', import.meta.url), 'utf8');

  assert.match(html, /id="live-news-ticker"/);
  assert.match(html, /LIVE Breaking News:/);
  assert.match(html, /class="live-news-ticker-viewport"/);
  assert.match(html, /class="live-news-ticker-content"/);
  assert.match(html, /Comment on YouTube chat to choose your view\./);
  assert.match(html, /id="live-news-ticker-url"/);
  assert.match(html, /Live at/);
  assert.match(html, /Now!/);
  assert.match(html, /Download our Google Chrome extension named Cloud Computer AI Agent to control this channel\./);
  assert.match(css, /\.live-news-ticker \{[\s\S]*?position: fixed;[\s\S]*?bottom: 0;/);
  assert.match(css, /--live-news-ticker-height/);
  const tickerRule = css.slice(css.indexOf('.live-news-ticker {'), css.indexOf('}', css.indexOf('.live-news-ticker {')));
  const adminReserveRule = css.slice(
    css.indexOf('body:has(#loading-screen.compatibility-error:not(.hidden)) .admin-console {', css.indexOf('.live-news-ticker {')),
  );
  assert.match(tickerRule, /z-index: 1300/);
  assert.match(tickerRule, /justify-content: flex-start/);
  assert.match(tickerRule, /text-align: left/);
  assert.match(css, /\.live-news-ticker-label \{[\s\S]*?flex: 0 0 auto;[\s\S]*?text-align: left;/);
  assert.match(css, /\.live-news-ticker-viewport \{[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.live-news-ticker-content \{[\s\S]*?animation: live-news-ticker-scroll 40s linear infinite;/);
  assert.match(css, /@keyframes live-news-ticker-scroll \{[\s\S]*?translateX\(-100%\)/);
  assert.match(adminReserveRule, /inset: 0 0 var\(--live-news-ticker-height\) 0/);
  assert.match(adminReserveRule, /z-index: 1400/);

  for (const id of [
    'admin-launch',
    'command-dock',
    'location-bar',
    'control-panel',
    'gev-nextchat',
    'gev-nextchat-composer',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must remain present`);
  }
  assert.match(realtime, /root\.id = 'gev-voice-control'/, 'dynamic GEV MIC control must remain present');
});

test('homepage interaction displays every comment and runs validated actions with cooldowns', async () => {
  const displayed = [];
  const statuses = [];
  const calls = [];
  let currentTime = 20_000;
  const interaction = createYoutubeHomepageInteraction({
    nextchat: {
      publishViewerMessage(message) { displayed.push(message); },
      setHarnessStatus(message) { statuses.push(message); },
    },
    runner: async (action, args) => {
      calls.push({ action, args });
      return { ok: true };
    },
    now: () => currentTime,
    documentRef: null,
  });

  await interaction.ingest([
    {
      id: 'chat-1',
      videoId: '',
      author: 'CruiseWatcher',
      text: 'I want to see the earthquake in Ensenada, Mexico.',
      publishedAt: '2026-08-31T22:30:00.000Z',
      actions: inferHomepageViewerActions('I want to see the earthquake in Ensenada, Mexico.'),
    },
    {
      id: 'chat-2',
      videoId: '',
      author: 'AnotherViewer',
      text: 'Show me Paris',
      publishedAt: '2026-08-31T22:30:01.000Z',
      actions: inferHomepageViewerActions('Show me Paris'),
    },
    {
      id: 'chat-3',
      videoId: '',
      author: 'ChatOnly',
      text: 'Amazing view',
      publishedAt: '2026-08-31T22:30:02.000Z',
      actions: [],
    },
  ]);

  assert.equal(displayed.length, 3);
  assert.equal(displayed[0].author, 'CruiseWatcher');
  assert.equal(displayed[0].text, 'I want to see the earthquake in Ensenada, Mexico.');
  assert.equal(displayed[0].metadata.actionState, 'interpreting');
  assert.equal(displayed[2].metadata.actionState, 'chat');
  assert.deepEqual(calls.map((call) => call.action), ['set_layer_visibility', 'fly_to_location']);
  assert.ok(statuses.some((status) => /showing Ensenada, Mexico for CruiseWatcher/i.test(status)));
  assert.ok(statuses.some((status) => /cooldown/i.test(status)));

  currentTime += 9_000;
  await interaction.ingest([{
    id: 'chat-4',
    videoId: '',
    author: 'AnotherViewer',
    text: 'Show me Paris',
    actions: inferHomepageViewerActions('Show me Paris'),
  }]);
  assert.equal(calls.at(-1).action, 'fly_to_location');
  assert.equal(calls.at(-1).args.query, 'Paris');
  assert.equal(calls.at(-1).args.waitForArrival, true);
});

test('an actionable comment received before globe startup is queued and runs when the runner attaches', async () => {
  const calls = [];
  let resolveCall;
  const called = new Promise((resolve) => { resolveCall = resolve; });
  const interaction = createYoutubeHomepageInteraction({
    nextchat: {
      publishViewerMessage() {},
      setHarnessStatus() {},
    },
    runner: null,
    now: () => 20_000,
    documentRef: null,
  });
  await interaction.ingest([{
    id: 'early-comment',
    videoId: '',
    author: 'EarlyViewer',
    text: 'go to ensenada mexico',
    actions: inferHomepageViewerActions('go to ensenada mexico'),
  }]);
  assert.equal(interaction.getState().pendingActions, 1);
  assert.equal(interaction.getState().runnerReady, false);

  interaction.setRunner(async (action, args) => {
    calls.push({ action, args });
    resolveCall();
    return { ok: true };
  });
  await called;
  assert.equal(interaction.getState().pendingActions, 0);
  assert.deepEqual(calls, [{
    action: 'fly_to_location',
    args: { query: 'ensenada mexico', viewMode: 'close', waitForArrival: true },
  }]);
});

test('viewer navigation dismisses the first-run launcher before moving the camera', async () => {
  let clicked = 0;
  const launcher = {
    hidden: false,
    classList: { contains: (value) => value === 'visible' },
    querySelector: () => ({ click() { clicked += 1; } }),
  };
  const interaction = createYoutubeHomepageInteraction({
    nextchat: {
      publishViewerMessage() {},
      setHarnessStatus() {},
    },
    runner: async () => ({ ok: true }),
    now: () => 20_000,
    documentRef: {
      getElementById(id) {
        if (id === 'first-run-launcher') return launcher;
        return null;
      },
    },
  });
  await interaction.ingest([{
    id: 'dismiss-overlay',
    videoId: '',
    author: 'Viewer',
    text: 'go to ensenada mexico',
    actions: inferHomepageViewerActions('go to ensenada mexico'),
  }]);
  assert.equal(clicked, 1);
});

test('browser memory poll is faster when live and visible, slower when hidden or idle', () => {
  assert.equal(memoryPollDelay({ active: true, status: 'live', pollingIntervalMillis: 800 }), MEMORY_POLL_LIVE_MS);
  assert.equal(
    memoryPollDelay({ active: true, status: 'live', pollingIntervalMillis: 800 }, { hidden: true }),
    MEMORY_POLL_HIDDEN_MS,
  );
  assert.equal(memoryPollDelay({ active: false, status: 'ended' }), MEMORY_POLL_IDLE_MS);
  assert.notEqual(
    memoryPollDelay({ active: true, status: 'live', ingestPollingIntervalMillis: 12_000, pollingIntervalMillis: 800 }),
    12_000,
  );
});

test('generation change still clears browser dedupe when comments keep flowing', async () => {
  const displayed = [];
  const interaction = createYoutubeHomepageInteraction({
    nextchat: {
      publishViewerMessage(message) { displayed.push(message); },
      setHarnessStatus() {},
    },
    documentRef: null,
    now: () => 20_000,
  });
  await interaction.ingest([
    { id: 'same', videoId: 'aaaa', author: 'A', text: 'one', actions: [] },
  ]);
  await interaction.ingest([
    { id: 'same', videoId: 'aaaa', author: 'A', text: 'one', actions: [] },
  ]);
  assert.equal(displayed.length, 1);
  interaction.getState();
  const state = interaction.getState();
  assert.equal(state.seen, 1);
});

test('YouTube /help appears in LIVE COMMENTS and typewrites the GEV ACTIONS reply', async () => {
  const displayed = [];
  const replies = [];
  const interaction = createYoutubeHomepageInteraction({
    nextchat: {
      publishViewerMessage(message) { displayed.push(message); },
      typeActionReply(text) { replies.push(text); },
      setHarnessStatus() {},
    },
    documentRef: null,
    now: () => 20_000,
  });
  await interaction.ingest([{
    id: 'help-comment',
    videoId: 'vid',
    author: 'ChatViewer',
    text: '/help',
    publishedAt: '2026-09-01T00:00:00.000Z',
    actions: [],
  }]);
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].text, '/help');
  assert.equal(displayed[0].author, 'ChatViewer');
  interaction.publishCommandStatuses([{
    id: 'cmd-help',
    command: '/help',
    state: 'succeeded',
    answer: PUBLIC_HELP_REPLY,
    viewer: 'ChatViewer',
    commentId: 'help-comment',
    videoId: 'vid',
    updatedAt: 20_000,
  }]);
  assert.deepEqual(replies, [PUBLIC_HELP_REPLY]);
  assert.equal(displayed.length, 1, 'help reply must not duplicate into LIVE COMMENTS');
});

test('YouTube /explore-manually is ingested as a live comment', async () => {
  const displayed = [];
  const interaction = createYoutubeHomepageInteraction({
    nextchat: {
      publishViewerMessage(message) { displayed.push(message); },
      setHarnessStatus() {},
    },
    documentRef: null,
    now: () => 20_000,
  });
  await interaction.ingest([{
    id: 'explore-comment',
    videoId: 'vid',
    author: 'Explorer',
    text: '/explore-manually',
    publishedAt: '2026-09-01T00:00:00.000Z',
    actions: [],
  }]);
  assert.equal(displayed[0].text, '/explore-manually');
});

test('visible live page executes an AI tool lease and posts its result', async () => {
  const requests = [];
  const calls = [];
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const interaction = createYoutubeHomepageInteraction({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/feed')) {
        return {
          ok: true,
          async json() {
            return {
              active: true,
              status: 'live',
              videoId: 'vid',
              generation: 1,
              commandsEnabled: true,
              items: [],
              commands: [{
                id: 'cmd-1',
                commentId: 'comment-1',
                command: '/live-contacts',
                state: 'awaiting-execution',
                videoId: 'vid',
                generation: 1,
              }],
            };
          },
        };
      }
      if (url.includes('/agent/lease')) {
        return {
          ok: true,
          async json() {
            return {
              lease: {
                commandId: 'cmd-1',
                nonce: 'nonce-1',
                videoId: 'vid',
                generation: 1,
                tool: {
                  name: 'run_view_preset',
                  arguments: { preset: '/live-contacts' },
                },
              },
            };
          },
        };
      }
      if (url.includes('/agent/result')) {
        complete(JSON.parse(options.body));
        return { ok: true, async json() { return { ok: true }; } };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    nextchat: {
      publishViewerMessage() {},
      updateAgentReply() {},
      setHarnessStatus() {},
    },
    runner: async (action, args) => {
      calls.push({ action, args });
      return { ok: true, action, preset: args.preset };
    },
    getViewContext: async () => ({ camera: { latitude: 32.7, longitude: -117.2 } }),
    documentRef: null,
    clock: {
      setTimeout() { return 1; },
      clearTimeout() {},
    },
  });

  interaction.start();
  const result = await done;
  assert.deepEqual(calls, [{
    action: 'run_view_preset',
    args: { preset: '/live-contacts' },
  }]);
  assert.deepEqual(result, {
    commandId: 'cmd-1',
    nonce: 'nonce-1',
    result: { ok: true, action: 'run_view_preset', preset: '/live-contacts' },
    viewContext: { camera: { latitude: 32.7, longitude: -117.2 } },
  });
  const leaseRequest = requests.find(({ url }) => url.includes('/agent/lease'));
  assert.equal(leaseRequest.options.method, 'POST');
  assert.deepEqual(JSON.parse(leaseRequest.options.body), {
    viewContext: { camera: { latitude: 32.7, longitude: -117.2 } },
  });
  assert.equal(requests.filter(({ url }) => url.includes('/agent/lease')).length, 1);
  assert.equal(requests.filter(({ url }) => url.includes('/agent/result')).length, 1);
  interaction.stop();
});

test('with commandRuntime, /help becomes a succeeded command with commentId', async () => {
  const registered = [];
  const middleware = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => liveIdentity(),
    listChat: async () => ({
      items: [{
        id: 'chat-help',
        snippet: { displayMessage: '/help', publishedAt: '2026-09-01T00:00:00.000Z' },
        authorDetails: { displayName: 'Pat' },
        authorHandle: '@patHandle',
      }],
      nextPageToken: '',
      pollingIntervalMillis: 5000,
    }),
    commandRuntime: {
      registerMessage: async (item) => { registered.push(item); },
      statuses: async () => [{
        id: 'cmd-help',
        commentId: 'chat-help',
        command: '/help',
        state: 'succeeded',
        answer: PUBLIC_HELP_REPLY,
        viewer: 'Pat',
        authorHandle: '@patHandle',
        videoId: '9ZiwwXr-qU4',
        generation: 1,
        updatedAt: 1,
      }],
    },
  });
  const response = await invoke(middleware, '/feed');
  assert.equal(response.status, 200);
  assert.equal(registered[0].id, 'chat-help');
  assert.equal(registered[0].authorHandle, '@patHandle');
  assert.equal(response.body.commands[0].commentId, 'chat-help');
  assert.equal(response.body.commands[0].authorHandle, '@patHandle');
});

test('vite homepage middleware is constructed with commandRuntime', () => {
  const src = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(src, /createYoutubePublicCommandRuntime\s*\(/);
  assert.match(src, /createYoutubeHomepageChatMiddleware\(\s*\{[\s\S]*commandRuntime/);
});

test('every comment in a poll batch is registered, not just the last', async () => {
  const seen = [];
  const runtime = { registerMessage: async (item) => { seen.push(item.id); } };
  const items = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }];
  const count = await registerBatch(runtime, items, { videoId: 'v', generation: 1 });
  // The regression: `items.at(-1)` registered only 'c4' and dropped the rest
  // before any model saw them.
  assert.deepEqual(seen, ['c1', 'c2', 'c3', 'c4']);
  assert.equal(count, 4);
});

test('one failing comment does not strand the rest of the batch', async () => {
  const seen = [];
  const runtime = {
    registerMessage: async (item) => {
      if (item.id === 'c2') throw new Error('bad comment');
      seen.push(item.id);
    },
  };
  const count = await registerBatch(runtime, [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], {});
  assert.deepEqual(seen, ['c1', 'c3']);
  assert.equal(count, 2);
});

test('a runtime without registerMessage is a no-op', async () => {
  assert.equal(await registerBatch(null, [{ id: 'c1' }], {}), 0);
  assert.equal(await registerBatch({}, [{ id: 'c1' }], {}), 0);
});
