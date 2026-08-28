/**
 * @module webglCapability
 * @description The GPU capability boundary that runs before data layers,
 * timers, or network polling starts.
 *
 * Cesium reads its whole `ContextLimits` table once, at `Context` construction,
 * straight out of `gl.getParameter` (see
 * `@cesium/engine/Source/Renderer/Context.js`). It does not sanity-check those
 * numbers. On a software/emulated or partially initialized context they can come
 * back as 0, NaN, or mutually contradictory, and Cesium then fails deep inside
 * the render loop — `PolylineCollection` throws "Vertex texture fetch support is
 * required to render polylines" when `MAX_VERTEX_TEXTURE_IMAGE_UNITS` is 0,
 * `Texture` throws "Width must be less than or equal to the maximum texture
 * size (0)" when `MAX_TEXTURE_SIZE` is 0, and `ContextLimits`
 * `maximumAliasedLineWidth` silently becomes 0 when `ALIASED_LINE_WIDTH_RANGE`
 * is junk. Each of those is an uncaught error per frame, forever.
 *
 * So every limit Cesium consumes is validated here against the WebGL 1.0 spec
 * floor (Table 6.18 "Implementation Dependent Values") and against the
 * invariants the spec guarantees. Anything zero, non-finite, context-lost, or
 * internally inconsistent is classified UNSUPPORTED and the app stops at the
 * compatibility screen instead of entering the render loop.
 */

export const WEBGL_COMPATIBILITY_REASONS = Object.freeze({
  unavailable: 'webgl-unavailable',
  contextLost: 'webgl-context-lost',
  insufficientVertexTextures: 'vertex-texture-fetch-unavailable',
  insufficientTextureSize: 'texture-size-unavailable',
  invalidLineWidthRange: 'aliased-line-width-range-invalid',
  inconsistentLimits: 'gpu-limits-inconsistent',
});

/**
 * WebGL 1.0 spec floors for the limits Cesium reads at context construction.
 * A conformant implementation cannot report less than these, so a smaller
 * value means the context is emulated, lost, or lying — not merely modest.
 * `maxVertexTextureImageUnits` is the one exception: the spec floor is 0, but
 * Cesium's `PolylineCollection`/`Primitive` per-instance attribute path
 * requires at least 1, which is what the trails and tracked-target lines use.
 * @type {ReadonlyArray<{key: string, parameter: string, minimum: number, reason: string}>}
 */
const SCALAR_LIMITS = Object.freeze([
  {
    key: 'maxVertexTextureImageUnits',
    parameter: 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
    minimum: 1,
    reason: WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
  },
  {
    key: 'maxTextureSize',
    parameter: 'MAX_TEXTURE_SIZE',
    minimum: 64,
    reason: WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize,
  },
  {
    key: 'maxCubeMapTextureSize',
    parameter: 'MAX_CUBE_MAP_TEXTURE_SIZE',
    minimum: 16,
    reason: WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize,
  },
  {
    key: 'maxRenderbufferSize',
    parameter: 'MAX_RENDERBUFFER_SIZE',
    minimum: 1,
    reason: WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize,
  },
  {
    key: 'maxTextureImageUnits',
    parameter: 'MAX_TEXTURE_IMAGE_UNITS',
    minimum: 8,
    reason: WEBGL_COMPATIBILITY_REASONS.inconsistentLimits,
  },
  {
    key: 'maxVertexAttributes',
    parameter: 'MAX_VERTEX_ATTRIBS',
    minimum: 8,
    reason: WEBGL_COMPATIBILITY_REASONS.inconsistentLimits,
  },
]);

/** @constant {object} Limit values reported for a context we never reached. */
const NO_LIMITS = Object.freeze({
  maxVertexTextureImageUnits: 0,
  maxTextureSize: 0,
  maxCubeMapTextureSize: 0,
  maxRenderbufferSize: 0,
  maxTextureImageUnits: 0,
  maxVertexAttributes: 0,
  aliasedLineWidthRange: null,
  maxViewportDimensions: null,
});

