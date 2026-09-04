import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  createYoutubeHomepageChatMiddleware,
  inferHomepageViewerActions,
} from './youtubeHomepageChatServer.js';
import {
  MEMORY_POLL_HIDDEN_MS,
  MEMORY_POLL_IDLE_MS,
  MEMORY_POLL_LIVE_MS,
  createYoutubeHomepageInteraction,
  formatFollowUpCountdown,
  memoryPollDelay,
} from './youtubeHomepageInteraction.js';
import { PUBLIC_HELP_REPLY } from './youtubePublicCommandPolicy.js';
import { createInMemoryPublicCommandLedger } from './youtubePublicCommandLedger.js';
import {
  createYoutubePublicCommandRuntime,
  PUBLIC_EXECUTOR_HEADER,
} from './youtubePublicCommandRuntime.js';

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
        args: { query: 'Ensenada, Mexico', viewMode: 'overview' },
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

test('homepage feed starts the AI for every live comment and exposes normalized fields only', async () => {
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
            displayMessage: 'This stream looks great!',
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
    text: 'This stream looks great!',
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
            title: 'Cloud Computer AI.com Live',
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
  assert.match(realtime, /root\.id = 'gev-voice-control'/, 'dynamic Cloud Computer AI.com MIC control must remain present');
});

test('homepage interaction displays every comment but never executes untrusted feed actions', async () => {
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
  assert.deepEqual(calls, []);

  currentTime += 9_000;
  await interaction.ingest([{
    id: 'chat-4',
    videoId: '',
    author: 'AnotherViewer',
    text: 'Show me Paris',
    actions: inferHomepageViewerActions('Show me Paris'),
  }]);
  assert.deepEqual(calls, []);
});

