// The optional AI summary must be truly optional.
//
// Field report (the failing preview): with no OPENAI_API_KEY the dev proxy
// answers `503 {"error":"OPENAI_API_KEY is not set"}` — a permanent condition
// for the life of the process. The HUD treated it as a transient outage: it
// re-dirtied its signature, warned `[HUD] AI summary unavailable:` every 15 s
// forever, issued a request per tick, and re-typed the summary each time (which
// reflows an occluder and wakes the render governor — see scripts/qa-perf.mjs).
//
// This file pins the fix from the outside: a configuration-missing answer is
// asked for exactly ONCE, the periodic timer stops, the deterministic telemetry
// line stays on screen, and the console sees one line rather than a stream.
//
// hud.js imports `mgrs`, a CommonJS package whose named exports Node's ESM
// loader cannot see, so a module hook swaps that specifier for a stub. The
// import must also precede any DOM globals: Cesium's widget bundle probes for
// `document` at module scope. Hence hook -> import -> install DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

const FALLBACK_LINE = 'NORMAL ORBITAL AUSTIN | TEXAS | ALT 400M';

/**
 * A live IntelHUD wired to stub DOM, timers, console and fetch. `intel-hud` is
 * deliberately absent so `_buildDOM` bails and `#hud-summary` stays a plain
 * text sink this test can read.
 * @param {function(): Promise<Response>} fetchImpl - Stubbed global fetch.
 * @returns {object} Harness with the hud, observed lines, and a restore hook.
 */
function makeHud(fetchImpl) {
  const summaryEl = { textContent: '' };
  const intervals = new Map();
  let nextTimerId = 1;

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    warn: console.warn,
  };

  globalThis.document = {
    getElementById: (id) => (id === 'hud-summary' ? summaryEl : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  // Deterministic timers: the HUD's periodic ticks are driven by hand, so the
  // test never races a real 15 s interval and never leaks one either.
  globalThis.setInterval = (fn, ms) => {
    const id = nextTimerId += 1;
    intervals.set(id, { fn, ms });
    return id;
  };
  globalThis.clearInterval = (id) => { intervals.delete(id); };
  globalThis.window = {
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  globalThis.fetch = fetchImpl;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));

  const viewer = {
    camera: {
      pitch: -Math.PI / 2,
      positionCartographic: { latitude: 0.5, longitude: -1.3, height: 400 },
      computeViewRectangle: () => undefined,
      moveEnd: { addEventListener() {}, removeEventListener() {} },
    },
  };

  const hud = new IntelHUD(viewer);
  hud._visible = true;
  hud._latestMetrics = { altM: 400 };
  // Pin the two scene-walking seams: this file is about the degradation
  // contract, not about what the summary says.
  hud._composeSummary = () => FALLBACK_LINE;
  let contextSeq = 0;
  hud._summaryContext = async () => ({ seq: contextSeq += 1 });

  return {
    hud,
    summaryEl,
    warnings,
    /** Fire every registered periodic tick once, as the browser would. */
    tick() {
      for (const { fn } of [...intervals.values()]) fn();
    },
    /** @returns {number} How many periodic timers are still armed. */
    intervalCount: () => intervals.size,
    restore() {
      hud.destroy();
      globalThis.document = previous.document;
      globalThis.window = previous.window;
      globalThis.fetch = previous.fetch;
      globalThis.setInterval = previous.setInterval;
      globalThis.clearInterval = previous.clearInterval;
      console.warn = previous.warn;
    },
  };
}

/** The exact body the dev proxy returns when OPENAI_API_KEY is absent. */
function missingKeyResponse() {
  return Promise.resolve({
    ok: false,
    status: 503,
    json: async () => ({ error: 'OPENAI_API_KEY is not set' }),
  });
}

