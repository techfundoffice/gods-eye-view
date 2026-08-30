import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DataLayerManager } from './manager.js';
import { LAYER_STATE_REGISTRY, REGISTERED_LAYER_IDS } from './layerState.js';
import {
  PUBLIC_API_LAYER_IDS,
  selectGlobeRelevantPublicApis,
} from './publicApiCatalog.js';
import { PUBLIC_API_LAYERS, publicApiLayerById } from './publicApiLayers.js';
import { capCatalogRecords, createCatalogGeoLayer } from './catalogGeoLayer.js';
import { createOpenAqLayer } from './openaq.js';
import { createOpenChargeMapLayer, parseOpenChargeMapPayload } from './openChargeMap.js';
import { createGbifLayer, parseGbifPayload } from './gbif.js';
import { createUsgsWaterLayer, parseUsgsWaterPayload } from './usgsWater.js';
import { createNwsAlertsLayer, parseNwsAlertsPayload } from './nwsAlerts.js';
import { createOpenSenseMapLayer, parseOpenSenseMapPayload } from './openSenseMap.js';
import {
  createAqicnLayer,
  createAviationApiLayer,
  createIdigbioLayer,
  createLuchtmeetnetLayer,
  createNpsLayer,
  createPm25Layer,
  createPurpleAirLayer,
  createRefugeLayer,
  createRidbLayer,
  parseAqicnPayload,
  parseAviationApiPayload,
  parseIdigbioPayload,
  parseLuchtmeetnetPayload,
  parseNpsPayload,
  parsePm25Payload,
  parsePurpleAirPayload,
  parseRefugePayload,
  parseRidbPayload,
} from './catalogCollections.js';
import { clampUsgsIvBbox, USGS_IV_BBOX_PRODUCT_MAX, publicApiCatalogProxy } from '../publicApiProxies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    camera: { computeViewRectangle() { return null; } },
    scene: { globe: { ellipsoid: {} } },
    _dataSources: dataSources,
  };
}

const silentOverlay = { setEntries() {}, setVisible() {}, clearSource() {} };

function jsonFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

test('catalog point cap never emits an uncapped dump', () => {
  const records = Array.from({ length: 500 }, (_, i) => ({ id: String(i), lat: 0, lon: 0 }));
  assert.equal(capCatalogRecords(records).length, 200);
  assert.equal(capCatalogRecords(records, 50).length, 50);
});

