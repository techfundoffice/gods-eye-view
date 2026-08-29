import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_API_KEY_PREFIX,
  ADMIN_LOGIN_FREE_ATTEMPTS,
  ADMIN_LOGIN_MAX_BACKOFF_MS,
  apiKeyPreview,
  createAdminAuth,
  extractApiKey,
  generateApiKey,
  hashAdminPassword,
  hashApiKey,
  isAdminPasswordHash,
  loginBackoffMs,
  normalizeApiKeyLabel,
  parseCookies,
  resolveAdminPasswordHash,
  serializeAdminCookie,
  verifyAdminPassword,
} from './adminAuth.js';

/** Deterministic entropy so key assertions do not depend on randomness. */
function fixedRandomBytes(seed) {
  let counter = 0;
  return (size) => Buffer.alloc(size, (seed + counter++) % 256);
}

function memoryStore(initial = {}) {
  let state = { version: 1, apiKeys: [], mcpEnabled: false, ...initial };
  return {
    read: () => state,
    update(mutate) {
      state = mutate(state);
      return state;
    },
  };
}

test('password hashing round-trips and rejects wrong passwords', () => {
  const hash = hashAdminPassword('correct horse battery staple');
  assert.ok(isAdminPasswordHash(hash));
  assert.equal(verifyAdminPassword('correct horse battery staple', hash), true);
  assert.equal(verifyAdminPassword('Correct horse battery staple', hash), false);
  assert.equal(verifyAdminPassword('', hash), false);
});

test('a malformed stored hash is a failed login, not a thrown error', () => {
  assert.equal(verifyAdminPassword('anything', 'not-a-hash'), false);
  assert.equal(verifyAdminPassword('anything', ''), false);
  assert.equal(verifyAdminPassword('anything', 'scrypt$1$2$3$$'), false);
  assert.equal(isAdminPasswordHash('scrypt$16384$8$1$abc'), false);
});

test('hashing an empty password is refused outright', () => {
  assert.throws(() => hashAdminPassword(''), /must not be empty/);
});

test('the credential comes from the hash first, then the plaintext, else nothing', () => {
  const hash = hashAdminPassword('a-long-enough-password');
  assert.deepEqual(resolveAdminPasswordHash({ ADMIN_PASSWORD_HASH: hash }), { hash, source: 'hash' });

  const derived = resolveAdminPasswordHash({ ADMIN_PASSWORD: 'a-long-enough-password' });
  assert.equal(derived.source, 'password');
  assert.equal(verifyAdminPassword('a-long-enough-password', derived.hash), true);

  assert.equal(resolveAdminPasswordHash({}), null);
  // An unusable ADMIN_PASSWORD_HASH must disable the console, never fall back.
  assert.equal(resolveAdminPasswordHash({ ADMIN_PASSWORD_HASH: 'garbage', ADMIN_PASSWORD: 'x' }), null);
});

test('login backoff stays flat then grows to a five-minute ceiling', () => {
  assert.equal(loginBackoffMs(0), 0);
  assert.equal(loginBackoffMs(ADMIN_LOGIN_FREE_ATTEMPTS), 0);
  assert.equal(loginBackoffMs(ADMIN_LOGIN_FREE_ATTEMPTS + 1), 1000);
  assert.equal(loginBackoffMs(ADMIN_LOGIN_FREE_ATTEMPTS + 2), 2000);
  assert.equal(loginBackoffMs(100), ADMIN_LOGIN_MAX_BACKOFF_MS);
});

test('an unconfigured console refuses every login', () => {
  const auth = createAdminAuth({ credential: null, store: memoryStore() });
  assert.equal(auth.configured, false);
  assert.deepEqual(auth.login('anything'), { ok: false, reason: 'unconfigured' });
});

test('a correct password mints a session that authenticates and expires', () => {
  let clock = 1_000;
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword('operator-password'), source: 'hash' },
    store: memoryStore(),
    now: () => clock,
    sessionTtlMs: 60_000,
  });
  const result = auth.login('operator-password');
  assert.equal(result.ok, true);
  assert.ok(auth.authenticate(result.sessionId));

  clock += 59_000;
  assert.ok(auth.authenticate(result.sessionId), 'still inside the TTL');
  clock += 2_000;
  assert.equal(auth.authenticate(result.sessionId), null, 'expired sessions stop authenticating');
  assert.equal(auth.sessionCount(), 0);
});

test('logout invalidates the session id immediately', () => {
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword('operator-password'), source: 'hash' },
    store: memoryStore(),
  });
  const { sessionId } = auth.login('operator-password');
  assert.equal(auth.logout(sessionId), true);
  assert.equal(auth.authenticate(sessionId), null);
});

