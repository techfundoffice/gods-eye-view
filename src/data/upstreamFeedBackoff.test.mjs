// Upstream feed degradation for the two aircraft feeds.
//
// Both layers used to keep a FLAT `_retryAt` cooldown (20 s transient, 45 s on
// 429), so a feed that had been down for an hour was still polled every 20 s
// for that whole hour — each attempt writing an identical `console.warn`. The
// 429 line even said "backing off to 30s" while backing off for 45.
//
// Both now share the bounded exponential backoff and rate-limited, classified
// diagnostics in ./feedDiagnostics.js. This file drives the real `update()` of
// each layer against a stubbed fetch and pins that contract from the outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import flightsLayer, { _resetFeedDegradationForTest as resetFlightsFeed } from './flights.js';
import militaryFlightsLayer, { _resetFeedDegradationForTest as resetMilitaryFeed } from './militaryFlights.js';

/** Per-layer degradation reset — the ladder only clears on a served response. */
const RESET = new Map([
  [flightsLayer, resetFlightsFeed],
  [militaryFlightsLayer, resetMilitaryFeed],
]);

/** A viewer with just the camera the flights URL builder reads. */
const VIEWER = {
  camera: { positionCartographic: { latitude: 0.53, longitude: -1.71, height: 5000 } },
};

/**
 * Drive one layer's production update loop against a stubbed upstream.
 * @param {object} layer - The data layer under test.
 * @param {function(): Promise<object>} respond - Stubbed fetch.
 * @param {function(object): Promise<void>} run - Test body.
 * @returns {Promise<void>}
 */
/**
 * Both layers hold their cooldown and log-suppression state at MODULE scope.
 * Each case starts an hour after the last one ended AND resets the ladder: the
 * cooldown ladder is deliberately not time-based, so only an explicit reset
 * (or a served response) puts the next case back at the base delay.
 */
let _clockBase = 1_700_000_000_000;
/** The active case's clock, so a stubbed response can date itself honestly. */
let _now = _clockBase;

async function withFeed(layer, respond, run) {
  const priorFetch = globalThis.fetch;
  const priorNow = Date.now;
  const priorWarn = console.warn;
  const priorLog = console.log;
  let clock = (_clockBase += 3_600_000);
  _now = clock;
  const warnings = [];
  let requests = 0;

  globalThis.fetch = async () => {
    requests += 1;
    return respond();
  };
  Date.now = () => clock;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  console.log = () => {};
  RESET.get(layer)();
  try {
    await run({
      warnings,
      requestCount: () => requests,
      stats: () => layer.getStats(),
      poll: () => layer.update(VIEWER),
      advance(deltaMs) { clock += deltaMs; _now = clock; },
      /** Run one poll, then jump just past whatever cooldown it armed. */
      async pollThenWaitOutCooldown() {
        await layer.update(VIEWER);
        clock += layer.getStats().retryInSec * 1000 + 1;
        _now = clock;
      },
    });
  } finally {
    // Hand the next case a clock past anything this one armed.
    _clockBase = Math.max(_clockBase, clock);
    RESET.get(layer)();
    globalThis.fetch = priorFetch;
    Date.now = priorNow;
    console.warn = priorWarn;
    console.log = priorLog;
  }
}

const rateLimited = () => ({ ok: false, status: 429, headers: new Headers(), json: async () => ({}) });
const unauthorized = () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({ error: 'invalid token' }) });
const serverError = () => ({ ok: false, status: 502, headers: new Headers(), json: async () => ({}) });

test('a blocked cooldown suppresses the poll entirely', async () => {
  await withFeed(flightsLayer, serverError, async (feed) => {
    await feed.poll();
    assert.equal(feed.requestCount(), 1);
    for (let i = 0; i < 10; i += 1) await feed.poll();
    assert.equal(feed.requestCount(), 1, 'polls inside the cooldown must not reach the network');
    assert.equal(feed.stats().stale, true);
  });
});

test('the OpenSky cooldown doubles and stops at a five-minute ceiling', async () => {
  await withFeed(flightsLayer, serverError, async (feed) => {
    const delays = [];
    for (let i = 0; i < 6; i += 1) {
      await feed.poll();
      delays.push(feed.stats().retryInSec);
      feed.advance(feed.stats().retryInSec * 1000 + 1);
    }
    // 20s base, doubling, capped at 300s. Jitter is +/-20%, so assert bands.
    const expected = [20, 40, 80, 160, 300, 300];
    for (const [index, seconds] of delays.entries()) {
      const ceiling = Math.min(300, expected[index] * 1.2) + 1;
      const floor = Math.min(300, expected[index]) * 0.8 - 1;
      assert.ok(
        seconds >= floor && seconds <= ceiling,
        `step ${index}: expected ~${expected[index]}s, got ${seconds}s`,
      );
    }
    assert.ok(delays[5] <= 301, 'the ceiling must hold');
  });
});

