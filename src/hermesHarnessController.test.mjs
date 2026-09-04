import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHermesHarnessController, HERMES_HARNESS_ID, OPENROUTER_HARNESS_ID } from './hermesHarnessController.js';
import { createAdminMcpServer } from './adminMcpServer.js';

function mcpServer() {
  return createAdminMcpServer({
    builder: {
      list: () => [],
      start: () => ({}),
      get: () => null,
      send: () => null,
    },
  });
}

test('Hermes is the preferred default; failed preflight reports Hermes offline without impersonating it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-h-'));
  const controller = createHermesHarnessController({
    hermesCommand: '',
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(dir, 'missing-skill.md'),
    postChat: async () => ({ ok: false, payload: { error: 'nope' } }),
    openrouterInterpret: async () => ({ ok: true, kind: 'complete', text: 'fallback' }),
  });
  await controller.loadPreferred();
  const before = controller.status();
  assert.equal(before.preferred, HERMES_HARNESS_ID);
  const started = await controller.startHermes();
  assert.equal(started.ready, false);
  assert.equal(started.active, HERMES_HARNESS_ID);
  assert.match(started.fallbackReason, /skill missing|OpenRouter|catalog|Hermes/i);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8').catch(() => '{"preferred":"hermes"}'));
  assert.notEqual(saved.preferred, OPENROUTER_HARNESS_ID);
  await assert.rejects(() => controller.interpret({ comment: 'hi' }), /Hermes/i);
});

test('selecting OpenRouter is an explicit operator override that persists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-h-'));
  const controller = createHermesHarnessController({
    hermesCommand: '',
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(dir, 'missing-skill.md'),
    openrouterInterpret: async () => ({ ok: true, kind: 'complete', text: 'or' }),
  });
  const selected = await controller.select(OPENROUTER_HARNESS_ID);
  assert.equal(selected.preferred, OPENROUTER_HARNESS_ID);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.preferred, OPENROUTER_HARNESS_ID);
});

test('Hermes starts on Grok only through the real CLI path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-g-'));
  const calls = [];
  const fakeCli = path.join(dir, 'hermes');
  await fs.writeFile(fakeCli, '#!/bin/sh\n', { mode: 0o755 });
  const controller = createHermesHarnessController({
    hermesCommand: fakeCli,
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md'),
    openrouterInterpret: async () => ({ ok: true, kind: 'complete', text: 'should not run' }),
  });
  await controller.connectMcpServer(mcpServer());
  const started = await controller.startHermes();
  assert.equal(started.ready, true);
  assert.equal(started.model, 'x-ai/grok-4.6');
  assert.equal(started.provider, 'openrouter');
  assert.equal(started.modelVendor, 'x-ai');
  assert.equal(started.cli, true);
  assert.equal(started.bin, fakeCli);
  assert.equal(started.runtimeVersion, '0.21.0');
  assert.equal(calls.length, 0);
  controller.stopHermes();
});

test('MCP discovery uses the live server and excludes privileged and disabled tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-mcp-'));
  const controller = createHermesHarnessController({
    hermesCommand: '',
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md'),
    isFunctionEnabled: (name) => name !== 'fly_to_location',
  });
  const snapshot = await controller.connectMcpServer(mcpServer());
  assert.equal(snapshot.mcpConnected, true);
  assert.equal(snapshot.mcpServerName, 'gods-eye-view-admin');
  assert.ok(snapshot.mcpDiscoveredCount > snapshot.mcpExposedCount);
  assert.equal(snapshot.mcpExecutionTransport, 'youtube-public-coordinator');
});

test('malformed MCP discovery is explicit and prevents Hermes startup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-mcp-'));
  const controller = createHermesHarnessController({
    hermesCommand: '',
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md'),
  });
  const snapshot = await controller.connectMcpServer({ handle: async () => ({ jsonrpc: '2.0', result: {} }) });
  assert.equal(snapshot.mcpConnected, false);
  assert.match(snapshot.latestMcpError, /Malformed MCP initialize response/);
  const started = await controller.startHermes();
  assert.equal(started.ready, false);
  assert.match(started.lastError, /MCP discovery unavailable/);
});

test('an empty MCP catalog never falls back to built-in tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-mcp-empty-'));
  const controller = createHermesHarnessController({
    hermesCommand: '',
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md'),
  });
  let request = 0;
  const snapshot = await controller.connectMcpServer({
    handle: async () => (++request === 1
      ? {
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'empty', version: '1' },
        },
      }
      : { jsonrpc: '2.0', result: { tools: [] } }),
  });
  assert.equal(snapshot.mcpConnected, false);
  assert.equal(snapshot.mcpExposedCount, 0);
  assert.match(snapshot.latestMcpError, /empty catalog/);
});

test('MCP initialization preserves an explicit OpenRouter override', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-mcp-override-'));
  const settingsPath = path.join(dir, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ preferred: OPENROUTER_HARNESS_ID }));
  const controller = createHermesHarnessController({
    settingsPath,
    skillPath: path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md'),
  });
  const snapshot = await controller.initializeMcpServer(mcpServer());
  assert.equal(snapshot.preferred, OPENROUTER_HARNESS_ID);
  assert.equal(snapshot.active, OPENROUTER_HARNESS_ID);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.mcpConnected, true);
});

test('selecting OpenRouter stops a running Hermes bridge', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-mcp-stop-'));
  const fakeCli = path.join(dir, 'hermes');
  await fs.writeFile(fakeCli, '#!/bin/sh\n', { mode: 0o755 });
  const controller = createHermesHarnessController({
    hermesCommand: fakeCli,
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md'),
  });
  await controller.connectMcpServer(mcpServer());
  assert.equal((await controller.startHermes()).running, true);
  const selected = await controller.select(OPENROUTER_HARNESS_ID);
  assert.equal(selected.active, OPENROUTER_HARNESS_ID);
  assert.equal(selected.running, false);
  assert.equal(selected.ready, false);
});

test('an OpenRouter selection made during MCP discovery wins the startup race', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-mcp-race-'));
  const fakeCli = path.join(dir, 'hermes');
  await fs.writeFile(fakeCli, '#!/bin/sh\n', { mode: 0o755 });
  let releaseTools;
  const toolsReady = new Promise((resolve) => { releaseTools = resolve; });
  let listStarted;
  const listing = new Promise((resolve) => { listStarted = resolve; });
  const real = mcpServer();
  const delayed = {
    handle: async (message) => {
      if (message.method === 'tools/list') {
        listStarted();
        await toolsReady;
      }
      return real.handle(message);
    },
  };
  const controller = createHermesHarnessController({
    hermesCommand: fakeCli,
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md'),
  });
  const initializing = controller.initializeMcpServer(delayed);
  await listing;
  await controller.select(OPENROUTER_HARNESS_ID);
  releaseTools();
  const snapshot = await initializing;
  assert.equal(snapshot.preferred, OPENROUTER_HARNESS_ID);
  assert.equal(snapshot.active, OPENROUTER_HARNESS_ID);
  assert.equal(snapshot.running, false);
});