test('a missing OpenAI key is asked about exactly once', async () => {
  let requests = 0;
  const harness = makeHud(() => {
    requests += 1;
    return missingKeyResponse();
  });
  try {
    await harness.hud._updateSummary(false, true);
    assert.equal(requests, 1);

    // Twenty periodic ticks and twenty forced kicks later: still one request.
    for (let i = 0; i < 20; i += 1) {
      harness.tick();
      await harness.hud._updateSummary(false, true);
    }
    assert.equal(requests, 1, 'the layer must stop asking for an absent credential');
  } finally {
    harness.restore();
  }
});

test('the missing key stops the periodic summary timer outright', async () => {
  const harness = makeHud(missingKeyResponse);
  try {
    const armedBefore = harness.intervalCount();
    assert.ok(armedBefore > 0, 'the HUD arms periodic timers at construction');
    await harness.hud._updateSummary(false, true);
    assert.equal(
      harness.intervalCount(),
      armedBefore - 1,
      'exactly the summary timer must be cleared — the telemetry timers stay',
    );
  } finally {
    harness.restore();
  }
});

test('the deterministic telemetry line survives as the summary', async () => {
  const harness = makeHud(missingKeyResponse);
  try {
    await harness.hud._updateSummary(false, true);
    assert.equal(harness.summaryEl.textContent, FALLBACK_LINE);
    await harness.hud._updateSummary(false, true);
    assert.equal(harness.summaryEl.textContent, FALLBACK_LINE);
  } finally {
    harness.restore();
  }
});

test('the unavailable state is reported once, and non-fatally', async () => {
  const harness = makeHud(missingKeyResponse);
  try {
    await harness.hud._updateSummary(false, true);
    for (let i = 0; i < 10; i += 1) await harness.hud._updateSummary(false, true);

    assert.equal(harness.warnings.length, 1, 'one line, not one per tick');
    assert.match(harness.warnings[0], /AI summary disabled/);
    assert.match(harness.warnings[0], /OPENAI_API_KEY is not set/);
    assert.match(harness.warnings[0], /no further requests/);

    assert.deepEqual(harness.hud.getSummaryServiceStatus(), {
      available: false,
      reason: 'OPENAI_API_KEY is not set',
    });
  } finally {
    harness.restore();
  }
});

test('a transient outage keeps retrying, with the warning rate limited', async () => {
  let requests = 0;
  const harness = makeHud(() => {
    requests += 1;
    return Promise.reject(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
  });
  try {
    for (let i = 0; i < 5; i += 1) await harness.hud._updateSummary(false, true);

    assert.equal(requests, 5, 'a timeout is not a configuration fact — keep asking');
    assert.equal(harness.hud.getSummaryServiceStatus().available, true);
    assert.ok(harness.intervalCount() > 0, 'the periodic timer must stay armed');
    assert.equal(harness.warnings.length, 1, 'five identical timeouts produce one line');
    assert.match(harness.warnings[0], /AI summary timed out/);
    assert.match(harness.warnings[0], /local telemetry line/);
    assert.equal(harness.summaryEl.textContent, FALLBACK_LINE);
  } finally {
    harness.restore();
  }
});

test('an upstream 502 is transient, not a configuration fact', async () => {
  let requests = 0;
  const harness = makeHud(() => {
    requests += 1;
    return Promise.resolve({
      ok: false,
      status: 502,
      json: async () => ({ summary: null, error: 'upstream refused' }),
    });
  });
  try {
    for (let i = 0; i < 3; i += 1) await harness.hud._updateSummary(false, true);
    assert.equal(requests, 3);
    assert.equal(harness.hud.getSummaryServiceStatus().available, true);
  } finally {
    harness.restore();
  }
});

test('a healthy summary is used and leaves the service available', async () => {
  const harness = makeHud(() => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ summary: 'ELEVATED ACTIVITY | 3 CONTACTS' }),
  }));
  try {
    await harness.hud._updateSummary(false, true);
    assert.equal(harness.summaryEl.textContent, 'ELEVATED ACTIVITY | 3 CONTACTS');
    assert.deepEqual(harness.hud.getSummaryServiceStatus(), { available: true, reason: null });
    assert.deepEqual(harness.warnings, []);
  } finally {
    harness.restore();
  }
});
