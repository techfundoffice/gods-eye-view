#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGevEnv } from '../src/gevEnv.js';

/**
 * Read one dotenv key with the same loader the Vite server uses; no file
 * content is executed.
 *
 * Reports what the FILES say. Vite's `loadEnv` lets `process.env` override
 * the parsed files, so an inherited export — an empty one above all, which
 * is how a shell says "unset" to this script's callers — would otherwise
 * mask the value the user wrote down. The key is hidden for the duration of
 * the read and restored afterwards, leaving the caller's environment
 * untouched. ADMIN_PASSWORD_HASH / ADMIN_PASSWORD keep their `$` characters
 * (dotenv-expand would otherwise eat a pasted scrypt hash).
 */
export function readDotenvValue(variableName, rootDir = process.cwd(), mode = 'development') {
  const key = String(variableName || '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return '';
  const inherited = Object.prototype.hasOwnProperty.call(process.env, key)
    ? process.env[key]
    : undefined;
  if (inherited !== undefined) delete process.env[key];
  try {
    const env = loadGevEnv(mode, path.resolve(rootDir), '');
    return String(env[key] ?? '');
  } finally {
    if (inherited !== undefined) process.env[key] = inherited;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.stdout.write(readDotenvValue(process.argv[2], process.argv[3] || process.cwd()));
}
