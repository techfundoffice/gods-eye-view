import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePollDelay,
  mergeUniqueById,
  normalizeCommentThread,
  normalizeLiveChatMessage,
} from './youtubeLive.js';

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
