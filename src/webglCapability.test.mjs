import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WEBGL_COMPATIBILITY_REASONS,
  classifyCesiumStartupError,
  classifyWebGLLimits,
  isWebGLInitializationError,
  readSceneContextLimits,
  validateSceneContext,
  probeWebGLCapability,
  showWebGLCompatibilityState,
} from './webglCapability.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** WebGL enum values, so the fake context is addressed the way Cesium does. */
const GL_ENUMS = {
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660,
  MAX_TEXTURE_SIZE: 3379,
  MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
  MAX_RENDERBUFFER_SIZE: 34024,
  MAX_TEXTURE_IMAGE_UNITS: 34930,
  MAX_VERTEX_ATTRIBS: 34921,
  ALIASED_LINE_WIDTH_RANGE: 33902,
  MAX_VIEWPORT_DIMS: 3386,
};

/** Limits a healthy desktop GPU reports. */
const HEALTHY = Object.freeze({
  maxVertexTextureImageUnits: 16,
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxTextureImageUnits: 16,
  maxVertexAttributes: 16,
  aliasedLineWidthRange: [1, 1],
  maxViewportDimensions: [16384, 16384],
});

function context({ limits = {}, loseContext = () => {}, contextLost = false } = {}) {
  const values = { ...HEALTHY, ...limits };
  const byEnum = new Map([
    [GL_ENUMS.MAX_VERTEX_TEXTURE_IMAGE_UNITS, values.maxVertexTextureImageUnits],
    [GL_ENUMS.MAX_TEXTURE_SIZE, values.maxTextureSize],
    [GL_ENUMS.MAX_CUBE_MAP_TEXTURE_SIZE, values.maxCubeMapTextureSize],
    [GL_ENUMS.MAX_RENDERBUFFER_SIZE, values.maxRenderbufferSize],
    [GL_ENUMS.MAX_TEXTURE_IMAGE_UNITS, values.maxTextureImageUnits],
    [GL_ENUMS.MAX_VERTEX_ATTRIBS, values.maxVertexAttributes],
    [GL_ENUMS.ALIASED_LINE_WIDTH_RANGE, values.aliasedLineWidthRange],
    [GL_ENUMS.MAX_VIEWPORT_DIMS, values.maxViewportDimensions],
  ]);
  return {
    ...GL_ENUMS,
    isContextLost: () => contextLost,
    getParameter(parameter) {
      assert.ok(byEnum.has(parameter), `unexpected getParameter(${parameter})`);
      return byEnum.get(parameter);
    },
    getExtension(name) {
      assert.equal(name, 'WEBGL_lose_context');
      return { loseContext };
    },
  };
}

function probe(options) {
  const gl = context(options);
  return probeWebGLCapability({
    createCanvas: () => ({ getContext: (name) => (name === 'webgl2' ? gl : null) }),
  });
}

test('a usable WebGL context with complete limits is accepted', () => {
  let released = 0;
  const gl = context({ loseContext: () => { released += 1; } });
  const requested = [];
  const result = probeWebGLCapability({
    createCanvas: () => ({
      getContext(name) {
        requested.push(name);
        return name === 'webgl2' ? gl : null;
      },
    }),
  });

  assert.equal(result.supported, true);
  assert.equal(result.reason, null);
  assert.equal(result.contextType, 'webgl2');
  assert.equal(result.maxVertexTextureImageUnits, 16);
  assert.equal(result.limits.maxTextureSize, 16384);
  assert.deepEqual(result.limits.aliasedLineWidthRange, [1, 1]);
  assert.deepEqual(requested, ['webgl2']);
  assert.equal(released, 1, 'the probe context must be released');
});

test('missing WebGL reports an unavailable compatibility result', () => {
  const result = probeWebGLCapability({
    createCanvas: () => ({ getContext: () => null }),
  });
  assert.equal(result.supported, false);
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.unavailable);
  assert.equal(result.contextType, null);
  assert.equal(result.maxVertexTextureImageUnits, 0);
});

test('zero vertex texture units fail before Cesium primitives can render', () => {
  const result = probe({ limits: { maxVertexTextureImageUnits: 0 } });
  assert.equal(result.supported, false);
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures);
  assert.equal(result.contextType, 'webgl2');
});