function unsupported(reason, details = {}) {
  return {
    supported: false,
    reason,
    contextType: null,
    maxVertexTextureImageUnits: 0,
    limits: NO_LIMITS,
    ...details,
  };
}

function releaseProbeContext(gl) {
  try {
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
  } catch {
    // Context release is best-effort; capability detection has already finished.
  }
}

/** Read one numeric limit, mapping any throw or absent enum to NaN. */
function readScalar(gl, parameter) {
  try {
    const enumValue = gl[parameter];
    if (enumValue === undefined) return Number.NaN;
    return Number(gl.getParameter(enumValue));
  } catch {
    return Number.NaN;
  }
}

function readScalarOr(gl, parameter, fallback) {
  const value = readScalar(gl, parameter);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Read a limit reported as a 2-element numeric range/pair. Typed arrays,
 * plain arrays, and array-likes all normalize to `[a, b]`; anything else,
 * including a partially initialized context returning `null`, yields `null`.
 */
function readPair(gl, parameter) {
  let raw;
  try {
    const enumValue = gl[parameter];
    if (enumValue === undefined) return null;
    raw = gl.getParameter(enumValue);
  } catch {
    return null;
  }
  if (!raw || typeof raw.length !== 'number' || raw.length < 2) return null;
  return [Number(raw[0]), Number(raw[1])];
}

/**
 * Validate the collected limits. Returns a failure reason, or null when every
 * value is usable AND mutually consistent.
 * @param {object} limits - Limits read from the probe context.
 * @returns {string|null} A `WEBGL_COMPATIBILITY_REASONS` value, or null.
 */
export function classifyWebGLLimits(limits = {}) {
  for (const { key, minimum, reason } of SCALAR_LIMITS) {
    const value = Number(limits[key]);
    // Zero and non-finite are the two shapes seen in the failing previews;
    // both mean Cesium's ContextLimits table would be unusable.
    if (!Number.isFinite(value) || value < minimum) return reason;
  }

  const range = limits.aliasedLineWidthRange;
  if (!Array.isArray(range) || range.length < 2) {
    return WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange;
  }
  const [minWidth, maxWidth] = range.map(Number);
  if (!Number.isFinite(minWidth) || !Number.isFinite(maxWidth)) {
    return WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange;
  }
  // Cesium stores range[1] as ContextLimits.maximumAliasedLineWidth; a zero or
  // sub-1 maximum makes every line-width clamp collapse to nothing.
  if (maxWidth < 1 || minWidth <= 0) {
    return WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange;
  }
  // Spec invariants: the range is ordered and MUST contain 1.0. A context that
  // violates either is reporting internally inconsistent limits.
  if (minWidth > maxWidth || minWidth > 1) {
    return WEBGL_COMPATIBILITY_REASONS.inconsistentLimits;
  }

  const viewport = limits.maxViewportDimensions;
  if (!Array.isArray(viewport) || viewport.length < 2) {
    return WEBGL_COMPATIBILITY_REASONS.inconsistentLimits;
  }
  const [viewportWidth, viewportHeight] = viewport.map(Number);
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
    || viewportWidth < 1 || viewportHeight < 1) {
    return WEBGL_COMPATIBILITY_REASONS.inconsistentLimits;
  }
  // A drawing surface smaller than one texture the driver claims to accept is
  // contradictory: Cesium sizes its framebuffers from the viewport and its
  // render targets from the texture limit, so the two must agree.
  if (viewportWidth < Math.min(64, Number(limits.maxTextureSize))) {
    return WEBGL_COMPATIBILITY_REASONS.inconsistentLimits;
  }

  return null;
}

/**
 * Check every WebGL limit Cesium consumes before the application constructs
 * its real viewer.
 * @param {object} [options] - Probe options.
 * @param {function(): (HTMLCanvasElement|undefined)} [options.createCanvas] -
 *   Canvas factory (injected in tests).
 * @returns {{supported: boolean, reason: string|null, contextType: string|null,
 *   maxVertexTextureImageUnits: number, limits: object}} Capability verdict.
 */
