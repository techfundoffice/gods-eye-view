import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubeLiveChatPoster, youtubeReplyPayload } from './hermesYoutubeReply.js';

test('YouTube replies are correlated, sent at most once, and reject a stale broadcast', async () => {
  const calls = [];
  const poster = createYoutubeLiveChatPoster({
    call: async (method, params, body) => { calls.push({ method, params, body }); },
  });
  const payload = youtubeReplyPayload({ liveChatId: 'CHAT', text: '@ada overview is up' });
  assert.equal(payload.snippet.liveChatId, 'CHAT');
  const first = await poster.post({
    commandId: 'cmd-1', videoId: 'vid', liveChatId: 'CHAT', text: '@ada overview is up', expectedVideoId: 'vid',
  });
  assert.equal(first.status, 'sent');
  const again = await poster.post({
    commandId: 'cmd-1', videoId: 'vid', liveChatId: 'CHAT', text: '@ada overview is up', expectedVideoId: 'vid',
  });
  assert.equal(again.status, 'duplicate');
  assert.equal(calls.length, 1);
  const stale = await poster.post({
    commandId: 'cmd-2', videoId: 'other', liveChatId: 'CHAT', text: 'nope', expectedVideoId: 'vid',
  });
  assert.equal(stale.status, 'stale');
});
