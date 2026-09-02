import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GEV_API_PREFIX,
  gevApiDocumentation,
  gevFunctionPath,
  gevMcpToolDefinitions,
  gevOpenRouterTools,
  listGevFunctions,
} from './gevApi.js';
import { PUBLIC_GEV_TOOL_NAMES } from './youtubePublicCommandPolicy.js';

test('every GEV function has a REST path and MCP/OpenRouter descriptor', () => {
  const functions = listGevFunctions();
  assert.equal(functions.length, PUBLIC_GEV_TOOL_NAMES.length);
  assert.ok(functions.some((fn) => fn.name === 'fly_to_location'));
  assert.ok(functions.some((fn) => fn.name === 'zoom_to_globe'));
  assert.ok(functions.some((fn) => fn.name === 'get_current_view_state'));
  for (const fn of functions) {
    assert.equal(fn.method, 'POST');
    assert.equal(fn.path, gevFunctionPath(fn.name));
    assert.match(fn.path, new RegExp(`^${GEV_API_PREFIX}/`));
    assert.equal(fn.parameters.type, 'object');
  }
  const mcp = gevMcpToolDefinitions();
  assert.deepEqual(mcp.map((tool) => tool.name), functions.map((fn) => fn.name));
  const openrouter = gevOpenRouterTools();
  assert.equal(openrouter.length, functions.length);
  assert.equal(openrouter[0].type, 'function');
  assert.equal(openrouter[0].function.name, functions[0].name);
});

test('ADMIN documentation lists auth, MCP setup, and curl', () => {
  const docs = gevApiDocumentation({ origin: 'https://example.test' });
  assert.equal(docs.prefix, GEV_API_PREFIX);
  assert.match(docs.auth, /API key/);
  assert.match(docs.mcp.url, /\/api\/admin\/mcp$/);
  assert.ok(docs.mcp.tools.includes('fly_to_location'));
  assert.match(docs.curl, /Authorization: Bearer/);
  assert.match(docs.curl, /\/api\/gev\/fly_to_location/);
  assert.ok(docs.functions.length >= 20);
});

test('documentation includes MCP client config and OpenRouter hook', () => {
  const docs = gevApiDocumentation({ origin: 'https://example.test' });
  assert.equal(docs.openrouter.tools, docs.functions.length);
  assert.match(docs.openrouter.youtubeChat, /YouTube/);
  assert.equal(docs.mcp.config.mcpServers['gods-eye-view'].url, 'https://example.test/api/admin/mcp');
  assert.match(docs.mcp.config.mcpServers['gods-eye-view'].headers.Authorization, /Bearer/);
  const fly = docs.functions.find((fn) => fn.name === 'fly_to_location');
  assert.match(fly.description, /globe camera/i);
});
