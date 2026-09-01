/**
 * `ffmpeg` live-streaming control for the operator YouTube panel and the
 * ADMIN console.
 *
 * The globe is a WebGL canvas, so there is no camera or file to push: this
 * module drives a headless Chromium at the running app, pulls composited
 * frames over the DevTools screencast API, and pipes them into ffmpeg for
 * H.264/RTMP delivery to YouTube Live (or any RTMP ingest).
 *
 * Screencast frames arrive only when the page repaints, which is variable
 * rate; RTMP wants constant rate. The controller therefore holds the most
 * recent frame and a fixed-cadence ticker writes it to ffmpeg, so the encoder
 * always sees a steady clock even when the globe is momentarily still.
 *
 * The stream key is a bearer credential. It is never returned by the status
 * route, never logged, and is scrubbed from ffmpeg output before it is stored.
 *
 * @module liveStream
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';

/** Encoder defaults tuned for a software-rendered globe on a shared host. */
export const LIVE_DEFAULTS = Object.freeze({
  width: 1280,
  height: 720,
  fps: 30,
  videoBitrateKbps: 4500,
  audioBitrateKbps: 128,
  gopSeconds: 2,
  quality: 80,
});

/** ffmpeg speaks dozens of protocols; an ingest target may only be RTMP. */
export const LIVE_ALLOWED_INGEST_PROTOCOLS = Object.freeze(['rtmp:', 'rtmps:']);

/** Bounds that keep a console typo from pinning the host's CPU. */
export const LIVE_BOUNDS = Object.freeze({
  width: [640, 1920],
  height: [360, 1080],
  fps: [1, 60],
  videoBitrateKbps: [300, 12_000],
  audioBitrateKbps: [64, 320],
  quality: [30, 100],
});

/** Lines of ffmpeg output retained for the console. */
export const LIVE_MAX_LOG_LINES = 60;

/** Chromium navigation wait — `networkidle2` never settles on a polling globe. */
export const LIVE_CAPTURE_WAIT_UNTIL = 'domcontentloaded';

/** Selector that means the globe surface (or at least its container) is present. */
export const LIVE_CAPTURE_CANVAS_SELECTOR = '#cesiumContainer canvas';

/** Public statuses the encoder itself reports. Session layer may promote these. */
export const LIVE_ENCODER_STATUSES = Object.freeze([
  'idle',
  'starting',
  'encoding',
  'stopped',
  'error',
]);

/** Statuses that mean a start is already in flight or publishing. */
export const LIVE_ACTIVE_STATUSES = Object.freeze([
  'starting',
  'encoding',
  'ingesting',
  'waiting-for-youtube',
  'live',
  'stopping',
]);

const REDACTED = '***';

/**
 * Whether a controller/session status should refuse a *different* start.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isActiveLiveStatus(status) {
  return LIVE_ACTIVE_STATUSES.includes(String(status || ''));
}

/**
 * Clamp one numeric option into its supported range.
 *
 * @param {string} name Option name, used for the bounds lookup and errors.
 * @param {*} value Raw value from the console.
 * @param {number} fallback Default when the value is absent.
 * @returns {number}
 */