test('a rate limit gets its own longer floor and an honest message', async () => {
  await withFeed(flightsLayer, rateLimited, async (feed) => {
    await feed.poll();
    // The old line claimed 30s while waiting 45.
    assert.ok(feed.stats().retryInSec >= 35, `expected the 45s floor, got ${feed.stats().retryInSec}s`);
    assert.equal(feed.warnings.length, 1);
    assert.match(feed.warnings[0], /\[Data:Flights\]/);
    assert.match(feed.warnings[0], /quota exhausted/);
    assert.match(feed.warnings[0], /OpenSky rate limited/);
    // The chip ceils the remaining wait and the log rounds the armed delay, so
    // they can differ by a second — assert the shape, and the band separately.
    assert.match(feed.warnings[0], /next attempt in \d+s/);
  });
});

test('an authentication rejection is named as such, not as a network error', async () => {
  await withFeed(flightsLayer, unauthorized, async (feed) => {
    await feed.poll();
    assert.equal(feed.warnings.length, 1);
    assert.match(feed.warnings[0], /authentication rejected \(HTTP 401\)/);
    // The server's own explanation is surfaced verbatim to the chip.
    assert.equal(feed.stats().error, 'invalid token');
    assert.ok(feed.stats().retryInSec >= 35, 'auth uses the longer floor too');
  });
});

test('a timeout is distinguished from an unreachable network', async () => {
  await withFeed(flightsLayer, () => {
    throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  }, async (feed) => {
    await feed.poll();
    assert.equal(feed.stats().error, 'OpenSky timed out');
    assert.match(feed.warnings[0], /OpenSky timed out/);
  });

  await withFeed(flightsLayer, () => { throw new TypeError('Failed to fetch'); }, async (feed) => {
    await feed.poll();
    assert.equal(feed.stats().error, 'OpenSky unreachable');
  });
});

test('a sustained OpenSky outage is one line per window, not one per poll', async () => {
  await withFeed(flightsLayer, serverError, async (feed) => {
    // Four failures inside the five-minute reporting window.
    for (let i = 0; i < 4; i += 1) await feed.pollThenWaitOutCooldown();
    assert.equal(feed.requestCount(), 4, 'the polls really did happen');
    assert.equal(feed.warnings.length, 1, 'but they produced one diagnostic');
    assert.match(feed.warnings[0], /upstream response \(HTTP 502\)/);
  });
});

test('a served snapshot clears the cooldown so recovery is immediate', async () => {
  let down = true;
  await withFeed(flightsLayer, () => (down
    ? serverError()
    // Dated against the harness clock: a snapshot minutes old would read as
    // stale and mask the recovery this case is about.
    : { ok: true, status: 200, headers: new Headers(), json: async () => ({ time: Math.floor(_now / 1000), states: [] }) }
  ), async (feed) => {
    await feed.poll();
    assert.ok(feed.stats().retryInSec > 0, 'the first failure arms a cooldown');
    feed.advance(feed.stats().retryInSec * 1000 + 1);
    await feed.poll();
    assert.ok(feed.stats().retryInSec > 25, 'the second failure arms a longer one');
    feed.advance(feed.stats().retryInSec * 1000 + 1);

    down = false;
    await feed.poll();
    assert.equal(feed.stats().retryInSec, 0, 'a good response resets the ladder');
    assert.equal(feed.stats().error, null);

    // And the ladder restarts from the base delay rather than where it left off.
    down = true;
    await feed.poll();
    assert.ok(feed.stats().retryInSec <= 25, `expected a base-delay retry, got ${feed.stats().retryInSec}s`);
  });
});

test('the military feed backs off and reports on the same contract', async () => {
  await withFeed(militaryFlightsLayer, rateLimited, async (feed) => {
    await feed.poll();
    assert.ok(feed.stats().retryInSec >= 35, 'a 429 uses the longer floor');
    assert.equal(feed.stats().error, 'adsb.lol rate limited');
    assert.equal(feed.warnings.length, 1);
    assert.match(feed.warnings[0], /\[Data:Military\]/);
    assert.match(feed.warnings[0], /quota exhausted/);

    for (let i = 0; i < 5; i += 1) await feed.poll();
    assert.equal(feed.requestCount(), 1, 'the cooldown suppresses polls here too');
    assert.equal(feed.warnings.length, 1, 'and the console stays quiet');
  });
});

test('the military feed names a timeout instead of "network error"', async () => {
  await withFeed(militaryFlightsLayer, () => {
    throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  }, async (feed) => {
    await feed.poll();
    assert.equal(feed.stats().error, 'adsb.lol timed out');
  });
});

test('a malformed payload is reported rather than failing silently', async () => {
  await withFeed(militaryFlightsLayer, () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ nonsense: true }),
  }), async (feed) => {
    await feed.poll();
    assert.equal(feed.stats().error, 'Malformed adsb.lol response');
    assert.equal(feed.warnings.length, 1);
    assert.match(feed.warnings[0], /malformed payload/);
  });
});