test('a zero maximum texture size is unsupported, not a small GPU', () => {
  // Cesium's Texture throws "Width must be less than or equal to the maximum
  // texture size (0)" on every frame with this limit.
  const result = probe({ limits: { maxTextureSize: 0 } });
  assert.equal(result.supported, false);
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize);
});

test('a texture size below the WebGL spec floor is unsupported', () => {
  const result = probe({ limits: { maxTextureSize: 32 } });
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize);
});

test('a zero cube-map texture size is unsupported', () => {
  const result = probe({ limits: { maxCubeMapTextureSize: 0 } });
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize);
});

test('a zero renderbuffer size is unsupported', () => {
  const result = probe({ limits: { maxRenderbufferSize: 0 } });
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize);
});

test('a non-finite limit is unsupported rather than silently coerced', () => {
  assert.equal(
    probe({ limits: { maxTextureSize: Number.NaN } }).reason,
    WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize,
  );
  assert.equal(
    probe({ limits: { maxVertexTextureImageUnits: Number.NaN } }).reason,
    WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
  );
});

test('a zero aliased line width range is unsupported', () => {
  // Cesium stores range[1] as ContextLimits.maximumAliasedLineWidth; at 0
  // every trail and tracked-target line clamps away to nothing.
  const result = probe({ limits: { aliasedLineWidthRange: [0, 0] } });
  assert.equal(result.supported, false);
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange);
});

test('a missing or malformed aliased line width range is unsupported', () => {
  assert.equal(
    probe({ limits: { aliasedLineWidthRange: null } }).reason,
    WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange,
  );
  assert.equal(
    probe({ limits: { aliasedLineWidthRange: [1] } }).reason,
    WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange,
  );
  assert.equal(
    probe({ limits: { aliasedLineWidthRange: [Number.NaN, Number.NaN] } }).reason,
    WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange,
  );
});

test('an inverted line width range is reported as inconsistent limits', () => {
  const result = probe({ limits: { aliasedLineWidthRange: [8, 2] } });
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.inconsistentLimits);
});

test('a line width range that excludes 1.0 violates the spec invariant', () => {
  const result = probe({ limits: { aliasedLineWidthRange: [4, 8] } });
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.inconsistentLimits);
});

test('a degenerate viewport is reported as inconsistent limits', () => {
  assert.equal(
    probe({ limits: { maxViewportDimensions: [0, 0] } }).reason,
    WEBGL_COMPATIBILITY_REASONS.inconsistentLimits,
  );
  assert.equal(
    probe({ limits: { maxViewportDimensions: null } }).reason,
    WEBGL_COMPATIBILITY_REASONS.inconsistentLimits,
  );
  // A surface smaller than one texture the driver claims to accept.
  assert.equal(
    probe({ limits: { maxViewportDimensions: [16, 16] } }).reason,
    WEBGL_COMPATIBILITY_REASONS.inconsistentLimits,
  );
});

test('sub-spec fragment/vertex unit counts are reported as inconsistent limits', () => {
  assert.equal(
    probe({ limits: { maxTextureImageUnits: 0 } }).reason,
    WEBGL_COMPATIBILITY_REASONS.inconsistentLimits,
  );
  assert.equal(
    probe({ limits: { maxVertexAttributes: 4 } }).reason,
    WEBGL_COMPATIBILITY_REASONS.inconsistentLimits,
  );
});

test('an already-lost context is named as lost, not as a missing GPU feature', () => {
  const result = probe({ contextLost: true, limits: { maxTextureSize: 0 } });
  assert.equal(result.supported, false);
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.contextLost);
  assert.equal(result.contextType, 'webgl2');
});

test('a context lost while the limits are read is caught before they are trusted', () => {
  let reads = 0;
  const gl = {
    ...GL_ENUMS,
    // Healthy on the pre-read check, lost by the post-read check.
    isContextLost: () => reads > 0,
    getParameter() {
      reads += 1;
      return 0;
    },
    getExtension: () => ({ loseContext: () => {} }),
  };
  const result = probeWebGLCapability({
    createCanvas: () => ({ getContext: (name) => (name === 'webgl2' ? gl : null) }),
  });
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.contextLost);
});