export function boundedOption(name, value, fallback) {
  const bounds = LIVE_BOUNDS[name];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  const rounded = Math.round(parsed);
  if (!bounds) return rounded;
  const [min, max] = bounds;
  if (rounded < min || rounded > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return rounded;
}

/**
 * Validate an RTMP ingest address and join it to the stream key.
 *
 * Keeping the key out of the stored URL means the console can show operators
 * where they are publishing without ever showing the credential.
 *
 * @param {string} ingestUrl RTMP ingest address, e.g. rtmp://a.rtmp.youtube.com/live2
 * @param {string} streamKey YouTube stream name/key.
 * @returns {{display: string, target: string, host: string}}
 */
export function normalizeIngestTarget(ingestUrl, streamKey) {
  const raw = String(ingestUrl || '').trim();
  if (!raw) throw new Error('An RTMP ingest URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('The ingest URL is not a valid URL');
  }
  if (!LIVE_ALLOWED_INGEST_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error('Only rtmp:// and rtmps:// ingest URLs are allowed');
  }
  const key = String(streamKey || '').trim();
  if (!key) throw new Error('A stream key is required');
  if (/[\s'"]/.test(key)) throw new Error('The stream key contains invalid characters');
  const suffixIndex = raw.search(/[?#]/);
  const base = (suffixIndex >= 0 ? raw.slice(0, suffixIndex) : raw).replace(/\/+$/, '');
  const suffix = suffixIndex >= 0 ? raw.slice(suffixIndex) : '';
  return {
    display: `${base}/${REDACTED}${suffix}`,
    target: `${base}/${key}${suffix}`,
    host: parsed.host,
  };
}

/**
 * Split a YouTube Studio paste that may be a bare stream key or a full
 * `rtmp(s)://…/live2/<key>` URL. Studio's copy button often yields the latter.
 *
 * @param {string} raw Pasted key or ingest URL.
 * @param {string} [fallbackIngestUrl]
 * @returns {{ingestUrl: string, streamKey: string}}
 */
export function splitYoutubeIngestPaste(raw, fallbackIngestUrl = 'rtmps://a.rtmp.youtube.com/live2') {
  const text = String(raw || '').trim();
  const fallback = String(fallbackIngestUrl || 'rtmps://a.rtmp.youtube.com/live2').trim();
  if (!text) return { ingestUrl: fallback, streamKey: '' };

  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  const token = firstLine.split(/\s+/)[0] || '';
  if (/^rtmps?:\/\//i.test(token)) {
    let parsed;
    try {
      parsed = new URL(token);
    } catch {
      return { ingestUrl: fallback, streamKey: firstLine };
    }
    if (!LIVE_ALLOWED_INGEST_PROTOCOLS.includes(parsed.protocol)) {
      return { ingestUrl: fallback, streamKey: firstLine };
    }
    const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length >= 2) {
      return {
        ingestUrl: `${parsed.protocol}//${parsed.host}/${parts.slice(0, -1).join('/')}`,
        streamKey: parts[parts.length - 1],
      };
    }
    const rest = text.slice(text.indexOf(firstLine) + firstLine.length).trim().split(/\s+/)[0] || '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return {
      ingestUrl: `${parsed.protocol}//${parsed.host}${path}`,
      streamKey: rest,
    };
  }
  return { ingestUrl: fallback, streamKey: firstLine.split(/\s+/)[0] || text };
}

/**
 * Validate an optional audio bed for the broadcast.
 *
 * ffmpeg will happily open `concat:`, `file:`, and a dozen other protocols, so
 * a source is either a local file that exists or a plain http(s) URL — the same
 * narrowing the ingest URL gets.
 *
 * @param {string} value Local path or http(s) URL; empty means silence.
 * @param {(path: string) => boolean} [exists] File-existence probe.
 * @returns {string|null} Normalized source, or null for a silent stream.
 */
export function normalizeAudioSource(value, exists = existsSync) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('The audio source is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('The audio source must be a local file or an http(s) URL');
    }
    return raw;
  }
  if (!exists(raw)) throw new Error(`No audio file at ${raw}`);
  return raw;
}

/**
 * Remove a stream key from text before it is stored or shown.
 *
 * @param {string} text Raw text, typically an ffmpeg log line.
 * @param {string} streamKey Key to scrub.
 * @returns {string}
 */
export function redactStreamKey(text, streamKey) {
  const line = String(text ?? '');
  const key = String(streamKey || '').trim();
  if (!key) return line;
  return line.split(key).join(REDACTED);
}

/**
 * Validate and normalize the console's start request.
 *
 * @param {object} input Raw request body.
 * @returns {object} Normalized options with an ingest target.
 */
export function normalizeLiveOptions(input = {}) {
  const options = {
    width: boundedOption('width', input.width, LIVE_DEFAULTS.width),
    height: boundedOption('height', input.height, LIVE_DEFAULTS.height),
    fps: boundedOption('fps', input.fps, LIVE_DEFAULTS.fps),
    videoBitrateKbps: boundedOption('videoBitrateKbps', input.videoBitrateKbps, LIVE_DEFAULTS.videoBitrateKbps),
    audioBitrateKbps: boundedOption('audioBitrateKbps', input.audioBitrateKbps, LIVE_DEFAULTS.audioBitrateKbps),
    quality: boundedOption('quality', input.quality, LIVE_DEFAULTS.quality),
    gopSeconds: LIVE_DEFAULTS.gopSeconds,
  };
  // Even dimensions only: libx264 with yuv420p cannot encode odd sizes.
  options.width -= options.width % 2;
  options.height -= options.height % 2;

  const captureUrl = normalizeCaptureUrl(
    String(input.captureUrl || '').trim() || 'http://localhost:5000/',
  );

  const extraHeaders = input.extraHeaders && typeof input.extraHeaders === 'object'
    ? { ...input.extraHeaders }
    : null;
  const hostResolverRules = String(input.hostResolverRules || '').trim() || null;

  return {
    ...options,
    captureUrl,
    extraHeaders,
    hostResolverRules,
    audioSource: normalizeAudioSource(input.audioSource),
    ingest: normalizeIngestTarget(input.ingestUrl, input.streamKey),
    streamKey: String(input.streamKey || '').trim(),
  };
}

/**
 * Normalize an http(s) capture URL. File, concat, and other ffmpeg protocols
 * are refused so the capture browser cannot be pointed at the host filesystem.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeCaptureUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('A capture URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('The capture URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The capture URL must be http or https');
  }
  return parsed.toString();
}

/**
 * Public origin of the incoming request, used when the console did not pick a
 * capture URL. Replit preview hosts win over loopback so Chromium loads the
 * same origin the operator is looking at.
 *
 * @param {object} [req] Node request.
 * @param {object} [env]
 * @returns {string}
 */
export function publicOriginFromRequest(req = null, env = process.env) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim();
  const proto = forwardedProto || (String(env.NODE_ENV || '') === 'production' ? 'https' : 'http');
  if (forwardedHost) {
    try {
      const origin = new URL(`${proto}://${forwardedHost}`).origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) {
        return `${origin}/`;
      }
      if (origin) {
        const replit = replitPublicOrigin(env);
        if (replit) return replit;
        return `${origin}/`;
      }
    } catch {
      // Invalid Host header — fall through to Replit / loopback.
    }
  }
  const replit = replitPublicOrigin(env);
  if (replit) return replit;
  const port = String(env.PORT || '5000').trim() || '5000';
  return `http://127.0.0.1:${port}/`;
}