test('visible Youtube conversation renders viewer request first with one countdown and a waiting queue', async () => {
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.textContent = '';
      this.className = '';
      this.disabled = false;
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    querySelector(selector) { return this.refs?.[selector] || null; }
  }
  const list = new Element('ol');
  const progressList = new Element('ol');
  const root = new Element('section');
  root.refs = {
    '#youtube-comments-list': list,
    '#youtube-progress-list': progressList,
    '#youtube-progress-status': new Element(),
    '#youtube-progress-count': new Element(),
    '#youtube-comments-status': new Element(),
    '#youtube-comments-video': new Element(),
    '#youtube-comments-count': new Element(),
    '#youtube-comments-refresh': new Element('button'),
    '#youtube-comments-more': new Element('button'),
  };
  let currentTime = Date.parse('2026-09-02T14:01:00.000Z');
  const interaction = createYoutubeHomepageInteraction({
    nextchat: { publishViewerMessage() {}, upsertLiveComment() {}, updateAgentReply() {}, setHarnessStatus() {} },
    runner: async (action, args) => ({
      ok: true,
      destination: args.query,
      viewMode: args.viewMode,
      action,
    }),
    now: () => currentTime,
    documentRef: {
      createElement: (tagName) => new Element(tagName),
      getElementById: (id) => id === 'youtube-comments-panel' ? root : null,
    },
  });

  await interaction.ingest([{
    id: 'ens-1',
    videoId: '',
    author: 'Viewer Name',
    authorHandle: '@viewerhandle',
    text: 'Navigate to Ensenada, Mexico',
    publishedAt: '2026-09-02T14:00:00.000Z',
    actions: [{ action: 'fly_to_location', args: { query: 'Ensenada, Mexico', viewMode: 'street' } }],
  }]);

  assert.equal(list.children[0].children[0].textContent, '@viewerhandle · 14:00 UTC');
  assert.equal(list.children[0].children[1].textContent, 'Navigate to Ensenada, Mexico');
  const exchange = progressList.children[0];
  assert.equal(exchange.children[0].textContent, '@viewerhandle · 14:00 UTC');
  assert.equal(exchange.children[1].textContent, 'Navigate to Ensenada, Mexico');
  assert.equal(exchange.children[2].className, 'youtube-agent-reply');
  assert.equal(exchange.children[2].children[0].className, 'youtube-followup-countdown is-urgent');
  assert.equal(exchange.children[2].children[0].children[0].textContent, '0:30');
  assert.equal(exchange.children[2].children[0].children[1].textContent, 'TIME LEFT TO REPLY');
  assert.equal(exchange.children[2].children[1].textContent, "@viewerhandle'S TURN");
  assert.equal(exchange.children[2].children[2].textContent, 'CLOUD COMPUTER AI.COM REPLY · 14:01 UTC');
  assert.match(exchange.children[2].children[4].textContent, /I NAVIGATED TO ENSENADA, MEXICO · STREET VIEW/);
  assert.match(exchange.children[2].children[5].textContent, /REPLY TO ASK: ALTITUDE/);

  await interaction.ingest([{
    id: 'ordinary-1',
    videoId: '',
    author: 'Another Viewer',
    authorHandle: '@another',
    text: 'This should keep the general chat moving',
    publishedAt: '2026-09-02T14:01:30.000Z',
    actions: [],
  }]);
  assert.equal(list.children.length, 2, 'all comments keeps receiving ordinary chat');
  assert.equal(progressList.children.length, 1, 'ordinary chat does not displace the active conversation');

  await interaction.ingest([{
    id: 'queued-1',
    videoId: '',
    author: 'Queued Viewer',
    authorHandle: '@queued',
    text: 'Navigate to Tokyo',
    publishedAt: '2026-09-02T14:01:31.000Z',
    agentMode: 'execute',
    actions: [],
  }]);
  interaction.publishCommandStatuses([{
    id: 'cmd-queued-1',
    command: 'viewer-request',
    state: 'received',
    reason: 'Queued until @viewerhandle replies (30s window)',
    holdUntil: currentTime + 30_000,
    viewer: 'Queued Viewer',
    authorHandle: '@queued',
    commentId: 'queued-1',
    videoId: '',
    updatedAt: currentTime,
  }]);
  assert.equal(progressList.children.length, 2);
  const largeCountdowns = progressList.children.flatMap((row) => (
    row.children.flatMap((child) => (
      child.children?.filter((nested) => nested.className?.includes('youtube-followup-countdown')) || []
    ))
  ));
  assert.equal(largeCountdowns.length, 1, 'only one active conversation renders the large countdown');
  assert.equal(progressList.children[1].children[0].textContent, '#1 WAITING');
  assert.equal(progressList.children[1].children[1].textContent, '@queued');
  assert.equal(progressList.children[1].children[2].textContent, 'Navigate to Tokyo');

  currentTime += 30_001;
  interaction.publishCommandStatuses([{
    id: 'cmd-queued-1',
    command: 'viewer-request',
    state: 'interpreting',
    viewer: 'Queued Viewer',
    authorHandle: '@queued',
    commentId: 'queued-1',
    videoId: '',
    updatedAt: currentTime,
  }]);
  await interaction.ingest([{
    id: 'ordinary-2',
    videoId: '',
    author: 'Third Viewer',
    authorHandle: '@third',
    text: 'The feed continues after another viewer expires',
    publishedAt: '2026-09-02T14:03:01.000Z',
    actions: [],
  }]);
  assert.equal(list.children.length, 4);
  assert.equal(progressList.children.length, 1);
  assert.equal(progressList.children[0].children[0].textContent, '@queued · 14:01 UTC');
  assert.equal(progressList.children[0].children[1].textContent, 'Navigate to Tokyo');
  assert.equal(progressList.children[0].children[2].children[0].textContent, "CLOUD COMPUTER AI.COM'S TURN");
});