export function probeWebGLCapability({
  createCanvas = () => globalThis.document?.createElement?.('canvas'),
} = {}) {
  let canvas;
  try {
    canvas = createCanvas?.();
  } catch {
    return unsupported(WEBGL_COMPATIBILITY_REASONS.unavailable);
  }
  if (!canvas?.getContext) {
    return unsupported(WEBGL_COMPATIBILITY_REASONS.unavailable);
  }

  let gl = null;
  let contextType = null;
  for (const candidate of ['webgl2', 'webgl', 'experimental-webgl']) {
    try {
      gl = canvas.getContext(candidate, {
        alpha: false,
        antialias: false,
        depth: true,
        failIfMajorPerformanceCaveat: false,
        powerPreference: 'high-performance',
      });
    } catch {
      gl = null;
    }
    if (gl) {
      contextType = candidate;
      break;
    }
  }
  if (!gl) {
    return unsupported(WEBGL_COMPATIBILITY_REASONS.unavailable);
  }

  // A context that is already lost reports zeros for everything; classifying
  // that as "insufficient texture size" would send the user chasing a driver
  // problem they do not have.
  let contextLost = false;
  try {
    contextLost = gl.isContextLost?.() === true;
  } catch {
    contextLost = true;
  }
  if (contextLost) {
    releaseProbeContext(gl);
    return unsupported(WEBGL_COMPATIBILITY_REASONS.contextLost, { contextType });
  }

  let limits;
  try {
    limits = {
      maxVertexTextureImageUnits: readScalar(gl, 'MAX_VERTEX_TEXTURE_IMAGE_UNITS'),
      maxTextureSize: readScalar(gl, 'MAX_TEXTURE_SIZE'),
      maxCubeMapTextureSize: readScalar(gl, 'MAX_CUBE_MAP_TEXTURE_SIZE'),
      maxRenderbufferSize: readScalar(gl, 'MAX_RENDERBUFFER_SIZE'),
      maxTextureImageUnits: readScalar(gl, 'MAX_TEXTURE_IMAGE_UNITS'),
      maxVertexAttributes: readScalar(gl, 'MAX_VERTEX_ATTRIBS'),
      aliasedLineWidthRange: readPair(gl, 'ALIASED_LINE_WIDTH_RANGE'),
      maxViewportDimensions: readPair(gl, 'MAX_VIEWPORT_DIMS'),
    };
  } catch {
    releaseProbeContext(gl);
    return unsupported(WEBGL_COMPATIBILITY_REASONS.unavailable, { contextType });
  }

  // Reading the table can itself kill a marginal context. Re-check before
  // trusting numbers that may have been captured mid-teardown.
  try {
    if (gl.isContextLost?.() === true) {
      releaseProbeContext(gl);
      return unsupported(WEBGL_COMPATIBILITY_REASONS.contextLost, { contextType });
    }
  } catch {
    releaseProbeContext(gl);
    return unsupported(WEBGL_COMPATIBILITY_REASONS.contextLost, { contextType });
  }

  releaseProbeContext(gl);

  const failure = classifyWebGLLimits(limits);
  if (failure) {
    return unsupported(failure, { contextType, limits: Object.freeze({ ...limits }) });
  }

  return {
    supported: true,
    reason: null,
    contextType,
    maxVertexTextureImageUnits: limits.maxVertexTextureImageUnits,
    limits: Object.freeze({ ...limits }),
  };
}

/**
 * Cesium startup/render failures that mean "this GPU cannot run the globe".
 * Every one of these collapses into the single compatibility state rather than
 * surfacing as a raw error, because the user's action is identical for all of
 * them. Sourced from the messages Cesium actually throws:
 * `Context.js` ("The browser supports WebGL, but initialization failed.",
 * "CONTEXT_LOST_WEBGL lost"), `CesiumWidget.js` ("Error constructing
 * CesiumWidget."), `PolylineCollection.js`/`Primitive.js` ("Vertex texture
 * fetch support is required…"), and `Texture.js` ("… maximum texture size …").
 * @param {*} error - Any thrown value.
 * @returns {boolean} True when the failure is a GPU capability failure.
 */
