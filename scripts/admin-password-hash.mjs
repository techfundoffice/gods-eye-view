#!/usr/bin/env node
/**
 * Print an `ADMIN_PASSWORD_HASH` value for the ADMIN console.
 *
 * Usage:
 *   node scripts/admin-password-hash.mjs 'your admin password'
 *   ADMIN_PASSWORD='your admin password' node scripts/admin-password-hash.mjs
 *
 * Storing the hash rather than `ADMIN_PASSWORD` keeps the plaintext out of the
 * environment of every child process the dev server spawns — including the
 * coding agent the console itself can start. Paste the printed
 * `ADMIN_PASSWORD_HASH=scrypt$...` line into `.env` as-is; the Vite loader
 * restores `$` that dotenv-expand would otherwise eat.
 */

import { hashAdminPassword } from '../src/adminAuth.js';

const password = process.argv[2] ?? process.env.ADMIN_PASSWORD ?? '';

if (!password.trim()) {
  console.error('Usage: node scripts/admin-password-hash.mjs \'<password>\'');
  console.error('   or: ADMIN_PASSWORD=\'<password>\' node scripts/admin-password-hash.mjs');
  process.exitCode = 1;
} else if (password.trim().length < 12) {
  console.error('Refusing to hash a password shorter than 12 characters.');
  console.error('The ADMIN console can drive an agent that edits this repository.');
  process.exitCode = 1;
} else {
  console.log(`ADMIN_PASSWORD_HASH=${hashAdminPassword(password)}`);
}
