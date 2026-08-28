import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_ERROR_KINDS,
  classifyFeedError,
  createBoundedBackoff,
  createRateLimitedLogger,
  describeFeedError,
  isTerminalFeedErrorKind,
} from './feedDiagnostics.js';

test('timeout, auth, quota and network failures are told apart', () => {
  // AbortSignal.timeout rejects with a DOMException named TimeoutError; every
  // call site previously reported all four of these as "network error".
  assert.equal(
    classifyFeedError(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })),
    FEED_ERROR_KINDS.timeout,
  );
  assert.equal(classifyFeedError(new Error('request timeout')), FEED_ERROR_KINDS.timeout);
  assert.equal(classifyFeedError(null, { status: 401 }), FEED_ERROR_KINDS.auth);
  assert.equal(classifyFeedError(null, { status: 403 }), FEED_ERROR_KINDS.auth);
  assert.equal(classifyFeedError(null, { status: 429 }), FEED_ERROR_KINDS.quota);
  assert.equal(classifyFeedError(new Error('Failed to fetch')), FEED_ERROR_KINDS.network);
});

test('a layer-initiated abort is not a failure', () => {
  assert.equal(
    classifyFeedError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    FEED_ERROR_KINDS.aborted,
  );
});

test('a 503 is split by body: absent credential versus a real outage', () => {
  // Both of this app's proxies answer 503 for "optional key absent".
  assert.equal(
    classifyFeedError(null, { status: 503, detail: 'OPENAI_API_KEY is not set' }),
    FEED_ERROR_KINDS.configurationMissing,
  );
  assert.equal(
    classifyFeedError(null, { status: 503, detail: 'AISSTREAM_API_KEY is not set' }),
    FEED_ERROR_KINDS.configurationMissing,
  );
  assert.equal(
    classifyFeedError(null, { status: 503, detail: 'no_key' }),
    FEED_ERROR_KINDS.configurationMissing,
  );
  assert.equal(
    classifyFeedError(null, { status: 503, detail: 'Regional briefing is temporarily unavailable' }),
    FEED_ERROR_KINDS.upstream,
  );
});

test('server and client error classes are separated', () => {
  assert.equal(classifyFeedError(null, { status: 500 }), FEED_ERROR_KINDS.upstream);
  assert.equal(classifyFeedError(null, { status: 502 }), FEED_ERROR_KINDS.upstream);
  assert.equal(classifyFeedError(null, { status: 404 }), FEED_ERROR_KINDS.http);
  assert.equal(classifyFeedError(new Error('malformed response')), FEED_ERROR_KINDS.malformed);
});

test('only an absent credential is terminal', () => {
  assert.equal(isTerminalFeedErrorKind(FEED_ERROR_KINDS.configurationMissing), true);
  for (const kind of [
    FEED_ERROR_KINDS.timeout,
    FEED_ERROR_KINDS.auth,
    FEED_ERROR_KINDS.quota,
    FEED_ERROR_KINDS.network,
    FEED_ERROR_KINDS.upstream,
  ]) {
    assert.equal(isTerminalFeedErrorKind(kind), false, `${kind} must stay retryable`);
  }
});

test('each kind gets its own actionable phrase', () => {
  const phrases = Object.values(FEED_ERROR_KINDS).map((kind) => describeFeedError(kind, 'OpenSky'));
  assert.equal(new Set(phrases).size, phrases.length, 'phrases must be distinguishable');
  assert.match(describeFeedError(FEED_ERROR_KINDS.timeout, 'OpenSky'), /timed out/);
  assert.match(describeFeedError(FEED_ERROR_KINDS.auth, 'OpenSky'), /credential/);
  assert.match(describeFeedError(FEED_ERROR_KINDS.quota, 'OpenSky'), /rate limited/);
});

test('backoff doubles and stops at the ceiling', () => {
  let clock = 0;
  const backoff = createBoundedBackoff({
    baseMs: 1000,
    maxMs: 8000,
    jitter: 0,
    now: () => clock,
    random: () => 0.5,
  });
  assert.deepEqual(
    [backoff.fail(), backoff.fail(), backoff.fail(), backoff.fail(), backoff.fail(), backoff.fail()],
    [1000, 2000, 4000, 8000, 8000, 8000],
  );
  assert.equal(backoff.consecutiveFailures(), 6);
});

