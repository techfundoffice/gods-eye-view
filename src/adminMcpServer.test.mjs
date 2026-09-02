import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JSON_RPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  adminMcpToolDefinitions,
  createAdminMcpServer,
  jsonRpcError,
  jsonRpcResult,
  toolContent,
} from './adminMcpServer.js';

/** Minimal plugin-builder stand-in recording what the MCP tools asked for. */
function stubBuilder(overrides = {}) {
  const calls = [];
  return {
    calls,
    list() {
      calls.push(['list']);
      return [{ id: 'job-1', name: 'Fleet Watchlist', status: 'ready' }];
    },
    start(input) {
      calls.push(['start', input]);
      return { id: 'job-2', name: input.name, status: 'running', transcript: [] };
    },
    get(id) {
      calls.push(['get', id]);
      return id === 'job-1' ? { id, name: 'Fleet Watchlist', status: 'ready', transcript: [] } : null;
    },
    send(id, message) {
      calls.push(['send', id, message]);
      return id === 'job-1' ? { id, status: 'running', transcript: [{ role: 'admin', text: message }] } : null;
    },
    ...overrides,
  };
}

/** Parse the single text block an MCP tool result carries. */
function toolPayload(result) {
  return JSON.parse(result.content[0].text);
}

test('the server requires a builder', () => {
  assert.throws(() => createAdminMcpServer({}), /requires a plugin builder/);
});

test('initialize advertises the protocol version, tools, and server identity', async () => {
  const server = createAdminMcpServer({ builder: stubBuilder(), version: '9.9.9' });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(response.result.serverInfo, { name: MCP_SERVER_NAME, version: '9.9.9' });
  assert.ok(response.result.capabilities.tools);
});

test('tools/list returns every declared tool with a schema', async () => {
  const server = createAdminMcpServer({ builder: stubBuilder() });
  const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = response.result.tools.map((tool) => tool.name);
  for (const required of [
    'create_admin_plugin',
    'get_admin_plugin',
    'list_admin_plugins',
    'send_admin_plugin_message',
    'fly_to_location',
    'zoom_to_globe',
    'get_current_view_state',
  ]) {
    assert.ok(names.includes(required), required);
  }
  for (const tool of adminMcpToolDefinitions()) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} declares an object schema`);
    assert.ok(tool.description.length > 10, `${tool.name} is described`);
  }
});

test('notifications get no response body', async () => {
  const server = createAdminMcpServer({ builder: stubBuilder() });
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'ping' }), null);
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 5, method: 'ping' })).result, {});
});

test('a malformed envelope is an invalid-request error', async () => {
  const server = createAdminMcpServer({ builder: stubBuilder() });
  assert.equal((await server.handle(null)).error.code, JSON_RPC_ERRORS.invalidRequest);
  assert.equal((await server.handle({ id: 1, method: 'ping' })).error.code, JSON_RPC_ERRORS.invalidRequest);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 1 })).error.code, JSON_RPC_ERRORS.invalidRequest);
});

test('an unknown method with an id is a method-not-found error', async () => {
  const server = createAdminMcpServer({ builder: stubBuilder() });
  const response = await server.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(response.error.code, JSON_RPC_ERRORS.methodNotFound);
  assert.match(response.error.message, /resources\/list/);
  // An unknown notification is still silent.
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'resources/list' }), null);
});

test('list_admin_plugins returns the builder list', async () => {
  const builder = stubBuilder();
  const server = createAdminMcpServer({ builder });
  const response = await server.handle({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_admin_plugins' },
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(toolPayload(response.result).plugins[0].name, 'Fleet Watchlist');
  assert.deepEqual(builder.calls, [['list']]);
});

test('create_admin_plugin forwards the name and instructions', async () => {
  const builder = stubBuilder();
  const server = createAdminMcpServer({ builder });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'create_admin_plugin', arguments: { name: 'Watchlist', instructions: 'Track vessels' } },
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(builder.calls[0], ['start', { name: 'Watchlist', instructions: 'Track vessels' }]);
});

test('create_admin_plugin refuses an empty name without touching the builder', async () => {
  const builder = stubBuilder();
  const server = createAdminMcpServer({ builder });
  const response = await server.handle({
    jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_admin_plugin', arguments: { name: '  ' } },
  });
  assert.equal(response.result.isError, true);
  assert.deepEqual(builder.calls, []);
});

test('a rejected plugin name comes back as a tool error, not a transport error', async () => {
  const builder = stubBuilder({
    start() { throw new TypeError('Plugin name must contain letters or numbers'); },
  });
  const server = createAdminMcpServer({ builder });
  const response = await server.handle({
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_admin_plugin', arguments: { name: '***' } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /letters or numbers/);
  assert.equal(response.error, undefined);
});

test('get and send report a missing build as a tool error', async () => {
  const server = createAdminMcpServer({ builder: stubBuilder() });
  const missing = await server.handle({
    jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_admin_plugin', arguments: { jobId: 'nope' } },
  });
  assert.equal(missing.result.isError, true);

  const found = await server.handle({
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_admin_plugin', arguments: { jobId: 'job-1' } },
  });
  assert.equal(found.result.isError, false);
  assert.equal(toolPayload(found.result).id, 'job-1');

  const sent = await server.handle({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'send_admin_plugin_message', arguments: { jobId: 'job-1', message: 'add export' } },
  });
  assert.equal(sent.result.isError, false);
  assert.equal(toolPayload(sent.result).transcript[0].text, 'add export');
});

test('an unknown tool name is an invalid-params error', async () => {
  const server = createAdminMcpServer({ builder: stubBuilder() });
  const response = await server.handle({
    jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'rm_rf' },
  });
  assert.equal(response.error.code, JSON_RPC_ERRORS.invalidParams);
});

test('a thrown tool becomes an internal error rather than an unhandled rejection', async () => {
  const builder = stubBuilder({ list() { throw new Error('registry offline'); } });
  const server = createAdminMcpServer({ builder });
  const response = await server.handle({
    jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'list_admin_plugins' },
  });
  assert.equal(response.error.code, JSON_RPC_ERRORS.internal);
  assert.match(response.error.message, /registry offline/);
});

test('envelope helpers produce well-formed JSON-RPC', () => {
  assert.deepEqual(jsonRpcResult(1, { ok: true }), { jsonrpc: '2.0', id: 1, result: { ok: true } });
  assert.deepEqual(jsonRpcError(undefined, -1, 'bad'), { jsonrpc: '2.0', id: null, error: { code: -1, message: 'bad' } });
  assert.deepEqual(toolContent('plain'), { content: [{ type: 'text', text: 'plain' }], isError: false });
  assert.equal(JSON.parse(toolContent({ a: 1 }).content[0].text).a, 1);
});
