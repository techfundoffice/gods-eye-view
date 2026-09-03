import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultGevFunctionToggles,
  normalizeGevFunctionToggles,
  setGevFunctionToggles,
  setGevFunctionEnabled,
  isGevFunctionEnabled,
} from './gevFunctionToggles.js';

test('every GEV function is on until an admin turns one off', () => {
  const all = defaultGevFunctionToggles();
  assert.equal(all.fly_to_location, true);
  assert.equal(all.set_layer_visibility, true);
  assert.equal(all.control_cockpit, true);
  setGevFunctionToggles({ fly_to_location: false, mystery: false });
  assert.equal(isGevFunctionEnabled('fly_to_location'), false);
  assert.equal(isGevFunctionEnabled('set_visual_style'), true);
  assert.equal(normalizeGevFunctionToggles({ mystery: false }).mystery, undefined);
  const saved = setGevFunctionEnabled('set_layer_visibility', false);
  assert.equal(saved.ok, true);
  assert.equal(isGevFunctionEnabled('set_layer_visibility'), false);
  setGevFunctionToggles(null);
});
