import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHermesHarnessController, HERMES_HARNESS_ID, OPENROUTER_HARNESS_ID } from './hermesHarnessController.js';

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
    openrouterInterpret: async (...args) => { calls.push(args); return { ok: true, kind: 'complete', text: 'fallback' }; },
    openrouterInterpret: async () => ({ ok: true, kind: 'complete', text: 'should not run' }),
  });
  const started = await controller.startHermes();
  assert.equal(started.ready, true);
  assert.equal(started.model, 'x-ai/grok-4.6');
  assert.equal(started.provider, 'x-ai');
  assert.equal(started.cli, true);
  assert.equal(started.bin, fakeCli);
  assert.equal(started.runtimeVersion, '0.21.0');
  assert.equal(calls.length, 0);
  controller.stopHermes();
});