/**
 * @param {object} [env]
 * @returns {string} `https://<domain>/` or empty.
 */
export function replitPublicOrigin(env = process.env) {
  const domain = String(env.REPLIT_DEV_DOMAIN || '').trim()
    || String(env.REPLIT_DOMAINS || '').split(',')[0].trim();
  if (!domain) return '';
  const host = domain.replace(/^https?:\/\//i, '').split('/')[0];
  return host ? `https://${host}/` : '';
}

/**
 * Pick the URL Chromium should open.
 *
 * Priority: `LIVE_CAPTURE_URL` → operator-requested http(s) → request origin →
 * Replit public domain → loopback on `PORT`.
 *
 * @param {object} [input]
 * @param {string} [input.requested]
 * @param {object|null} [input.req]
 * @param {object} [input.env]
 * @returns {string}
 */
export function resolveLiveCaptureTarget({ requested = '', req = null, env = process.env } = {}) {
  const explicit = String(env.LIVE_CAPTURE_URL || '').trim();
  if (explicit) return normalizeCaptureUrl(explicit);
  const fromForm = String(requested || '').trim();
  if (fromForm) return normalizeCaptureUrl(fromForm);
  return normalizeCaptureUrl(publicOriginFromRequest(req, env));
}

/**
 * Extra Chromium flags / headers so a Replit public host resolves to this
 * process instead of stalling on the outer proxy.
 *
 * @param {string} captureUrl
 * @param {object} [env]
 * @returns {{hostResolverRules: string|null, extraHeaders: object|null, loopbackUrl: string|null, publicHost: string|null}}
 */
export function chromiumCaptureHints(captureUrl, env = process.env) {
  const empty = {
    hostResolverRules: null,
    extraHeaders: null,
    loopbackUrl: null,
    publicHost: null,
  };
  let parsed;
  try {
    parsed = new URL(captureUrl);
  } catch {
    return empty;
  }
  const replitOrigin = replitPublicOrigin(env);
  if (!replitOrigin) return empty;
  const publicHost = new URL(replitOrigin).hostname;
  const port = String(env.PORT || '5000').trim() || '5000';
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.hostname !== publicHost && !local) return empty;
  return {
    hostResolverRules: `MAP ${publicHost} 127.0.0.1`,
    extraHeaders: { Host: publicHost },
    loopbackUrl: `http://127.0.0.1:${port}/`,
    publicHost,
  };
}

