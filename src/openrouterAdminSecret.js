/**
 * Server-only OpenRouter key store. Gitignored `.gev-cache/` file, mode 0600.
 * Never import from a browser bundle. Never return the raw key to HTTP clients.
 */

import fs from 'node:fs';
import path from 'node:path';

export const OPENROUTER_SECRET_FILE = '.gev-cache/openrouter-secret.json';
export const OPENROUTER_ADMIN_MODEL = 'openrouter/free';

const DUMMY_KEYS = new Set(['', '_DUMMY_API_KEY_', 'undefined', 'null']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUsableOpenRouterKey(value) {
  const key = String(value ?? '').trim();
  if (!key || DUMMY_KEYS.has(key) || key.startsWith('_DUMMY')) return false;
  return key.length >= 20;
}

/**
 * @param {unknown} raw
 * @returns {{apiKey: string, model: string, updatedAt: string}}
 */
export function normalizeOpenRouterSecret(raw) {
  const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '';
  return {
    apiKey: isUsableOpenRouterKey(apiKey) ? apiKey : '',
    model: OPENROUTER_ADMIN_MODEL,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {typeof fs} [options.fsImpl]
 */
export function createOpenRouterAdminSecret({
  file = OPENROUTER_SECRET_FILE,
  fsImpl = fs,
} = {}) {
  const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      cache = normalizeOpenRouterSecret(JSON.parse(fsImpl.readFileSync(resolved, 'utf8')));
    } catch {
      cache = normalizeOpenRouterSecret({});
    }
    return cache;
  }

  function write(next) {
    cache = normalizeOpenRouterSecret(next);
    const serialized = `${JSON.stringify({
      apiKey: cache.apiKey,
      model: OPENROUTER_ADMIN_MODEL,
      updatedAt: cache.updatedAt || new Date().toISOString(),
    }, null, 2)}\n`;
    try {
      fsImpl.mkdirSync(path.dirname(resolved), { recursive: true });
      const temp = `${resolved}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temp, serialized, { mode: 0o600 });
      fsImpl.renameSync(temp, resolved);
    } catch (error) {
      console.warn('[OpenRouter] Could not persist admin secret:', error?.message || error);
    }
    return cache;
  }

  function setKey(apiKey) {
    const trimmed = String(apiKey ?? '').trim();
    if (!trimmed) return write({ apiKey: '', updatedAt: new Date().toISOString() });
    if (!isUsableOpenRouterKey(trimmed)) {
      const error = new Error('OpenRouter API key is not usable');
      error.status = 400;
      error.kind = 'invalid';
      throw error;
    }
    return write({ apiKey: trimmed, updatedAt: new Date().toISOString() });
  }

  function publicStatus(envKey = process.env.OPENROUTER_API_KEY) {
    const adminKey = read().apiKey;
    const adminPresent = isUsableOpenRouterKey(adminKey);
    const envPresent = isUsableOpenRouterKey(envKey);
    return {
      present: adminPresent || envPresent,
      source: adminPresent ? 'admin' : envPresent ? 'env' : 'missing',
      model: OPENROUTER_ADMIN_MODEL,
    };
  }

  return { file: resolved, read, write, setKey, publicStatus };
}

const defaultSecret = createOpenRouterAdminSecret();

export function readOpenRouterAdminSecret() {
  return defaultSecret.read();
}

export function setOpenRouterAdminKey(apiKey) {
  return defaultSecret.setKey(apiKey);
}

export function openRouterAdminPublicStatus(envKey) {
  return defaultSecret.publicStatus(envKey);
}

/**
 * ADMIN store first, then process.env. Dummy / empty values are skipped.
 *
 * @param {object} [options]
 * @param {string} [options.adminKey]
 * @param {string} [options.envKey]
 * @returns {string}
 */
export function resolveOpenRouterApiKey({
  adminKey = defaultSecret.read().apiKey,
  envKey = process.env.OPENROUTER_API_KEY,
} = {}) {
  if (isUsableOpenRouterKey(adminKey)) return String(adminKey).trim();
  if (isUsableOpenRouterKey(envKey)) return String(envKey).trim();
  return '';
}
