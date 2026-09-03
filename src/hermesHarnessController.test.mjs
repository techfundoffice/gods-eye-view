import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHermesHarnessController, HERMES_HARNESS_ID, OPENROUTER_HARNESS_ID } from './hermesHarnessController.js';

test('Hermes is the preferred default; failed preflight uses OpenRouter without saving that default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-h-'));
  const controller = createHermesHarnessController({
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(dir, 'missing-skill.md'),
    postChat: async () => ({ ok: false, payload: { error: 'nope' } }),
    openrouterInterpret: async () => ({ ok: true, kind: 'complete', text: 'fallback' }),
    hermesCommand: '',
  });
  await controller.loadPreferred();
  const before = controller.status();
  assert.equal(before.preferred, HERMES_HARNESS_ID);
  const started = await controller.startHermes();
  assert.equal(started.ready, false);
  assert.equal(started.active, OPENROUTER_HARNESS_ID);
  assert.match(started.fallbackReason, /skill missing|OpenRouter|catalog|Hermes/i);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8').catch(() => '{"preferred":"hermes"}'));
  assert.notEqual(saved.preferred, OPENROUTER_HARNESS_ID);
  const out = await controller.interpret({ comment: 'hi' });
  assert.equal(out.text, 'fallback');
});

test('selecting OpenRouter is an explicit operator override that persists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-h-'));
  const controller = createHermesHarnessController({
    settingsPath: path.join(dir, 'settings.json'),
    skillPath: path.join(dir, 'missing-skill.md'),
    openrouterInterpret: async () => ({ ok: true, kind: 'complete', text: 'or' }),
  });
  const selected = await controller.select(OPENROUTER_HARNESS_ID);
  assert.equal(selected.preferred, OPENROUTER_HARNESS_ID);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.preferred, OPENROUTER_HARNESS_ID);
});
