import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SIZE,
  FLOAT_SIZES,
  SIZES,
  STORAGE_KEY,
  embedUrlFor,
  initHomeVideo,
  normalizeSize,
  readSize,
  requestHomeVideo,
  writeSize,
} from './homeVideo.js';
import { DEFAULT_VIDEO_ID, parseYoutubeUrl } from './homeVideoModeration.js';

/** Minimal in-memory Storage stand-in. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

/** Storage that throws, like a browser with site data blocked. */
const hostileStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};

test('normalizeSize accepts only the known sizes', () => {
  assert.deepEqual(SIZES, ['sm', 'md', 'lg']);
  assert.deepEqual(FLOAT_SIZES, ['sm', 'md']);
  for (const size of SIZES) assert.equal(normalizeSize(size), size);
  assert.equal(normalizeSize('MD'), 'md');
  assert.equal(normalizeSize('enormous'), DEFAULT_SIZE);
  assert.equal(normalizeSize(undefined), DEFAULT_SIZE);
});

test('size persistence round-trips and never restores into fullscreen', () => {
  const storage = fakeStorage();
  writeSize('md', storage);
  assert.equal(readSize(storage), 'md');
  assert.equal(storage.getItem(STORAGE_KEY), JSON.stringify({ size: 'md' }));

  // 'lg' is a transient mode; it must not be stored or restored.
  writeSize('lg', storage);
  assert.equal(readSize(storage), 'md');
  assert.equal(readSize(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ size: 'lg' }) })), DEFAULT_SIZE);
});

test('size persistence fails open when storage is unavailable', () => {
  assert.equal(readSize(hostileStorage), DEFAULT_SIZE);
  assert.doesNotThrow(() => writeSize('md', hostileStorage));
  assert.equal(readSize(fakeStorage({ [STORAGE_KEY]: 'not json' })), DEFAULT_SIZE);
  assert.equal(readSize(null), DEFAULT_SIZE);
});

test('embedUrlFor always autoplays muted from the nocookie origin', () => {
  const url = new URL(embedUrlFor({ kind: 'video', id: DEFAULT_VIDEO_ID }));
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, `/embed/${DEFAULT_VIDEO_ID}`);
  assert.equal(url.searchParams.get('autoplay'), '1');
  // Autoplay with sound is blocked by browsers, so muted is not optional.
  assert.equal(url.searchParams.get('mute'), '1');
  assert.equal(url.searchParams.get('enablejsapi'), '1');
  assert.equal(url.searchParams.get('rel'), '0');
});

test('embedUrlFor loops a lone video but not one with a queue behind it', () => {
  const looping = new URL(embedUrlFor({ kind: 'video', id: DEFAULT_VIDEO_ID }, { loop: true }));
  assert.equal(looping.searchParams.get('loop'), '1');
  // A single-video loop needs its own id repeated as the playlist.
  assert.equal(looping.searchParams.get('playlist'), DEFAULT_VIDEO_ID);

  // A looping video never reports ENDED, which is what advances the queue.
  const queued = new URL(embedUrlFor({ kind: 'video', id: DEFAULT_VIDEO_ID }, { loop: false }));
  assert.equal(queued.searchParams.get('loop'), null);
  assert.equal(queued.searchParams.get('playlist'), null);
});

test('embedUrlFor handles playlists and refuses anything else', () => {
  const list = new URL(embedUrlFor({ kind: 'playlist', id: 'PLabcdefghijkl' }));
  assert.equal(list.pathname, '/embed/videoseries');
  assert.equal(list.searchParams.get('list'), 'PLabcdefghijkl');

  assert.equal(embedUrlFor({ kind: 'channel', id: 'UC123' }), '');
  assert.equal(embedUrlFor({ kind: 'video', id: '' }), '');
  assert.equal(embedUrlFor(null), '');
  assert.equal(embedUrlFor(parseYoutubeUrl('https://vimeo.com/1')), '');
});

test('embedUrlFor pins the origin when one is given', () => {
  const url = new URL(embedUrlFor({ kind: 'video', id: DEFAULT_VIDEO_ID }, { origin: 'https://example.test' }));
  assert.equal(url.searchParams.get('origin'), 'https://example.test');
  assert.equal(new URL(embedUrlFor({ kind: 'video', id: DEFAULT_VIDEO_ID })).searchParams.get('origin'), null);
});

test('initHomeVideo is a no-op without markup, and the tool reports that honestly', async () => {
  assert.equal(initHomeVideo({ getElementById: () => null }), null);
  const result = await requestHomeVideo({ action: 'play', url: 'https://youtu.be/aqz-KE-bpKQ' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not on this page/);
});
