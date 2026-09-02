import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenRouterAdminSecret,
  isUsableOpenRouterKey,
  normalizeOpenRouterSecret,
  resolveOpenRouterApiKey,
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
  assert.equal(status.model, 'google/gemini-3.8-flash');
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

test('setModel persists and publicStatus returns it', () => {
  const fsImpl = memoryFs();
  const store = createOpenRouterAdminSecret({ file: '/secret.json', fsImpl });
  store.setKey('sk-or-v1-abcdefghijklmnopqrstuvwxyz012345');
  store.setModel('google/gemini-3-pro-preview');
  const status = store.publicStatus('');
  assert.equal(status.model, 'google/gemini-3-pro-preview');
  assert.equal(JSON.parse(fsImpl.files['/secret.json']).model, 'google/gemini-3-pro-preview');
});

test('setModel rejects auto router slugs', () => {
  const fsImpl = memoryFs();
  const store = createOpenRouterAdminSecret({ file: '/secret.json', fsImpl });
  assert.throws(() => store.setModel('openrouter/auto'));
});
