import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENROUTER_ADMIN_MODEL,
  OPENROUTER_MODEL_CHOICES,
  createOpenRouterAdminSecret,
  isAllowedOpenRouterModel,
  isUsableOpenRouterKey,
  normalizeOpenRouterSecret,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
} from './openrouterAdminSecret.js';

function memoryFs(files = {}) {
  const written = { ...files };
  const calls = [];
  return {
    files: written,
    calls,
    readFileSync(file) {
      if (!(file in written)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return written[file];
    },
    writeFileSync(file, data, options) {
      calls.push(['write', file, options]);
      written[file] = data;
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
      written[to] = written[from];
      delete written[from];
    },
    mkdirSync(dir, options) {
      calls.push(['mkdir', dir, options]);
    },
  };
}

test('dummy and empty keys are not usable', () => {
  assert.equal(isUsableOpenRouterKey(''), false);
  assert.equal(isUsableOpenRouterKey('_DUMMY_API_KEY_'), false);
  assert.equal(isUsableOpenRouterKey('sk-or-v1-abcdefghijklmnopqrstuvwxyz012345'), true);
});

test('normalize drops dummy keys and never invents one', () => {
  assert.equal(normalizeOpenRouterSecret({ apiKey: '_DUMMY_API_KEY_' }).apiKey, '');
  assert.equal(normalizeOpenRouterSecret(null).apiKey, '');
});

test('ADMIN key wins over env; dummy admin falls through to env', () => {
  const key = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz012345';
  assert.equal(resolveOpenRouterApiKey({ adminKey: key, envKey: 'sk-or-v1-other-key-other-key-other' }), key);
  assert.equal(resolveOpenRouterApiKey({ adminKey: '_DUMMY_API_KEY_', envKey: key }), key);
  assert.equal(resolveOpenRouterApiKey({ adminKey: '', envKey: '' }), '');
});

test('public status never includes the raw key', () => {
  const fsImpl = memoryFs();
  const store = createOpenRouterAdminSecret({ file: '/secret.json', fsImpl });
  store.setKey('sk-or-v1-abcdefghijklmnopqrstuvwxyz012345');
  const status = store.publicStatus('');
  assert.equal(status.present, true);
  assert.equal(status.source, 'admin');
  assert.equal(status.model, 'openrouter/free');
  assert.equal(JSON.stringify(status).includes('sk-or-'), false);
});

test('writes are owner-only and atomic', () => {
  const fsImpl = memoryFs();
  const store = createOpenRouterAdminSecret({ file: '/secret.json', fsImpl });
  store.setKey('sk-or-v1-abcdefghijklmnopqrstuvwxyz012345');
  const kinds = fsImpl.calls.map((entry) => entry[0]);
  assert.deepEqual(kinds, ['mkdir', 'write', 'rename']);
  assert.equal(fsImpl.calls[1][2].mode, 0o600);
  assert.equal(JSON.parse(fsImpl.files['/secret.json']).apiKey.startsWith('sk-or-'), true);
});

test('a stored model survives a round trip and is not reset by saving the key', () => {
  const files = new Map();
  const fsImpl = {
    readFileSync: (p) => { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirSync: () => {},
  };
  const store = createOpenRouterAdminSecret({ file: '/tmp/or-secret.json', fsImpl });
  store.setModel('google/gemini-2.5-flash');
  assert.equal(store.read().model, 'google/gemini-2.5-flash');
  // Regression: setKey() used to write without carrying the model, silently
  // resetting the operator's choice on every key save.
  store.setKey('sk-or-v1-0123456789abcdefghij');
  assert.equal(store.read().model, 'google/gemini-2.5-flash');
  assert.equal(store.read().apiKey, 'sk-or-v1-0123456789abcdefghij');
});

test('an off-allowlist model is refused and a retired one degrades to the default', () => {
  const store = createOpenRouterAdminSecret({
    file: '/tmp/or-secret-2.json',
    fsImpl: {
      readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      writeFileSync: () => {}, renameSync: () => {}, mkdirSync: () => {},
    },
  });
  assert.throws(() => store.setModel('some/expensive-model'), /not selectable/);
  assert.throws(() => store.setModel(''), /not selectable/);
  // A model dropped from the catalog must not strand every live comment on an
  // upstream 400 — it reads back as unset.
  assert.equal(normalizeOpenRouterSecret({ model: 'google/retired-model' }).model, '');
  assert.equal(normalizeOpenRouterSecret({ model: 'openrouter/free' }).model, 'openrouter/free');
});

test('model resolution is admin then env then the free router', () => {
  assert.equal(resolveOpenRouterModel({ adminModel: 'google/gemini-2.5-pro', envModel: 'x/y' }), 'google/gemini-2.5-pro');
  // Unset admin selection is what lets OPENROUTER_MODEL still win.
  assert.equal(resolveOpenRouterModel({ adminModel: '', envModel: 'x/y' }), 'x/y');
  assert.equal(resolveOpenRouterModel({ adminModel: '', envModel: '' }), OPENROUTER_ADMIN_MODEL);
  // An off-allowlist stored value never reaches the router.
  assert.equal(resolveOpenRouterModel({ adminModel: 'some/expensive-model', envModel: '' }), OPENROUTER_ADMIN_MODEL);
});

test('every selectable model is tool-capable and the free router is the default', () => {
  assert.equal(OPENROUTER_MODEL_CHOICES[0].id, OPENROUTER_ADMIN_MODEL);
  assert.ok(OPENROUTER_MODEL_CHOICES.some((c) => c.id.startsWith('google/gemini')), 'Gemini must be selectable');
  for (const choice of OPENROUTER_MODEL_CHOICES) {
    assert.ok(isAllowedOpenRouterModel(choice.id));
    assert.ok(['free', 'paid'].includes(choice.tier), `${choice.id} needs a tier`);
    // :batch resolves through the async batch API, not chat/completions.
    assert.ok(!choice.id.includes(':batch'), `${choice.id} is a batch variant`);
  }
});
