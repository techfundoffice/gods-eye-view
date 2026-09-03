import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifyToolCapability,
  compareSkillToViewSafeCatalog,
  documentedViewSafeToolsFromSkill,
  HERMES_SKILL_VERSION,
  isViewSafeTool,
  validateViewSafeToolCall,
  viewSafeToolsFrom,
} from './hermesViewSafeCatalog.js';
import { PUBLIC_GEV_TOOL_NAMES } from './youtubePublicCommandPolicy.js';
import { adminMcpToolDefinitions } from './adminMcpServer.js';

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

test('the YouTube GEV skill documents every view-safe MCP tool and no extra GEV names', () => {
  const skillPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/gods-eye-view/SKILL.md');
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, new RegExp(`version:\\s*${HERMES_SKILL_VERSION}`));
  const live = viewSafeToolsFrom();
  assert.deepEqual(live.map((tool) => tool.name), PUBLIC_GEV_TOOL_NAMES);
  const compared = compareSkillToViewSafeCatalog(skill);
  assert.deepEqual(compared.missingFromSkill, [], compared.missingFromSkill.join(', '));
  assert.deepEqual(compared.extraInSkill, []);
  assert.equal(documentedViewSafeToolsFromSkill(skill).length, PUBLIC_GEV_TOOL_NAMES.length);
  const adminNames = adminMcpToolDefinitions()
    .map((tool) => tool.name)
    .filter((name) => classifyToolCapability(name) === 'admin');
  for (const name of adminNames) {
    assert.match(skill, new RegExp(`\`${name}\``));
    assert.equal(isViewSafeTool(name), false);
  }
  assert.match(skill, /Do not call `list_admin_plugins`/);
});