test('chat box includes the supplied Cloud Computer AI.com logo and working state', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(html, /id="youtube-chat-brand"/);
  assert.match(html, /Cloud_Computer_Ai\.com_Logo_1788479760821\.png/);
  assert.match(html, /WAITING FOR THE NEXT VIEWER REQUEST/);
  assert.match(css, /\.youtube-chat-brand\[data-turn-state='working'\] \.youtube-chat-brand-logo/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('full Hermes details stay open inside Live Comments with live-turn states', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const interaction = readFileSync(new URL('./youtubeHomepageInteraction.js', import.meta.url), 'utf8');
  assert.match(html, /id="hermes-agent-card"[^>]*data-state="idle"/);
  assert.match(html, /HERMES AGENT/);
  assert.match(html, /Hi, I’m Hermes\./);
  assert.match(html, /Thanks for watching me train myself\. I’m kind of lonely—can you please chat with me here\?/);
  assert.match(html, /id="youtube-hermes-mode"/);
  assert.match(html, /id="youtube-hermes-detail"/);
  assert.match(html, /id="hermes-agent-seeing"/);
  assert.match(html, /id="hermes-agent-observing"/);
  assert.match(html, /id="hermes-agent-capabilities"/);
  assert.match(html, /data-hermes-action="rollback-learning"/);
  assert.doesNotMatch(html, /<aside id="hermes-agent-card"/);
  assert.doesNotMatch(html, /hermes-agent-expand|FULL DETAILS/);
  assert.ok(
    html.indexOf('id="hermes-agent-card"') < html.indexOf('class="youtube-chat-card youtube-progress-card"'),
    'Hermes details should be the first card inside Live Comments',
  );
  assert.ok(
    html.indexOf('class="youtube-chat-card youtube-progress-card"') < html.indexOf('class="youtube-chat-card youtube-all-comments-card"'),
    'viewer progress and all-comments cards should retain their order after Hermes',
  );
  assert.match(css, /\.youtube-hermes-card/);
  assert.match(css, /\.youtube-hermes-card[\s\S]*background:\s*rgba\(2,\s*12,\s*20,\s*0\.76\)/);
  assert.doesNotMatch(css, /youtube-hermes-card[\s\S]{0,300}166,\s*132,\s*255/);
  assert.match(css, /#hermes-agent-card\[data-state='working'\]/);
  assert.match(interaction, /NO VIEWER TURN ACTIVE/);
  assert.match(interaction, /Hermes is finishing the current training task\./);
  assert.match(interaction, /I’ll reply to your comment as soon as I finish the current task I’m executing\./);
  assert.match(interaction, /VIEWER COMMENT QUEUED · TRAINING TASK IN PROGRESS/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('Hermes diagnostics follow all live comments in the required single-column order', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const orderedIds = [
    'hermes-agent-title',
    'youtube-hermes-mode',
    'hermes-agent-status',
    'youtube-progress-title',
    'youtube-all-comments-title',
    'hermes-agent-seeing',
    'hermes-agent-practicing',
    'hermes-agent-attempting',
    'hermes-agent-observing',
    'hermes-agent-learning',
    'hermes-agent-provider',
    'hermes-agent-capabilities',
    'hermes-agent-failure',
    'hermes-agent-lessons',
  ];
  for (let index = 1; index < orderedIds.length; index += 1) {
    assert.ok(
      html.indexOf(`id="${orderedIds[index - 1]}"`) < html.indexOf(`id="${orderedIds[index]}"`),
      `${orderedIds[index - 1]} should precede ${orderedIds[index]}`,
    );
  }
  const orderedControls = ['pause-training', 'resume-training', 'hermes-agent-inspect', 'clear-learning', 'rollback-learning'];
  const controlPositions = orderedControls.map((control) => (
    control === 'hermes-agent-inspect'
      ? html.indexOf(`id="${control}"`)
      : html.indexOf(`data-hermes-action="${control}"`)
  ));
  assert.deepEqual(controlPositions, [...controlPositions].sort((a, b) => a - b));
  assert.match(css, /#youtube-comments-panel #hermes-agent-card \{[\s\S]*?flex-direction: column !important;[\s\S]*?gap: 12px !important;/);
  assert.match(css, /#youtube-comments-panel #hermes-agent-card \.hermes-agent-header \{[\s\S]*?flex-direction: column !important;/);
  assert.match(css, /#youtube-comments-panel \.hermes-agent-diagnostics \.hermes-agent-mind \{[\s\S]*?flex-direction: column !important;/);
  assert.match(css, /#youtube-comments-panel \.hermes-agent-diagnostics \.hermes-agent-details div \{[\s\S]*?flex-direction: column !important;/);
  assert.match(css, /#youtube-comments-panel \.hermes-agent-diagnostics \.hermes-agent-controls \{[\s\S]*?flex-direction: column !important;/);
  assert.match(css, /#youtube-comments-panel \.hermes-agent-diagnostics \.hermes-agent-controls button \{[\s\S]*?width: 100% !important;/);
  assert.match(css, /#youtube-comments-panel \.hermes-agent-diagnostics #hermes-agent-lessons \{[\s\S]*?overflow-wrap: anywhere !important;[\s\S]*?white-space: normal !important;/);
});

test('follow-up countdown displays the complete 30-second reply window', () => {
  assert.equal(formatFollowUpCountdown(30_000), '0:30');
  assert.equal(formatFollowUpCountdown(30_001), '0:31');
  assert.equal(formatFollowUpCountdown(0), '0:00');
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
    now: () => 100_000,
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
    args: { query: 'ensenada mexico', viewMode: 'overview', waitForArrival: true },
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
    now: () => 100_000,
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
      if (url.includes('/agent/valid')) {
        return { ok: true, async json() { return { active: true }; } };
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

  globalThis.__GEV_CAPTURE_EXECUTOR__ = true;
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
  delete globalThis.__GEV_CAPTURE_EXECUTOR__;
});

test('trusted capture page drains idle practice through the executor transport', async () => {
  const calls = [];
  let leaseRequests = 0;
  let postedResult = null;
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const interaction = createYoutubeHomepageInteraction({
    fetchImpl: async (url, options = {}) => {
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
              commands: [],
            };
          },
        };
      }
      if (url.includes('/agent/lease')) {
        return { ok: true, async json() { return { lease: null }; } };
      }
      if (url.includes('/executor/lease')) {
        leaseRequests += 1;
        return {
          ok: true,
          async json() {
            return {
              lease: {
                commandId: 'practice-1',
                captureEpoch: 'epoch-1',
                videoId: 'vid',
                generation: 1,
                tool: { name: 'get_current_view_state', arguments: {} },
              },
            };
          },
        };
      }
      if (url.includes('/executor/valid')) {
        return { ok: true, async json() { return { active: true }; } };
      }
      if (url.includes('/executor/result')) {
        postedResult = JSON.parse(options.body);
        complete(postedResult);
        return { ok: true, async json() { return { ok: true }; } };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    runner: async (action, args) => {
      calls.push({ action, args });
      return { ok: true, action };
    },
    nextchat: {
      publishViewerMessage() {},
      updateAgentReply() {},
      setHarnessStatus() {},
    },
    documentRef: null,
    clock: {
      setTimeout() { return 1; },
      clearTimeout() {},
    },
  });

  globalThis.__GEV_CAPTURE_EXECUTOR__ = true;
  interaction.start();
  const result = await done;
  interaction.stop();
  delete globalThis.__GEV_CAPTURE_EXECUTOR__;

  assert.deepEqual(calls, [{ action: 'get_current_view_state', args: {} }]);
  assert.deepEqual(result, {
    commandId: 'practice-1',
    captureEpoch: 'epoch-1',
    result: { ok: true, action: 'get_current_view_state' },
  });
});

test('trusted capture page aborts an idle action when its lease is preempted', async () => {
  let leaseRequests = 0;
  let validityChecks = 0;
  let resultPosts = 0;
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const interaction = createYoutubeHomepageInteraction({
    fetchImpl: async (url) => {
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
              commands: [],
            };
          },
        };
      }
      if (url.includes('/agent/lease')) {
        return { ok: true, async json() { return { lease: null }; } };
      }
      if (url.includes('/executor/lease')) {
        leaseRequests += 1;
        return {
          ok: true,
          async json() {
            return {
              lease: leaseRequests === 1
                ? {
                  commandId: 'practice-preempt',
                  captureEpoch: 'epoch-1',
                  videoId: 'vid',
                  generation: 1,
                  tool: { name: 'zoom_to_globe', arguments: {} },
                }
                : null,
            };
          },
        };
      }
      if (url.includes('/executor/valid')) {
        validityChecks += 1;
        return { ok: true, async json() { return { active: validityChecks === 1 }; } };
      }
      if (url.includes('/executor/result')) {
        resultPosts += 1;
        return { ok: false, async json() { return { error: { kind: 'cancelled' } }; } };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    runner: async (_action, _args, control) => new Promise((resolve, reject) => {
      control.signal.addEventListener('abort', () => {
        complete(control.signal.reason?.message || 'aborted');
        reject(control.signal.reason);
      }, { once: true });
    }),
    nextchat: {
      publishViewerMessage() {},
      updateAgentReply() {},
      setHarnessStatus() {},
    },
    documentRef: null,
    clock: {
      setTimeout(callback, delay) {
        if (delay === 50) queueMicrotask(callback);
        return 1;
      },
      clearTimeout() {},
    },
  });

  globalThis.__GEV_CAPTURE_EXECUTOR__ = true;
  interaction.start();
  const result = await done;
  await new Promise((resolve) => setTimeout(resolve, 0));
  interaction.stop();
  delete globalThis.__GEV_CAPTURE_EXECUTOR__;

  assert.equal(result, 'Idle practice was preempted');
  assert.equal(validityChecks, 2);
  assert.equal(resultPosts, 1);
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


test('with commandRuntime, every live chat item is registered not only the latest', async () => {
  const registered = [];
  const middleware = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => liveIdentity(),
    listChat: async () => ({
      items: [
        {
          id: 'chat-a',
          snippet: { displayMessage: 'navigate to Tokyo', publishedAt: '2026-09-01T00:00:00.000Z' },
          authorDetails: { displayName: 'Ada' },
        },
        {
          id: 'chat-b',
          snippet: { displayMessage: 'navigate to Paris', publishedAt: '2026-09-01T00:00:01.000Z' },
          authorDetails: { displayName: 'Bob' },
        },
      ],
      nextPageToken: '',
      pollingIntervalMillis: 5000,
    }),
    commandRuntime: {
      registerMessage: async (item) => { registered.push(item.id); },
      statuses: async () => [],
    },
  });
  const response = await invoke(middleware, '/feed');
  assert.equal(response.status, 200);
  assert.deepEqual(registered, ['chat-a', 'chat-b']);
});

test('homepage comments reach Hermes with capture context before the first tool selection', async () => {
  const interpreted = [];
  const runtime = createYoutubePublicCommandRuntime({
    ledger: createInMemoryPublicCommandLedger(),
    interpret: async (input) => {
      interpreted.push(input);
      return {
        ok: true,
        kind: 'tool',
        call: {
          name: 'fly_to_location',
          arguments: { query: 'Tokyo' },
          responseId: 'response',
          callId: 'call',
        },
      };
    },
  });
  const session = await runtime.rotateExecutor();
  const identity = liveIdentity();
  const homepage = createYoutubeHomepageChatMiddleware({
    discoverActive: async () => identity,
    listChat: async () => ({
      items: [{
        id: 'chat-context',
        snippet: { displayMessage: 'Take me to Tokyo', publishedAt: '2026-09-01T00:00:00.000Z' },
        authorDetails: { displayName: 'Viewer' },
      }],
      nextPageToken: '',
      pollingIntervalMillis: 5000,
    }),
    commandRuntime: runtime,
  });
  await invoke(homepage, '/feed');
  assert.equal(interpreted.length, 0);

  const binding = { commandsEnabled: true, videoId: identity.videoId, generation: identity.generation };
  const agent = runtime.middleware({ getBinding: () => binding });
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/agent/lease';
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = {
    host: '127.0.0.1:5000',
    'content-type': 'application/json',
    [PUBLIC_EXECUTOR_HEADER]: session.credential,
  };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(value) { this.body = JSON.parse(value); },
  };
  const viewContext = {
    camera: { latitude: 35.68, longitude: 139.76 },
    controls: [{ id: 'style-thermal', label: 'Thermal', disabled: false }],
    screenshot: { dataUrl: `data:image/webp;base64,${'a'.repeat(12_000)}` },
  };
  const pending = agent(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ viewContext })));
  req.emit('end');
  await pending;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lease.tool.name, 'fly_to_location');
  assert.deepEqual(interpreted[0].viewContext, viewContext);
});

test('vite homepage middleware is constructed with commandRuntime', () => {
  const src = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(src, /createYoutubePublicCommandRuntime\s*\(/);
  assert.match(src, /createYoutubeHomepageChatMiddleware\(\s*\{[\s\S]*commandRuntime/);
});
