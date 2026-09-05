import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { ADMIN_STATE_FILE, createAdminStore, emptyAdminState, normalizeAdminState } from './adminStore.js';

/** In-memory `fs` stand-in covering only what the store uses. */
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

test('an absent state file reads as empty rather than throwing', () => {
  const store = createAdminStore({ file: '/state/admin.json', fsImpl: memoryFs() });
  assert.deepEqual(store.read(), emptyAdminState());
});

test('a corrupt state file degrades to empty, trusting no keys', () => {
  const store = createAdminStore({
    file: '/state/admin.json',
    fsImpl: memoryFs({ '/state/admin.json': '{ this is not json' }),
  });
  assert.deepEqual(store.read().apiKeys, []);
  assert.equal(store.read().mcpEnabled, false);
});

test('unexpected shapes are normalized away', () => {
  assert.deepEqual(normalizeAdminState(null), emptyAdminState());
  assert.deepEqual(normalizeAdminState('nope'), emptyAdminState());
  assert.deepEqual(normalizeAdminState({ apiKeys: 'not-an-array' }).apiKeys, []);
  assert.deepEqual(normalizeAdminState({ apiKeys: [null, 4, { id: 'a' }] }).apiKeys, [{ id: 'a' }]);
  assert.equal(normalizeAdminState({ mcpEnabled: 'yes' }).mcpEnabled, true);
  assert.equal(normalizeAdminState({ version: 'x' }).version, 1);
  const trending = normalizeAdminState({
    youtubeTrending: { enabled: true, regionCode: 'gb', refreshMinutes: 1, categoryIds: ['10', '20', '30', '40'] },
  }).youtubeTrending;
  assert.equal(trending.enabled, true);
  assert.equal(trending.regionCode, 'GB');
  assert.equal(trending.refreshMinutes, 15);
  assert.deepEqual(trending.categoryIds, ['10', '20', '30']);
});

test('writes are atomic — a temp file is written, then renamed over the target', () => {
  const fsImpl = memoryFs();
  const store = createAdminStore({ file: '/state/admin.json', fsImpl });
  store.write({ apiKeys: [{ id: 'k1' }], mcpEnabled: true });

  const kinds = fsImpl.calls.map((entry) => entry[0]);
  assert.deepEqual(kinds, ['mkdir', 'write', 'rename']);
  const [, tempPath, writeOptions] = fsImpl.calls[1];
  assert.match(tempPath, /\.tmp$/, 'the payload lands in a temp file first');
  assert.equal(writeOptions.mode, 0o600, 'the file holds key hashes; keep it owner-only');
  assert.deepEqual(fsImpl.calls[2], ['rename', tempPath, '/state/admin.json']);
});

test('written state reads back through the cache and off disk', () => {
  const fsImpl = memoryFs();
  const store = createAdminStore({ file: '/state/admin.json', fsImpl });
  store.write({ apiKeys: [{ id: 'k1' }], mcpEnabled: true });
  assert.equal(store.read().mcpEnabled, true);

  const reopened = createAdminStore({ file: '/state/admin.json', fsImpl });
  assert.deepEqual(reopened.read().apiKeys, [{ id: 'k1' }]);
});

test('update mutates the current state in place', () => {
  const store = createAdminStore({ file: '/state/admin.json', fsImpl: memoryFs() });
  store.update((state) => ({ ...state, apiKeys: [{ id: 'first' }] }));
  store.update((state) => ({ ...state, apiKeys: [...state.apiKeys, { id: 'second' }] }));
  assert.deepEqual(store.read().apiKeys.map((key) => key.id), ['first', 'second']);
});

test('an unwritable location keeps the in-process state usable', () => {
  const fsImpl = memoryFs();
  fsImpl.writeFileSync = () => { throw new Error('EROFS: read-only file system'); };
  const store = createAdminStore({ file: '/state/admin.json', fsImpl });
  assert.doesNotThrow(() => store.write({ apiKeys: [{ id: 'k1' }], mcpEnabled: true }));
  assert.equal(store.read().mcpEnabled, true, 'the console still works for this process');
});

test('a relative path resolves under the working directory and stays gitignored', () => {
  const store = createAdminStore({ fsImpl: memoryFs() });
  assert.equal(store.file, path.join(process.cwd(), ADMIN_STATE_FILE));
  assert.ok(ADMIN_STATE_FILE.startsWith('.gev-cache/'), 'state lives in the ignored cache directory');
});
