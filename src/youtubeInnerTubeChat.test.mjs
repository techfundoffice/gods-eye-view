import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  INNERTUBE_CHAT_PATH,
  INNERTUBE_ORIGIN,
  createYoutubeInnerTubeChat,
  innerTubeRendererToDataApiItem,
  isConsentInterstitial,
  messageRunsToText,
  normalizeVideoId,
  parseLiveChatResponse,
  parseWatchPageOptions,
  rendererFromAction,
} from './youtubeInnerTubeChat.js';
import { createYoutubeInnerTubeChatMiddleware } from './youtubeInnerTubeChatServer.js';
import { normalizeLiveChatMessage } from './youtubeLive.js';

const WATCH_HTML = `
<html><head>
<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk">
<script>ytcfg.set({"INNERTUBE_API_KEY":"web-key-1","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20240827.01.00"});</script>
<script>var ytInitialData = {"contents":{"liveChatRenderer":{"continuations":[{"timedContinuationData":{"continuation":"CONT_INIT","timeoutMs":5000}}]}}};</script>
</head></html>
`;

const CHAT_PAYLOAD = {
  continuationContents: {
    liveChatContinuation: {
      actions: [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: 'msg-1',
                timestampUsec: '1756540800000000',
                authorName: { simpleText: 'DockHand' },
                authorExternalChannelId: 'UC9',
                message: { runs: [{ text: '#Task fly to Ensenada' }, { emoji: { shortcuts: [':ship:'] } }] },
                authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: 'MODERATOR' } } }],
              },
            },
          },
        },
        {
          addChatItemAction: {
            item: {
              liveChatPaidMessageRenderer: {
                id: 'sc-1',
                timestampUsec: '1756540801000000',
                authorName: { simpleText: 'Patron' },
                message: { runs: [{ text: 'Super thanks' }] },
                purchaseAmountText: { simpleText: '$5.00' },
              },
            },
          },
        },
        { addChatItemAction: { item: { liveChatViewerEngagementMessageRenderer: { id: 'sys' } } } },
      ],
      continuations: [{ timedContinuationData: { continuation: 'CONT_NEXT', timeoutMs: 4200 } }],
    },
  },
};