export function isWebGLInitializationError(error) {
  const text = [
    error?.name,
    error?.message,
    error?.stack,
    typeof error === 'string' ? error : '',
  ].filter(Boolean).join(' ');
  return /\bwebgl2?\b/i.test(text)
    || /constructing cesiumwidget/i.test(text)
    || /vertex texture fetch/i.test(text)
    || /vertex texture image units/i.test(text)
    || /maximum texture size|maximumtexturesize/i.test(text)
    || /aliased ?line ?width|maximumaliasedlinewidth/i.test(text)
    || /context ?_?lost/i.test(text)
    || /failed to (?:create|initialize) (?:a )?(?:rendering |graphics )?context/i.test(text);
}

/**
 * Read Cesium's exported limit snapshot for diagnostics.
 *
 * This is the singleton Cesium's renderer consumes. It remains decisive unless
 * it can be safely reconciled from the same viewer canvas before rendering.
 *
 * @param {object} contextLimits - `Cesium.ContextLimits`.
 * @returns {object|null} Limits in `classifyWebGLLimits` shape, or null when
 *   the table is absent.
 */
export function readCesiumContextLimits(contextLimits) {
  if (!contextLimits) return null;
  const minimumLineWidth = Number(contextLimits.minimumAliasedLineWidth);
  return {
    maxCombinedTextureImageUnits: contextLimits.maximumCombinedTextureImageUnits,
    maxVertexTextureImageUnits: contextLimits.maximumVertexTextureImageUnits,
    maxTextureSize: contextLimits.maximumTextureSize,
    max3DTextureSize: contextLimits.maximum3DTextureSize,
    maxCubeMapTextureSize: contextLimits.maximumCubeMapSize,
    maxRenderbufferSize: contextLimits.maximumRenderbufferSize,
    maxTextureImageUnits: contextLimits.maximumTextureImageUnits,
    maxFragmentUniformVectors: contextLimits.maximumFragmentUniformVectors,
    maxVaryingVectors: contextLimits.maximumVaryingVectors,
    maxVertexAttributes: contextLimits.maximumVertexAttributes,
    maxVertexUniformVectors: contextLimits.maximumVertexUniformVectors,
    aliasedLineWidthRange: [
      // Cesium stores the range's ends separately and leaves the minimum at
      // its 0 initializer on some drivers; a 0 there is not a bad range.
      Number.isFinite(minimumLineWidth) && minimumLineWidth > 0 ? minimumLineWidth : 1,
      contextLimits.maximumAliasedLineWidth,
    ],
    maxViewportDimensions: [
      contextLimits.maximumViewportWidth,
      contextLimits.maximumViewportHeight,
    ],
    aliasedPointSizeRange: [
      contextLimits.minimumAliasedPointSize,
      contextLimits.maximumAliasedPointSize,
    ],
    maxTextureFilterAnisotropy: contextLimits.maximumTextureFilterAnisotropy,
    maxDrawBuffers: contextLimits.maximumDrawBuffers,
    maxColorAttachments: contextLimits.maximumColorAttachments,
    maxSamples: contextLimits.maximumSamples,
    highpFloatSupported: contextLimits.highpFloatSupported,
    highpIntSupported: contextLimits.highpIntSupported,
  };
}

const CESIUM_LIMIT_BACKING_FIELDS = Object.freeze({
  maxCombinedTextureImageUnits: ['maximumCombinedTextureImageUnits', '_maximumCombinedTextureImageUnits'],
  maxVertexTextureImageUnits: '_maximumVertexTextureImageUnits',
  maxTextureSize: '_maximumTextureSize',
  max3DTextureSize: ['maximum3DTextureSize', '_maximum3DTextureSize'],
  maxCubeMapTextureSize: '_maximumCubeMapSize',
  maxRenderbufferSize: '_maximumRenderbufferSize',
  maxTextureImageUnits: '_maximumTextureImageUnits',
  maxFragmentUniformVectors: ['maximumFragmentUniformVectors', '_maximumFragmentUniformVectors'],
  maxVaryingVectors: ['maximumVaryingVectors', '_maximumVaryingVectors'],
  maxVertexAttributes: '_maximumVertexAttributes',
  maxVertexUniformVectors: ['maximumVertexUniformVectors', '_maximumVertexUniformVectors'],
  maxTextureFilterAnisotropy: ['maximumTextureFilterAnisotropy', '_maximumTextureFilterAnisotropy'],
  maxDrawBuffers: ['maximumDrawBuffers', '_maximumDrawBuffers'],
  maxColorAttachments: ['maximumColorAttachments', '_maximumColorAttachments'],
  maxSamples: ['maximumSamples', '_maximumSamples'],
  highpFloatSupported: ['highpFloatSupported', '_highpFloatSupported'],
  highpIntSupported: ['highpIntSupported', '_highpIntSupported'],
});

