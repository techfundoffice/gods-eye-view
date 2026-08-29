// Space Missions must never depend on an app-defined Material cache entry.
// Losing such an entry during reload causes Material.fromType to throw from
// Scene.render, which stops the entire Cesium render loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'data', 'rocketLaunches.js'), 'utf8');

test('mission orbit rendering uses only Cesium built-in material types', () => {
  assert.doesNotMatch(source, /GevMissionOrbitTactical/);
  assert.match(source, /Cesium\.Material\.PolylineDashType/);
  assert.match(source, /new Cesium\.PolylineDashMaterialProperty/);
});

test('mission orbit rendering never mutates Cesium private material cache', () => {
  assert.doesNotMatch(source, /Material\._materialCache/);
});
