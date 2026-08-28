import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WEBGL_COMPATIBILITY_REASONS,
  isWebGLInitializationError,
  probeWebGLCapability,
  showWebGLCompatibilityState,
} from './webglCapability.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function context({ units = 8, loseContext = () => {} } = {}) {
  return {
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660,
    getParameter(parameter) {
      assert.equal(parameter, 35660);
      return units;
    },
    getExtension(name) {
      assert.equal(name, 'WEBGL_lose_context');
      return { loseContext };
    },
  };
}

test('a usable WebGL context with vertex texture fetch support is accepted', () => {
  let released = 0;
  const gl = context({ units: 16, loseContext: () => { released += 1; } });
  const requested = [];
  const result = probeWebGLCapability({
    createCanvas: () => ({
      getContext(name) {
        requested.push(name);
        return name === 'webgl2' ? gl : null;
      },
    }),
  });

  assert.deepEqual(result, {
    supported: true,
    reason: null,
    contextType: 'webgl2',
    maxVertexTextureImageUnits: 16,
  });
  assert.deepEqual(requested, ['webgl2']);
  assert.equal(released, 1);
});

test('missing WebGL reports an unavailable compatibility result', () => {
  const result = probeWebGLCapability({
    createCanvas: () => ({ getContext: () => null }),
  });
  assert.deepEqual(result, {
    supported: false,
    reason: WEBGL_COMPATIBILITY_REASONS.unavailable,
    contextType: null,
    maxVertexTextureImageUnits: 0,
  });
});

test('zero vertex texture units fail before Cesium primitives can render', () => {
  const gl = context({ units: 0 });
  const result = probeWebGLCapability({
    createCanvas: () => ({
      getContext: (name) => name === 'webgl2' ? gl : null,
    }),
  });
  assert.deepEqual(result, {
    supported: false,
    reason: WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
    contextType: 'webgl2',
    maxVertexTextureImageUnits: 0,
  });
});

test('probe errors fail closed instead of escaping startup', () => {
  assert.equal(
    probeWebGLCapability({ createCanvas: () => { throw new Error('blocked'); } }).supported,
    false,
  );
  assert.equal(
    probeWebGLCapability({
      createCanvas: () => ({ getContext: () => { throw new Error('blocked'); } }),
    }).supported,
    false,
  );
});

test('Cesium WebGL startup failures are distinguished from unrelated errors', () => {
  assert.equal(isWebGLInitializationError(new Error('WebGL initialization failed.')), true);
  assert.equal(isWebGLInitializationError('Error constructing CesiumWidget'), true);
  assert.equal(isWebGLInitializationError(new Error('Vertex texture fetch support is required')), true);
  assert.equal(isWebGLInitializationError(new Error('GOOGLE_MAPS_API_KEY not found')), false);
});

test('compatibility presentation is accessible and reveals the guidance', () => {
  const classes = new Set(['hidden']);
  const attributes = new Map();
  const details = { hidden: true };
  const loadingScreen = {
    classList: {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
    },
    setAttribute: (name, value) => attributes.set(name, value),
    querySelector: (selector) => selector === '.webgl-compatibility' ? details : null,
  };
  const loaderAttributes = new Map();
  const loaderStatus = {
    textContent: '',
    setAttribute: (name, value) => loaderAttributes.set(name, value),
  };

  assert.equal(showWebGLCompatibilityState({
    loadingScreen,
    loaderStatus,
    reason: WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
  }), true);
  assert.equal(classes.has('hidden'), false);
  assert.equal(classes.has('compatibility-error'), true);
  assert.equal(attributes.get('aria-labelledby'), 'webgl-compatibility-title');
  assert.equal(loaderAttributes.get('role'), 'alert');
  assert.equal(loaderAttributes.get('aria-live'), 'assertive');
  assert.match(loaderStatus.textContent, /GPU features/);
  assert.equal(details.hidden, false);
});

test('the capability gate runs before Cesium viewer construction', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const probeIndex = main.indexOf('probeWebGLCapability()');
  const viewerIndex = main.indexOf("new Cesium.Viewer('cesiumContainer'");
  assert.ok(probeIndex >= 0, 'main startup must run the WebGL capability probe');
  assert.ok(viewerIndex > probeIndex, 'the capability probe must precede Cesium viewer construction');
  assert.match(
    main.slice(probeIndex, viewerIndex),
    /if \(!webglCapability\.supported\)[\s\S]*?showWebGLCompatibilityState[\s\S]*?return;/,
  );
});