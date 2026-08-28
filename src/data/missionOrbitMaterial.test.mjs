// GEV-01: enabling Space Missions halted Cesium's render loop.
//
// The orbit polylines use a custom material type, 'GevMissionOrbitTactical'.
// It was registered lazily, from two call sites, behind a module-level
// `_registered` flag. Any path that produced an orbit polyline without passing
// through one of those call sites left an entity referencing a type Cesium had
// never heard of. Cesium's `MaterialProperty.getValue` then called
// `Material.fromType` on it and threw from inside `Scene.render`:
//
//   DeveloperError: material with type 'GevMissionOrbitTactical' does not exist.
//     at Material.fromType
//     at MaterialProperty.getValue
//     at StaticGeometryPerMaterialBatch.update
//     at PolylineVisualizer.update
//
// A render-loop throw is not survivable by the layer that caused it: Cesium
// stops rendering the WHOLE scene, and because the layer's ON state is
// persisted the next page load re-enabled it and crashed again. A first-time
// visitor who picked "Space Missions" on the welcome screen bricked the app
// for themselves across reloads.
//
// Registration now happens at module load through Cesium's own
// `Material._materialCache.addMaterial` — a pure cache write, no GL or DOM —
// so these assertions hold in plain Node, with no viewer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Cesium from 'cesium';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATERIAL_TYPE = 'GevMissionOrbitTactical';

// The cache is global to the Cesium module, so capture the pre-import state
// before anything in this file pulls the layer in.
const registeredBeforeImport = !!Cesium.Material._materialCache.getMaterial(MATERIAL_TYPE);
const rocketLaunches = await import('./rocketLaunches.js');

test('importing the layer registers its material type', () => {
  assert.equal(registeredBeforeImport, false, 'the type must not pre-exist in Cesium');
  assert.ok(
    Cesium.Material._materialCache.getMaterial(MATERIAL_TYPE),
    'the orbit material must be registered at module load, before any polyline can reference it',
  );
});

test('the registered entry has the shape Material.fromType consumes', () => {
  // Cesium clones `cachedMaterial.fabric` and reads `cachedMaterial.translucent`.
  // Registering a bare Material instance instead of a {fabric, translucent}
  // template is what the built-ins never do, and it would not survive fromType.
  const entry = Cesium.Material._materialCache.getMaterial(MATERIAL_TYPE);
  assert.equal(typeof entry, 'object');
  assert.equal(entry.fabric?.type, MATERIAL_TYPE);
  assert.equal(typeof entry.fabric?.source, 'string');
  assert.ok(entry.fabric.source.includes('czm_getMaterial'), 'the fabric must carry its shader');
  assert.deepEqual(Object.keys(entry.fabric.uniforms ?? {}).sort(), ['color', 'dashCount', 'groupCount']);
  // The dash mask writes alpha 0 between marks; opaque would render black gaps.
  assert.equal(entry.translucent, true);
});

test('the layer module exposes the default export the manager registers', () => {
  assert.ok(rocketLaunches.default, 'the layer module must still export its layer');
  assert.equal(rocketLaunches.default.id, 'rocket-launches');
});

test('registration is idempotent and survives a repeat import', async () => {
  const first = Cesium.Material._materialCache.getMaterial(MATERIAL_TYPE);
  await import('./rocketLaunches.js');
  assert.equal(
    Cesium.Material._materialCache.getMaterial(MATERIAL_TYPE),
    first,
    're-registering must not replace a live cache entry',
  );
});

test('the material type is never referenced without a guarded registration', () => {
  // Every literal use of the type name must sit next to the registration
  // helper. The regression was a bare literal in getType() with the only
  // registration behind a flag that a second code path had already set.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'data', 'rocketLaunches.js'), 'utf8');
  // Strip comments: the prose that documents this bug quotes the type name.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bareLiterals = code.match(/'GevMissionOrbitTactical'/g) ?? [];
  assert.equal(
    bareLiterals.length,
    1,
    'the type name should live in one constant, not be repeated as string literals',
  );
  assert.match(
    source,
    /const MISSION_ORBIT_MATERIAL_TYPE = 'GevMissionOrbitTactical';/,
    'the type must be a named constant',
  );
  // Registration runs at module scope, not only from inside a call site.
  assert.match(
    source,
    /^ensureMissionOrbitPatternRegistered\(\);$/m,
    'the material must be registered at module load',
  );
  // getType() is called by Cesium immediately before Material.fromType(type).
  assert.match(
    source,
    /getType = function getType\(\) \{[\s\S]{0,400}?ensureMissionOrbitPatternRegistered\(\);[\s\S]{0,200}?return MISSION_ORBIT_MATERIAL_TYPE;/,
    'getType must re-assert registration at the moment Cesium resolves the type',
  );
});

test('registration uses the cache API rather than the new-Material side effect', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'data', 'rocketLaunches.js'), 'utf8');
  assert.match(
    source,
    /Cesium\.Material\._materialCache\.addMaterial\(\s*MISSION_ORBIT_MATERIAL_TYPE/,
    'registration must be a pure cache write so it can run before any viewer exists',
  );
});
