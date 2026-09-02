import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from 'vite';
import { readDotenvValue } from '../scripts/read-dotenv-value.mjs';
import { loadAndApplyGevEnv } from './gevEnv.js';
import {
  hashAdminPassword,
  isAdminPasswordHash,
  resolveAdminPasswordHash,
  verifyAdminPassword,
} from './adminAuth.js';

const ADMIN_ENV_KEYS = ['ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD'];

function stashAdminEnv() {
  const stash = new Map();
  for (const key of ADMIN_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      stash.set(key, process.env[key]);
    }
    delete process.env[key];
  }
  return stash;
}

function restoreAdminEnv(stash) {
  for (const key of ADMIN_ENV_KEYS) delete process.env[key];
  for (const [key, value] of stash) process.env[key] = value;
}

test('dotenv reader preserves values without executing shell metacharacters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-dotenv-'));
  const marker = path.join(root, 'must-not-exist');
  try {
    await fs.writeFile(path.join(root, '.env'), [
      'PLAIN_KEY=plain-value',
      'QUOTED_KEY="quoted value"',
      `SHELL_PAYLOAD=$(touch ${marker})`,
      'BACKTICK_PAYLOAD=`printf owned`',
    ].join('\n'));
    assert.equal(readDotenvValue('PLAIN_KEY', root), 'plain-value');
    assert.equal(readDotenvValue('QUOTED_KEY', root), 'quoted value');
    assert.equal(readDotenvValue('SHELL_PAYLOAD', root), `$(touch ${marker})`);
    // dotenv treats backticks as quote delimiters, but never executes them.
    assert.equal(readDotenvValue('BACKTICK_PAYLOAD', root), 'printf owned');
    await assert.rejects(fs.access(marker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an inherited export never masks the value written in the file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-dotenv-'));
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GEV_INHERIT_PROBE');
  const previous = process.env.GEV_INHERIT_PROBE;
  try {
    await fs.writeFile(path.join(root, '.env'), 'GEV_INHERIT_PROBE=from-dotenv\n');

    // An empty export is how a shell says "unset" to the launcher's `:-`
    // fallbacks, and Vite's loadEnv otherwise lets process.env win — which is
    // exactly how a configured key went missing.
    process.env.GEV_INHERIT_PROBE = '';
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');

    // A non-empty inherited value must not win either: this reader answers for
    // the files, and the caller decides precedence.
    process.env.GEV_INHERIT_PROBE = 'from-shell';
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');

    // The caller's own environment survives the read unchanged.
    assert.equal(process.env.GEV_INHERIT_PROBE, 'from-shell');

    delete process.env.GEV_INHERIT_PROBE;
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'GEV_INHERIT_PROBE'), false);
  } finally {
    if (had) process.env.GEV_INHERIT_PROBE = previous;
    else delete process.env.GEV_INHERIT_PROBE;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Vite loadEnv + resolveAdminPasswordHash keep $ in scrypt hashes and passwords', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-admin-env-'));
  const operatorPassword = 'admin, Ishouldofhadav8gw!$*';
  const hash = hashAdminPassword(operatorPassword);
  const dollarPassword = 'op$secret$dollar-value';
  const stash = stashAdminEnv();
  try {
    await fs.writeFile(path.join(root, '.env'), [
      `ADMIN_PASSWORD_HASH=${hash}`,
      `ADMIN_PASSWORD=${dollarPassword}`,
    ].join('\n'));

    // The trap this test exists to catch: dotenv-expand strips `$` from the
    // hash (and from a password like op$secret), so the expanded value must
    // not authenticate. If this assertion fails, expand stopped eating `$`
    // and the overlay in gevEnv.js may be unnecessary — keep the failure.
    const expanded = loadEnv('development', root, '');
    assert.equal(isAdminPasswordHash(expanded.ADMIN_PASSWORD_HASH), false);
    assert.equal(verifyAdminPassword(operatorPassword, expanded.ADMIN_PASSWORD_HASH || ''), false);
    assert.notEqual(expanded.ADMIN_PASSWORD, dollarPassword);
    // Even the expanded/mangled hash must not mask a valid password fallback.
    const expandedCredential = resolveAdminPasswordHash(expanded);
    assert.equal(expandedCredential?.source, 'password');
    assert.equal(verifyAdminPassword(expanded.ADMIN_PASSWORD, expandedCredential.hash), true);

    // Empty inherited env is how a shell says unset; it must not shadow .env.
    process.env.ADMIN_PASSWORD_HASH = '';
    process.env.ADMIN_PASSWORD = '';
    const loaded = loadAndApplyGevEnv('development', root);
    assert.equal(loaded.ADMIN_PASSWORD_HASH, hash);
    assert.equal(loaded.ADMIN_PASSWORD, dollarPassword);
    const credential = resolveAdminPasswordHash();
    assert.equal(credential?.source, 'hash');
    assert.equal(verifyAdminPassword(operatorPassword, credential.hash), true);
    assert.equal(process.env.ADMIN_PASSWORD, dollarPassword);
  } finally {
    restoreAdminEnv(stash);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a password-only ADMIN_PASSWORD containing $ authenticates after the server load path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-admin-pass-'));
  const dollarPassword = 'op$secret$dollar-value';
  const stash = stashAdminEnv();
  try {
    await fs.writeFile(path.join(root, '.env'), `ADMIN_PASSWORD=${dollarPassword}\n`);
    const expanded = loadEnv('development', root, '');
    assert.notEqual(expanded.ADMIN_PASSWORD, dollarPassword);
    const expandedCredential = resolveAdminPasswordHash(expanded);
    assert.equal(
      expandedCredential ? verifyAdminPassword(dollarPassword, expandedCredential.hash) : false,
      false,
    );

    loadAndApplyGevEnv('development', root);
    const credential = resolveAdminPasswordHash();
    assert.equal(credential?.source, 'password');
    assert.equal(verifyAdminPassword(dollarPassword, credential.hash), true);
  } finally {
    restoreAdminEnv(stash);
    await fs.rm(root, { recursive: true, force: true });
  }
});