function invoke(middleware, { method = 'GET', url = '/?videoId=abcdefghijk', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      headers,
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(payload) {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: payload ? JSON.parse(payload) : {},
        });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

test('video ids must be the 11-character YouTube form', () => {
  assert.equal(normalizeVideoId('abcdefghijk'), 'abcdefghijk');
  assert.equal(normalizeVideoId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(normalizeVideoId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(normalizeVideoId('nope'), '');
  assert.equal(normalizeVideoId('toolongvideoid'), '');
  assert.equal(normalizeVideoId('https://evil.example/watch?v=abcdefghijk'), 'abcdefghijk');
});

test('watch-page bootstrap extracts WEB client options and rejects replay/consent', () => {
  const options = parseWatchPageOptions(WATCH_HTML);
  assert.equal(options.apiKey, 'web-key-1');
  assert.equal(options.clientVersion, '2.20240827.01.00');
  assert.equal(options.continuation, 'CONT_INIT');
  assert.equal(options.liveId, 'abcdefghijk');

  assert.equal(isConsentInterstitial('Before you continue to YouTube'), true);
  assert.throws(
    () => parseWatchPageOptions('consent.youtube.com INNERTUBE_API_KEY "x" INNERTUBE_CONTEXT_CLIENT_VERSION "y" "continuation":"z"'),
    (error) => error.kind === 'unavailable',
  );
  assert.throws(
    () => parseWatchPageOptions('"isReplay": true "INNERTUBE_API_KEY":"k" "INNERTUBE_CONTEXT_CLIENT_VERSION":"v" "continuation":"c"'),
    (error) => error.kind === 'ended',
  );
  assert.throws(
    () => parseWatchPageOptions('"INNERTUBE_API_KEY":"k" "INNERTUBE_CONTEXT_CLIENT_VERSION":"v"'),
    (error) => error.kind === 'no-chat',
  );
});

test('message runs flatten text and emoji shortcuts', () => {
  assert.equal(messageRunsToText({ runs: [{ text: 'Hi ' }, { emoji: { shortcuts: [':wave:'] } }] }), 'Hi :wave:');
  assert.equal(messageRunsToText({ simpleText: 'plain' }), 'plain');
});

test('InnerTube actions map onto the Data API live-chat item shape', () => {
  const parsed = parseLiveChatResponse(CHAT_PAYLOAD);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.continuation, 'CONT_NEXT');
  assert.equal(parsed.timeoutMs, 4200);
  const text = normalizeLiveChatMessage(parsed.items[0]);
  assert.equal(text.id, 'msg-1');
  assert.equal(text.author, 'DockHand');
  assert.equal(text.text, '#Task fly to Ensenada:ship:');
  assert.equal(text.moderator, true);
  assert.equal(parsed.items[1].snippet.type, 'superChatEvent');
  assert.equal(rendererFromAction({ addChatItemAction: { item: {} } }), null);
  assert.equal(innerTubeRendererToDataApiItem({ id: 'x' }), null);
});

test('the poller bootstraps from the watch page then posts get_live_chat', async () => {
  const calls = [];
  const chat = createYoutubeInnerTubeChat({
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      if (String(url).includes('/watch?')) {
        return { ok: true, status: 200, url, text: async () => WATCH_HTML };
      }
      return {
        ok: true,
        status: 200,
        url,
        text: async () => JSON.stringify(CHAT_PAYLOAD),
      };
    },
  });
  const first = await chat.poll({ videoId: 'abcdefghijk', cacheKey: 's1' });
  assert.equal(first.source, 'innertube');
  assert.equal(first.videoId, 'abcdefghijk');
  assert.equal(first.nextPageToken, 'CONT_NEXT');
  assert.equal(first.items[0].id, 'msg-1');
  assert.equal(calls[0].url, `${INNERTUBE_ORIGIN}/watch?v=abcdefghijk&hl=en`);
  assert.match(calls[1].url, new RegExp(`${INNERTUBE_ORIGIN}${INNERTUBE_CHAT_PATH}\\?prettyPrint=false&key=web-key-1`));
  assert.equal(calls[1].method, 'POST');
  assert.equal(JSON.parse(calls[1].body).continuation, 'CONT_INIT');
  assert.equal(JSON.parse(calls[1].body).context.client.clientName, 'WEB');

  const second = await chat.poll({
    videoId: 'abcdefghijk',
    continuation: 'CONT_NEXT',
    cacheKey: 's1',
  });
  assert.equal(second.nextPageToken, 'CONT_NEXT');
  assert.equal(calls.length, 3, 'cached WEB client skips a second watch-page fetch');
  assert.equal(JSON.parse(calls[2].body).continuation, 'CONT_NEXT');
});

test('client-supplied keys and non-video identifiers are refused', async () => {
  const chat = createYoutubeInnerTubeChat({
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
  });
  await assert.rejects(
    () => chat.poll({ videoId: 'https://evil.example/watch' }),
    (error) => error.kind === 'invalid-request' && error.status === 400,
  );
  await assert.rejects(
    () => chat.poll({ videoId: 'abcdefghijk', continuation: 'x'.repeat(5000) }),
    (error) => error.kind === 'invalid-request',
  );
});

test('signed-out live-chat requests are 401 and never hit YouTube', async () => {
  let fetched = false;
  const middleware = createYoutubeInnerTubeChatMiddleware({
    authorizeRequest: async () => null,
    chat: { poll: async () => { fetched = true; return {}; } },
  });
  const response = await invoke(middleware);
  assert.equal(response.status, 401);
  assert.equal(response.body.error.kind, 'authentication');
  assert.equal(fetched, false);
});

test('the live-chat route returns normalized items and never the WEB client key', async () => {
  const middleware = createYoutubeInnerTubeChatMiddleware({
    authorizeRequest: async () => ({ sessionId: 's1' }),
    chat: {
      poll: async (request) => {
        assert.equal(request.videoId, 'abcdefghijk');
        assert.equal(request.cacheKey, 's1');
        return {
          items: parseLiveChatResponse(CHAT_PAYLOAD).items,
          nextPageToken: 'CONT_NEXT',
          pollingIntervalMillis: 4200,
          videoId: 'abcdefghijk',
          source: 'innertube',
          apiKey: 'web-key-1',
        };
      },
    },
  });
  const response = await invoke(middleware, { url: '/?videoId=abcdefghijk&key=stolen&url=https://evil.example' });
  assert.equal(response.status, 200);
  assert.equal(response.body.source, 'innertube');
  assert.equal(response.body.items[0].id, 'msg-1');
  assert.equal(response.body.nextPageToken, 'CONT_NEXT');
  const raw = JSON.stringify(response.body);
  assert.equal(raw.includes('web-key-1'), false);
  assert.equal(raw.includes('stolen'), false);
  assert.equal(Object.hasOwn(response.body, 'apiKey'), false);
});

test('POST is refused; invalid video ids are 400', async () => {
  const middleware = createYoutubeInnerTubeChatMiddleware({
    authorizeRequest: async () => ({ sessionId: 's1' }),
    chat: { poll: async () => ({ items: [] }) },
  });
  const posted = await invoke(middleware, { method: 'POST' });
  assert.equal(posted.status, 405);
  const bad = await invoke(middleware, { url: '/?videoId=nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.kind, 'invalid-request');
});

test('Vite mounts /api/youtube/live-chat ahead of the Data API proxy', () => {
  const vite = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(vite, /createYoutubeInnerTubeChatMiddleware/);
  const liveChat = vite.indexOf("middlewares.use('/api/youtube/live-chat'");
  const dataApi = vite.indexOf("middlewares.use('/api/youtube'");
  assert.ok(liveChat > 0 && liveChat < dataApi);
});
