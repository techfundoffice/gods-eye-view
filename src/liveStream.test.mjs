import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  LIVE_CAPTURE_CANVAS_SELECTOR,
  LIVE_CAPTURE_WAIT_UNTIL,
  buildChromiumArgs,
  chromiumCaptureHints,
  classifyFfmpegLine,
  describeEncoderReadiness,
  isActiveLiveStatus,
  isExecutableFile,
  normalizeAudioSource,
  normalizeCaptureUrl,
  buildFfmpegArgs,
  createLiveStreamController,
  normalizeIngestTarget,
  normalizeLiveOptions,
  prepareCapturePage,
  probeCaptureUrl,
  publicOriginFromRequest,
  redactStreamKey,
  resolveChromiumPath,
  resolveFfmpegPath,
  resolveLiveCaptureTarget,
} from './liveStream.js';

const KEY = 'abcd-1234-efgh-5678';

function fakeFfmpeg() {
  const proc = new EventEmitter();
  proc.written = [];
  proc.killed = false;
  proc.stdin = new EventEmitter();
  proc.stdin.write = (chunk) => { proc.written.push(chunk); return true; };
  proc.stdin.end = () => { proc.stdin.ended = true; };
  proc.stderr = new EventEmitter();
  proc.signals = [];
  proc.kill = (signal) => { proc.killed = true; proc.signals.push(signal); };
  return proc;
}

function fakeBrowser() {
  const browser = { closed: false, frames: 0 };
  browser.startScreencast = (onFrame) => {
    browser.frames += 1;
    onFrame(Buffer.from('jpeg-frame'));
    return Promise.resolve();
  };
  browser.close = () => { browser.closed = true; return Promise.resolve(); };
  return browser;
}

function controllerWith(overrides = {}) {
  const spawned = [];
  const browser = fakeBrowser();
  const proc = fakeFfmpeg();
  const controller = createLiveStreamController({
    spawn: (bin, args) => { spawned.push({ bin, args }); return proc; },
    launchBrowser: async () => browser,
    chromiumPath: '/usr/bin/chromium',
    resolveFfmpeg: () => '/usr/bin/ffmpeg',
    probeCapture: async (url) => ({ url, status: 200 }),
    ...overrides,
  });
  return { controller, spawned, browser, proc };
}

const START = {
  ingestUrl: 'rtmp://a.rtmp.youtube.com/live2',
  streamKey: KEY,
  captureUrl: 'http://localhost:5000/',
  fps: 60,
};

test('an ingest target must be RTMP and never displays the key', () => {
  const target = normalizeIngestTarget('rtmp://a.rtmp.youtube.com/live2', KEY);
  assert.equal(target.target, `rtmp://a.rtmp.youtube.com/live2/${KEY}`);
  assert.equal(target.display, 'rtmp://a.rtmp.youtube.com/live2/***');
  assert.ok(!target.display.includes(KEY));
  assert.equal(normalizeIngestTarget('rtmps://a.rtmp.youtube.com/live2', KEY).host, 'a.rtmp.youtube.com');

  for (const bad of ['file:///etc/passwd', 'http://example.com/live', 'concat:/etc/passwd']) {
    assert.throws(() => normalizeIngestTarget(bad, KEY), /rtmp|valid URL/i, bad);
  }
  assert.throws(() => normalizeIngestTarget('rtmp://x/live2', ''), /stream key is required/);
  assert.throws(() => normalizeIngestTarget('rtmp://x/live2', 'has space'), /invalid characters/);
});

test('stream keys are scrubbed from arbitrary text', () => {
  assert.equal(redactStreamKey(`rtmp://x/live2/${KEY} failed`, KEY), 'rtmp://x/live2/*** failed');
  assert.equal(redactStreamKey('nothing to hide', KEY), 'nothing to hide');
  assert.equal(redactStreamKey('nothing to hide', ''), 'nothing to hide');
});

