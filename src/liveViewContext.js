import { resolveModelCapabilities } from './modelCapabilities.js';

export const LIVE_CONTEXT_LIMITS = Object.freeze({
  totalText: 6000,
  string: 500,
  array: 24,
  keys: 64,
  depth: 5,
  imageUrl: 2_000_000,
  imageBytes: 1_500_000,
  audioUrl: 1_400_000,
  audioBytes: 1_000_000,
  videoFrameBytes: 1_000_000,
  videoFrames: 4,
});

const SECRET_KEY = /(?:authorization|cookie|secret|password|passphrase|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|credential)/i;
const IMAGE_KEY = /^(?:image|imageUrl|screenshot|screenshotUrl|frame|frameUrl)$/i;
const MEDIA_KEY = /^(?:audio|audioUrl|audioData|video|videoFrames)$/i;
const SECRET_VALUE = /(?:Bearer\s+\S+|sk-or-[a-z0-9_-]+|gev_[a-z0-9_-]+)/gi;

function clean(value, limits, state, depth = 0) {
  if (depth > limits.depth || state.keys >= limits.keys) return undefined;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const text = value.replace(SECRET_VALUE, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limits.string);
    state.text += text.length;
    return state.text <= limits.totalText ? text : text.slice(0, Math.max(0, limits.totalText - (state.text - text.length)));
  }
  if (Array.isArray(value)) {
    return value.slice(0, limits.array).map((item) => clean(item, limits, state, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (state.keys >= limits.keys) break;
    if (SECRET_KEY.test(key) || IMAGE_KEY.test(key) || MEDIA_KEY.test(key) || key.startsWith('_')) continue;
    state.keys += 1;
    const next = clean(child, limits, state, depth + 1);
    if (next !== undefined) output[String(key).slice(0, 80)] = next;
  }
  return output;
}

function mediaUrl(value, kind, maxChars, maxBytes) {
  if (typeof value !== 'string') return { url: '', reason: value == null || value === '' ? '' : 'media-is-not-a-data-url' };
  const url = value.trim();
  const pattern = kind === 'audio'
    ? /^data:audio\/(?:mpeg|mp3|wav|ogg|webm);base64,[a-z0-9+/=\r\n]+$/i
    : /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i;
  if (!pattern.test(url)) return { url: '', reason: 'media-is-not-a-supported-data-url' };
  if (url.length > maxChars) return { url: '', reason: 'encoded-media-limit-exceeded' };
  const payload = (url.split(',', 2)[1] || '').replace(/\s+/g, '');
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
  if (!decodedBytes || decodedBytes > maxBytes) return { url: '', reason: 'decoded-media-limit-exceeded' };
  return { url, reason: '' };
}

function nestedValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.dataUrl || value.url || value.src || '';
  return '';
}

function collectMedia(source, limits, capabilities) {
  const screenshot = nestedValue(source.screenshot || source.image || source.frame);
  const cctv = nestedValue(source.cctv?.image || source.cctv?.frame || source.cctvImage);
  const radio = source.radio || {};
  const audio = nestedValue(radio.audio || source.audio);
  const transcript = typeof radio.transcript === 'string' ? radio.transcript : (typeof source.audioTranscript === 'string' ? source.audioTranscript : '');
  const rawFrames = source.videoFrames || source.video?.frames || [];
  const failures = [];
  for (const [mediaType, candidate] of [['screenshot', source.screenshot], ['cctv', source.cctv?.image]]) {
    if (candidate === null || candidate?.available === false) {
      failures.push({ mediaType, reason: String(candidate?.reason || 'missing').slice(0, 160) });
    }
  }
  const imageBytes = Math.min(
    Number(limits.imageBytes) || Infinity,
    Number(capabilities?.limits?.imageBytes) || Infinity,
  );
  const audioBytes = Math.min(
    Number(limits.audioBytes) || Infinity,
    Number(capabilities?.limits?.audioBytes) || Infinity,
  );
  const videoFrameBytes = Math.min(
    Number(limits.videoFrameBytes) || Infinity,
    Number(capabilities?.limits?.videoFrameBytes) || imageBytes,
  );
  const screenshotMedia = mediaUrl(screenshot, 'image', limits.imageUrl, imageBytes);
  const cctvMedia = mediaUrl(cctv, 'image', limits.imageUrl, imageBytes);
  const audioMedia = mediaUrl(audio, 'audio', limits.audioUrl, audioBytes);
  const frameMedia = (Array.isArray(rawFrames) ? rawFrames : []).slice(0, limits.videoFrames)
    .map((frame) => mediaUrl(nestedValue(frame), 'image', limits.imageUrl, videoFrameBytes));
  for (const [mediaType, candidate, result] of [
    ['screenshot', screenshot, screenshotMedia],
    ['cctv', cctv, cctvMedia],
    ['audio', audio, audioMedia],
  ]) {
    if (candidate && !result.url) failures.push({ mediaType, reason: result.reason || 'invalid-media' });
  }
  frameMedia.forEach((result, index) => {
    if (!result.url) failures.push({ mediaType: 'video', frame: index, reason: result.reason || 'invalid-media' });
  });
  return {
    images: [
      ['screenshot', screenshotMedia.url],
      ['cctv', cctvMedia.url],
    ].filter(([, url]) => url),
    audio: audioMedia.url,
    transcript: transcript.replace(SECRET_VALUE, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limits.string),
    frames: frameMedia.map((result) => result.url).filter(Boolean),
    failures,
  };
}

