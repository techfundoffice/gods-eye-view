/**
 * Server-only OpenRouter key store. Gitignored `.gev-cache/` file, mode 0600.
 * Never import from a browser bundle. Never return the raw key to HTTP clients.
 */

import fs from 'node:fs';
import path from 'node:path';

export const OPENROUTER_SECRET_FILE = '.gev-cache/openrouter-secret.json';
export const OPENROUTER_ADMIN_MODEL = 'openrouter/free';

/**
 * Models the ADMIN console may select, newest first within each tier.
 *
 * Every entry MUST support OpenRouter function calling. The public-comment
 * interpreter sends `tools` and reads `message.tool_calls` back; a model
 * without tool support answers in prose and the globe never moves, which
 * ships a feature that looks like it works and does not. Verified against
 * `supported_parameters` in https://openrouter.ai/api/v1/models — no free
 * Gemini variant carries tool support, so every Gemini choice here is paid.
 * `:batch` variants are deliberately excluded: they resolve through the async
 * batch API, not the synchronous chat-completions call this path makes.
 */
export const OPENROUTER_MODEL_CHOICES = Object.freeze([
  Object.freeze({ id: 'openrouter/free', label: 'Free Models Router', tier: 'free' }),
  Object.freeze({ id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', tier: 'paid' }),
  Object.freeze({ id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'paid' }),
  Object.freeze({ id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'paid' }),
]);

const ALLOWED_MODEL_IDS = new Set(OPENROUTER_MODEL_CHOICES.map((choice) => choice.id));

/**
 * Is this an operator-selectable model id?
 *
 * The browser posts this value, so it is untrusted: an unfiltered field is how
 * an unsupported — or unexpectedly expensive — model reaches the router.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAllowedOpenRouterModel(value) {
  return ALLOWED_MODEL_IDS.has(String(value ?? '').trim());
}

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
  // Empty means "the operator has not chosen", which is what lets the
  // `OPENROUTER_MODEL` env var still win; defaulting to the free router here
  // instead would make the admin value permanently truthy and strand the env
  // escape hatch. A stored model is honoured only while it is still on the
  // allowlist, so one retired from the catalog degrades to the default rather
  // than failing every live comment with an upstream 400.
  const model = isAllowedOpenRouterModel(raw?.model) ? String(raw.model).trim() : '';
  return {
    apiKey: isUsableOpenRouterKey(apiKey) ? apiKey : '',
    model,
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
      model: cache.model,
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
    // The selected model rides along on every write: it lives in the same
    // record, and omitting it here would silently reset the operator's choice
    // to the default every time the key is saved or cleared.
    const model = read().model;
    if (!trimmed) return write({ apiKey: '', model, updatedAt: new Date().toISOString() });
    if (!isUsableOpenRouterKey(trimmed)) {
      const error = new Error('OpenRouter API key is not usable');
      error.status = 400;
      error.kind = 'invalid';
      throw error;
    }
    return write({ apiKey: trimmed, model, updatedAt: new Date().toISOString() });
  }

  function setModel(model) {
    const trimmed = String(model ?? '').trim();
    if (!isAllowedOpenRouterModel(trimmed)) {
      const error = new Error('OpenRouter model is not selectable');
      error.status = 400;
      error.kind = 'invalid';
      throw error;
    }
    return write({ apiKey: read().apiKey, model: trimmed, updatedAt: new Date().toISOString() });
  }

  function publicStatus(envKey = process.env.OPENROUTER_API_KEY) {
    const current = read();
    const adminPresent = isUsableOpenRouterKey(current.apiKey);
    const envPresent = isUsableOpenRouterKey(envKey);
    return {
      present: adminPresent || envPresent,
      source: adminPresent ? 'admin' : envPresent ? 'env' : 'missing',
      // The EFFECTIVE model, not the stored one: the pane must show what the
      // live comment path will actually send, including an env override.
      model: resolveOpenRouterModel({ adminModel: current.model }),
      choices: OPENROUTER_MODEL_CHOICES.map((choice) => ({ ...choice })),
    };
  }

  return { file: resolved, read, write, setKey, setModel, publicStatus };
}

const defaultSecret = createOpenRouterAdminSecret();

export function readOpenRouterAdminSecret() {
  return defaultSecret.read();
}

export function setOpenRouterAdminKey(apiKey) {
  return defaultSecret.setKey(apiKey);
}

export function setOpenRouterAdminModel(model) {
  return defaultSecret.setModel(model);
}

/**
 * ADMIN selection first, then process.env, then the free router.
 *
 * This is the single resolution point the live YouTube comment path runs
 * through, so the ADMIN console's choice reaches the interpreter here or
 * nowhere. `OPENROUTER_MODEL` stays an unvalidated server-side escape hatch —
 * it is operator-set, unlike the browser-posted admin value.
 *
 * @param {object} [options]
 * @param {string} [options.adminModel]
 * @param {string} [options.envModel]
 * @returns {string}
 */
export function resolveOpenRouterModel({
  adminModel = defaultSecret.read().model,
  envModel = process.env.OPENROUTER_MODEL,
} = {}) {
  if (isAllowedOpenRouterModel(adminModel)) return String(adminModel).trim();
  const fromEnv = String(envModel ?? '').trim();
  if (fromEnv) return fromEnv;
  return OPENROUTER_ADMIN_MODEL;
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