/**
 * Reconcile Cesium's renderer-consumed singleton from the viewer's live WebGL
 * context. This only succeeds when every required backing field is writable
 * and the public table reads back as healthy after the update.
 */
function reconcileCesiumContextLimits(contextLimits, liveLimits) {
  if (!contextLimits || classifyWebGLLimits(liveLimits)) return null;
  const scalarEntries = Object.entries(CESIUM_LIMIT_BACKING_FIELDS).map(
    ([key, field]) => [key, ...(Array.isArray(field) ? field : [
      key === 'maxCubeMapTextureSize' ? 'maximumCubeMapSize'
        : key.replace(/^max/, 'maximum').replace(/^highp/, 'highp'),
      field,
    ])],
  );
  const pairEntries = [
    ['minimumAliasedLineWidth', '_minimumAliasedLineWidth', liveLimits.aliasedLineWidthRange?.[0]],
    ['maximumAliasedLineWidth', '_maximumAliasedLineWidth', liveLimits.aliasedLineWidthRange?.[1]],
    ['minimumAliasedPointSize', '_minimumAliasedPointSize', liveLimits.aliasedPointSizeRange?.[0]],
    ['maximumAliasedPointSize', '_maximumAliasedPointSize', liveLimits.aliasedPointSizeRange?.[1]],
    ['maximumViewportWidth', '_maximumViewportWidth', liveLimits.maxViewportDimensions?.[0]],
    ['maximumViewportHeight', '_maximumViewportHeight', liveLimits.maxViewportDimensions?.[1]],
  ];
  const writes = [
    ...scalarEntries.map(([key, publicName, field]) => [publicName, field, liveLimits[key]]),
    ...pairEntries,
  ];
  if (writes.some(([, field]) => {
    const descriptor = Object.getOwnPropertyDescriptor(contextLimits, field);
    return !descriptor?.writable;
  })) return null;

  for (const [, field, value] of writes) contextLimits[field] = value;
  if (writes.some(([publicName, , value]) => !Object.is(contextLimits[publicName], value))) {
    return null;
  }
  const reconciled = readCesiumContextLimits(contextLimits);
  return reconciled && !classifyWebGLLimits(reconciled) ? reconciled : null;
}

/**
 * Read the limits of the WebGL context bound to the viewer's canvas.
 *
 * A second, independent look at the same GPU. `canvas.getContext` returns the
 * SAME context object for a canvas that already has one of that type (HTML
 * spec), so this reaches the viewer's own context through public API — useful
 * when the limit table cannot be read, and as corroboration when it can.
 *
 * @param {object} scene - `viewer.scene`.
 * @returns {object|null} Limits in `classifyWebGLLimits` shape, or null when
 *   the context cannot be reached.
 */
