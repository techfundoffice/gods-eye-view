import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  createYoutubeHomepageChatMiddleware,
  inferHomepageViewerActions,
} from './youtubeHomepageChatServer.js';
import { createYoutubeHomepageInteraction } from './youtubeHomepageInteraction.js';

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

test('homepage feed is tied to the active broadcast and exposes normalized fields only', async () => {
  const middleware = createYoutubeHomepageChatMiddleware({
    sessionStatus: () => ({
      status: 'live',
      broadcast: {
        id: 'CVSB4QJhVTU',
        title: 'Gods Eye View Live',
        watchUrl: 'https://www.youtube.com/watch?v=CVSB4QJhVTU',
        streamKey: 'must-not-leak',
      },
    }),
    chat: {
      async poll(request) {
        assert.equal(request.videoId, 'CVSB4QJhVTU');
        assert.equal(request.continuation, 'NEXT');
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
    },
  });
  const response = await invoke(middleware, '/feed?continuation=NEXT');
  assert.equal(response.status, 200);
  assert.equal(response.body.active, true);
  assert.equal(response.body.videoId, 'CVSB4QJhVTU');
  assert.deepEqual(response.body.items[0], {
    id: 'chat-1',
    videoId: 'CVSB4QJhVTU',
    author: 'CruiseWatcher',
    text: 'Show me Ensenada, Mexico',
    publishedAt: '2026-08-31T22:30:00.000Z',
    source: 'youtube',
    actions: [{
      action: 'fly_to_location',
      args: { query: 'Ensenada, Mexico', viewMode: 'close' },
      reason: 'Viewer requested a frontend view change',
    }],
  });
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /must-not-leak|profileImageUrl|apiKey|streamKey/);
});

test('homepage feed is explicitly offline when the shared live session is inactive', async () => {
  let polls = 0;
  const middleware = createYoutubeHomepageChatMiddleware({
    sessionStatus: () => ({ status: 'stopped', broadcast: { id: 'CVSB4QJhVTU' } }),
    chat: { async poll() { polls += 1; return {}; } },
  });
  const response = await invoke(middleware);
  assert.equal(response.status, 200);
  assert.equal(response.body.active, false);
  assert.deepEqual(response.body.items, []);
  assert.equal(polls, 0);
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
  assert.match(html, /Comment now to change views/);
  assert.match(html, /id="live-news-ticker-url"/);
  assert.match(html, /Live at/);
  assert.match(html, /Now!/);
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
  assert.match(css, /\.live-news-ticker-content \{[\s\S]*?animation: live-news-ticker-scroll 28s linear infinite;/);
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
  assert.equal(displayed[0].metadata.actionState, 'validated');
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