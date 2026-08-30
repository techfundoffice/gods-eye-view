/**
 * Checkout dotenv load used by the Vite server.
 *
 * Vite's `loadEnv` always runs dotenv-expand. That is fine for ordinary keys
 * that interpolate `${OTHER}`, but it destroys two ADMIN values:
 *
 *   - `ADMIN_PASSWORD_HASH=scrypt$N$r$p$salt$hash` — each `$token` is treated
 *     as a variable and dropped, after which `isAdminPasswordHash` disables
 *     the console.
 *   - `ADMIN_PASSWORD` containing `$` (`op$secret`, `$*` is the lucky case
 *     that happens to survive).
 *
 * An empty inherited `process.env` entry also wins over the file: `loadEnv`
 * copies it back, and `process.env[key] === undefined` then refuses to
 * backfill. Empty is how a shell says "unset". Non-empty shell values still
 * win, matching the rest of this checkout.
 *
 * @module gevEnv
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from 'vite';

/** Keys whose file values must survive dotenv-expand and empty inherited env. */
export const ADMIN_CREDENTIAL_ENV_KEYS = Object.freeze(['ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD']);

/**
 * dotenv LINE matcher — the unexpanded half of Vite's `loadEnv` parse.
 * Copied from the dotenv parse Vite bundles so hashes round-trip as written.
 */
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * Env files Vite merges, later files override earlier ones.
 *
 * @param {string} mode Vite mode (`development`, `production`, …).
 * @returns {string[]}
 */
export function gevEnvFileNames(mode) {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
}

/**
 * Parse dotenv text without expanding `$` interpolations.
 *
 * @param {string|Buffer} src File contents.
 * @returns {Record<string, string>}
 */
function parseDotenvNoExpand(src) {
  const obj = {};
  const lines = String(src ?? '').replace(/\r\n?/gm, '\n');
  DOTENV_LINE.lastIndex = 0;
  let match;
  while ((match = DOTENV_LINE.exec(lines)) != null) {
    const key = match[1];
    let value = match[2] || '';
    value = value.trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, '\n');
      value = value.replace(/\\r/g, '\r');
    }
    obj[key] = value;
  }
  return obj;
}

/**
 * Unexpanded ADMIN credential values from the same files `loadEnv` reads.
 *
 * @param {string} envDir Directory that holds `.env*`.
 * @param {string} [mode]
 * @returns {Record<string, string>}
 */
export function readUnexpandedAdminCredentials(envDir, mode = 'development') {
  const out = {};
  const root = path.resolve(envDir);
  for (const name of gevEnvFileNames(mode)) {
    const filePath = path.join(root, name);
    let text;
    try {
      text = fs.readFileSync(filePath);
    } catch {
      continue;
    }
    const parsed = parseDotenvNoExpand(text);
    for (const key of ADMIN_CREDENTIAL_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = parsed[key];
    }
  }
  return out;
}

/**
 * @param {string[]} keys
 * @returns {Map<string, string>}
 */
function stashProcessEnv(keys) {
  const stash = new Map();
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      stash.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  return stash;
}

/**
 * @param {Map<string, string>} stash
 */
function restoreProcessEnv(stash) {
  for (const [key, value] of stash) process.env[key] = value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function inheritedAdminValueWins(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Vite `loadEnv` plus the ADMIN overlay the server actually applies.
 *
 * @param {string} mode
 * @param {string} envDir
 * @param {string|string[]} [prefixes] Passed through to `loadEnv`. `''` loads every key.
 * @returns {Record<string, string>}
 */
export function loadGevEnv(mode, envDir, prefixes = '') {
  const stash = stashProcessEnv(ADMIN_CREDENTIAL_ENV_KEYS);
  try {
    const loaded = loadEnv(mode, envDir, prefixes);
    const unexpanded = readUnexpandedAdminCredentials(envDir, mode);
    for (const key of ADMIN_CREDENTIAL_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(unexpanded, key)) loaded[key] = unexpanded[key];
    }
    for (const key of ADMIN_CREDENTIAL_ENV_KEYS) {
      if (stash.has(key) && inheritedAdminValueWins(stash.get(key))) {
        loaded[key] = stash.get(key);
      }
    }
    return loaded;
  } finally {
    restoreProcessEnv(stash);
  }
}

/**
 * Copy loaded values into `process.env`. Empty inherited ADMIN credentials
 * do not shadow a file value; every other key keeps the historical
 * `=== undefined` backfill.
 *
 * @param {Record<string, string|undefined>} loaded
 * @returns {NodeJS.ProcessEnv}
 */
export function applyGevEnv(loaded) {
  const admin = new Set(ADMIN_CREDENTIAL_ENV_KEYS);
  for (const [key, val] of Object.entries(loaded)) {
    if (val === undefined) continue;
    if (admin.has(key)) {
      const current = process.env[key];
      if (current === undefined || String(current).trim() === '') process.env[key] = val;
      continue;
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return process.env;
}

/**
 * The Vite config entry: load checkout dotenv and apply it to `process.env`.
 *
 * @param {string} mode
 * @param {string} envDir
 * @param {string|string[]} [prefixes]
 * @returns {Record<string, string>}
 */
export function loadAndApplyGevEnv(mode, envDir, prefixes = '') {
  const loaded = loadGevEnv(mode, envDir, prefixes);
  applyGevEnv(loaded);
  return loaded;
}
