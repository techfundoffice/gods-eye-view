import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleLiveViewContext, LIVE_CONTEXT_LIMITS } from './liveViewContext.js';

test('live context is typed, redacted, bounded, and capability aware', () => {
  const imageUrl = 'data:image/png;base64,AAAA';
  const vision = assembleLiveViewContext({
    camera: { latitude: 1, label: 'Bearer secret-value' },
    apiKey: 'do-not-send',
    screenshot: imageUrl,
  }, { model: 'google/gemini-3.8-flash' });
  assert.equal(vision.ok, true);
  assert.equal(vision.imageIncluded, true);
  assert.equal(vision.content[1].type, 'image_url');
  assert.equal(JSON.stringify(vision.context).includes('do-not-send'), false);
  assert.match(vision.context.camera.label, /\[redacted\]/);

  const text = assembleLiveViewContext({ screenshot: imageUrl }, { model: 'openrouter/free' });
  assert.equal(text.imageIncluded, false);
  assert.equal(text.imageOmitted, true);
  assert.equal(text.content.length, 1);
});

test('live context rejects non-object input with a typed failure', () => {
  assert.deepEqual(assembleLiveViewContext('bad'), {
    ok: false,
    kind: 'invalid-context',
    reason: 'Live view context must be an object',
  });
});

test('nested frontend screenshot, CCTV, audio, and video frames become typed media', () => {
  const context = assembleLiveViewContext({
    screenshot: { available: true, dataUrl: 'data:image/webp;base64,AAAA' },
    cctv: { image: { dataUrl: 'data:image/png;base64,BBBB' } },
    radio: {
      audio: { dataUrl: 'data:audio/mpeg;base64,CCCC' },
      transcript: 'Public weather bulletin',
    },
    video: { frames: [{ dataUrl: 'data:image/jpeg;base64,DDDD' }] },
  }, { model: 'google/gemini-3.8-flash' });
  assert.equal(context.ok, true);
  assert.equal(context.content.filter((part) => part.type === 'image_url').length, 3);
  assert.equal(context.content.some((part) => part.type === 'input_audio'), true);
  assert.match(context.content[0].text, /Public weather bulletin/);
  assert.deepEqual(context.mediaFailures, []);
});

test('text-only models explicitly omit optional media and fail required media', () => {
  const input = { screenshot: { dataUrl: 'data:image/png;base64,AAAA' } };
  const omitted = assembleLiveViewContext(input, { model: 'openrouter/free' });
  assert.equal(omitted.ok, true);
  assert.deepEqual(omitted.mediaFailures, [{ mediaType: 'screenshot', reason: 'model-does-not-support-images' }]);
  const requiredUnsupported = assembleLiveViewContext(input, {
    model: 'openrouter/free', requiredMedia: ['screenshot'],
  });
  assert.equal(requiredUnsupported.kind, 'required-media-unsupported');
  const missing = assembleLiveViewContext({}, {
    model: 'google/gemini-3.8-flash', requiredMedia: ['audio'],
  });
  assert.equal(missing.kind, 'required-media-missing');
});

test('media limits are enforced against decoded bytes and reported explicitly', () => {
  const result = assembleLiveViewContext({
    screenshot: `data:image/png;base64,${Buffer.alloc(12).toString('base64')}`,
  }, {
    model: 'google/gemini-2.5-flash',
    limits: {
      ...LIVE_CONTEXT_LIMITS,
      imageBytes: 8,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.content.some((part) => part.type === 'image_url'), false);
  assert.equal(result.mediaFailures.some((failure) => (
    failure.mediaType === 'screenshot' && failure.reason === 'decoded-media-limit-exceeded'
  )), true);
});