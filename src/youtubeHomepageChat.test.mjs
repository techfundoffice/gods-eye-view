import assert from 'node:assert/strict';
import test from 'node:test';

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
});