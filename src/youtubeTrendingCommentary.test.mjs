import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubeTrendingCommentary, normalizeYoutubeTrendingConfig, selectTrendingVideo } from './youtubeTrendingCommentary.js';

const item = (id, views, publishedAt = '2025-01-01T00:00:00Z') => ({
  id, snippet: { title: `Title ${id}`, channelId: 'UCabcdefghijklmnopqrstuv', channelTitle: 'Channel', publishedAt, categoryId: '1' },
  statistics: { viewCount: String(views) }, status: { embeddable: true, privacyStatus: 'public' },
});
const config = (extra = {}) => ({ enabled: true, categoryIds: ['1', '2'], ...extra });

test('normalizes bounded trending configuration and manual single-video URLs', () => {
  const value = normalizeYoutubeTrendingConfig({ enabled: 1, regionCode: 'usa', refreshMinutes: 1, categoryIds: ['1', '1', '2', '3'], maxResults: 99, manualVideoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
  assert.deepEqual(value.categoryIds, ['1', '2', '3']);
  assert.equal(value.regionCode, 'US'); assert.equal(value.refreshMinutes, 15); assert.equal(value.maxResults, 25);
  assert.equal(value.manualVideoUrl, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.equal(normalizeYoutubeTrendingConfig({ manualVideoUrl: 'https://youtube.com/playlist?list=PLabcdefghijkl' }).manualVideoUrl, '');
});

test('merges every category, deduplicates, and selects deterministically', async () => {
  const calls = [];
  const service = createYoutubeTrendingCommentary({
    readConfig: () => config(), readGeminiKey: () => '',
    getOwnerCall: async () => async (_resource, { params }) => {
      calls.push(params.videoCategoryId);
      return { items: params.videoCategoryId === '1'
        ? [item('aaaaaaaaaaa', 10), item('bbbbbbbbbbb', 5)]
        : [item('aaaaaaaaaaa', 10), item('ccccccccccc', 10, '2025-02-01T00:00:00Z')] };
    },
  });
  const snap = await service.snapshot({ force: true });
  assert.deepEqual(calls.sort(), ['1', '2']);
  assert.equal(snap.source.videoId, 'ccccccccccc');
  assert.equal(selectTrendingVideo([item('bbbbbbbbbbb', 1), { ...item('aaaaaaaaaaa', 99), status: { embeddable: false, privacyStatus: 'public' } }]).id, 'bbbbbbbbbbb');
});

test('one unavailable category does not discard valid candidates from another', async () => {
  const service = createYoutubeTrendingCommentary({
    readConfig: () => config(),
    readGeminiKey: () => '',
    getOwnerCall: async () => async (_resource, { params }) => {
      if (params.videoCategoryId === '1') throw new Error('category unavailable');
      return { items: [item('aqz-KE-bpKQ', 20)] };
    },
  });
  assert.equal((await service.snapshot({ force: true })).source.videoId, 'aqz-KE-bpKQ');
});

test('public loads in background, deduplicates calls, and negative-caches failures', async () => {
  let calls = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createYoutubeTrendingCommentary({
    readConfig: () => config({ categoryIds: ['1'] }), readGeminiKey: () => '',
    getOwnerCall: async () => { calls += 1; await gate; throw new Error('offline'); },
  });
  assert.equal((await service.snapshot()).status, 'loading');
  assert.equal((await service.snapshot()).status, 'loading');
  assert.equal(calls, 1);
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.snapshot()).status, 'unavailable');
  assert.equal(calls, 1);
});

test('upstream failure details never cross the public snapshot boundary', async () => {
  const service = createYoutubeTrendingCommentary({
    readConfig: () => config({ categoryIds: ['1'] }),
    getOwnerCall: async () => { throw new Error('upstream token abc-secret-value'); },
  });
  const snap = await service.snapshot({ force: true });
  assert.equal(snap.status, 'unavailable');
  assert.deepEqual(snap.error, {
    kind: 'source-unavailable',
    message: 'Trending source is temporarily unavailable.',
  });
  assert.equal(JSON.stringify(snap).includes('abc-secret-value'), false);
});

test('manual lookup is one validated video and public source is bounded watch/embed data only', async () => {
  let params;
  const service = createYoutubeTrendingCommentary({
    readConfig: () => config({ manualVideoUrl: 'https://youtu.be/aqz-KE-bpKQ' }), readGeminiKey: () => '',
    getOwnerCall: async () => async (_resource, request) => { params = request.params; return { items: [item('aqz-KE-bpKQ', 1)] }; },
  });
  const snap = await service.snapshot({ force: true });
  assert.equal(params.id, 'aqz-KE-bpKQ'); assert.equal(params.chart, undefined);
  assert.deepEqual(Object.keys(snap.source).sort(), ['categoryId', 'channelId', 'channelTitle', 'freshUntil', 'publishedAt', 'regionCode', 'selectedAt', 'title', 'url', 'videoId', 'viewCount']);
  assert.equal(snap.source.url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.equal('raw' in snap, false);
});

test('Gemini receives watch URL in a URL media part and failures are typed', async () => {
  let request; let requestUrl; let requestHeaders;
  const service = createYoutubeTrendingCommentary({
    readConfig: () => config({ categoryIds: ['1'] }), readGeminiKey: () => 'secret',
    getOwnerCall: async () => async () => ({ items: [item('aqz-KE-bpKQ', 1)] }),
    fetchImpl: async (url, options) => {
      requestUrl = url; requestHeaders = options.headers; request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"summary":"Original","segments":[{"atSeconds":3,"text":"Brief"}]}' }] } }] }) };
    },
  });
  const snap = await service.snapshot({ force: true });
  assert.equal(request.contents[0].parts[0].file_data.file_uri, snap.source.url);
  assert.equal(new URL(requestUrl).searchParams.has('key'), false);
  assert.equal(requestHeaders['x-goog-api-key'], 'secret');
  assert.equal(snap.analysis.status, 'ready'); assert.equal(snap.commentator.voiceEnabled, false); assert.equal(snap.commentator.avatarEnabled, true);
  const bad = createYoutubeTrendingCommentary({ readConfig: () => config({ categoryIds: ['1'] }), readGeminiKey: () => 'x', getOwnerCall: async () => async () => ({ items: [item('aqz-KE-bpKQ', 1)] }), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal((await bad.snapshot({ force: true })).analysis.status, 'unavailable');
});

test('decodes the real Response boundary returned by the shared YouTube caller', async () => {
  const service = createYoutubeTrendingCommentary({
    readConfig: () => config({ categoryIds: ['1'] }),
    readGeminiKey: () => '',
    getOwnerCall: async () => async () => new Response(JSON.stringify({ items: [item('aqz-KE-bpKQ', 12)] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal((await service.snapshot({ force: true })).source.videoId, 'aqz-KE-bpKQ');
});

test('unconfigured Gemini is explicitly metadata-only and not transcript analysis', async () => {
  const service = createYoutubeTrendingCommentary({ readConfig: () => config({ categoryIds: ['1'] }), getOwnerCall: async () => async () => ({ items: [item('aqz-KE-bpKQ', 1)] }), readGeminiKey: () => '' });
  const analysis = (await service.snapshot({ force: true })).analysis;
  assert.equal(analysis.status, 'metadata'); assert.match(analysis.summary, /Metadata-only/); assert.match(analysis.summary, /not transcript analysis/);
});