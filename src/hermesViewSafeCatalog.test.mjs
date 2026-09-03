import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyToolCapability,
  isViewSafeTool,
  validateViewSafeToolCall,
  viewSafeToolsFrom,
} from './hermesViewSafeCatalog.js';

test('every shipped GEV function is view-safe and ADMIN tools are not', () => {
  const tools = viewSafeToolsFrom();
  assert.ok(tools.length >= 20);
  assert.equal(isViewSafeTool('fly_to_location'), true);
  assert.equal(isViewSafeTool('set_layer_visibility'), true);
  assert.equal(isViewSafeTool('get_current_view_state'), true);
  assert.equal(isViewSafeTool('list_admin_plugins'), false);
  assert.equal(classifyToolCapability('create_admin_plugin'), 'admin');
  assert.equal(classifyToolCapability('liveChatMessages.insert'), 'youtube-write');
  assert.equal(validateViewSafeToolCall('list_admin_plugins', {}).ok, false);
  assert.equal(validateViewSafeToolCall('fly_to_location', { query: 'Paris' }).ok, true);
});

test('unknown MCP names are rejected instead of guessed', () => {
  assert.equal(classifyToolCapability('rm_rf_workspace'), 'unknown');
  assert.equal(isViewSafeTool('rm_rf_workspace'), false);
});