test('a context that throws on every getParameter is unsupported, not a crash', () => {
  const gl = {
    ...GL_ENUMS,
    isContextLost: () => false,
    getParameter() { throw new Error('context is gone'); },
    getExtension: () => ({ loseContext: () => {} }),
  };
  const result = probeWebGLCapability({
    createCanvas: () => ({ getContext: (name) => (name === 'webgl2' ? gl : null) }),
  });
  assert.equal(result.supported, false);
  assert.equal(result.reason, WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures);
});

test('probe errors fail closed instead of escaping startup', () => {
  assert.equal(
    probeWebGLCapability({ createCanvas: () => { throw new Error('blocked'); } }).supported,
    false,
  );
  assert.equal(
    probeWebGLCapability({
      createCanvas: () => ({ getContext: () => { throw new Error('blocked'); } }),
    }).supported,
    false,
  );
});

test('classifyWebGLLimits accepts a healthy table and names the first fault otherwise', () => {
  assert.equal(classifyWebGLLimits(HEALTHY), null);
  assert.equal(classifyWebGLLimits({}), WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures);
  // Typed-array ranges are what a real context returns; the probe normalizes
  // them to plain arrays before classification, so classification sees arrays.
  assert.equal(
    classifyWebGLLimits({ ...HEALTHY, aliasedLineWidthRange: [1, 10] }),
    null,
  );
});

test('a real context reporting typed-array ranges is accepted', () => {
  const result = probe({
    limits: {
      aliasedLineWidthRange: Float32Array.from([1, 1]),
      maxViewportDimensions: Int32Array.from([8192, 8192]),
    },
  });
  assert.equal(result.supported, true);
  assert.deepEqual(result.limits.aliasedLineWidthRange, [1, 1]);
});

test('Cesium GPU capability failures are distinguished from unrelated errors', () => {
  // Each string is one Cesium throws verbatim — see the module JSDoc.
  assert.equal(isWebGLInitializationError(new Error('WebGL initialization failed.')), true);
  assert.equal(isWebGLInitializationError('Error constructing CesiumWidget'), true);
  assert.equal(
    isWebGLInitializationError(new Error('The browser supports WebGL, but initialization failed.')),
    true,
  );
  assert.equal(
    isWebGLInitializationError(new Error(
      'Vertex texture fetch support is required to render polylines. '
      + 'The maximum number of vertex texture image units must be greater than zero.',
    )),
    true,
  );
  assert.equal(
    isWebGLInitializationError(new Error(
      'Width must be less than or equal to the maximum texture size (0).  Check maximumTextureSize.',
    )),
    true,
  );
  assert.equal(isWebGLInitializationError(new Error('CONTEXT_LOST_WEBGL lost')), true);
  assert.equal(isWebGLInitializationError(new Error('maximumAliasedLineWidth is 0')), true);
  assert.equal(isWebGLInitializationError(new Error('Failed to create a rendering context')), true);
  assert.equal(isWebGLInitializationError(new Error('GOOGLE_MAPS_API_KEY not found')), false);
  assert.equal(isWebGLInitializationError(new Error('OpenSky rate limited')), false);
});

test('compatibility presentation is accessible and reveals the guidance', () => {
  const classes = new Set(['hidden']);
  const attributes = new Map();
  const details = { hidden: true };
  const loadingScreen = {
    classList: {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
    },
    setAttribute: (name, value) => attributes.set(name, value),
    querySelector: (selector) => (selector === '.webgl-compatibility' ? details : null),
  };
  const loaderAttributes = new Map();
  const loaderStatus = {
    textContent: '',
    setAttribute: (name, value) => loaderAttributes.set(name, value),
  };

  assert.equal(showWebGLCompatibilityState({
    loadingScreen,
    loaderStatus,
    reason: WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
  }), true);
  assert.equal(classes.has('hidden'), false);
  assert.equal(classes.has('compatibility-error'), true);
  assert.equal(attributes.get('aria-labelledby'), 'webgl-compatibility-title');
  assert.equal(loaderAttributes.get('role'), 'alert');
  assert.equal(loaderAttributes.get('aria-live'), 'assertive');
  assert.match(loaderStatus.textContent, /GPU features/);
  assert.equal(details.hidden, false);
});

