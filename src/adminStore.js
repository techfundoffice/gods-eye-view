/**
 * Durable JSON state for the ADMIN console.
 *
 * The admin surface has to survive a dev-server restart: revoking an MCP API
 * key or building a plugin is operator work, not session scratch. State lands
 * in the gitignored `.gev-cache/` directory alongside the other server-side
 * caches, is written atomically (temp file + rename) so a crash mid-write can
 * never leave a truncated key list, and is created with owner-only permissions
 * because it holds API-key hashes.
 *
 * @module adminStore
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeHermesYoutubeAdmin } from './hermesYoutubeAdmin.js';
import { normalizeGevFunctionToggles, setGevFunctionToggles } from './gevFunctionToggles.js';

/** Default on-disk location, relative to the repository root. */
export const ADMIN_STATE_FILE = '.gev-cache/admin-state.json';

/** Shape returned when nothing has been persisted yet. */
export function emptyAdminState() {
  return { version: 1, apiKeys: [], mcpEnabled: false, plugins: [], hermesYoutubeAdmin: normalizeHermesYoutubeAdmin(null), gevFunctionToggles: normalizeGevFunctionToggles(null) };
}

/**
 * Merge a persisted blob onto the empty shape, discarding anything unexpected.
 * A hand-edited or partially written file must degrade to defaults rather than
 * propagate `undefined` into the auth path.
 *
 * @param {unknown} raw Parsed file contents.
 * @returns {{version: number, apiKeys: object[], mcpEnabled: boolean, plugins: object[]}}
 */
export function normalizeAdminState(raw) {
  const base = emptyAdminState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: Number.isFinite(raw.version) ? Number(raw.version) : base.version,
    apiKeys: Array.isArray(raw.apiKeys) ? raw.apiKeys.filter((entry) => entry && typeof entry === 'object') : [],
    mcpEnabled: Boolean(raw.mcpEnabled),
    plugins: Array.isArray(raw.plugins) ? raw.plugins.filter((entry) => entry && typeof entry === 'object') : [],
    hermesYoutubeAdmin: normalizeHermesYoutubeAdmin(raw.hermesYoutubeAdmin),
    gevFunctionToggles: normalizeGevFunctionToggles(raw.gevFunctionToggles),
  };
}

/**
 * File-backed admin state with an in-memory cache.
 *
 * @param {object} [options]
 * @param {string} [options.file] Absolute or repo-relative state path.
 * @param {typeof fs} [options.fsImpl] Injected for tests.
 * @returns {{read: () => object, write: (state: object) => object, update: (fn: (state: object) => object) => object, file: string}}
 */
export function createAdminStore({ file = ADMIN_STATE_FILE, fsImpl = fs } = {}) {
  const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      cache = normalizeAdminState(JSON.parse(fsImpl.readFileSync(resolved, 'utf8')));
    } catch {
      // Missing file on first run, or an unreadable/corrupt one: either way the
      // console must still start, with no keys trusted.
      cache = emptyAdminState();
    }
    setGevFunctionToggles(cache.gevFunctionToggles);
    return cache;
  }

  function write(state) {
    cache = normalizeAdminState(state);
    setGevFunctionToggles(cache.gevFunctionToggles);
    const serialized = `${JSON.stringify(cache, null, 2)}\n`;
    try {
      fsImpl.mkdirSync(path.dirname(resolved), { recursive: true });
      const temp = `${resolved}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temp, serialized, { mode: 0o600 });
      fsImpl.renameSync(temp, resolved);
    } catch (error) {
      // A read-only checkout still gets a working console for this process.
      console.warn('[Admin] Could not persist admin state:', error?.message || error);
    }
    return cache;
  }

  function update(mutate) {
    return write(mutate(read()));
  }

  return { read, write, update, file: resolved };
}
