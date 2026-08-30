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
  fps: 24,
  videoBitrateKbps: 2500,
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

const REDACTED = '***';

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
  const base = raw.replace(/\/+$/, '');
  return {
    display: `${base}/${REDACTED}`,
    target: `${base}/${key}`,
    host: parsed.host,
  };
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

  const captureUrl = String(input.captureUrl || '').trim() || 'http://localhost:5000/';
  let parsedCapture;
  try {
    parsedCapture = new URL(captureUrl);
  } catch {
    throw new Error('The capture URL is not a valid URL');
  }
  if (parsedCapture.protocol !== 'http:' && parsedCapture.protocol !== 'https:') {
    throw new Error('The capture URL must be http or https');
  }

  return {
    ...options,
    captureUrl: parsedCapture.toString(),
    audioSource: normalizeAudioSource(input.audioSource),
    ingest: normalizeIngestTarget(input.ingestUrl, input.streamKey),
    streamKey: String(input.streamKey || '').trim(),
  };
}

/**
 * Build the ffmpeg argument vector for a live push.
 *
 * Video arrives as a JPEG stream on stdin. YouTube expects an audio track on
 * every ingest, so a silent stereo source is synthesized and `-shortest` ties
 * its (otherwise infinite) duration to the video.
 *
 * @param {object} options Normalized options from {@link normalizeLiveOptions}.
 * @returns {string[]}
 */
export function buildFfmpegArgs(options) {
  const gop = Math.max(1, options.fps * options.gopSeconds);
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'image2pipe',
    '-framerate', String(options.fps),
    '-i', 'pipe:0',
    // `-re` paces the bed at its native rate so it cannot race ahead of the
    // video clock, and `-stream_loop -1` keeps it playing for a long broadcast.
    ...(options.audioSource
      ? ['-re', '-stream_loop', '-1', '-i', options.audioSource]
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-b:v', `${options.videoBitrateKbps}k`,
    '-maxrate', `${options.videoBitrateKbps}k`,
    '-bufsize', `${options.videoBitrateKbps * 2}k`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-c:a', 'aac',
    '-b:a', `${options.audioBitrateKbps}k`,
    '-ar', '44100',
    '-shortest',
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
  return [
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
 * @returns {Promise<{startScreencast: Function, close: Function}>}
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
  await page.goto(options.captureUrl, { waitUntil: 'networkidle2', timeout: 120_000 });
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
 * @returns {{start: Function, stop: Function, status: Function}}
 */
export function createLiveStreamController({
  spawn = nodeSpawn,
  launchBrowser = defaultLaunchBrowser,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  chromiumPath = null,
  resolveFfmpeg = null,
  shutdownGraceMs = 4000,
  now = () => Date.now(),
} = {}) {
  const state = {
    status: 'idle',
    startedAt: 0,
    framesSent: 0,
    target: '',
    captureUrl: '',
    settings: null,
    error: null,
    log: [],
  };
  let browser = null;
  let ffmpeg = null;
  let ticker = null;
  let lastFrame = null;
  let writable = true;
  let streamKey = '';

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
  }

  /**
   * Begin a broadcast.
   *
   * @param {object} input Raw console body.
   * @returns {Promise<object>} Public state.
   */
  async function start(input) {
    if (state.status === 'live' || state.status === 'starting') {
      const error = new Error('A broadcast is already running. Stop it before starting another.');
      error.status = 409;
      throw error;
    }
    const options = normalizeLiveOptions(input);
    streamKey = options.streamKey;
    state.status = 'starting';
    state.startedAt = now();
    state.framesSent = 0;
    state.target = options.ingest.display;
    state.captureUrl = options.captureUrl;
    state.error = null;
    state.log = [];
    state.settings = {
      width: options.width,
      height: options.height,
      fps: options.fps,
      videoBitrateKbps: options.videoBitrateKbps,
      audioBitrateKbps: options.audioBitrateKbps,
      audioSource: options.audioSource ? 'track' : 'silent',
    };

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
      log(`Capturing ${options.captureUrl} at ${options.width}x${options.height}@${options.fps}`);
      log(`Publishing to ${options.ingest.display}`);

      ffmpeg = spawn(encoderBin, buildFfmpegArgs(options), { stdio: ['pipe', 'ignore', 'pipe'] });
      ffmpeg.stderr?.on('data', (chunk) => log(String(chunk)));
      ffmpeg.stdin?.on('error', () => { writable = false; });
      ffmpeg.stdin?.on('drain', () => { writable = true; });
      ffmpeg.on('error', (error) => {
        state.error = `ffmpeg failed to start: ${error.message}`;
        state.status = 'error';
        teardown();
      });
      ffmpeg.on('exit', (code) => {
        // A clean stop tears ffmpeg down itself; reaching here while live means
        // the encoder or the ingest dropped out.
        if (state.status === 'live' || state.status === 'starting') {
          state.status = 'error';
          state.error = `ffmpeg exited unexpectedly (code ${code}).`;
          teardown();
        }
      });

      browser = await launchBrowser({
        executablePath,
        args: buildChromiumArgs(options),
        options,
      });
      await browser.startScreencast((frame) => { lastFrame = frame; });

      // Constant-rate pacing: RTMP wants a steady clock, screencast frames do
      // not arrive on one. Re-sending the newest frame keeps the encoder fed.
      ticker = setInterval(() => {
        if (!ffmpeg?.stdin || !lastFrame || !writable) return;
        writable = ffmpeg.stdin.write(lastFrame);
        state.framesSent += 1;
      }, Math.max(1, Math.round(1000 / options.fps)));
      ticker.unref?.();

      state.status = 'live';
      log('Encoder running.');
    } catch (error) {
      state.status = 'error';
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
    if (state.status === 'idle' || state.status === 'stopped') return describeLiveState(state);
    state.status = 'stopped';
    await teardown();
    log('Broadcast stopped.');
    return describeLiveState(state);
  }

  return {
    start,
    stop,
    status: () => describeLiveState(state),
  };
}
