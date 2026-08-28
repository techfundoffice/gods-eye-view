// AISStream is an OPTIONAL provider. Without AISSTREAM_API_KEY the dev server's
// watchdog never opens a socket and `/api/ais-live` answers
// `503 {status:"missing-key", error:"AISSTREAM_API_KEY is not set"}` — a settled
// configuration fact for the life of the process.
//
// The layer used to treat it as a failed request: `markAisUnavailable` + a
// `console.warn('[Data:ais-live-vessels]', …)` on every 60 s poll, forever, plus
// a pointless request per tick. This file pins the corrected contract — the
// layer asks once, latches a deterministic unavailable state, reports it once,
// and recovers if a key is added and the layer re-enabled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import aisLiveVesselsLayer, {
  _beginAisSessionForTest,
  _getVesselFeedStateForTest,
  _loadLivePositionsForTest,
  _setAisRuntimeForTest,
  _setVesselStateForTest,
} from './aisLiveVessels.js';

/** A clock the layer's first-connect grace timers can be driven against. */
function fakeRuntime(startMs = 1000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    setTimeout: () => ({ cleared: false }),
    clearTimeout: () => {},
    advance(deltaMs) { nowMs += deltaMs; },
  };
}

/**
 * Drive the production poll against a stubbed `/api/ais-live`.
 * @param {function(): Promise<object>} respond - Stubbed fetch.
 * @returns {object} Harness with request/warning counters and a restore hook.
 */
function harness(respond) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  const priorWarn = console.warn;
  const runtime = fakeRuntime();
  const warnings = [];
  let requests = 0;

  globalThis.window = { location: { origin: 'http://localhost:4173' } };
  globalThis.fetch = async () => {
    requests += 1;
    return respond();
  };
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  _setAisRuntimeForTest(runtime);
  _setVesselStateForTest({ viewer: {}, records: [] });
  _beginAisSessionForTest();

  return {
    runtime,
    warnings,
    requestCount: () => requests,
    poll: () => _loadLivePositionsForTest({}),
    feed: () => _getVesselFeedStateForTest(),
    stats: () => aisLiveVesselsLayer.getStats(),
    restore() {
      globalThis.fetch = priorFetch;
      console.warn = priorWarn;
      if (hadWindow) globalThis.window = priorWindow;
      else delete globalThis.window;
      _setVesselStateForTest({ enabled: false });
      _setAisRuntimeForTest();
    },
  };
}

/** The exact body the dev proxy returns when AISSTREAM_API_KEY is absent. */
const missingKey = () => ({
  ok: false,
  status: 503,
  json: async () => ({ status: 'missing-key', error: 'AISSTREAM_API_KEY is not set', rows: [] }),
});

test('a missing AIS key is asked about exactly once', async () => {
  const h = harness(missingKey);
  try {
    await h.poll();
    assert.equal(h.requestCount(), 1);
    for (let i = 0; i < 20; i += 1) await h.poll();
    assert.equal(h.requestCount(), 1, 'the poll must stop, not keep retrying every interval');
  } finally {
    h.restore();
  }
});

test('the layer settles into a deterministic, non-fatal unavailable state', async () => {
  const h = harness(missingKey);
  try {
    await h.poll();
    const feed = h.feed();
    assert.equal(feed.error, 'AISSTREAM_API_KEY not set');
    assert.equal(feed.status, 'unavailable');
    assert.equal(feed.firstConnectPhase, 'unavailable');
    assert.equal(feed.loading, false);
    // Never "stale": there was no earlier good data to go stale.
    assert.equal(feed.stale, false);

    const stats = h.stats();
    // loadingFeedback treats keyRequired as a settled row rather than a failed
    // mission — see terminalFromParticipantStats in src/loadingFeedback.js.
    assert.equal(stats.keyRequired, true);
    assert.equal(stats.retryInSec, 0, 'a countdown would imply waiting is the fix');
  } finally {
    h.restore();
  }
});

test('the unavailable state is reported once, not once per poll', async () => {
  const h = harness(missingKey);
  try {
    for (let i = 0; i < 10; i += 1) await h.poll();
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /\[Data:ais-live-vessels\]/);
    assert.match(h.warnings[0], /AISSTREAM_API_KEY not set/);
    assert.match(h.warnings[0], /no further requests/);
  } finally {
    h.restore();
  }
});

test('an unsupported transport latches the same way as an absent key', async () => {
  const h = harness(() => ({
    ok: false,
    status: 503,
    json: async () => ({ status: 'unsupported', error: 'ws is unavailable', rows: [] }),
  }));
  try {
    await h.poll();
    await h.poll();
    assert.equal(h.requestCount(), 1);
    assert.equal(h.stats().keyRequired, true);
    assert.equal(h.feed().error, 'live feed unsupported');
  } finally {
    h.restore();
  }
});

test('a transient outage keeps polling, with the warning rate limited', async () => {
  const h = harness(() => ({
    ok: false,
    status: 502,
    json: async () => ({ status: 'error', error: 'stream error' }),
  }));
  try {
    for (let i = 0; i < 5; i += 1) await h.poll();
    assert.equal(h.requestCount(), 5, 'a real outage is not a configuration fact');
    assert.equal(h.stats().keyRequired, false);
    assert.equal(h.warnings.length, 1, 'five identical failures produce one line');
    assert.match(h.warnings[0], /feed down/);
  } finally {
    h.restore();
  }
});

test('a key added between toggles is picked up on the next session', async () => {
  let keyPresent = false;
  const h = harness(() => (keyPresent
    ? { ok: true, status: 200, json: async () => ({ status: 'live', rows: [], lastMessageAt: 1 }) }
    : missingKey()));
  try {
    await h.poll();
    assert.equal(h.stats().keyRequired, true);

    // Operator sets the secret and re-enables the layer.
    keyPresent = true;
    _beginAisSessionForTest();
    assert.equal(h.stats().keyRequired, false, 'a new session must clear the latch');

    await h.poll();
    assert.equal(h.requestCount(), 2, 'the poll resumes on the new session');
    assert.equal(h.stats().keyRequired, false);
  } finally {
    h.restore();
  }
});