test('OpenAQ fixture plots coordinates; HTTP error is not count 0; missing key is KEY REQUIRED', async () => {
  const viewer = fakeViewer();
  const layer = createOpenAqLayer({
    overlayHost: silentOverlay,
    fetchImpl: jsonFetch(200, {
      results: [
        { id: 11, name: 'Austin', coordinates: { latitude: 30.27, longitude: -97.74 }, country: { name: 'US' } },
      ],
    }),
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(viewer._dataSources[0].entities.values.length, 1);
  const ok = layer.getStats();
  assert.equal(ok.count, 1);
  assert.equal(ok.error, null);
  assert.ok(ok.lastUpdate);
  layer.destroy(viewer);

  const failed = createOpenAqLayer({
    overlayHost: silentOverlay,
    fetchImpl: jsonFetch(502, { error: 'upstream' }),
  });
  failed.init(fakeViewer());
  assert.equal(await failed.update(fakeViewer()), false);
  const bad = failed.getStats();
  assert.notEqual(bad.count, 0);
  assert.equal(bad.count, null);
  assert.ok(bad.error);
  assert.equal(bad.lastUpdate, null);

  const keyless = createOpenAqLayer({
    overlayHost: silentOverlay,
    fetchImpl: jsonFetch(503, { error: 'no_key' }),
  });
  keyless.init(fakeViewer());
  assert.equal(await keyless.update(fakeViewer()), false);
  const missing = keyless.getStats();
  assert.equal(missing.keyRequired, true);
  assert.equal(missing.error, 'KEY REQUIRED');
  assert.notEqual(missing.count, 0);
  assert.equal(missing.loadingLabel, 'KEY REQUIRED');
});

test('Open Charge Map, GBIF, USGS water, NWS alerts, and senseBoxes plot fixture coordinates', async () => {
  const cases = [
    {
      create: createOpenChargeMapLayer,
      payload: [{ ID: 9, AddressInfo: { Title: 'Depot', Latitude: 51.5, Longitude: -0.12, Town: 'London' } }],
      parse: parseOpenChargeMapPayload,
    },
    {
      create: createGbifLayer,
      payload: { results: [{ key: 1, decimalLatitude: -1.29, decimalLongitude: 36.82, scientificName: 'Loxodonta' }] },
      parse: parseGbifPayload,
    },
    {
      create: createUsgsWaterLayer,
      payload: {
        value: {
          timeSeries: [{
            sourceInfo: {
              siteName: 'Colorado River',
              siteCode: [{ value: '09380000' }],
              geoLocation: { geogLocation: { latitude: 36.86, longitude: -111.59 } },
            },
            variable: { variableName: 'Streamflow' },
          }],
        },
      },
      parse: parseUsgsWaterPayload,
    },
    {
      create: createNwsAlertsLayer,
      payload: {
        features: [{
          id: 'NWS.1',
          geometry: { type: 'Point', coordinates: [-95.3, 29.7] },
          properties: { event: 'Tornado Warning', areaDesc: 'Harris' },
        }],
      },
      parse: parseNwsAlertsPayload,
    },
    {
      create: createOpenSenseMapLayer,
      payload: { boxes: [{ _id: 'box1', name: 'Roof', currentLocation: { coordinates: [13.4, 52.5] }, exposure: 'outdoor' }] },
      parse: parseOpenSenseMapPayload,
    },
    {
      create: createPurpleAirLayer,
      payload: { fields: ['latitude', 'longitude', 'name'], data: [[30.2, -97.7, 'Austin']] },
      parse: parsePurpleAirPayload,
    },
    {
      create: createIdigbioLayer,
      payload: { items: [{ indexTerms: { uuid: 'u1', geopoint: { lat: 40.7, lon: -74 }, scientificname: 'Quercus' } }] },
      parse: parseIdigbioPayload,
    },
    {
      create: createAqicnLayer,
      payload: { data: [{ uid: 1, lat: 31.2, lon: 121.5, aqi: 80, station: { name: 'Shanghai' } }] },
      parse: parseAqicnPayload,
    },
    {
      create: createLuchtmeetnetLayer,
      payload: { data: [{ number: 'NL1', location: 'Utrecht', geometry: { coordinates: [5.1, 52.1] } }] },
      parse: parseLuchtmeetnetPayload,
    },
    {
      create: createPm25Layer,
      payload: { feeds: [{ device_id: 'd1', gps_lat: 25.0, gps_lon: 121.5, SiteName: 'Taipei' }] },
      parse: parsePm25Payload,
    },
    {
      create: createRefugeLayer,
      payload: [{ id: 3, name: 'Library', latitude: 37.77, longitude: -122.42, city: 'SF' }],
      parse: parseRefugePayload,
    },
    {
      create: createAviationApiLayer,
      payload: [{ faa_ident: 'AUS', facility_name: 'Austin', latitude: 30.19, longitude: -97.67, city: 'Austin' }],
      parse: parseAviationApiPayload,
    },
    {
      create: createNpsLayer,
      payload: { data: [{ parkCode: 'yose', name: 'Yosemite', latitude: '37.86', longitude: '-119.53', states: 'CA' }] },
      parse: parseNpsPayload,
    },
    {
      create: createRidbLayer,
      payload: { RECDATA: [{ FacilityID: '1', FacilityName: 'Camp', FacilityLatitude: 39.1, FacilityLongitude: -106.3 }] },
      parse: parseRidbPayload,
    },
  ];

  for (const entry of cases) {
    assert.equal(entry.parse(entry.payload).length, 1, `${entry.create.name} parser`);
    const viewer = fakeViewer();
    const layer = entry.create({
      overlayHost: silentOverlay,
      fetchImpl: jsonFetch(200, entry.payload),
    });
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(await layer.update(viewer), true, `${layer.id} update`);
    assert.equal(viewer._dataSources[0].entities.values.length, 1, `${layer.id} entity`);
    const stats = layer.getStats();
    assert.equal(stats.count, 1, `${layer.id} count`);
    assert.equal(stats.error, null);
    assert.ok(stats.lastUpdate);
    layer.destroy(viewer);
  }
});

test('USGS IV bbox product is clamped to 25 square degrees', () => {
  const tenByTen = clampUsgsIvBbox({ west: 0, south: 0, east: 10, north: 10 });
  const latSpan = Math.abs(tenByTen.north - tenByTen.south);
  const lonSpan = Math.abs(tenByTen.east - tenByTen.west);
  assert.ok(latSpan * lonSpan <= USGS_IV_BBOX_PRODUCT_MAX + 1e-9);
  assert.equal(Number((latSpan * lonSpan).toFixed(6)), USGS_IV_BBOX_PRODUCT_MAX);
  const small = clampUsgsIvBbox({ west: -80, south: 35, east: -79, north: 36 });
  assert.deepEqual(small, { west: -80, south: 35, east: -79, north: 36 });
  assert.equal(clampUsgsIvBbox(null), null);
});

test('catalog proxy mounts on both the dev server and vite preview', () => {
  const plugin = publicApiCatalogProxy();
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  assert.equal(plugin.configurePreviewServer, plugin.configureServer);
});

test('coverage-limited empty USGS/openSenseMap is labeled ZOOM IN, not count 0', async () => {
  const layer = createUsgsWaterLayer({
    overlayHost: silentOverlay,
    fetchImpl: jsonFetch(200, { value: { timeSeries: [] }, coverage: 'zoom-in' }),
  });
  layer.init(fakeViewer());
  assert.equal(await layer.update(fakeViewer()), true);
  const stats = layer.getStats();
  assert.notEqual(stats.count, 0);
  assert.equal(stats.count, null);
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.loadingLabel, 'ZOOM IN');
  assert.equal(stats.error, null);
  assert.ok(stats.lastUpdate);
});

test('a never-answered catalog layer is not a successful count 0', () => {
  const layer = createCatalogGeoLayer({
    id: 'probe',
    name: 'Probe',
    icon: '·',
    source: 'test',
    endpoint: '/api/probe',
    parsePayload: () => [],
    overlayHost: silentOverlay,
    fetchImpl: jsonFetch(500, {}),
  });
  const stats = layer.getStats();
  assert.equal(stats.lastUpdate, null);
  assert.notEqual(stats.count, 0);
});

test('every filter-accepted catalog source is registered on the DATA panel', () => {
  const accepted = selectGlobeRelevantPublicApis();
  assert.deepEqual(
    accepted.map((entry) => entry.layerId).sort(),
    [...PUBLIC_API_LAYER_IDS].sort(),
  );
  for (const entry of accepted) {
    const layer = publicApiLayerById(entry.layerId);
    assert.ok(layer, `${entry.name} must ship a DATA layer`);
    assert.equal(layer.id, entry.layerId);
    assert.notEqual(layer.showInTogglePanel, false);
    assert.match(mainSource, new RegExp(`publicApiLayers|${entry.layerId}`));
    assert.ok(REGISTERED_LAYER_IDS.includes(entry.layerId), `${entry.layerId} must persist in the layer-state registry`);
  }
  assert.equal(PUBLIC_API_LAYERS.length, accepted.length);
  const existing = [
    'earthquakes', 'flights', 'local-firms', 'ais-live-vessels', 'satellites',
    'rocket-launches', 'bikeshare', 'cctv', 'radio', 'traffic',
    'local-dams', 'local-datacenters', 'telegeography-submarine-cables',
    'military', 'military-awareness', 'military-installations',
  ];
  for (const id of existing) {
    assert.ok(REGISTERED_LAYER_IDS.includes(id), `existing ${id} still registered`);
  }
});

test('catalog layers finalize with the production serialization registry', () => {
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS) {
    const catalog = publicApiLayerById(id);
    manager.register(catalog || {
      id,
      name: id,
      icon: '·',
      source: 'test',
      updateInterval: 0,
      init() {},
      enable() {},
      disable() {},
      update() {},
      destroy() {},
      getStats() { return { count: 0, lastUpdate: null }; },
    });
  }
  assert.equal(manager.finalizeRegistrations(LAYER_STATE_REGISTRY), true);
});
