import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTrail } from './trailRenderer.js';

test('trail visibility can change without discarding its accumulated geometry', () => {
  const added = [];
  const removed = [];
  const viewer = {
    isDestroyed: () => false,
    entities: {
      add(definition) {
        added.push(definition);
        return definition;
      },
      remove(entity) {
        removed.push(entity);
      },
    },
  };
  const trail = createTrail(viewer, { color: '#ffffff' });
  const positions = [
    new Cesium.Cartesian3(1, 2, 3),
    new Cesium.Cartesian3(4, 5, 6),
  ];

  trail.setVisible(false);
  trail.setPositions(positions);
  assert.equal(added.length, 1);
  assert.equal(added[0].show, false);
  assert.deepEqual(added[0].polyline.positions.getValue(), positions);

  trail.setVisible(true);
  assert.equal(added[0].show, true);
  assert.deepEqual(added[0].polyline.positions.getValue(), positions);

  trail.destroy();
  assert.deepEqual(removed, [added[0]]);
});

test('the trail is built with explicit material properties and a valid width', () => {
  const added = [];
  const viewer = {
    isDestroyed: () => false,
    entities: { add: (d) => (added.push(d), d), remove: () => {} },
  };
  const trail = createTrail(viewer, { color: '#2fe0ff', width: 2.5 });
  trail.setPositions([new Cesium.Cartesian3(1, 2, 3), new Cesium.Cartesian3(4, 5, 6)]);

  const { polyline } = added[0];
  // A bare Color here re-enables Cesium's material-type inference, which is
  // what threw "Unable to infer material type" out of the poll callback.
  assert.ok(polyline.material instanceof Cesium.ColorMaterialProperty);
  assert.ok(polyline.depthFailMaterial instanceof Cesium.ColorMaterialProperty);
  assert.equal(polyline.width, 2.5);

  const now = Cesium.JulianDate.now();
  const visible = polyline.material.color.getValue(now);
  const occluded = polyline.depthFailMaterial.color.getValue(now);
  // Appearance is unchanged: the locked alphas from round 6 still apply.
  assert.equal(visible.alpha, 0.85);
  assert.equal(occluded.alpha, 0.4);
  assert.equal(visible.blue, 1);
});

test('an unusable width or colour degrades instead of reaching the GPU', () => {
  const added = [];
  const viewer = {
    isDestroyed: () => false,
    entities: { add: (d) => (added.push(d), d), remove: () => {} },
  };
  // A computed width that has gone NaN, and a hue string Cesium cannot parse.
  const trail = createTrail(viewer, { color: 'not-a-color', width: Number.NaN });
  trail.setPositions([new Cesium.Cartesian3(1, 2, 3), new Cesium.Cartesian3(4, 5, 6)]);

  const { polyline } = added[0];
  assert.equal(polyline.width, 2.5, 'falls back to the documented default width');
  assert.ok(polyline.material instanceof Cesium.ColorMaterialProperty);
  assert.equal(polyline.material.color.getValue(Cesium.JulianDate.now()).alpha, 0.85);
});

test('a zero width is lifted to a renderable minimum', () => {
  const added = [];
  const viewer = {
    isDestroyed: () => false,
    entities: { add: (d) => (added.push(d), d), remove: () => {} },
  };
  createTrail(viewer, { color: '#ffffff', width: 0 })
    .setPositions([new Cesium.Cartesian3(1, 2, 3), new Cesium.Cartesian3(4, 5, 6)]);
  assert.equal(added[0].polyline.width, 2.5);
});