test('a blocked backoff suppresses polls until it expires', () => {
  let clock = 0;
  const backoff = createBoundedBackoff({
    baseMs: 1000, maxMs: 8000, jitter: 0, now: () => clock, random: () => 0.5,
  });
  assert.equal(backoff.isBlocked(), false, 'a fresh backoff never blocks');
  backoff.fail();
  assert.equal(backoff.isBlocked(), true);
  assert.equal(backoff.blockedFor(), 1000);
  clock = 999;
  assert.equal(backoff.isBlocked(), true);
  clock = 1000;
  assert.equal(backoff.isBlocked(), false);
  assert.equal(backoff.blockedFor(), 0);
});

test('a success clears the ladder so recovery is immediate', () => {
  let clock = 0;
  const backoff = createBoundedBackoff({
    baseMs: 1000, maxMs: 8000, jitter: 0, now: () => clock, random: () => 0.5,
  });
  backoff.fail();
  backoff.fail();
  backoff.fail();
  backoff.succeed();
  assert.equal(backoff.isBlocked(), false);
  assert.equal(backoff.consecutiveFailures(), 0);
  assert.equal(backoff.fail(), 1000, 'the ladder restarts from the base delay');
});

test('a per-kind floor raises a delay but never escapes the ceiling', () => {
  let clock = 0;
  const backoff = createBoundedBackoff({
    baseMs: 1000, maxMs: 8000, jitter: 0, now: () => clock, random: () => 0.5,
  });
  assert.equal(backoff.fail(45_000), 8000, 'a long Retry-After is still capped');
  backoff.succeed();
  assert.equal(backoff.fail(4000), 4000, 'the floor wins over a smaller grown delay');
  assert.equal(backoff.fail(1000), 2000, 'the grown delay wins over a smaller floor');
});

test('jitter spreads the delay without leaving the ceiling', () => {
  const backoff = createBoundedBackoff({
    baseMs: 1000, maxMs: 8000, jitter: 0.2, now: () => 0, random: () => 1,
  });
  const delay = backoff.fail();
  assert.ok(delay > 1000 && delay <= 1200, `expected jittered delay near 1000, got ${delay}`);
});

test('jitter can never push a delay past the ceiling', () => {
  // random() === 1 is the maximum upward spread; at the cap it must not apply.
  const backoff = createBoundedBackoff({
    baseMs: 1000, maxMs: 4000, jitter: 0.5, now: () => 0, random: () => 1,
  });
  for (let i = 0; i < 10; i += 1) {
    assert.ok(backoff.fail() <= 4000, 'a bounded backoff must actually be bounded');
  }
  // And a server-directed floor cannot escape it either.
  backoff.succeed();
  assert.ok(backoff.fail(600_000) <= 4000);
});

test('a repeated warning is emitted once, then rate limited', () => {
  let clock = 0;
  const lines = [];
  const logger = createRateLimitedLogger({
    prefix: '[Feed]', intervalMs: 1000, now: () => clock, write: (line) => lines.push(line),
  });

  assert.equal(logger.warn('upstream unreachable', 'net'), true);
  for (let i = 0; i < 20; i += 1) {
    clock += 30;
    assert.equal(logger.warn('upstream unreachable', 'net'), false);
  }
  assert.equal(lines.length, 1, 'twenty identical failures produce one line');

  clock += 1000;
  assert.equal(logger.warn('upstream unreachable', 'net'), true);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /20 similar suppressed/, 'the suppressed count survives');
});

test('a different failure kind reports immediately instead of waiting out the window', () => {
  let clock = 0;
  const lines = [];
  const logger = createRateLimitedLogger({
    prefix: '[Feed]', intervalMs: 100_000, now: () => clock, write: (line) => lines.push(line),
  });
  logger.warn('timed out', 'timeout');
  clock += 10;
  logger.warn('rejected credentials', 'auth');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[Feed\] timed out$/);
  assert.match(lines[1], /^\[Feed\] rejected credentials$/);
});

test('reset re-arms reporting so a recovered feed is not silenced', () => {
  let clock = 0;
  const lines = [];
  const logger = createRateLimitedLogger({
    prefix: '', intervalMs: 100_000, now: () => clock, write: (line) => lines.push(line),
  });
  logger.warn('down', 'k');
  assert.equal(logger.warn('down', 'k'), false);
  logger.reset();
  assert.equal(logger.warn('down', 'k'), true);
  assert.deepEqual(lines, ['down', 'down']);
});

test('extra details are forwarded to the sink for debugging', () => {
  const calls = [];
  const logger = createRateLimitedLogger({
    prefix: '[Feed]', intervalMs: 1000, now: () => 0, write: (...args) => calls.push(args),
  });
  const cause = new Error('socket hang up');
  logger.warn('unreachable', 'net', cause);
  assert.deepEqual(calls, [['[Feed] unreachable', cause]]);
});