test('encoder options are bounded and dimensions stay even', () => {
  const options = normalizeLiveOptions({ ...START, width: 1281, height: 721, fps: 30 });
  assert.equal(options.width, 1280);
  assert.equal(options.height, 720);
  assert.equal(options.fps, 30);

  assert.throws(() => normalizeLiveOptions({ ...START, fps: 240 }), /fps must be between/);
  assert.throws(() => normalizeLiveOptions({ ...START, videoBitrateKbps: 99_999 }), /videoBitrateKbps/);
  assert.throws(() => normalizeLiveOptions({ ...START, captureUrl: 'file:///etc/passwd' }), /http or https/);
  assert.throws(() => normalizeLiveOptions({ ...START, fps: 'fast' }), /must be a number/);
});

test('ffmpeg is invoked for realtime H.264 over FLV with a silent audio track', () => {
  const args = buildFfmpegArgs(normalizeLiveOptions({ ...START, fps: 30 }));
  const joined = args.join(' ');
  assert.match(joined, /-f image2pipe/);
  assert.match(joined, /anullsrc/);
  assert.match(joined, /-c:v libx264/);
  assert.match(joined, /-pix_fmt yuv420p/);
  assert.match(joined, /-c:a aac/);
  assert.match(joined, /-profile:v main/);
  assert.match(joined, /-r 30/);
  assert.match(joined, /scenecut=0/);
  assert.match(joined, /-flvflags no_duration_filesize/);
  assert.ok(!joined.includes('-shortest'), 'silent+pipe are both infinite; -shortest can exit early');
  // A two-second GOP at 30fps keeps YouTube's keyframe requirement satisfied.
  assert.equal(args[args.indexOf('-g') + 1], '60');
  assert.equal(args[args.length - 3], '-f');
  assert.equal(args[args.length - 2], 'flv');
  assert.equal(args[args.length - 1], `rtmp://a.rtmp.youtube.com/live2/${KEY}`);
});

test('Chromium is told to software-render WebGL when no GPU exists', () => {
  const args = buildChromiumArgs({ width: 1280, height: 720 });
  assert.ok(args.includes('--use-angle=swiftshader'));
  assert.ok(args.includes('--enable-unsafe-swiftshader'));
  assert.ok(args.includes('--window-size=1280,720'));
  const mapped = buildChromiumArgs({
    width: 1280,
    height: 720,
    hostResolverRules: 'MAP example.replit.dev 127.0.0.1',
  });
  assert.ok(mapped.includes('--host-resolver-rules=MAP example.replit.dev 127.0.0.1'));
});

test('an explicit Chromium path wins over a PATH search', () => {
  assert.equal(resolveChromiumPath({ CHROME_PATH: '/opt/chrome' }, () => true), '/opt/chrome');
  assert.equal(
    resolveChromiumPath({ PATH: '/a:/b' }, (candidate) => candidate === '/b/chromium'),
    '/b/chromium',
  );
  assert.equal(resolveChromiumPath({ PATH: '/a' }, () => false), null);
});

test('starting a broadcast spawns ffmpeg, feeds frames, and hides the key', async () => {
  const { controller, spawned, browser, proc } = controllerWith();
  const started = await controller.start(START);
  assert.equal(started.status, 'encoding');
  assert.equal(spawned.length, 1);
  assert.equal(browser.frames, 1);
  assert.equal(started.target, 'rtmp://a.rtmp.youtube.com/live2/***');

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(proc.written.length > 0, 'frames should reach ffmpeg');
  assert.ok(controller.status().framesSent > 0);

  // Nothing the console can read may carry the credential.
  assert.ok(!JSON.stringify(controller.status()).includes(KEY));

  const stopped = await controller.stop();
  assert.equal(stopped.status, 'stopped');
  assert.equal(browser.closed, true);
  assert.equal(proc.stdin.ended, true);
});

test('a second start for the same ingest is idempotent; a different one is refused', async () => {
  const { controller } = controllerWith();
  const first = await controller.start(START);
  assert.equal(first.status, 'encoding');
  const again = await controller.start(START);
  assert.equal(again.status, 'encoding');
  await assert.rejects(
    () => controller.start({ ...START, streamKey: 'other-key-zzzz' }),
    /already running/,
  );
  assert.equal(controller.status().status, 'encoding');
  await controller.stop();
});