/**
 * Chromium must open the HTTP loopback URL on this process. Mapping the
 * public HTTPS host to 127.0.0.1 still uses port 443 and fails with
 * net::ERR_INVALID_ARGUMENT.
 *
 * @param {string} captureUrl
 * @param {object} [hints] From {@link chromiumCaptureHints}
 * @returns {{captureUrl: string, hostResolverRules: string|null, extraHeaders: object|null}}
 */
export function encoderCaptureFromHints(captureUrl, hints = null) {
  const loopback = String(hints?.loopbackUrl || '').trim();
  if (loopback) {
    return {
      captureUrl: loopback,
      hostResolverRules: null,
      extraHeaders: null,
    };
  }
  return {
    captureUrl,
    hostResolverRules: hints?.hostResolverRules || null,
    extraHeaders: hints?.extraHeaders || null,
  };
}

/**
 * GET-probe a capture URL so we fail before spawning Chromium.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.headers]
 * @returns {Promise<{url: string, status: number}>}
 */
export async function probeCaptureUrl(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  headers = undefined,
} = {}) {
  const target = normalizeCaptureUrl(url);
  if (typeof fetchImpl !== 'function') {
    throw new Error('Capture URL is not reachable from this server: fetch is unavailable');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: headers && typeof headers === 'object' ? headers : undefined,
    });
    if (!response.ok) {
      throw new Error(`Capture URL is not reachable from this server: HTTP ${response.status}`);
    }
    return { url: target, status: response.status };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Capture URL is not reachable from this server: timed out');
    }
    if (/Capture URL is not reachable/.test(error?.message || '')) throw error;
    throw new Error(`Capture URL is not reachable from this server: ${error?.message || 'request failed'}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map an ffmpeg stderr line to an operator-facing ingest failure, or null when
 * the line is ordinary encoder chatter.
 *
 * @param {string} line
 * @returns {string|null}
 */
export function classifyFfmpegLine(line) {
  const text = String(line || '').toLowerCase();
  if (!text) return null;
  if (/403|invalid (stream|key|app)|unknown app|authentication failed|error number -1007/.test(text)) {
    return 'YouTube rejected the RTMP key; create or select the broadcast again';
  }
  if (/connection refused|failed to (open|connect)|cannot open|unknown host|name or service not known/.test(text)) {
    return 'Encoder could not reach the RTMP ingest host';
  }
  if (/broken pipe|connection reset|end of file|server close|error number -32/.test(text)) {
    return 'RTMP ingest disconnected';
  }
  if (/error while opening encoder|unknown encoder|cannot find.*aac|libx264/.test(text) && /error|unknown|cannot/.test(text)) {
    return 'ffmpeg could not encode H.264/AAC for YouTube ingest';
  }
  return null;
}

/**
 * Build the ffmpeg argument vector for a live push.
 *
 * Video arrives as a JPEG stream on stdin. YouTube requires an audio track on
 * every ingest, so a silent stereo AAC source is synthesized when no bed is
 * given. `-shortest` is only used with a looping bed: both the JPEG pipe and
 * `anullsrc` are infinite, and `-shortest` can make ffmpeg exit before a GOP.
 *
 * @param {object} options Normalized options from {@link normalizeLiveOptions}.
 * @returns {string[]}
 */
export function buildFfmpegArgs(options) {
  if (!options?.ingest?.target) {
    throw new Error('An RTMP ingest URL is required');
  }
  const gop = Math.max(1, options.fps * options.gopSeconds);
  const hasBed = Boolean(options.audioSource);
  const audioInput = hasBed
    ? ['-re', '-stream_loop', '-1', '-i', options.audioSource]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
  if (!audioInput.includes('-i')) {
    throw new Error('YouTube ingest requires an AAC audio track');
  }
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-re',
    '-f', 'image2pipe',
    '-framerate', String(options.fps),
    '-i', 'pipe:0',
    ...audioInput,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-r', String(options.fps),
    '-b:v', `${options.videoBitrateKbps}k`,
    '-maxrate', `${options.videoBitrateKbps}k`,
    '-bufsize', `${options.videoBitrateKbps * 2}k`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`,
    '-c:a', 'aac',
    '-b:a', `${options.audioBitrateKbps}k`,
    '-ar', '44100',
    '-ac', '2',
    ...(hasBed ? ['-shortest'] : []),
    '-f', 'flv',
    options.ingest.target,
  ];
}

