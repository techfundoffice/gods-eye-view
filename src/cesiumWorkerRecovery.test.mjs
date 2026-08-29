import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientCesiumWorkerImportError } from './cesiumWorkerRecovery.js';

test('recognizes a failed Cesium geometry worker module fetch', () => {
  assert.equal(isTransientCesiumWorkerImportError(new TypeError(
    'Failed to fetch dynamically imported module: https://preview.example/cesium/Workers/createEllipseGeometry.js',
  )), true);
});

test('accepts worker URLs with cache query parameters', () => {
  assert.equal(isTransientCesiumWorkerImportError(
    'Failed to fetch dynamically imported module: /cesium/Workers/createPolylineGeometry.js?v=123',
  ), true);
});

test('does not classify unrelated render or module errors as worker reconnects', () => {
  assert.equal(isTransientCesiumWorkerImportError(
    new Error("material with type 'BrokenMaterial' does not exist"),
  ), false);
  assert.equal(isTransientCesiumWorkerImportError(
    new Error('Failed to fetch dynamically imported module: /src/panel.js'),
  ), false);
});