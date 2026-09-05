import test from 'node:test';
import assert from 'node:assert/strict';
import { embedUrlForTrending, initTrendingCommentator, validVideoId } from './trendingCommentator.js';

function fakeDom() {
  const make = (tag, id = '') => ({
    tagName: String(tag).toUpperCase(),
    id,
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    attributes: {},
    classList: { add() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) {
      const tagName = String(selector).toUpperCase();
      const queue = [...this.children];
      while (queue.length) {
        const current = queue.shift();
        if (current.tagName === tagName) return current;
        queue.push(...(current.children || []));
      }
      return null;
    },
  });
  const root = make('section', 'gev-split-view');
  const mount = make('div', 'gev-split-view-mount');
  root.append(mount);
  const defaultView = {
    location: { origin: 'https://example.test' },
    setInterval: () => 1,
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  };
  const doc = {
    defaultView,
    createElement: (tag) => make(tag),
    getElementById: (id) => ({ 'gev-split-view': root, 'gev-split-view-mount': mount }[id] || null),
  };
  return { doc, root };
}

const future = () => new Date(Date.now() + 60_000).toISOString();
const source = {
  videoId: 'aqz-KE-bpKQ',
  title: 'A public video',
  channelTitle: 'Source Channel',
  regionCode: 'US',
  freshUntil: future(),
};

function all(root) {
  const found = [root];
  for (let i = 0; i < found.length; i += 1) found.push(...(found[i].children || []));
  return found;
}

test('trending embeds accept only validated YouTube video ids', () => {
  assert.equal(validVideoId('aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.equal(validVideoId('short'), '');
  assert.equal(validVideoId('PLabcdefghijkl'), '');
  assert.equal(embedUrlForTrending('https://youtu.be/aqz-KE-bpKQ'), '');
  const url = new URL(embedUrlForTrending('aqz-KE-bpKQ', 'https://example.test'));
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, '/embed/aqz-KE-bpKQ');
  assert.equal(url.searchParams.get('autoplay'), '1');
  assert.equal(url.searchParams.get('mute'), '1');
});

test('invalid ids never produce an iframe source', () => {
  assert.equal(embedUrlForTrending('bad<script>'), '');
  assert.equal(embedUrlForTrending('1234567890'), '');
});

test('the second surface reuses a stale official embed and clears it when disabled', async () => {
  const { doc, root } = fakeDom();
  const payloads = [
    {
      enabled: true,
      status: 'ready',
      source,
      analysis: { status: 'metadata', summary: 'Metadata-only AI commentary.', segments: [] },
      commentator: { label: 'AI-GENERATED COMMENTARY', voiceEnabled: false, avatarEnabled: false },
    },
    {
      enabled: true,
      status: 'stale',
      source: { ...source, freshUntil: new Date(Date.now() - 1000).toISOString() },
      analysis: { status: 'unavailable', summary: 'Provider unavailable.', segments: [] },
      commentator: { label: 'AI-GENERATED COMMENTARY', voiceEnabled: false, avatarEnabled: false },
    },
    { enabled: false, status: 'disabled', source: null, commentator: { label: 'AI-GENERATED COMMENTARY' } },
  ];
  let index = 0;
  const control = initTrendingCommentator(doc, {
    fetchImpl: async () => ({ ok: true, json: async () => payloads[Math.min(index++, payloads.length - 1)] }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const firstFrame = root.querySelector('iframe');
  assert.ok(firstFrame);
  assert.equal(new URL(firstFrame.src).origin, 'https://www.youtube-nocookie.com');
  assert.equal(all(root).some((node) => node.className === 'gev-trending-avatar'), false);
  assert.match(all(root).find((node) => node.className === 'gev-trending-attribution').textContent, /AI-generated/);

  await control.refresh();
  assert.equal(root.querySelector('iframe'), firstFrame, 'stale refresh reuses the current official embed');
  assert.match(all(root).find((node) => node.className === 'gev-trending-status').textContent, /STALE/);

  await control.refresh();
  assert.equal(root.querySelector('iframe'), null);
  assert.match(all(root).find((node) => node.className === 'gev-trending-status').textContent, /DISABLED/);
  control.stop();
});

test('an unavailable typed error renders its safe message, never object coercion', async () => {
  const { doc, root } = fakeDom();
  const control = initTrendingCommentator(doc, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        enabled: true,
        status: 'unavailable',
        source: null,
        analysis: { status: 'unavailable', summary: '' },
        commentator: { label: 'AI-GENERATED COMMENTARY' },
        error: { kind: 'source-unavailable', message: 'Trending source is temporarily unavailable.' },
      }),
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const label = all(root).find((node) => node.className === 'gev-trending-status').textContent;
  assert.match(label, /Trending source is temporarily unavailable/);
  assert.doesNotMatch(label, /\\[object Object\\]/);
  control.stop();
});