test('ffmpeg discovery prefers FFMPEG_PATH and otherwise searches PATH', () => {
  assert.equal(resolveFfmpegPath({ FFMPEG_PATH: '/opt/ffmpeg' }, () => true), '/opt/ffmpeg');
  assert.equal(resolveFfmpegPath({ FFMPEG_PATH: '/opt/missing' }, () => false), null);
  assert.equal(
    resolveFfmpegPath({ PATH: '/a:/b' }, (candidate) => candidate === '/b/ffmpeg'),
    '/b/ffmpeg',
  );
  assert.equal(resolveFfmpegPath({ PATH: '/a' }, () => false), null);
});

test('a missing ffmpeg reports an error and never goes live', async () => {
  let spawned = 0;
  const { controller, browser } = controllerWith({
    resolveFfmpeg: () => null,
    spawn: () => { spawned += 1; return fakeFfmpeg(); },
  });
  const result = await controller.start(START);
  assert.equal(result.status, 'error');
  assert.match(result.error, /ffmpeg/i);
  assert.equal(spawned, 0);
  assert.equal(browser.closed, false);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('a missing Chromium reports an error and leaves nothing running', async () => {
  const { controller, browser } = controllerWith({ chromiumPath: null });
  const result = await controller.start({ ...START, captureUrl: 'http://localhost:5000/' });
  // resolveChromiumPath() consults the real environment; when it finds nothing
  // the controller must fail closed rather than spawn a half-built pipeline.
  if (result.status === 'error') {
    assert.match(result.error, /Chromium|CHROME_PATH/);
    assert.equal(browser.closed, false);
  } else {
    assert.equal(result.status, 'live');
    await controller.stop();
  }
});

test('ffmpeg stderr is captured for the console with the key removed', async () => {
  const { controller, proc } = controllerWith();
  await controller.start(START);
  proc.stderr.emit('data', Buffer.from(`Connection to rtmp://a.rtmp.youtube.com/live2/${KEY} failed`));
  const status = controller.status();
  assert.ok(status.log.some((line) => line.includes('***')));
  assert.ok(!status.log.join('\n').includes(KEY));
  await controller.stop();
});

test('an audio bed is a local file or an http(s) URL, or nothing at all', () => {
  assert.equal(normalizeAudioSource(''), null);
  assert.equal(normalizeAudioSource('   '), null);
  assert.equal(normalizeAudioSource('https://example.com/bed.mp3'), 'https://example.com/bed.mp3');
  assert.equal(normalizeAudioSource('/music/bed.mp3', () => true), '/music/bed.mp3');

  for (const bad of ['file:///etc/passwd', 'concat:/etc/passwd', 'rtmp://x/live2']) {
    assert.throws(() => normalizeAudioSource(bad), /local file or an http/, bad);
  }
  assert.throws(() => normalizeAudioSource('/music/missing.mp3', () => false), /No audio file at/);
});

test('a silent stream synthesizes audio; a bed replaces it and is paced and looped', () => {
  const silent = buildFfmpegArgs(normalizeLiveOptions(START)).join(' ');
  assert.match(silent, /-f lavfi -i anullsrc/);
  assert.ok(!silent.includes('-stream_loop'));

  const withBed = buildFfmpegArgs(normalizeLiveOptions({
    ...START,
    audioSource: 'https://example.com/bed.mp3',
  })).join(' ');
  assert.match(withBed, /-re -stream_loop -1 -i https:\/\/example\.com\/bed\.mp3/);
  assert.ok(!withBed.includes('anullsrc'));
  // The video clock still terminates the broadcast, not the looping bed.
  assert.match(withBed, /-shortest/);
});

test('the console is told whether the broadcast carries audio', async () => {
  const { controller } = controllerWith();
  await controller.start({ ...START, audioSource: 'https://example.com/bed.mp3' });
  assert.equal(controller.status().settings.audioSource, 'track');
  await controller.stop();

  const plain = controllerWith();
  await plain.controller.start(START);
  assert.equal(plain.controller.status().settings.audioSource, 'silent');
  await plain.controller.stop();
});

test('Chromium discovery actually searches PATH by default', () => {
  // Regression: the probe defaulted to () => false, so every PATH candidate was
  // rejected and only CHROME_PATH could ever resolve.
  const found = resolveChromiumPath(
    { PATH: '/nope:/opt/bin' },
    (candidate) => candidate === '/opt/bin/google-chrome-stable',
  );
  assert.equal(found, '/opt/bin/google-chrome-stable');

  // The default probe is a real filesystem check, not a stub that always fails.
  assert.equal(isExecutableFile('/definitely/not/here'), false);
  assert.equal(isExecutableFile('/bin/sh'), true);
});

test('stopping closes stdin to flush, and only force-kills a stuck encoder', async () => {
  const stuck = controllerWith({ shutdownGraceMs: 20 });
  await stuck.controller.start(START);
  await stuck.controller.stop();
  assert.equal(stuck.proc.stdin.ended, true, 'stdin EOF is the graceful signal');
  assert.deepEqual(stuck.proc.signals, [], 'no signal before the grace period');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(stuck.proc.signals, ['SIGKILL'], 'backstop fires for a stuck encoder');

  const clean = controllerWith({ shutdownGraceMs: 20 });
  await clean.controller.start(START);
  await clean.controller.stop();
  clean.proc.emit('exit', 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(clean.proc.signals, [], 'an encoder that exits is never killed');
});

test('capture URLs are http(s) only and Replit public origin beats loopback', () => {
  assert.equal(normalizeCaptureUrl('http://localhost:4173/'), 'http://localhost:4173/');
  assert.throws(() => normalizeCaptureUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => normalizeCaptureUrl('concat:/etc/passwd'), /http or https/);

  assert.equal(
    resolveLiveCaptureTarget({ env: { LIVE_CAPTURE_URL: 'https://preview.example/' } }),
    'https://preview.example/',
  );
  assert.equal(
    resolveLiveCaptureTarget({ requested: 'http://127.0.0.1:5000/', env: {} }),
    'http://127.0.0.1:5000/',
  );
  assert.equal(
    publicOriginFromRequest(
      { headers: { host: '127.0.0.1:5000' } },
      { REPLIT_DEV_DOMAIN: 'app.example.replit.dev', PORT: '5000' },
    ),
    'https://app.example.replit.dev/',
  );
  assert.equal(
    publicOriginFromRequest(
      { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.replit.dev' } },
      {},
    ),
    'https://app.example.replit.dev/',
  );

  const hints = chromiumCaptureHints('https://app.example.replit.dev/', {
    REPLIT_DEV_DOMAIN: 'app.example.replit.dev',
    PORT: '5000',
  });
  assert.equal(hints.hostResolverRules, 'MAP app.example.replit.dev 127.0.0.1');
  assert.equal(hints.loopbackUrl, 'http://127.0.0.1:5000/');
  assert.equal(hints.extraHeaders.Host, 'app.example.replit.dev');
});

test('a failed capture probe never spawns ffmpeg or Chromium', async () => {
  let spawned = 0;
  let launched = 0;
  const { controller } = controllerWith({
    probeCapture: async () => {
      throw new Error('Capture URL is not reachable from this server: HTTP 502');
    },
    spawn: () => { spawned += 1; return fakeFfmpeg(); },
    launchBrowser: async () => { launched += 1; return fakeBrowser(); },
  });
  const result = await controller.start(START);
  assert.equal(result.status, 'error');
  assert.match(result.error, /not reachable/);
  assert.equal(spawned, 0);
  assert.equal(launched, 0);
});

test('probeCaptureUrl uses the injected fetch and fails closed on HTTP errors', async () => {
  const seen = [];
  const ok = await probeCaptureUrl('http://localhost:4173/', {
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(seen[0], 'http://localhost:4173/');

  await assert.rejects(
    () => probeCaptureUrl('http://localhost:4173/', {
      fetchImpl: async () => ({ ok: false, status: 407 }),
    }),
    /HTTP 407/,
  );
});

test('capture navigation waits for DOM, not network idle, then the globe canvas', async () => {
  const calls = [];
  const page = {
    extra: null,
    async setExtraHTTPHeaders(headers) { this.extra = headers; },
    async goto(url, opts) { calls.push(['goto', url, opts]); },
    async waitForSelector(sel, opts) { calls.push(['wait', sel, opts]); },
  };
  await prepareCapturePage(page, {
    captureUrl: 'http://127.0.0.1:5000/',
    extraHeaders: { Host: 'app.example.replit.dev' },
  });
  assert.deepEqual(page.extra, { Host: 'app.example.replit.dev' });
  assert.equal(calls[0][0], 'goto');
  assert.equal(calls[0][2].waitUntil, LIVE_CAPTURE_WAIT_UNTIL);
  assert.equal(LIVE_CAPTURE_WAIT_UNTIL, 'domcontentloaded');
  assert.equal(calls[1][1], LIVE_CAPTURE_CANVAS_SELECTOR);
});

test('ffmpeg ingest failures become operator sentences without the stream key', () => {
  assert.match(
    classifyFfmpegLine(`RTMP_Connect0, failed to connect to rtmp://x/live2/${KEY}`),
    /could not reach the RTMP ingest host/i,
  );
  assert.match(classifyFfmpegLine('Server returned 403 Forbidden'), /rejected the RTMP key/);
  assert.match(classifyFfmpegLine('Broken pipe'), /disconnected/);
  assert.equal(classifyFfmpegLine('frame=  12 fps=24'), null);
});

test('encoder backpressure drops frames instead of buffering JPEGs', async () => {
  const { controller, proc } = controllerWith();
  proc.stdin.write = () => false;
  await controller.start(START);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(controller.status().framesDropped > 0);
  assert.ok(controller.status().log.some((line) => /backpressure/i.test(line)));
  proc.stdin.emit('drain');
  proc.stdin.write = (chunk) => { proc.written.push(chunk); return true; };
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(controller.status().framesSent > 0);
  await controller.stop();
});

test('stop during start aborts and does not leave a live or encoding state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const inner = fakeBrowser();
  let launched = false;
  const { controller, proc } = controllerWith({
    launchBrowser: async () => {
      launched = true;
      await gate;
      return inner;
    },
  });
  const starting = controller.start(START);
  const deadline = Date.now() + 1000;
  while (!launched && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(launched, true, 'start should reach Chromium launch');
  await controller.stop();
  release();
  const result = await starting;
  assert.equal(result.status, 'stopped');
  assert.equal(controller.status().status, 'stopped');
  assert.equal(inner.closed, true);
  assert.equal(proc.stdin.ended, true);
});

test('an unexpected ffmpeg exit while encoding is an error, not live', async () => {
  const { controller, proc } = controllerWith();
  await controller.start(START);
  proc.stderr.emit('data', Buffer.from('Server returned 403'));
  proc.emit('exit', 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.status().status, 'error');
  assert.match(controller.status().error, /rejected the RTMP key/);
  assert.ok(!JSON.stringify(controller.status()).includes(KEY));
});

test('capture load failure is reported and tears the encoder down', async () => {
  let spawned = 0;
  const proc = fakeFfmpeg();
  const { controller } = controllerWith({
    spawn: () => { spawned += 1; return proc; },
    launchBrowser: async () => {
      throw new Error('Capture page did not load a usable globe surface: net::ERR_CONNECTION_REFUSED');
    },
  });
  const result = await controller.start(START);
  assert.equal(result.status, 'error');
  assert.match(result.error, /did not load a usable globe surface/);
  assert.equal(spawned, 1);
  assert.equal(proc.stdin.ended, true);
});

test('encoder readiness names the missing binary', () => {
  const none = describeEncoderReadiness({ env: { PATH: '/nope' }, exists: () => false });
  assert.equal(none.ready, false);
  assert.match(none.message, /ffmpeg or Chromium/);

  const ffmpegOnly = describeEncoderReadiness({
    env: { PATH: '/opt/bin', FFMPEG_PATH: '/opt/bin/ffmpeg' },
    exists: (path) => path.endsWith('/ffmpeg'),
  });
  assert.equal(ffmpegOnly.ffmpeg, true);
  assert.equal(ffmpegOnly.chromium, false);
  assert.match(ffmpegOnly.message, /CHROME_PATH/);

  assert.equal(isActiveLiveStatus('encoding'), true);
  assert.equal(isActiveLiveStatus('waiting-for-youtube'), true);
  assert.equal(isActiveLiveStatus('idle'), false);
});
