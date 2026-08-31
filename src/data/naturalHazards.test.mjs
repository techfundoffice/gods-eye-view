import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  HAZARD_CATEGORIES,
  NATURAL_HAZARDS_LABEL_LIMIT,
  buildHazardOverlayEntry,
  createNaturalHazardsLayer,
  hazardCounts,
  normalizeHazardPayload,
  sourceHealthSummary,
  visibleHazards,
} from './naturalHazards.js';

function payload() {
  return {
    generatedAt: '2026-08-31T12:00:00.000Z',
    hazards: [
      {
        id: 'usgs:q1',
        category: 'earthquake',
        title: 'M 5.1 test',
        coordinates: { latitude: 30, longitude: -97 },
        startedAt: '2026-08-31T11:00:00.000Z',
        updatedAt: '2026-08-31T11:05:00.000Z',
        magnitude: 5.1,
        depthKm: 8,
        source: { name: 'USGS', url: 'https://example.test/q1', attribution: 'USGS' },
      },
      {
        id: 'eonet:f1',
        category: 'wildfire',
        title: 'Test fire',
        coordinates: { latitude: 40, longitude: -120 },
        startedAt: '2026-08-31T10:00:00.000Z',
        source: { name: 'NASA EONET', url: 'https://example.test/f1', attribution: 'NASA' },
      },
    ],
    context: [{ id: 'fema:1', type: 'declaration', title: 'Declaration' }],
    sources: {
      eonet: { status: 'fresh', fetchedAt: '2026-08-31T12:00:00.000Z' },
      usgs: { status: 'cached', fetchedAt: '2026-08-31T12:00:00.000Z' },
      fema: { status: 'stale', fetchedAt: '2026-08-31T10:00:00.000Z' },
      reliefweb: { status: 'unavailable', fetchedAt: null },
    },
  };
}

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(value) { dataSources.push(value); return value; },
      remove(value) {
        const index = dataSources.indexOf(value);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    scene: {
      canvas: {},
      pick() { return null; },
    },
    _dataSources: dataSources,
  };
}

function fakeHandler() {
  return {
    actions: new Map(),
    setInputAction(callback, type) { this.actions.set(type, callback); },
    destroy() { this.destroyed = true; },
  };
}

test('hazard payload validation, filtering, counts, and source health are bounded and deterministic', () => {
  const raw = payload();
  raw.hazards.push(
    { ...raw.hazards[0], id: 'invalid-coordinates', coordinates: { latitude: 999, longitude: 0 } },
    { ...raw.hazards[0], id: 'unsupported', category: 'tsunami' },
    { ...raw.hazards[0] },
  );
  const normalized = normalizeHazardPayload(raw);
  assert.equal(normalized.hazards.length, 2);
  assert.deepEqual(hazardCounts(normalized.hazards), {
    earthquake: 1,
    wildfire: 1,
    'severe-storm': 0,
    volcano: 0,
  });
  assert.deepEqual(visibleHazards(normalized.hazards, { wildfire: false }).map(({ id }) => id), ['usgs:q1']);
  const health = sourceHealthSummary(normalized.sources);
  assert.deepEqual(health.stale.map(({ id }) => id), ['fema']);
  assert.deepEqual(health.unavailable.map(({ id }) => id), ['reliefweb']);
  assert.match(health.error, /FEMA stale/);
  assert.match(health.error, /RELIEFWEB unavailable/);
});

test('selected hazard overlay exposes details, source link, and a bounded ambient cohort', () => {
  const record = normalizeHazardPayload(payload()).hazards[0];
  const entry = buildHazardOverlayEntry(record, { selected: true, activate() {} });
  assert.equal(entry.variant, 'card');
  assert.equal(entry.protected, true);
  assert.match(entry.details.join(' '), /Magnitude 5.1/);
  assert.match(entry.details.join(' '), /https:\/\/example.test\/q1/);
  assert.equal(NATURAL_HAZARDS_LABEL_LIMIT, 48);
  assert.deepEqual(Object.keys(HAZARD_CATEGORIES), ['earthquake', 'wildfire', 'severe-storm', 'volcano']);
});

test('natural hazards layer renders, filters, reports source failures, and cleans up', async () => {
  const viewer = fakeViewer();
  const publications = [];
  const overlayHost = {
    setEntries(id, entries, options) { publications.push({ id, entries, options }); },
    setVisible() {},
    clearSource() {},
    hitTest() { return null; },
  };
  const layer = createNaturalHazardsLayer({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload() }),
    overlayHost,
    screenSpaceEventHandlerFactory: fakeHandler,
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(viewer._dataSources[0].entities.values.length, 2);
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().contextCount, 1);
  assert.equal(layer.getStats().stale, true);
  assert.match(layer.getStats().error, /RELIEFWEB unavailable/);
  assert.equal(layer.getRowControls().chips.length, 8);
  assert.equal(layer.setParams({ wildfire: false }), true);
  assert.equal(viewer._dataSources[0].entities.values.length, 1);
  assert.equal(layer.getStats().count, 1);
  assert.ok(publications.at(-1).entries.every((entry) => entry.id !== 'eonet:f1'));
  assert.equal(layer._selectForTest('usgs:q1'), true);
  assert.equal(publications.at(-1).entries[0].variant, 'card');
  layer.disable();
  layer.destroy(viewer);
  assert.equal(viewer._dataSources.length, 0);
});

test('natural hazards update is cancellable and does not publish aborted results', async () => {
  const viewer = fakeViewer();
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const layer = createNaturalHazardsLayer({
    fetchImpl: async () => {
      await pending;
      return { ok: true, status: 200, json: async () => payload() };
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {}, hitTest() { return null; } },
    screenSpaceEventHandlerFactory: fakeHandler,
  });
  layer.init(viewer);
  layer.enable(viewer);
  const controller = new AbortController();
  const update = layer.update(viewer, { signal: controller.signal });
  controller.abort();
  resolve();
  assert.equal(await update, false);
  assert.equal(layer.getStats().count, null);
  assert.equal(viewer._dataSources[0].entities.values.length, 0);
  layer.destroy(viewer);
});