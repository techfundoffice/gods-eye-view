import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Cesium from 'cesium';
import {
  DEFAULT_LINE_WIDTH,
  colorMaterial,
  normalizeLineWidth,
  toCesiumColor,
} from './cesiumMaterials.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('colorMaterial builds the explicit property type Cesium requires', () => {
  const material = colorMaterial('#2fe0ff');
  assert.ok(material instanceof Cesium.ColorMaterialProperty);
  // A Property is passed straight through by createPropertyDescriptor, so the
  // "Unable to infer material type" branch is never reached.
  assert.equal(typeof material.getValue, 'function');
});

test('an entity accepts the built material without inferring a type', () => {
  // The real assertion: Cesium's own PolylineGraphics setter must accept it.
  const graphics = new Cesium.PolylineGraphics({
    positions: [Cesium.Cartesian3.ZERO, new Cesium.Cartesian3(1, 0, 0)],
    width: normalizeLineWidth(2.5),
    material: colorMaterial('#ff9900', 0.9),
    depthFailMaterial: colorMaterial('#ff9900', 0.45),
  });
  assert.ok(graphics.material instanceof Cesium.ColorMaterialProperty);
  assert.ok(graphics.depthFailMaterial instanceof Cesium.ColorMaterialProperty);
  assert.equal(graphics.width.getValue(Cesium.JulianDate.now()), 2.5);
});

test('the applied alpha is preserved exactly', () => {
  const material = colorMaterial(Cesium.Color.RED, 0.45);
  const value = material.color.getValue(Cesium.JulianDate.now());
  assert.equal(value.alpha, 0.45);
  assert.equal(value.red, 1);
});

test('an alpha outside [0,1] is clamped rather than producing a broken colour', () => {
  const now = Cesium.JulianDate.now();
  assert.equal(colorMaterial(Cesium.Color.RED, 5).color.getValue(now).alpha, 1);
  assert.equal(colorMaterial(Cesium.Color.RED, -2).color.getValue(now).alpha, 0);
});

test('an omitted alpha leaves the source colour untouched', () => {
  const source = Cesium.Color.fromCssColorString('#2fe0ff').withAlpha(0.24);
  const value = colorMaterial(source).color.getValue(Cesium.JulianDate.now());
  assert.equal(value.alpha, 0.24);
});

test('an unparseable colour degrades to a visible fallback instead of throwing', () => {
  // Cesium.Color.fromCssColorString returns undefined (not a throw) for junk,
  // and `material: undefined` is exactly what used to reach the entity.
  assert.equal(Cesium.Color.fromCssColorString('totally-not-a-color'), undefined);
  for (const bad of ['totally-not-a-color', '', null, undefined, 42, {}]) {
    const material = colorMaterial(bad, 0.8);
    assert.ok(material instanceof Cesium.ColorMaterialProperty, `failed for ${String(bad)}`);
    const value = material.color.getValue(Cesium.JulianDate.now());
    assert.equal(value.alpha, 0.8);
    assert.equal(value.red, 1);
  }
});

test('toCesiumColor passes through a real colour by identity', () => {
  const source = Cesium.Color.CYAN;
  assert.equal(toCesiumColor(source), source);
});

test('valid widths are returned unchanged so appearance never shifts', () => {
  // Every width this app actually draws.
  for (const width of [1, 1.2, 1.5, 2, 2.4, 2.5, 3, 6, 9, 16]) {
    assert.equal(normalizeLineWidth(width), width);
  }
});

test('zero, negative and non-finite widths fall back instead of reaching the GPU', () => {
  for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, 'wide']) {
    assert.equal(normalizeLineWidth(width), DEFAULT_LINE_WIDTH, `failed for ${String(width)}`);
  }
  assert.equal(normalizeLineWidth(0, 2.5), 2.5, 'a caller-supplied fallback is honoured');
  assert.equal(normalizeLineWidth(Number.NaN, Number.NaN), DEFAULT_LINE_WIDTH);
});

test('runaway widths are clamped to a renderable ceiling', () => {
  assert.equal(normalizeLineWidth(1e9), 64);
  assert.equal(normalizeLineWidth(0.25), DEFAULT_LINE_WIDTH);
});

test('entity polyline and polygon materials are built explicitly across the app', () => {
  // Guards the regression directly: a bare Color reaching an entity `material`
  // slot re-enables Cesium's type inference, which is what threw.
  const files = [
    'src/data/trailRenderer.js',
    'src/data/flights.js',
    'src/data/militaryFlights.js',
    'src/data/cctv.js',
    'src/data/cctvGizmo.js',
    'src/data/militaryInstallations.js',
    'src/data/rocketLaunches.js',
  ];
  // The regression shape: a COLOUR expression in a material slot. A
  // Property-valued identifier (cctv's planeMaterial) is already correct and
  // must not be flagged.
  const bareColor = /^[^\n]*(?:depthFail)?[mM]aterial:\s*(?!colorMaterial\()(?:Cesium\.Color\b|[A-Za-z_$][\w$.]*\.withAlpha\(|[A-Z][A-Z0-9_]*_COLOR\b)[^\n]*$/gm;
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const offenders = source.match(bareColor) || [];
    assert.deepEqual(
      offenders,
      [],
      `${file} assigns a bare colour to a material slot: ${offenders.join(' | ')}`,
    );
  }
});