export function readSceneContextLimits(scene) {
  const canvas = scene?.canvas;
  if (!canvas?.getContext) return null;
  let gl = null;
  for (const candidate of ['webgl2', 'webgl', 'experimental-webgl']) {
    try {
      gl = canvas.getContext(candidate);
    } catch {
      gl = null;
    }
    if (gl) break;
  }
  if (!gl) return null;
  try {
    if (gl.isContextLost?.() === true) return null;
  } catch {
    return null;
  }
  const maxVertexTextureImageUnits = readScalar(gl, 'MAX_VERTEX_TEXTURE_IMAGE_UNITS');
  const maxTextureImageUnits = readScalar(gl, 'MAX_TEXTURE_IMAGE_UNITS');
  let pointRange = readPair(gl, 'ALIASED_POINT_SIZE_RANGE');
  if (!pointRange) pointRange = [1, 1];
  let anisotropy = 1;
  try {
    const extension = gl.getExtension?.('EXT_texture_filter_anisotropic')
      || gl.getExtension?.('WEBKIT_EXT_texture_filter_anisotropic');
    if (extension?.MAX_TEXTURE_MAX_ANISOTROPY_EXT !== undefined) {
      anisotropy = Number(gl.getParameter(extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
    }
  } catch {
    anisotropy = 1;
  }
  const precisionSupported = (precision, field) => {
    try {
      const format = gl.getShaderPrecisionFormat?.(gl.FRAGMENT_SHADER, gl[precision]);
      return Boolean(format) && Number(format[field]) !== 0;
    } catch {
      return false;
    }
  };
  return {
    maxCombinedTextureImageUnits: readScalarOr(
      gl,
      'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
      Number(maxVertexTextureImageUnits) + Number(maxTextureImageUnits),
    ),
    maxVertexTextureImageUnits,
    maxTextureSize: readScalar(gl, 'MAX_TEXTURE_SIZE'),
    max3DTextureSize: readScalarOr(gl, 'MAX_3D_TEXTURE_SIZE', 0),
    maxCubeMapTextureSize: readScalar(gl, 'MAX_CUBE_MAP_TEXTURE_SIZE'),
    maxRenderbufferSize: readScalar(gl, 'MAX_RENDERBUFFER_SIZE'),
    maxTextureImageUnits,
    maxFragmentUniformVectors: readScalarOr(gl, 'MAX_FRAGMENT_UNIFORM_VECTORS', 16),
    maxVaryingVectors: readScalarOr(gl, 'MAX_VARYING_VECTORS', 8),
    maxVertexAttributes: readScalar(gl, 'MAX_VERTEX_ATTRIBS'),
    maxVertexUniformVectors: readScalarOr(gl, 'MAX_VERTEX_UNIFORM_VECTORS', 128),
    aliasedLineWidthRange: readPair(gl, 'ALIASED_LINE_WIDTH_RANGE'),
    aliasedPointSizeRange: pointRange,
    maxViewportDimensions: readPair(gl, 'MAX_VIEWPORT_DIMS'),
    maxTextureFilterAnisotropy: Number.isFinite(anisotropy) ? anisotropy : 1,
    maxDrawBuffers: readScalarOr(gl, 'MAX_DRAW_BUFFERS', 1),
    maxColorAttachments: readScalarOr(gl, 'MAX_COLOR_ATTACHMENTS', 1),
    maxSamples: readScalarOr(gl, 'MAX_SAMPLES', 0),
    highpFloatSupported: precisionSupported('HIGH_FLOAT', 'precision'),
    highpIntSupported: precisionSupported('HIGH_INT', 'rangeMax'),
  };
}

/**
 * Verdict on the viewer Cesium just built, taken before the first frame.
 *
 * Both the live viewer canvas and Cesium's renderer-consumed singleton must be
 * usable. When the canvas is healthy but the singleton is still at its writable
 * zero initializer, reconcile that exact singleton from the same context and
 * verify it before rendering. If reconciliation cannot be proven, fail closed.
 *
 * @param {object} scene - `viewer.scene`.
 * @param {object} contextLimits - `Cesium.ContextLimits`.
 * @returns {{reason: string|null, limits: object|null, source: string|null,
 *   diagnostics: {cesiumContextLimits: object|null}}}
 *   Verdict, the live numbers behind it, and non-authoritative diagnostics.
 */
export function validateSceneContext(scene, contextLimits) {
  const cesiumLimits = readCesiumContextLimits(contextLimits);
  const diagnostics = {
    cesiumContextLimits: cesiumLimits,
  };
  const limits = readSceneContextLimits(scene);
  if (limits) {
    const liveReason = classifyWebGLLimits(limits);
    if (liveReason) {
      return {
        reason: liveReason, limits, source: 'viewer-canvas-context', diagnostics,
      };
    }
  }

  const cesiumReason = cesiumLimits && classifyWebGLLimits(cesiumLimits);
  if (cesiumReason) {
    const reconciled = limits
      ? reconcileCesiumContextLimits(contextLimits, limits)
      : null;
    if (!reconciled) {
      return {
        reason: cesiumReason,
        limits: cesiumLimits,
        source: 'cesium-context-limits',
        diagnostics,
      };
    }
    diagnostics.reconciledCesiumContextLimits = reconciled;
    return {
      reason: null,
      limits,
      source: 'viewer-canvas-context-reconciled',
      diagnostics,
    };
  }

  if (!limits && !cesiumLimits) {
    return { reason: null, limits: null, source: null, diagnostics };
  }
  return {
    reason: null,
    limits: limits || cesiumLimits,
    source: limits ? 'viewer-canvas-context' : 'cesium-context-limits',
    diagnostics,
  };
}

/**
 * Map a Cesium startup/render failure onto the compatibility reason it
 * describes, so the loader names the actual fault instead of falling back to
 * the generic "no context" copy. Callers should gate on
 * `isWebGLInitializationError` first; anything unrecognised here is reported
 * as an unavailable context.
 * @param {*} error - Any thrown value.
 * @returns {string} A `WEBGL_COMPATIBILITY_REASONS` value.
 */
export function classifyCesiumStartupError(error) {
  const text = [
    error?.name,
    error?.message,
    error?.stack,
    typeof error === 'string' ? error : '',
  ].filter(Boolean).join(' ');
  if (/context ?_?lost/i.test(text)) return WEBGL_COMPATIBILITY_REASONS.contextLost;
  if (/vertex texture fetch|vertex texture image units/i.test(text)) {
    return WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures;
  }
  if (/maximum texture size|maximumtexturesize/i.test(text)) {
    return WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize;
  }
  if (/aliased ?line ?width|maximumaliasedlinewidth/i.test(text)) {
    return WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange;
  }
  return WEBGL_COMPATIBILITY_REASONS.unavailable;
}

/** @constant {Object<string,string>} Reason -> operator-facing loader copy. */
const COMPATIBILITY_MESSAGES = Object.freeze({
  [WEBGL_COMPATIBILITY_REASONS.unavailable]:
    'A usable WebGL graphics context could not be created.',
  [WEBGL_COMPATIBILITY_REASONS.contextLost]:
    'The WebGL graphics context was lost before the 3D globe could start.',
  [WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures]:
    'This browser cannot provide the GPU features required by the 3D globe.',
  [WEBGL_COMPATIBILITY_REASONS.insufficientTextureSize]:
    'This GPU reports no usable texture memory limits for the 3D globe.',
  [WEBGL_COMPATIBILITY_REASONS.invalidLineWidthRange]:
    'This GPU reports an unusable line-width range for the 3D globe.',
  [WEBGL_COMPATIBILITY_REASONS.inconsistentLimits]:
    'This GPU reports inconsistent graphics limits that the 3D globe cannot use.',
});

/** Present the existing loading surface as the terminal compatibility state. */
export function showWebGLCompatibilityState({
  loadingScreen,
  loaderStatus,
  reason = WEBGL_COMPATIBILITY_REASONS.unavailable,
} = {}) {
  if (!loadingScreen || !loaderStatus) return false;
  loadingScreen.classList.remove('hidden');
  loadingScreen.classList.add('compatibility-error');
  loadingScreen.setAttribute('aria-labelledby', 'webgl-compatibility-title');
  loaderStatus.textContent = COMPATIBILITY_MESSAGES[reason]
    || COMPATIBILITY_MESSAGES[WEBGL_COMPATIBILITY_REASONS.unavailable];
  loaderStatus.setAttribute('role', 'alert');
  loaderStatus.setAttribute('aria-live', 'assertive');
  const details = loadingScreen.querySelector('.webgl-compatibility');
  if (details) details.hidden = false;
  return true;
}