test('every compatibility reason has its own operator-facing copy', () => {
  const seen = new Set();
  for (const reason of Object.values(WEBGL_COMPATIBILITY_REASONS)) {
    const loaderStatus = { textContent: '', setAttribute: () => {} };
    showWebGLCompatibilityState({
      loadingScreen: {
        classList: { add: () => {}, remove: () => {} },
        setAttribute: () => {},
        querySelector: () => null,
      },
      loaderStatus,
      reason,
    });
    assert.ok(loaderStatus.textContent.length > 0, `${reason} has no copy`);
    assert.equal(seen.has(loaderStatus.textContent), false, `${reason} reuses another reason's copy`);
    seen.add(loaderStatus.textContent);
  }
});

test('the capability gate runs before Cesium viewer construction', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const probeIndex = main.indexOf('probeWebGLCapability()');
  const viewerIndex = main.indexOf("new Cesium.Viewer('cesiumContainer'");
  assert.ok(probeIndex >= 0, 'main startup must run the WebGL capability probe');
  assert.ok(viewerIndex > probeIndex, 'the capability probe must precede Cesium viewer construction');
  assert.match(
    main.slice(probeIndex, viewerIndex),
    /if \(!webglCapability\.supported\)[\s\S]*?showWebGLCompatibilityState[\s\S]*?return;/,
  );
});

