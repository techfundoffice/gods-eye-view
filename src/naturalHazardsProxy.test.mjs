import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATURAL_HAZARD_SOURCES,
  createNaturalHazardsProxy,
  readJsonCapped,
} from './naturalHazardsProxy.js';

test('natural hazards proxy only has fixed authoritative source URLs', () => {
  assert.deepEqual(Object.keys(NATURAL_HAZARD_SOURCES), ['eonet', 'usgs', 'fema', 'reliefweb']);
  for (const url of Object.values(NATURAL_HAZARD_SOURCES)) assert.match(url, /^https:\/\//);
});

test('natural hazards proxy isolates failed sources and caches successful source responses', async () => {
  let calls = 0;
  const proxy = createNaturalHazardsProxy({
    now: () => 1_000,
    fetchImpl: async (url) => {
      calls += 1;
      if (url.includes('earthquake')) throw new Error('offline');
      return new Response(JSON.stringify(url.includes('eonet') ? {
        events: [{ id: 'f', title: 'fire', categories: [{ id: 'wildfires' }], geometry: [{ type: 'Point', date: '2025-01-01', coordinates: [1, 2] }] }],
      } : {}), { status: 200 });
    },
  });
  const [first, second] = await Promise.all([proxy.getPayload(), proxy.getPayload()]);
  assert.equal(first.hazards.length, 1);
  assert.equal(first.sources.usgs.status, 'unavailable');
  assert.equal(second.sources.eonet.status, 'fresh');
  assert.equal(calls, 4, 'single-flight shares every source refresh');
  const cached = await proxy.getPayload();
  assert.equal(cached.sources.eonet.status, 'cached');
});

test('bounded JSON reader rejects an oversized upstream body', async () => {
  await assert.rejects(readJsonCapped(new Response('{"value":"xxxxxxxx"}'), 8), /too large/);
});