test('repeated failures throttle a client while a correct password clears it', () => {
  let clock = 0;
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword('operator-password'), source: 'hash' },
    store: memoryStore(),
    now: () => clock,
  });
  for (let attempt = 0; attempt < ADMIN_LOGIN_FREE_ATTEMPTS; attempt += 1) {
    assert.equal(auth.login('wrong', { clientId: 'client-a' }).reason, 'invalid');
  }
  assert.equal(auth.login('wrong', { clientId: 'client-a' }).reason, 'invalid');
  const throttled = auth.login('operator-password', { clientId: 'client-a' });
  assert.equal(throttled.ok, false);
  assert.equal(throttled.reason, 'throttled', 'even the right password waits out the backoff');

  // A different client is unaffected by another client's failures.
  assert.equal(auth.login('operator-password', { clientId: 'client-b' }).ok, true);

  clock += 5_000;
  const recovered = auth.login('operator-password', { clientId: 'client-a' });
  assert.equal(recovered.ok, true);
  // The counter reset, so the next wrong password is free again.
  assert.equal(auth.login('wrong', { clientId: 'client-a' }).retryAfterMs, 0);
});

test('API keys are prefixed, previewed, and stored only as hashes', () => {
  const store = memoryStore();
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword('operator-password'), source: 'hash' },
    store,
    randomBytes: fixedRandomBytes(7),
  });
  const { token, record } = auth.createApiKey('  Laptop client  ');
  assert.ok(token.startsWith(ADMIN_API_KEY_PREFIX));
  assert.equal(record.label, 'Laptop client');
  assert.equal(record.preview, apiKeyPreview(token));
  assert.equal(record.token, undefined, 'the public record never carries the token');

  const stored = store.read().apiKeys[0];
  assert.equal(stored.hash, hashApiKey(token));
  assert.ok(!JSON.stringify(store.read()).includes(token), 'plaintext is never persisted');
});

test('key verification accepts a live key, stamps it, and rejects the rest', () => {
  let clock = Date.parse('2026-08-29T00:00:00.000Z');
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword('operator-password'), source: 'hash' },
    store: memoryStore(),
    randomBytes: fixedRandomBytes(11),
    now: () => clock,
  });
  const { token, record } = auth.createApiKey('client');
  assert.equal(auth.verifyApiKey(token).lastUsedAt, new Date(clock).toISOString());

  clock += 1_000;
  assert.equal(auth.verifyApiKey(token).id, record.id);
  assert.equal(auth.listApiKeys()[0].lastUsedAt, new Date(clock).toISOString());

  assert.equal(auth.verifyApiKey(''), null);
  assert.equal(auth.verifyApiKey('not-an-admin-key'), null);
  assert.equal(auth.verifyApiKey(`${ADMIN_API_KEY_PREFIX}wrong`), null);
});

test('revoking a key stops it verifying', () => {
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword('operator-password'), source: 'hash' },
    store: memoryStore(),
    randomBytes: fixedRandomBytes(3),
  });
  const { token, record } = auth.createApiKey('client');
  assert.equal(auth.revokeApiKey(record.id), true);
  assert.equal(auth.verifyApiKey(token), null);
  assert.deepEqual(auth.listApiKeys(), []);
  assert.equal(auth.revokeApiKey(record.id), false, 'revoking twice is not a second success');
});

test('the MCP switch persists through the store', () => {
  const store = memoryStore();
  const auth = createAdminAuth({
    credential: { hash: hashAdminPassword('operator-password'), source: 'hash' },
    store,
  });
  assert.equal(auth.mcpEnabled(), false);
  assert.equal(auth.setMcpEnabled(true), true);
  assert.equal(store.read().mcpEnabled, true);
  assert.equal(auth.setMcpEnabled(false), false);
});

test('key labels are bounded and stripped of control characters', () => {
  assert.equal(normalizeApiKeyLabel('  build box  '), 'build box');
  assert.equal(normalizeApiKeyLabel(''), 'MCP client');
  assert.equal(normalizeApiKeyLabel(null), 'MCP client');
  assert.equal(normalizeApiKeyLabel('a\u0000b\u001fc'), 'a b c');
  assert.equal(normalizeApiKeyLabel('x'.repeat(200)).length, 64);
});

test('generated keys are unique and long', () => {
  const first = generateApiKey();
  const second = generateApiKey();
  assert.notEqual(first, second);
  assert.ok(first.length > ADMIN_API_KEY_PREFIX.length + 40);
});

test('cookie parsing and serialization round-trip the session id', () => {
  const cookie = serializeAdminCookie('abc 123', 3600, true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=3600/);
  assert.equal(parseCookies(cookie.split(';')[0]).gev_admin_session, 'abc 123');
  assert.ok(!serializeAdminCookie('abc', 0, false).includes('Secure'));
});

test('an API key is read from either accepted header form', () => {
  assert.equal(extractApiKey({ authorization: 'Bearer key-one' }), 'key-one');
  assert.equal(extractApiKey({ authorization: 'bearer key-two' }), 'key-two');
  assert.equal(extractApiKey({ 'x-api-key': 'key-three' }), 'key-three');
  assert.equal(extractApiKey({}), '');
});
