import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MapStackController } from './mapStackController.js';
import {
  GOOGLE_EARTH_STACK_ID,
  GOOGLE_EARTH_STATUS,
  enableGoogleEarth,
  getGoogleEarthStatus,
  googleEarthUnavailableReason,
  hasUsableGoogleMapsKey,
  isGoogleEarthDisplaying,
  readGoogleEarthRuntime,
} from './googleEarth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a placeholder or blank Google Maps key is not usable', () => {
  assert.equal(hasUsableGoogleMapsKey(''), false);
  assert.equal(hasUsableGoogleMapsKey('   '), false);
  assert.equal(hasUsableGoogleMapsKey(undefined), false);
  assert.equal(hasUsableGoogleMapsKey('your_google_maps_api_key_here'), false);
  assert.equal(hasUsableGoogleMapsKey('AIzaSy-test-key'), true);
});

test('missing key reports KEY REQUIRED and never DISPLAYING', () => {
  const status = getGoogleEarthStatus({ googleApiKey: '', tileset: null, activeStackId: 'osm' });
  assert.equal(status.state, GOOGLE_EARTH_STATUS.KEY_REQUIRED);
  assert.equal(status.label, 'KEY REQUIRED');
  assert.equal(status.displaying, false);
  assert.equal(status.available, false);
  assert.equal(status.keyPresent, false);
  assert.equal(status.tilesetLoaded, false);
  assert.match(status.detail, /GOOGLE_MAPS_API_KEY/);
  assert.equal(
    googleEarthUnavailableReason({ keyPresent: false }),
    'KEY REQUIRED · GOOGLE_MAPS_API_KEY',
  );
});

test('a keyed failed tileset reports LOAD FAILED, not DISPLAYING', () => {
  const status = getGoogleEarthStatus({
    googleApiKey: 'AIzaSy-test-key',
    tileset: null,
    activeStackId: 'osm',
    loadError: 'Request failed with status 403',
  });
  assert.equal(status.state, GOOGLE_EARTH_STATUS.LOAD_FAILED);
  assert.equal(status.displaying, false);
  assert.equal(status.available, false);
  assert.equal(status.keyPresent, true);
  assert.match(status.detail, /403/);
  assert.equal(isGoogleEarthDisplaying({ tileset: null, activeStackId: 'photoreal' }), false);
});

test('a destroyed tileset is not a live Google Earth globe', () => {
  const status = getGoogleEarthStatus({
    googleApiKey: 'AIzaSy-test-key',
    tileset: { show: true, isDestroyed: () => true },
    activeStackId: 'photoreal',
    globeShown: false,
  });
  assert.equal(status.state, GOOGLE_EARTH_STATUS.LOAD_FAILED);
  assert.equal(status.displaying, false);
});

test('photoreal + live tileset + hidden ellipsoid is DISPLAYING', () => {
  const tileset = { show: true, isDestroyed: () => false };
  const status = getGoogleEarthStatus({
    googleApiKey: 'AIzaSy-test-key',
    tileset,
    activeStackId: 'photoreal',
    globeShown: false,
  });
  assert.equal(status.state, GOOGLE_EARTH_STATUS.DISPLAYING);
  assert.equal(status.displaying, true);
  assert.equal(status.available, true);
  assert.equal(status.tilesetLoaded, true);
  assert.equal(status.activeStack, 'photoreal');
});

test('a loaded tileset on OSM is AVAILABLE, not DISPLAYING', () => {
  const status = getGoogleEarthStatus({
    googleApiKey: 'AIzaSy-test-key',
    tileset: { show: false, isDestroyed: () => false },
    activeStackId: 'osm',
    globeShown: true,
  });
  assert.equal(status.state, GOOGLE_EARTH_STATUS.AVAILABLE);
  assert.equal(status.displaying, false);
  assert.equal(status.available, true);
});

test('enableGoogleEarth refuses missing and failed tilesets without claiming display', async () => {
  const missing = await enableGoogleEarth({
    googleApiKey: '',
    tileset: null,
    mapStackController: { setStack: async () => ({ activeId: 'photoreal' }) },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.displaying, false);
  assert.equal(missing.status.state, GOOGLE_EARTH_STATUS.KEY_REQUIRED);

  const failed = await enableGoogleEarth({
    googleApiKey: 'AIzaSy-test-key',
    tileset: null,
    loadError: 'root.json 401',
    mapStackController: { setStack: async () => ({ activeId: 'photoreal' }) },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.displaying, false);
  assert.equal(failed.status.state, GOOGLE_EARTH_STATUS.LOAD_FAILED);
});

test('enableGoogleEarth drives the shipped map stack onto photoreal when a tileset exists', async () => {
  const viewer = {
    scene: { globe: { show: true }, requestRender() {} },
    imageryLayers: { add() {}, remove() {} },
  };
  const tileset = { show: false, isDestroyed: () => false };
  const controller = new MapStackController(viewer, {
    googleTileset: tileset,
    cesiumToken: '',
    initialStack: 'osm',
  });
  assert.equal(controller.getActiveId(), 'osm');

  const result = await enableGoogleEarth({
    googleApiKey: 'AIzaSy-test-key',
    tileset,
    mapStackController: controller,
    viewer,
  });

  assert.equal(result.ok, true);
  assert.equal(result.displaying, true);
  assert.equal(result.activeStack, GOOGLE_EARTH_STACK_ID);
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(tileset.show, true);
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(result.status.state, GOOGLE_EARTH_STATUS.DISPLAYING);
});

test('readGoogleEarthRuntime reads the live gev object, not a copy of status', () => {
  const tileset = { show: true };
  const source = {
    __GOOGLE_MAPS_API_KEY__: 'AIzaSy-from-window',
    __godsEyeView: {
      tileset,
      googleApiKey: 'AIzaSy-from-gev',
      googleEarthLoadError: null,
      mapStackController: { getActiveId: () => 'photoreal' },
      viewer: { scene: { globe: { show: false } } },
    },
  };
  const runtime = readGoogleEarthRuntime(source);
  assert.equal(runtime.googleApiKey, 'AIzaSy-from-gev');
  assert.equal(runtime.tileset, tileset);
  assert.equal(runtime.activeStackId, 'photoreal');
  assert.equal(runtime.globeShown, false);
});

test('startup no longer aborts the globe when the Map Tiles key is missing', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(
    main,
    /throw new Error\('GOOGLE_MAPS_API_KEY not found/,
    'a missing Google key must continue as KEY REQUIRED, not a hard init throw',
  );
  assert.match(main, /hasUsableGoogleMapsKey\(googleApiKey\)/);
  assert.match(main, /createGooglePhotorealistic3DTileset/);
  assert.match(main, /googleEarthLoadError/);
  assert.match(main, /photorealUnavailableReason/);
});
