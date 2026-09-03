import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  DEFAULT_HERMES_YOUTUBE_ADMIN_EMAIL,
  DEFAULT_HERMES_YOUTUBE_ADMIN_HANDLE,
  createHermesAdminCliInterpreter,
  isGoLiveComment,
  isHermesYoutubeAdmin,
  redactHermesAdminReply,
} from './hermesYoutubeAdmin.js';

test('only the TechfundOffice YouTube operator is Hermes admin', () => {
  assert.equal(isHermesYoutubeAdmin({ authorHandle: `@${DEFAULT_HERMES_YOUTUBE_ADMIN_HANDLE}` }), true);
  assert.equal(isHermesYoutubeAdmin({ email: DEFAULT_HERMES_YOUTUBE_ADMIN_EMAIL }), true);
  assert.equal(isHermesYoutubeAdmin({ viewer: 'Techfund Office' }), true);
  assert.equal(isHermesYoutubeAdmin({ isChatOwner: true }), true);
  assert.equal(isHermesYoutubeAdmin({ authorHandle: '@marcusmanagementservices488', viewer: 'Marcus' }), false);
  assert.equal(isHermesYoutubeAdmin({ author: 'Marcus', isChatModerator: true }), false);
});

test('go-live comments are detected and secrets are stripped from CLI replies', () => {
  assert.equal(isGoLiveComment('go live on youtube'), true);
  assert.equal(isGoLiveComment('navigate to paris'), false);
  assert.match(
    redactHermesAdminReply('key=sk-or-v1-abc123 and OPENROUTER_API_KEY=secret'),
    /redacted/,
  );
});

test('admin go-live uses the encoder instead of a viewer fly', async () => {
  const calls = [];
  const interpret = createHermesAdminCliInterpreter({
    goLive: async (body) => {
      calls.push(body);
      return { live: { status: 'live' }, broadcast: { watchUrl: 'https://youtube.com/live/x' } };
    },
    spawnImpl: () => {
      throw new Error('CLI should not spawn for go-live');
    },
  });
  const out = await interpret({
    comment: 'go live on youtube',
    authorHandle: '@TechfundOffice',
    adminOperator: true,
  });
  assert.equal(out.admin, true);
  assert.match(out.text, /Go live live/i);
  assert.equal(calls.length, 1);
});

test('admin coding comments spawn unrestricted Hermes CLI', async () => {
  const spawnCalls = [];
  const spawnImpl = (command, args) => {
    spawnCalls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', 'Installed skill via hermes skills install foo');
      child.emit('close', 0);
    });
    return child;
  };
  const interpret = createHermesAdminCliInterpreter({
    bin: '/home/runner/.local/bin/hermes',
    spawnImpl,
  });
  const out = await interpret({
    comment: 'add a skill using skills.sh for browser testing',
    authorHandle: '@TechfundOffice',
  });
  assert.equal(out.admin, true);
  assert.match(out.text, /Installed skill/);
  assert.ok(spawnCalls[0].args.includes('--yolo'));
  assert.ok(spawnCalls[0].args.includes('--oneshot'));
});
