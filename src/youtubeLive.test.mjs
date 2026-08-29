import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  computePollDelay,
  mergeUniqueById,
  normalizeCommentThread,
  normalizeLiveChatMessage,
  summarizeCommentsPanel,
} from './youtubeLive.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
