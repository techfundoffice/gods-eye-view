import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { CAMERA_PRESETS, flyToLosAngeles } from './camera.js';

test('default camera opens above Los Angeles in a photoreal regional view', () => {
  const calls = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  const viewer = {
    camera: {
      setView(options) { calls.push({ kind: 'set', options }); },
      flyTo(options) { calls.push({ kind: 'fly', options }); },
    },
  };

  try {
    flyToLosAngeles(viewer);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'set');
  assert.equal(calls[1].kind, 'fly');
  assert.ok(Cesium.Cartesian3.equalsEpsilon(
    calls[1].options.destination,
    CAMERA_PRESETS.losAngeles.destination,
    Cesium.Math.EPSILON12,
  ));
  assert.equal(calls[1].options.duration, 4.5);
  assert.equal(calls[1].options.orientation.pitch, Cesium.Math.toRadians(-50));
});