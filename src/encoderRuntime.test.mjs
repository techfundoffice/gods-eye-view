import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEncoderRuntimeEnv, discoverEncoderRuntime } from './encoderRuntime.js';

test('explicit CHROME_PATH and FFMPEG_PATH win over fallbacks', () => {
  const env = {
    CHROME_PATH: '/opt/chrome/chrome',
    FFMPEG_PATH: '/opt/ffmpeg/ffmpeg',
    PATH: '/usr/bin',
  };
  const found = discoverEncoderRuntime({
    env,
    exists: (file) => file === '/opt/chrome/chrome' || file === '/opt/ffmpeg/ffmpeg',
  });
  assert.equal(found.chromium, '/opt/chrome/chrome');
  assert.equal(found.ffmpeg, '/opt/ffmpeg/ffmpeg');
});

test('applyEncoderRuntimeEnv fills unset paths from PATH without overwriting', () => {
  const env = { PATH: '/usr/bin:/usr/local/bin' };
  const applied = applyEncoderRuntimeEnv({
    env,
    exists: (file) => file === '/usr/bin/chromium' || file === '/usr/bin/ffmpeg',
  });
  assert.equal(applied.chromium, '/usr/bin/chromium');
  assert.equal(applied.ffmpeg, '/usr/bin/ffmpeg');
  assert.equal(env.CHROME_PATH, '/usr/bin/chromium');
  assert.equal(env.FFMPEG_PATH, '/usr/bin/ffmpeg');

  const locked = { CHROME_PATH: '/already/chrome', FFMPEG_PATH: '/already/ffmpeg', PATH: '/usr/bin' };
  applyEncoderRuntimeEnv({
    env: locked,
    exists: () => true,
  });
  assert.equal(locked.CHROME_PATH, '/already/chrome');
  assert.equal(locked.FFMPEG_PATH, '/already/ffmpeg');
});
