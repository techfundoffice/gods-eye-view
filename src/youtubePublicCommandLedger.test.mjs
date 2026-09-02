import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFilePublicCommandLedger,
  createInMemoryPublicCommandLedger,
  PUBLIC_COMMAND_STATES,
  PUBLIC_COMMAND_TERMINAL_STATES,
} from './youtubePublicCommandLedger.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const record = (id = 'one', commentId = 'comment') => ({
  id, videoId: 'video', commentId, generation: 7, state: 'received',
});

test('ledger atomically suppresses duplicate video/comment identities', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const [a, b] = await Promise.all([ledger.insert(record('one')), ledger.insert(record('two'))]);
  assert.equal([a, b].filter((item) => item.inserted).length, 1);
  assert.equal((await ledger.list()).length, 1);
});

test('compare-and-set allows one redemption and enforces state graph', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  await ledger.insert(record());
  await ledger.compareAndSet('one', 'received', { state: 'interpreting' });
  await ledger.compareAndSet('one', 'interpreting', { state: 'awaiting-execution', nonce: 'once' });
  const attempts = await Promise.all([
    ledger.compareAndSet('one', 'awaiting-execution', { state: 'executing', nonce: null }),
    ledger.compareAndSet('one', 'awaiting-execution', { state: 'executing', nonce: null }),
  ]);
  assert.equal(attempts.filter((item) => item.changed).length, 1);
  await assert.rejects(
    ledger.compareAndSet('one', 'executing', { state: 'received' }),
    /Invalid transition/,
  );
});

test('restart recovery cancels every nonterminal record but preserves terminal records', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  await ledger.insert(record('one', 'a'));
  await ledger.insert({ ...record('two', 'b'), state: 'succeeded' });
  assert.equal(await ledger.cancelNonterminal('restart'), 1);
  assert.equal((await ledger.get('one')).state, 'cancelled');
  assert.equal((await ledger.get('two')).state, 'succeeded');
  assert.ok(PUBLIC_COMMAND_TERMINAL_STATES.includes((await ledger.get('one')).state));
});

test('file-ledger hydration cancels nonterminal records and preserves terminal records', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-public-ledger-'));
  const filePath = path.join(directory, 'ledger.json');
  try {
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      records: [
        { ...record('pending', 'pending-comment'), state: 'executing', createdAt: 10, updatedAt: 11 },
        { ...record('done', 'done-comment'), state: 'succeeded', answer: 'complete', createdAt: 20, updatedAt: 21 },
      ],
    }));
    const ledger = createFilePublicCommandLedger({ filePath, now: () => 99 });
    await ledger.ready();
    const pending = await ledger.get('pending');
    const done = await ledger.get('done');
    assert.deepEqual(
      { state: pending.state, reason: pending.reason, updatedAt: pending.updatedAt },
      { state: 'cancelled', reason: 'Coordinator restarted before completion', updatedAt: 99 },
    );
    assert.deepEqual(
      { state: done.state, answer: done.answer, createdAt: done.createdAt, updatedAt: done.updatedAt },
      { state: 'succeeded', answer: 'complete', createdAt: 20, updatedAt: 21 },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('returned values are copies and bounded adapter evicts old terminal entries', async () => {
  const ledger = createInMemoryPublicCommandLedger({ maxRecords: 2 });
  await ledger.insert({ ...record('one', 'a'), state: 'succeeded' });
  const copy = await ledger.get('one');
  copy.state = 'failed';
  assert.equal((await ledger.get('one')).state, 'succeeded');
  await ledger.insert({ ...record('two', 'b'), state: 'succeeded' });
  await ledger.insert(record('three', 'c'));
  assert.equal(await ledger.get('one'), null);
});
test('a restart cancels in-flight commands but leaves deferred ones queued', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-ledger-'));
  const filePath = path.join(dir, 'ledger.json');
  const base = { videoId: 'v1', generation: 1, captureExecutorId: 'exec-1' };

  const first = createFilePublicCommandLedger({ filePath });
  await first.insert({ ...base, id: 'a', commentId: 'c-a', state: 'received' });
  await first.insert({ ...base, id: 'b', commentId: 'c-b', state: 'received' });
  await first.compareAndSet('b', 'received', { state: 'interpreting' });
  await first.compareAndSet('b', 'interpreting', { state: 'deferred', retryAt: 123 });

  // Fresh process against the same file.
  const second = createFilePublicCommandLedger({ filePath });
  await second.ready();
  assert.equal((await second.get('a')).state, 'cancelled');
  // The regression this guards: hydration used to cancel everything
  // non-terminal, so a restart during a rate-limit burst silently dropped the
  // whole queue.
  assert.equal((await second.get('b')).state, 'deferred');
  assert.equal((await second.get('b')).retryAt, 123);

  await fs.rm(dir, { recursive: true, force: true });
});

test('deferred is non-terminal and round-trips back into interpreting', async () => {
  assert.ok(PUBLIC_COMMAND_STATES.includes('deferred'));
  assert.ok(!PUBLIC_COMMAND_TERMINAL_STATES.includes('deferred'));
  const ledger = createInMemoryPublicCommandLedger();
  await ledger.insert({ id: 'x', videoId: 'v', commentId: 'c', state: 'received' });
  await ledger.compareAndSet('x', 'received', { state: 'interpreting' });
  assert.equal((await ledger.compareAndSet('x', 'interpreting', { state: 'deferred' })).changed, true);
  assert.equal((await ledger.compareAndSet('x', 'deferred', { state: 'interpreting' })).changed, true);
});