/**
 * Chromium flags for capturing a WebGL globe with no GPU present.
 *
 * @param {object} options Normalized options.
 * @returns {string[]}
 */
export function buildChromiumArgs(options) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    // No /dev/dri on a shared host: force the software rasterizer explicitly
    // rather than letting Chromium fall back to a blank canvas.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    `--window-size=${options.width},${options.height}`,
  ];
  const rules = String(options.hostResolverRules || '').trim();
  if (rules) args.push(`--host-resolver-rules=${rules}`);
  return args;
}

/**
 * Navigate the capture page: wait for DOM, then the globe canvas, with a
 * bounded fallback so ADMIN chrome still captures when WebGL never comes up.
 *
 * @param {object} page Puppeteer page.
 * @param {object} options Normalized live options.
 * @returns {Promise<void>}
 */
export async function prepareCapturePage(page, options) {
  if (options?.extraHeaders && typeof page.setExtraHTTPHeaders === 'function') {
    await page.setExtraHTTPHeaders(options.extraHeaders);
  }
  await page.goto(options.captureUrl, {
    waitUntil: LIVE_CAPTURE_WAIT_UNTIL,
    timeout: 60_000,
  });
  if (typeof page.waitForSelector !== 'function') return;
  try {
    await page.waitForSelector(LIVE_CAPTURE_CANVAS_SELECTOR, { timeout: 15_000 });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Whether a path is present and executable by this process.
 *
 * @param {string} candidate Absolute path to test.
 * @returns {boolean}
 */
export function isExecutableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a Chromium binary without pinning a store path.
 *
 * `CHROME_PATH` wins; otherwise PATH is searched for the usual binary names.
 *
 * @param {object} [env] Environment to read.
 * @param {(path: string) => boolean} [exists] Executable probe, injected in tests.
 * @returns {string|null}
 */
export function resolveChromiumPath(env = process.env, exists = isExecutableFile) {
  const explicit = String(env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (explicit) return explicit;
  const names = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome'];
  const dirs = String(env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = `${dir}/${name}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Locate an ffmpeg binary without pinning a store path.
 *
 * `FFMPEG_PATH` wins when it is a real executable path; a bare command name
 * (or an empty value) is looked up on PATH.
 *
 * @param {object} [env] Environment to read.
 * @param {(path: string) => boolean} [exists] Executable probe, injected in tests.
 * @returns {string|null}
 */
export function resolveFfmpegPath(env = process.env, exists = isExecutableFile) {
  const explicit = String(env.FFMPEG_PATH || '').trim();
  if (explicit && (explicit.includes('/') || explicit.startsWith('.'))) {
    return exists(explicit) ? explicit : null;
  }
  const name = explicit || 'ffmpeg';
  const dirs = String(env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = `${dir}/${name}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Public, credential-free view of the controller for the console.
 *
 * @param {object} state Internal controller state.
 * @returns {object}
 */
export function describeLiveState(state) {
  return {
    status: state.status,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    framesSent: state.framesSent,
    framesDropped: state.framesDropped || 0,
    target: state.target,
    captureUrl: state.captureUrl,
    settings: state.settings,
    error: state.error,
    log: state.log.slice(-LIVE_MAX_LOG_LINES),
  };
}

/**
 * Launch headless Chromium and expose a frame source.
 *
 * Kept behind an injectable seam so the controller can be tested without a
 * browser or an encoder present.
 *
 * @param {{executablePath: string, args: string[], options: object}} config
 * @returns {Promise<{startScreencast: Function, refresh: Function, close: Function}>}
 */
async function defaultLaunchBrowser({ executablePath, args, options }) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    executablePath,
    args,
    headless: true,
    defaultViewport: { width: options.width, height: options.height },
  });
  const page = await browser.newPage();
  try {
    await prepareCapturePage(page, options);
  } catch (error) {
    await browser.close().catch(() => {});
    const reason = error?.message || 'navigation failed';
    throw new Error(`Capture page did not load a usable globe surface: ${reason}`);
  }
  const client = await page.createCDPSession();
  return {
    async startScreencast(onFrame) {
      client.on('Page.screencastFrame', ({ data, sessionId }) => {
        onFrame(Buffer.from(data, 'base64'));
        // Chromium withholds the next frame until the last is acknowledged.
        client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: options.quality,
        maxWidth: options.width,
        maxHeight: options.height,
        everyNthFrame: 1,
      });
    },
    async refresh() {
      await page.reload({
        waitUntil: LIVE_CAPTURE_WAIT_UNTIL,
        timeout: 60_000,
      });
      if (typeof page.waitForSelector === 'function') {
        try {
          await page.waitForSelector(LIVE_CAPTURE_CANVAS_SELECTOR, { timeout: 15_000 });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    },
    async close() {
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Create the single live-stream controller backing `/api/youtube/live` and
 * `/api/admin/live`.
 *
 * Only one broadcast runs at a time: a second start while live is refused
 * rather than silently replacing the first. A missing ffmpeg or capture
 * binary is an error state, not a silent "live".
 *
 * @param {object} [deps] Injectable dependencies.
 * @returns {{start: Function, refresh: Function, stop: Function, status: Function}}
 */
export function createLiveStreamController({
  spawn = nodeSpawn,
  launchBrowser = defaultLaunchBrowser,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  chromiumPath = null,
  resolveFfmpeg = null,
  probeCapture = null,
  shutdownGraceMs = 4000,
  now = () => Date.now(),
} = {}) {
  const state = {
    status: 'idle',
    startedAt: 0,
    framesSent: 0,
    framesDropped: 0,
    target: '',
    captureUrl: '',
    settings: null,
    error: null,
    log: [],
    ingestFingerprint: '',
  };
  let browser = null;
  let ffmpeg = null;
  let ticker = null;
  let lastFrame = null;
  let writable = true;
  let warnedBackpressure = false;
  let streamKey = '';
  let generation = 0;

  /**
   * @param {string} line Text to record, with the stream key scrubbed.
   * @returns {void}
   */
  function log(line) {
    for (const part of redactStreamKey(line, streamKey).split(/\r?\n/)) {
      const text = part.trim();
      if (!text) continue;
      state.log.push(`${new Date(now()).toISOString()} ${text}`);
    }
    if (state.log.length > LIVE_MAX_LOG_LINES) {
      state.log.splice(0, state.log.length - LIVE_MAX_LOG_LINES);
    }
  }

  /**
   * Tear down the browser, encoder, and ticker regardless of who failed.
   *
   * @returns {Promise<void>}
   */
  async function teardown() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (browser) {
      const closing = browser;
      browser = null;
      await closing.close().catch(() => {});
    }
    if (ffmpeg) {
      const encoder = ffmpeg;
      ffmpeg = null;
      // Closing stdin is the graceful signal: ffmpeg drains its queue and
      // writes the RTMP trailer. Signalling immediately would truncate that,
      // so SIGKILL is only a backstop for an encoder that will not exit.
      try { encoder.stdin?.end(); } catch { /* already gone */ }
      const backstop = setTimeout(() => {
        try { encoder.kill?.('SIGKILL'); } catch { /* already reaped */ }
      }, shutdownGraceMs);
      backstop.unref?.();
      encoder.once?.('exit', () => clearTimeout(backstop));
    }
    lastFrame = null;
    writable = true;
    warnedBackpressure = false;
  }

  /**
   * @param {object} options
   * @returns {string}
   */
  function fingerprint(options) {
    return `${options.ingest.target}|${options.captureUrl}|${options.width}x${options.height}@${options.fps}`;
  }

  /**
   * Begin a broadcast.
   *
   * Encoder success is `encoding`, not `live`. YouTube confirmation lives in
   * the session layer so this process cannot claim a broadcast YouTube has
   * not seen.
   *
   * @param {object} input Raw console body.
   * @returns {Promise<object>} Public state.
   */
  async function start(input) {
    const options = normalizeLiveOptions(input);
    const finger = fingerprint(options);
    if (isActiveLiveStatus(state.status)) {
      if (state.ingestFingerprint === finger) return describeLiveState(state);
      const error = new Error('A broadcast is already running. Stop it before starting another.');
      error.status = 409;
      throw error;
    }

    const myGen = generation + 1;
    generation = myGen;
    streamKey = options.streamKey;
    let pendingIngestError = '';
    state.status = 'starting';
    state.startedAt = now();
    state.framesSent = 0;
    state.framesDropped = 0;
    state.target = options.ingest.display;
    state.captureUrl = options.captureUrl;
    state.error = null;
    state.log = [];
    state.ingestFingerprint = finger;
    state.settings = {
      width: options.width,
      height: options.height,
      fps: options.fps,
      videoBitrateKbps: options.videoBitrateKbps,
      audioBitrateKbps: options.audioBitrateKbps,
      gopSeconds: options.gopSeconds,
      audioSource: options.audioSource ? 'track' : 'silent',
    };

    const stillCurrent = () => myGen === generation;

    try {
      const encoderBin = typeof resolveFfmpeg === 'function'
        ? resolveFfmpeg()
        : resolveFfmpegPath({ ...process.env, FFMPEG_PATH: ffmpegPath });
      if (!encoderBin) {
        throw new Error('No ffmpeg binary found. Install ffmpeg or set FFMPEG_PATH to an ffmpeg executable.');
      }
      const executablePath = chromiumPath || resolveChromiumPath();
      if (!executablePath) {
        throw new Error('No Chromium binary found. Set CHROME_PATH to a Chromium or Chrome executable.');
      }

      const probe = probeCapture === null ? probeCaptureUrl : probeCapture;
      if (typeof probe === 'function') {
        await probe(options.captureUrl, {
          headers: options.extraHeaders || undefined,
        });
      }
      if (!stillCurrent()) return describeLiveState(state);

      log(`Capturing ${options.captureUrl} at ${options.width}x${options.height}@${options.fps}`);
      log(`Publishing to ${options.ingest.display}`);

      ffmpeg = spawn(encoderBin, buildFfmpegArgs(options), { stdio: ['pipe', 'ignore', 'pipe'] });
      ffmpeg.stderr?.on('data', (chunk) => {
        const raw = String(chunk);
        log(raw);
        const classified = classifyFfmpegLine(raw);
        if (classified) pendingIngestError = classified;
      });
      ffmpeg.stdin?.on('error', () => { writable = false; });
      ffmpeg.stdin?.on('drain', () => { writable = true; });
      ffmpeg.on('error', (error) => {
        if (!stillCurrent()) return;
        state.error = redactStreamKey(`ffmpeg failed to start: ${error.message}`, streamKey);
        state.status = 'error';
        state.ingestFingerprint = '';
        teardown();
      });
      ffmpeg.on('exit', (code) => {
        if (!stillCurrent()) return;
        if (!isActiveLiveStatus(state.status)) return;
        state.status = 'error';
        state.ingestFingerprint = '';
        const classified = pendingIngestError;
        state.error = classified
          ? `Encoder disconnected (code ${code}): ${classified}`
          : `Encoder disconnected (code ${code}).`;
        teardown();
      });

      browser = await launchBrowser({
        executablePath,
        args: buildChromiumArgs(options),
        options,
      });
      if (!stillCurrent()) {
        await teardown();
        return describeLiveState(state);
      }
      await browser.startScreencast((frame) => { lastFrame = frame; });
      if (!stillCurrent()) {
        await teardown();
        return describeLiveState(state);
      }

      // Constant-rate pacing: RTMP wants a steady clock, screencast frames do
      // not arrive on one. Re-sending the newest frame keeps the encoder fed.
      ticker = setInterval(() => {
        if (!stillCurrent() || !ffmpeg?.stdin || !lastFrame) return;
        if (!writable) {
          state.framesDropped += 1;
          if (!warnedBackpressure) {
            warnedBackpressure = true;
            log('Encoder backpressure: dropping frames until stdin drains');
          }
          return;
        }
        writable = ffmpeg.stdin.write(lastFrame);
        state.framesSent += 1;
      }, Math.max(1, Math.round(1000 / options.fps)));
      ticker.unref?.();

      state.status = 'encoding';
      log('Encoder running.');
    } catch (error) {
      if (!stillCurrent()) return describeLiveState(state);
      state.status = 'error';
      state.ingestFingerprint = '';
      state.error = redactStreamKey(error?.message || 'Live stream failed to start', streamKey);
      await teardown();
    }
    return describeLiveState(state);
  }

  /**
   * End the broadcast.
   *
   * @returns {Promise<object>} Public state.
   */
  async function stop() {
    generation += 1;
    if (state.status === 'idle' || state.status === 'stopped') return describeLiveState(state);
    state.status = 'stopped';
    state.ingestFingerprint = '';
    await teardown();
    log('Broadcast stopped.');
    return describeLiveState(state);
  }

  /**
   * Reload only the capture page. FFmpeg keeps receiving the most recent frame
   * during navigation, so YouTube stays on the same ingest and watch URL.
   *
   * @returns {Promise<object>} Public state.
   */
  async function refresh() {
    if (!isActiveLiveStatus(state.status) || !browser || typeof browser.refresh !== 'function') {
      const error = new Error('No active capture browser is available to refresh.');
      error.status = 409;
      throw error;
    }
    log('Refreshing the live capture with the latest app version.');
    try {
      await browser.refresh();
      log('Live capture refreshed. YouTube ingest was not restarted.');
      return describeLiveState(state);
    } catch (error) {
      const message = error?.message || 'capture reload failed';
      log(`Live capture refresh failed: ${message}`);
      const failure = new Error(`Unable to refresh the live capture: ${message}`);
      failure.status = 502;
      throw failure;
    }
  }

  return {
    start,
    refresh,
    stop,
    status: () => describeLiveState(state),
  };
}

/**
 * Whether ffmpeg and a capture browser are present, for the ADMIN readiness row.
 *
 * @param {object} [input]
 * @param {object} [input.env]
 * @param {string|null} [input.ffmpegPath]
 * @param {string|null} [input.chromiumPath]
 * @param {(path: string) => boolean} [input.exists]
 * @returns {{ready: boolean, message: string, ffmpeg: boolean, chromium: boolean}}
 */
export function describeEncoderReadiness({
  env = process.env,
  ffmpegPath = env.FFMPEG_PATH || 'ffmpeg',
  chromiumPath = null,
  exists = isExecutableFile,
} = {}) {
  const ffmpeg = resolveFfmpegPath({ ...env, FFMPEG_PATH: ffmpegPath }, exists);
  const chromium = chromiumPath || resolveChromiumPath(env, exists);
  const haveFfmpeg = Boolean(ffmpeg);
  const haveChromium = Boolean(chromium);
  let message = 'ffmpeg and Chromium are available';
  if (!haveFfmpeg && !haveChromium) {
    message = 'No ffmpeg or Chromium binary found. Install them or set FFMPEG_PATH and CHROME_PATH.';
  } else if (!haveFfmpeg) {
    message = 'No ffmpeg binary found. Install ffmpeg or set FFMPEG_PATH to an ffmpeg executable.';
  } else if (!haveChromium) {
    message = 'No Chromium binary found. Set CHROME_PATH to a Chromium or Chrome executable.';
  }
  return {
    ready: haveFfmpeg && haveChromium,
    message,
    ffmpeg: haveFfmpeg,
    chromium: haveChromium,
  };
}