test('the capability gate runs before any startup timer or data layer', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  /** Index of a STATEMENT (not a mention in prose) matching `pattern`. */
  const statementIndex = (pattern) => main.search(pattern);

  const probeIndex = statementIndex(/^\s*const webglCapability = probeWebGLCapability\(\);/m);
  assert.ok(probeIndex >= 0, 'the probe must be a module-scope statement');

  const gateIndex = statementIndex(/^\s*if \(!webglCapability\.supported\) \{/m);
  assert.ok(gateIndex > probeIndex, 'the gate must follow the probe');

  // initLogoGaze installs animation timers; the data manager opens network
  // polls. Neither may run before the verdict is known and acted on.
  for (const [label, pattern] of [
    ['initLogoGaze()', /^\s*initLogoGaze\(\);/m],
    ['new DataLayerManager(', /^\s*const dataManager = new DataLayerManager\(/m],
  ]) {
    const at = statementIndex(pattern);
    assert.ok(at >= 0, `${label} must still exist in startup`);
    assert.ok(at > gateIndex, `${label} must not run before the capability gate`);
  }
});

/** A scene whose canvas hands back a context reporting `limits`. */
function sceneWith(limits, { contextLost = false, canvas = undefined } = {}) {
  const gl = context({ limits, contextLost });
  return {
    canvas: canvas !== undefined ? canvas : {
      getContext: (name) => (name === 'webgl2' ? gl : null),
    },
  };
}

test("the viewer's own context is accepted when it is healthy", () => {
  const verdict = validateSceneContext(sceneWith({}));
  assert.equal(verdict.reason, null);
  assert.equal(verdict.limits.maxTextureSize, 16384);
});

test('the zeroed texture size Cesium would cache is rejected before a frame', () => {
  // The production failure: Cesium caches the limit into ContextLimits at
  // Context construction and Scene.render then throws "Width must be less than
  // or equal to the maximum texture size (0)" every frame.
  const verdict = validateSceneContext(sceneWith({ maxTextureSize: 0 }));
  assert.equal(verdict.reason, WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize);
  assert.equal(verdict.limits.maxTextureSize, 0, 'the report carries the rejected number');
});

test("a zeroed vertex-texture or line-width limit on the viewer's context is rejected", () => {
  assert.equal(
    validateSceneContext(sceneWith({ maxVertexTextureImageUnits: 0 })).reason,
    WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
  );
  assert.equal(
    validateSceneContext(sceneWith({ aliasedLineWidthRange: [0, 0] })).reason,
    WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange,
  );
});

test('an unreadable context fails OPEN rather than blocking a working GPU', () => {
  // A check that cannot see the GPU must never be the thing that stops it.
  // This is the regression that matters: reading Cesium.ContextLimits through
  // the bundled namespace yields a zero snapshot and condemned a browser that
  // renders the globe perfectly.
  for (const scene of [
    undefined,
    null,
    {},
    { canvas: null },
    { canvas: {} },
    sceneWith({}, { canvas: { getContext: () => null } }),
  ]) {
    const verdict = validateSceneContext(scene);
    assert.equal(verdict.reason, null, 'an unreadable context must not condemn startup');
    assert.equal(verdict.limits, null);
  }
});

test('a lost viewer context is not mistaken for zeroed limits', () => {
  // Reported by the render-error backstop instead, which names it as lost.
  const verdict = validateSceneContext(sceneWith({ maxTextureSize: 0 }, { contextLost: true }));
  assert.equal(verdict.reason, null);
});

test('readSceneContextLimits reuses the canvas context rather than making one', () => {
  // canvas.getContext returns the SAME context for a canvas that already has
  // one of that type, which is what makes this the viewer's real context.
  const gl = context({ limits: { maxTextureSize: 4096 } });
  let calls = 0;
  const limits = readSceneContextLimits({
    canvas: {
      getContext(name) {
        calls += 1;
        return name === 'webgl2' ? gl : null;
      },
    },
  });
  assert.equal(calls, 1, 'webgl2 is asked for first and answers');
  assert.equal(limits.maxTextureSize, 4096);
  assert.deepEqual(limits.aliasedLineWidthRange, [1, 1]);
});

test('a WebGL1-only viewer context is still read', () => {
  const gl = context({ limits: { maxTextureSize: 2048 } });
  const limits = readSceneContextLimits({
    canvas: { getContext: (name) => (name === 'webgl' ? gl : null) },
  });
  assert.equal(limits.maxTextureSize, 2048);
});

test('a Cesium startup failure names the limit it actually rejected', () => {
  assert.equal(
    classifyCesiumStartupError(new Error(
      'Width must be less than or equal to the maximum texture size (0).  Check maximumTextureSize.',
    )),
    WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize,
  );
  assert.equal(
    classifyCesiumStartupError(new Error('Vertex texture fetch support is required to render polylines.')),
    WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
  );
  assert.equal(
    classifyCesiumStartupError(new Error('CONTEXT_LOST_WEBGL lost')),
    WEBGL_COMPATIBILITY_REASONS.contextLost,
  );
  assert.equal(
    classifyCesiumStartupError(new Error('maximumAliasedLineWidth is 0')),
    WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange,
  );
  assert.equal(
    classifyCesiumStartupError(new Error('The browser supports WebGL, but initialization failed.')),
    WEBGL_COMPATIBILITY_REASONS.unavailable,
  );
});

test("the viewer's own context is validated before the render loop can run", () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const viewerIndex = main.indexOf("new Cesium.Viewer('cesiumContainer'");
  const checkIndex = main.indexOf('validateSceneContext(viewer.scene)');
  assert.ok(checkIndex > viewerIndex, 'the check must read the constructed context');
  // Everything that could start a frame, a timer, or a poll comes after it.
  for (const [label, pattern] of [
    ['targetFrameRate', /^\s*viewer\.targetFrameRate = /m],
    ['DataLayerManager', /^\s*const dataManager = new DataLayerManager\(/m],
    ['installRenderGovernor', /^\s*installRenderGovernor\(viewer\);/m],
  ]) {
    const at = main.search(pattern);
    assert.ok(at >= 0, `${label} must still exist in startup`);
    assert.ok(at > checkIndex, `${label} must not run before the context-limit check`);
  }
  // And the failing branch tears the viewer down rather than leaving it live.
  const failureBranch = main.slice(main.indexOf('if (sceneContext.reason) {', checkIndex));
  const destroyAt = failureBranch.indexOf('viewer.destroy()');
  const showAt = failureBranch.indexOf('showWebGLCompatibilityState');
  const returnAt = failureBranch.indexOf('return;');
  assert.ok(destroyAt > 0, 'the failing branch must tear the viewer down');
  assert.ok(showAt > destroyAt, 'and then show the compatibility state');
  assert.ok(returnAt > showAt, 'and then stop startup');
});

test('a GPU capability error raised while rendering reaches the compatibility state', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(
    main,
    /viewer\.scene\.renderError\.addEventListener\([\s\S]{0,400}?showWebGLCompatibilityState/,
    'Cesium stops its render loop on a render error; the UI must say why',
  );
});

test('a terminal GPU verdict is reported once, naming the stage and the limits', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // "Unsupported browser" alone is not actionable; the report must say which
  // limit was rejected and where it was caught.
  assert.match(main, /function reportGpuIncompatibility\(stage, reason, limits\)/);
  for (const stage of ['probe', 'cesium-context', 'render']) {
    assert.ok(
      main.includes(`reportGpuIncompatibility('${stage}'`),
      `the ${stage} path must report its verdict`,
    );
  }
});
