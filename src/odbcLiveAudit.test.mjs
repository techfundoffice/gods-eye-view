import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditRecordLooksSecret,
  describeOdbcPersistence,
  recordLiveAuditEvent,
  redactLiveAuditRecord,
} from './odbcLiveAudit.js';

test('redacted audit records never include stream keys or tokens', () => {
  const record = redactLiveAuditRecord({
    event: 'live',
    live: {
      status: 'live',
      framesSent: 12,
      target: 'rtmps://a.rtmp.youtube.com/live2/***',
      broadcast: { id: 'abc', watchUrl: 'https://www.youtube.com/watch?v=abc' },
      phases: { youtube: { ready: true } },
      streamKey: 'abcd-1234-efgh-5678',
    },
  });
  assert.equal(record.status, 'live');
  assert.equal(record.broadcastId, 'abc');
  assert.equal('streamKey' in record, false);
  assert.equal(auditRecordLooksSecret(record), false);
  assert.equal(auditRecordLooksSecret({ streamKey: 'abcd-1234-efgh-5678' }), true);
});

test('ODBC readiness degrades without a driver or DSN', () => {
  assert.equal(describeOdbcPersistence({ env: {} }).available, false);
  assert.match(describeOdbcPersistence({ env: {} }).message, /not configured/);
  const dsnOnly = describeOdbcPersistence({
    env: { ODBC_CONNECTION_STRING: 'DSN=gev' },
    driverAvailable: false,
  });
  assert.equal(dsnOnly.available, false);
  assert.match(dsnOnly.message, /no ODBC driver/);
});

test('audit writes are skipped when ODBC is unavailable and never throw', async () => {
  const result = await recordLiveAuditEvent({ live: { status: 'live', broadcast: { id: 'x' } } });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);

  let wrote = null;
  const ok = await recordLiveAuditEvent(
    { live: { status: 'stopped', broadcast: { id: 'x' } } },
    { connect: async (record) => { wrote = record; return { ok: true }; } },
  );
  assert.equal(ok.ok, true);
  assert.equal(wrote.status, 'stopped');
});
