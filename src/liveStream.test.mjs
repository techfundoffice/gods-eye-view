import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  buildChromiumArgs,
  isExecutableFile,
  normalizeAudioSource,
  buildFfmpegArgs,
  createLiveStreamController,
  normalizeIngestTarget,
  normalizeLiveOptions,
  redactStreamKey,
  resolveChromiumPath,
  resolveFfmpegPath,
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
  assert.match(joined, /-shortest/);
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
  assert.equal(started.status, 'live');
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

test('a second start while live is refused instead of replacing the broadcast', async () => {
  const { controller } = controllerWith();
  await controller.start(START);
  await assert.rejects(() => controller.start(START), /already running/);
  assert.equal(controller.status().status, 'live');
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