/**
 * Convert untrusted browser view state into bounded, redacted model content.
 * The returned content has the OpenAI typed-content shape when vision is usable.
 */
export function assembleLiveViewContext(input, {
  model = '',
  provider = '',
  limits = LIVE_CONTEXT_LIMITS,
  requiredMedia = [],
} = {}) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    return { ok: false, kind: 'invalid-context', reason: 'Live view context must be an object' };
  }
  const source = input || {};
  const context = clean(source, limits, { text: 0, keys: 0 }) || {};
  const capabilities = resolveModelCapabilities(model, provider);
  const media = collectMedia(source, limits, capabilities);
  const required = new Set(Array.isArray(requiredMedia) ? requiredMedia : [requiredMedia]);
  const available = new Set([
    ...(media.images.some(([name]) => name === 'screenshot') ? ['screenshot', 'image'] : []),
    ...(media.images.some(([name]) => name === 'cctv') ? ['cctv', 'image'] : []),
    ...(media.audio ? ['audio'] : []),
    ...(media.transcript ? ['transcript'] : []),
    ...(media.frames.length ? ['video'] : []),
  ]);
  const missing = [...required].filter((name) => name && !available.has(name));
  if (missing.length) {
    return { ok: false, kind: 'required-media-missing', reason: `Required media is missing: ${missing.join(', ')}`, mediaFailures: missing.map((mediaType) => ({ mediaType, reason: 'missing' })) };
  }
  const text = JSON.stringify({ type: 'live_view_context', context, radioTranscript: media.transcript || undefined });
  const content = [{ type: 'text', text }];
  const mediaFailures = [...media.failures];
  for (const [mediaType, url] of media.images) {
    if (capabilities.acceptsImages) content.push({ type: 'image_url', image_url: { url, detail: 'low' } });
    else mediaFailures.push({ mediaType, reason: 'model-does-not-support-images' });
  }
  if (media.audio) {
    if (capabilities.acceptsAudio) {
      const match = media.audio.match(/^data:audio\/([^;,]+);base64,(.*)$/i);
      content.push({ type: 'input_audio', input_audio: { format: match[1] === 'mpeg' ? 'mp3' : match[1], data: match[2] } });
    } else mediaFailures.push({ mediaType: 'audio', reason: 'model-does-not-support-audio' });
  }
  if (media.frames.length) {
    if (capabilities.acceptsVideo && capabilities.acceptsImages) {
      for (const url of media.frames) content.push({ type: 'image_url', image_url: { url, detail: 'low' } });
    } else mediaFailures.push({ mediaType: 'video', reason: 'transport-requires-image-frame-support' });
  }
  const unsupportedRequired = [...required].filter((name) => available.has(name)
    && mediaFailures.some((failure) => failure.mediaType === name || (name === 'image' && ['screenshot', 'cctv'].includes(failure.mediaType))));
  if (unsupportedRequired.length) {
    return { ok: false, kind: 'required-media-unsupported', reason: `Required media cannot be sent: ${unsupportedRequired.join(', ')}`, mediaFailures };
  }
  return {
    ok: true,
    kind: 'live-context',
    context,
    content,
    imageIncluded: media.images.length > 0 && capabilities.acceptsImages,
    imageOmitted: media.images.length > 0 && !capabilities.acceptsImages,
    mediaFailures,
    mediaOmissions: mediaFailures,
    capabilities,
  };
}

export const assembleLiveContext = assembleLiveViewContext;