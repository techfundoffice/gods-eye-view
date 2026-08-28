// Terrain-height degradation.
//
// Two gaps this pins shut. (1) The chunk `catch` in terrainHeights.js was
// bare: a dead `/api/terrain/heights` silently dropped every floor in the app
// to sea-level geoid math with nothing in the console to explain it.
// (2) The only cooldown was per COORDINATE, so during an outage a moving
// camera — whose every new cell is a first request — kept a dead endpoint
// saturated. A feed-wide bounded cooldown closes that without changing a
// single returned value: the resolver takes the geoid fallback path it would
// have taken anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetTerrainHeightsDegradationForTest,
  cachedEllipsoidalGround,
  resolveEllipsoidalGround,
  terrainHeightsStatus,
} from './terrainHeights.js';

/** Deterministic clock + fetch stub around one case. */
async function withEnvironment({ fetchImpl, startMs = 900_000_000 }, run) {
  const priorFetch = globalThis.fetch;
  const priorNow = Date.now;
  const priorWarn = console.warn;
  let clock = startMs;
  const warnings = [];
  globalThis.fetch = fetchImpl;
  Date.now = () => clock;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  _resetTerrainHeightsDegradationForTest();
  try {
    return await run({
      warnings,
      advance(deltaMs) { clock += deltaMs; },
    });
  } finally {
    globalThis.fetch = priorFetch;
    Date.now = priorNow;
    console.warn = priorWarn;
    _resetTerrainHeightsDegradationForTest();
  }
}

function proxyOk(points) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: points.map(([lon, lat]) => ({ lon, lat, ellipsoid: 100 })) }),
  };
}

function pointsFrom(url) {
  const parsed = new URL(String(url), 'http://internal');
  return parsed.searchParams.get('points').split(';').map((pair) => pair.split(',').map(Number));
}

/** Distinct coordinates per case — the module cache is process-wide. */
let coordSeed = 0;
function freshCoords(count) {
  coordSeed += 1;
  return Array.from({ length: count }, (_, index) => ({
    lat: 10 + coordSeed * 0.5 + index * 0.001,
    lon: 20 + coordSeed * 0.5 + index * 0.001,
    sourceOrthometricM: 50,
  }));
}

test('an outage stops flooding the dead proxy with every new coordinate', async () => {
  let requests = 0;
  await withEnvironment({
    fetchImpl: async () => {
      requests += 1;
      throw new Error('proxy is down');
    },
  }, async () => {
    // Each batch is a brand-new coordinate, so the per-key cooldown cannot
    // help — only the feed-wide one can.
    for (let i = 0; i < 8; i += 1) {
      const out = await resolveEllipsoidalGround(freshCoords(1));
      assert.equal(out[0].source, 'geoid-fallback', 'callers still get a usable height');
      assert.ok(Number.isFinite(out[0].ellipsoid));
    }
    assert.equal(requests, 1, 'the cooldown must bound requests, not just per-coordinate retries');
  });
});

test('the cooldown grows with consecutive failures and stops at its ceiling', async () => {
  let requests = 0;
  await withEnvironment({
    fetchImpl: async () => {
      requests += 1;
      throw new Error('proxy is down');
    },
  }, async ({ advance }) => {
    const delays = [];
    for (let i = 0; i < 8; i += 1) {
      await resolveEllipsoidalGround(freshCoords(1));
      delays.push(terrainHeightsStatus().retryInMs);
      advance(terrainHeightsStatus().retryInMs + 1);
    }
    assert.deepEqual(
      delays,
      [60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000],
      'bounded exponential backoff, capped at five minutes',
    );
    assert.equal(requests, 8, 'each attempt past the cooldown really is retried');
  });
});

test('a recovered proxy is used again on the very next batch', async () => {
  let down = true;
  await withEnvironment({
    fetchImpl: async (url) => {
      if (down) throw new Error('proxy is down');
      return proxyOk(pointsFrom(url));
    },
  }, async ({ advance }) => {
    const first = await resolveEllipsoidalGround(freshCoords(1));
    assert.equal(first[0].source, 'geoid-fallback');
    assert.equal(terrainHeightsStatus().degraded, true);

    down = false;
    advance(60_001);
    const healed = await resolveEllipsoidalGround(freshCoords(1));
    assert.equal(healed[0].source, 'reearth');
    assert.deepEqual(terrainHeightsStatus(), {
      degraded: false,
      kind: null,
      retryInMs: 0,
      consecutiveFailures: 0,
    });
  });
});

test('heights already resolved are preserved across an outage', async () => {
  let down = false;
  const warm = freshCoords(1);
  await withEnvironment({
    fetchImpl: async (url) => {
      if (down) throw new Error('proxy is down');
      return proxyOk(pointsFrom(url));
    },
  }, async () => {
    const [good] = await resolveEllipsoidalGround(warm);
    assert.equal(good.source, 'reearth');

    down = true;
    await resolveEllipsoidalGround(freshCoords(1));
    assert.equal(terrainHeightsStatus().degraded, true);

    // The successful cache is untouched — the outage must not poison it.
    const [again] = await resolveEllipsoidalGround(warm);
    assert.equal(again.source, 'reearth');
    assert.equal(again.ellipsoid, good.ellipsoid);
    assert.equal(cachedEllipsoidalGround(warm[0].lat, warm[0].lon), good.ellipsoid);
  });
});

test('the failure kind is named rather than reported as a generic error', async () => {
  const cases = [
    [() => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }); }, 'timeout', /timed out/],
    [() => ({ ok: false, status: 429, json: async () => ({}) }), 'quota', /rate limited/],
    [() => ({ ok: false, status: 403, json: async () => ({}) }), 'auth', /credential/],
    [() => ({ ok: false, status: 500, json: async () => ({}) }), 'upstream', /upstream error/],
    [() => { throw new TypeError('Failed to fetch'); }, 'network', /unreachable/],
  ];
  for (const [respond, expectedKind, expectedText] of cases) {
    await withEnvironment({ fetchImpl: async () => respond() }, async ({ warnings }) => {
      await resolveEllipsoidalGround(freshCoords(1));
      assert.equal(terrainHeightsStatus().kind, expectedKind);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /\[Data:TerrainHeights\]/);
      assert.match(warnings[0], expectedText);
      assert.match(warnings[0], /fell back to geoid math/);
      assert.match(warnings[0], /next request in \d+s/);
    });
  }
});

test('a sustained outage is one line, not one per batch', async () => {
  await withEnvironment({
    fetchImpl: async () => { throw new Error('proxy is down'); },
  }, async ({ warnings, advance }) => {
    // Many batches inside one cooldown window: the camera keeps moving, the
    // proxy keeps failing, the console keeps quiet after the first line.
    for (let i = 0; i < 40; i += 1) {
      await resolveEllipsoidalGround(freshCoords(1));
      advance(1000);
    }
    assert.equal(warnings.length, 1, 'forty failed batches produce one diagnostic');

    // Most of those batches never even became failures — the cooldown kept
    // them off the wire — which is why one line covers all forty.
    assert.equal(terrainHeightsStatus().consecutiveFailures, 1);

    // Past both the cooldown and the reporting window, a still-dead proxy says
    // so again: a long outage stays visible without becoming spam.
    advance(300_000);
    await resolveEllipsoidalGround(freshCoords(1));
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /fell back to geoid math/);
  });
});
