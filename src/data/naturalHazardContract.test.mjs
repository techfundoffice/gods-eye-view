import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeNaturalHazards,
  normalizedCoordinates,
  normalizedTime,
} from './naturalHazardContract.js';

test('natural hazard contract normalizes supported NASA and USGS records', () => {
  const result = normalizeNaturalHazards({
    eonet: { events: [{
      id: 'fire-1', title: 'A fire', categories: [{ id: 'wildfires' }],
      geometry: [{ type: 'Point', date: '2025-01-02T03:04:05Z', coordinates: [-120, 40] }],
    }] },
    usgs: { features: [{
      id: 'quake-1', geometry: { coordinates: [-122, 38, 7.5] },
      properties: { title: 'M 4.2 test', time: 1735787045000, updated: 1735787145000, mag: 4.2, url: 'https://example.test/q' },
    }] },
  });
  assert.equal(result.hazards.length, 2);
  const fire = result.hazards.find((item) => item.category === 'wildfire');
  assert.deepEqual(fire.coordinates, { latitude: 40, longitude: -120 });
  const quake = result.hazards.find((item) => item.category === 'earthquake');
  assert.equal(quake.magnitude, 4.2);
  assert.equal(quake.depthKm, 7.5);
  assert.equal(quake.source.url, 'https://example.test/q');
});

test('natural hazard contract rejects malformed coordinates and timestamps and caps deterministically', () => {
  assert.equal(normalizedCoordinates([181, 1]), null);
  assert.equal(normalizedTime('not a date'), null);
  const result = normalizeNaturalHazards({
    eonet: { events: [
      { id: 'bad', title: 'bad', categories: [{ id: 'volcanoes' }], geometry: [{ type: 'Point', date: 'bad', coordinates: [0, 0] }] },
      { id: 'z', title: 'z', categories: [{ id: 'volcanoes' }], geometry: [{ type: 'Point', date: '2025-01-01', coordinates: [0, 0] }] },
      { id: 'a', title: 'a', categories: [{ id: 'volcanoes' }], geometry: [{ type: 'Point', date: '2025-01-02', coordinates: [0, 0] }] },
    ] },
  }, { hazardLimit: 1 });
  assert.deepEqual(result.hazards.map((item) => item.id), ['eonet:a']);
});

test('natural hazard cap uses recency rather than source-prefixed ids', () => {
  const result = normalizeNaturalHazards({
    eonet: { events: [{
      id: 'old-fire', title: 'Old fire', categories: [{ id: 'wildfires' }],
      geometry: [{ type: 'Point', date: '2025-01-01', coordinates: [0, 0] }],
    }] },
    usgs: { features: [{
      id: 'new-quake', geometry: { coordinates: [1, 1, 5] },
      properties: { title: 'New quake', time: Date.parse('2025-02-01'), mag: 3 },
    }] },
  }, { hazardLimit: 1 });
  assert.deepEqual(result.hazards.map((item) => item.id), ['usgs:new-quake']);
});

test('natural hazard cap reserves room for every represented category', () => {
  const features = Array.from({ length: 8 }, (_, index) => ({
    id: `quake-${index}`,
    geometry: { coordinates: [index, index, 5] },
    properties: { title: `Quake ${index}`, time: Date.parse(`2025-02-0${index + 1}`), mag: 3 },
  }));
  const result = normalizeNaturalHazards({
    eonet: { events: [{
      id: 'fire', title: 'Fire', categories: [{ id: 'wildfires' }],
      geometry: [{ type: 'Point', date: '2025-01-01', coordinates: [0, 0] }],
    }] },
    usgs: { features },
  }, { hazardLimit: 4 });
  assert.ok(result.hazards.some((item) => item.category === 'wildfire'));
  assert.ok(result.hazards.some((item) => item.category === 'earthquake'));
  assert.equal(result.hazards.length, 4);
});

test('natural hazard contract keeps FEMA and ReliefWeb in non-hazard context', () => {
  const result = normalizeNaturalHazards({
    fema: { DisasterDeclarationsSummaries: [{ disasterNumber: 1, designatedArea: 'Texas', incidentType: 'Fire', declarationDate: '2025-01-01' }] },
    reliefweb: { data: [{ id: 2, fields: { title: 'Situation report', date: { created: '2025-01-02' } } }] },
  });
  assert.equal(result.hazards.length, 0);
  assert.deepEqual(result.context.map((item) => item.type), ['report', 'declaration']);
});