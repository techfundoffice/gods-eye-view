import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATIVE_COMMONS_LICENSE,
  DEFAULT_VIDEO_ID,
  REASON_CHANNEL_NOT_APPROVED,
  REASON_NOT_A_VIDEO,
  REASON_NOT_EMBEDDABLE,
  REASON_NOT_FOUND,
  REASON_NOT_ROYALTY_FREE,
  REASON_NOT_YOUTUBE,
  REASON_UNAVAILABLE,
  checkVideoLicense,
  isApprovedChannel,
  moderateRecommendation,
  normalizeApprovedChannels,
  parseYoutubeUrl,
} from './homeVideoModeration.js';

const CHANNEL = 'UCSMOQeBJ2RAnuFungnQOxLg';

/** Minimal `videos.list` stub. */
function stubFetch(item, { ok = true } = {}) {
  return async () => ({
    ok,
    json: async () => ({ items: item ? [item] : [] }),
  });
}

const ccItem = {
  status: { license: CREATIVE_COMMONS_LICENSE, embeddable: true },
  snippet: { channelId: CHANNEL, channelTitle: 'Blender', title: 'Big Buck Bunny' },
};

test('parseYoutubeUrl classifies every shape we accept', () => {
  assert.deepEqual(parseYoutubeUrl(DEFAULT_VIDEO_ID), { kind: 'video', id: DEFAULT_VIDEO_ID, handle: '', reason: '' });
  assert.equal(parseYoutubeUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ').id, DEFAULT_VIDEO_ID);
  assert.equal(parseYoutubeUrl('https://youtu.be/aqz-KE-bpKQ').id, DEFAULT_VIDEO_ID);
  assert.equal(parseYoutubeUrl('https://www.youtube.com/embed/aqz-KE-bpKQ').id, DEFAULT_VIDEO_ID);
  assert.equal(parseYoutubeUrl('https://www.youtube.com/shorts/aqz-KE-bpKQ').id, DEFAULT_VIDEO_ID);
  assert.equal(parseYoutubeUrl('youtube.com/watch?v=aqz-KE-bpKQ').id, DEFAULT_VIDEO_ID);

  // A video inside a playlist is still a video recommendation.
  const inList = parseYoutubeUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PLabcdefghijkl');
  assert.equal(inList.kind, 'video');
  assert.equal(inList.id, DEFAULT_VIDEO_ID);

  assert.deepEqual(parseYoutubeUrl('https://www.youtube.com/playlist?list=PLabcdefghijkl'),
    { kind: 'playlist', id: 'PLabcdefghijkl', handle: '', reason: '' });
  assert.equal(parseYoutubeUrl(`https://www.youtube.com/channel/${CHANNEL}`).kind, 'channel');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/@BlenderFoundation').handle, 'BlenderFoundation');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/c/Blender').handle, 'Blender');
});

test('parseYoutubeUrl refuses non-YouTube and malformed input', () => {
  // What matters is that nothing is classified; the reason is only for the message.
  for (const input of [
    '',
    'https://vimeo.com/12345',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://www.youtube.com/watch?v=short',
    'not a url at all',
    'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ',
    'https://notyoutube.com/watch?v=aqz-KE-bpKQ',
  ]) {
    const parsed = parseYoutubeUrl(input);
    assert.equal(parsed.kind, '', `expected no classification for ${input}`);
    assert.equal(parsed.id, '');
    assert.ok(parsed.reason, 'a refusal must carry a reason');
  }
  assert.equal(parseYoutubeUrl('').reason, 'empty');
  assert.equal(parseYoutubeUrl('https://vimeo.com/12345').reason, 'not-youtube');
});

test('normalizeApprovedChannels accepts ids, handles, URLs, and free text', () => {
  // Casing survives so ADMIN echoes back what the operator typed.
  assert.deepEqual(
    normalizeApprovedChannels([`https://www.youtube.com/channel/${CHANNEL}`, '@Blender', 'Blender', '  ', '@blender']),
    [CHANNEL, 'Blender'],
  );
  assert.deepEqual(normalizeApprovedChannels('@Blender, NASA'), ['Blender', 'NASA']);
  assert.deepEqual(normalizeApprovedChannels(null), []);
});

test('isApprovedChannel fails closed on an empty list', () => {
  assert.equal(isApprovedChannel({ channelId: CHANNEL }, []), false);
  assert.equal(isApprovedChannel({ channelId: CHANNEL }, [CHANNEL]), true);
  assert.equal(isApprovedChannel({ channelId: 'UCother', channelTitle: 'Blender' }, ['@blender']), true);
});

test('checkVideoLicense refuses rather than allows when it cannot verify', async () => {
  const noKey = await checkVideoLicense(DEFAULT_VIDEO_ID, { apiKey: '', fetchImpl: stubFetch(ccItem) });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.unavailable, true);
  assert.equal(noKey.reason, REASON_UNAVAILABLE);

  const upstreamDown = await checkVideoLicense(DEFAULT_VIDEO_ID, {
    apiKey: 'k',
    fetchImpl: async () => { throw new Error('network'); },
  });
  assert.equal(upstreamDown.ok, false);
  assert.equal(upstreamDown.unavailable, true);

  const http500 = await checkVideoLicense(DEFAULT_VIDEO_ID, { apiKey: 'k', fetchImpl: stubFetch(ccItem, { ok: false }) });
  assert.equal(http500.ok, false);
  assert.equal(http500.unavailable, true);

  const missing = await checkVideoLicense(DEFAULT_VIDEO_ID, { apiKey: 'k', fetchImpl: stubFetch(null) });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, REASON_NOT_FOUND);

  const badId = await checkVideoLicense('nope', { apiKey: 'k', fetchImpl: stubFetch(ccItem) });
  assert.equal(badId.reason, REASON_NOT_YOUTUBE);
});

test('checkVideoLicense reads the license and embeddable flags', async () => {
  const cc = await checkVideoLicense(DEFAULT_VIDEO_ID, { apiKey: 'k', fetchImpl: stubFetch(ccItem) });
  assert.equal(cc.ok, true);
  assert.equal(cc.license, CREATIVE_COMMONS_LICENSE);
  assert.equal(cc.channelId, CHANNEL);
  assert.equal(cc.title, 'Big Buck Bunny');

  const standard = await checkVideoLicense(DEFAULT_VIDEO_ID, {
    apiKey: 'k',
    fetchImpl: stubFetch({ ...ccItem, status: { license: 'youtube', embeddable: true } }),
  });
  assert.equal(standard.ok, false);
  assert.ok(standard.reason.startsWith(REASON_NOT_ROYALTY_FREE));

  const blocked = await checkVideoLicense(DEFAULT_VIDEO_ID, {
    apiKey: 'k',
    fetchImpl: stubFetch({ ...ccItem, status: { license: CREATIVE_COMMONS_LICENSE, embeddable: false } }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, REASON_NOT_EMBEDDABLE);
});

test('moderateRecommendation requires Creative Commons AND an approved channel', async () => {
  const opts = { apiKey: 'k', fetchImpl: stubFetch(ccItem) };

  const allowed = await moderateRecommendation('https://youtu.be/aqz-KE-bpKQ', { ...opts, approvedChannels: [CHANNEL] });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.videoId, DEFAULT_VIDEO_ID);
  assert.equal(allowed.reason, '');

  const unapproved = await moderateRecommendation('https://youtu.be/aqz-KE-bpKQ', { ...opts, approvedChannels: ['@someone-else'] });
  assert.equal(unapproved.allowed, false);
  assert.ok(unapproved.reason.startsWith(REASON_CHANNEL_NOT_APPROVED));
  assert.ok(unapproved.reason.includes('Blender'));

  const standard = await moderateRecommendation('https://youtu.be/aqz-KE-bpKQ', {
    apiKey: 'k',
    approvedChannels: [CHANNEL],
    fetchImpl: stubFetch({ ...ccItem, status: { license: 'youtube', embeddable: true } }),
  });
  assert.equal(standard.allowed, false);
  assert.ok(standard.reason.startsWith(REASON_NOT_ROYALTY_FREE));
});

test('moderateRecommendation refuses what it cannot license-check', async () => {
  const opts = { apiKey: 'k', approvedChannels: [CHANNEL], fetchImpl: stubFetch(ccItem) };

  const playlist = await moderateRecommendation('https://www.youtube.com/playlist?list=PLabcdefghijkl', opts);
  assert.equal(playlist.allowed, false);
  assert.ok(playlist.reason.startsWith(REASON_NOT_A_VIDEO));

  const channel = await moderateRecommendation(`https://www.youtube.com/channel/${CHANNEL}`, opts);
  assert.equal(channel.allowed, false);
  assert.ok(channel.reason.startsWith(REASON_NOT_A_VIDEO));

  const elsewhere = await moderateRecommendation('https://vimeo.com/12345', opts);
  assert.equal(elsewhere.allowed, false);
  assert.equal(elsewhere.reason, REASON_NOT_YOUTUBE);

  // The whole point: a failed lookup must never become an approval.
  const unverifiable = await moderateRecommendation('https://youtu.be/aqz-KE-bpKQ', {
    approvedChannels: [CHANNEL],
    apiKey: '',
    fetchImpl: stubFetch(ccItem),
  });
  assert.equal(unverifiable.allowed, false);
  assert.equal(unverifiable.unavailable, true);
  assert.equal(unverifiable.reason, REASON_UNAVAILABLE);
});
