/**
 * @module webglCapability
 * @description The GPU capability boundary that runs BEFORE any viewer, data
 * layer, timer, or network poll starts.
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
 * Read the limit table CESIUM ITSELF consults at render time.
 *
 * This is the authoritative source, because it is literally the object Cesium
 * branches on. `Primitive.update`:
 *
 * ```js
 * if (ContextLimits.maximumVertexTextureImageUnits === 0) {
 *   throw new RuntimeError("Vertex texture fetch support is required ...");
 * }
 * ```
 *
 * and `Texture` compares against `ContextLimits.maximumTextureSize`. Whatever
 * this table says is what Cesium will act on, so a bad value here is not a
 * prediction of a failure — it IS the failure, one frame early.
 *
 * The table is populated synchronously by the `Context` constructor (which
 * `new Viewer()` runs), so it is valid the moment the viewer returns.
 *
 * @param {object} contextLimits - `Cesium.ContextLimits`.
 * @returns {object|null} Limits in `classifyWebGLLimits` shape, or null when
 *   the table is absent.
 */
export function readCesiumContextLimits(contextLimits) {
  if (!contextLimits) return null;
  const minimumLineWidth = Number(contextLimits.minimumAliasedLineWidth);
  return {
    maxVertexTextureImageUnits: contextLimits.maximumVertexTextureImageUnits,
    maxTextureSize: contextLimits.maximumTextureSize,
    maxCubeMapTextureSize: contextLimits.maximumCubeMapSize,
    maxRenderbufferSize: contextLimits.maximumRenderbufferSize,
    maxTextureImageUnits: contextLimits.maximumTextureImageUnits,
    maxVertexAttributes: contextLimits.maximumVertexAttributes,
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
  };
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
  return {
    maxVertexTextureImageUnits: readScalar(gl, 'MAX_VERTEX_TEXTURE_IMAGE_UNITS'),
    maxTextureSize: readScalar(gl, 'MAX_TEXTURE_SIZE'),
    maxCubeMapTextureSize: readScalar(gl, 'MAX_CUBE_MAP_TEXTURE_SIZE'),
    maxRenderbufferSize: readScalar(gl, 'MAX_RENDERBUFFER_SIZE'),
    maxTextureImageUnits: readScalar(gl, 'MAX_TEXTURE_IMAGE_UNITS'),
    maxVertexAttributes: readScalar(gl, 'MAX_VERTEX_ATTRIBS'),
    aliasedLineWidthRange: readPair(gl, 'ALIASED_LINE_WIDTH_RANGE'),
    maxViewportDimensions: readPair(gl, 'MAX_VIEWPORT_DIMS'),
  };
}

/**
 * Verdict on the viewer Cesium just built, taken before the first frame.
 *
 * Consults BOTH sources and rejects if EITHER is unusable. They can disagree:
 * a page that has already spent several WebGL contexts can hand Cesium a
 * degraded one while a freshly created canvas still reports healthy numbers.
 * Cesium acts on its own table, so a bad table is decisive on its own; a bad
 * canvas context is decisive too, since that is the surface being drawn to.
 *
 * Fails open only when NEITHER source can be read — a check blind to the GPU
 * must not be the thing that stops a working one.
 *
 * @param {object} scene - `viewer.scene`.
 * @param {object} contextLimits - `Cesium.ContextLimits`.
 * @returns {{reason: string|null, limits: object|null, source: string|null}}
 *   Verdict, the numbers behind it, and which source produced it.
 */
export function validateSceneContext(scene, contextLimits) {
  const sources = [
    ['cesium-context-limits', readCesiumContextLimits(contextLimits)],
    ['viewer-canvas-context', readSceneContextLimits(scene)],
  ].filter(([, limits]) => limits);
  if (!sources.length) return { reason: null, limits: null, source: null };
  for (const [source, limits] of sources) {
    const reason = classifyWebGLLimits(limits);
    if (reason) return { reason, limits, source };
  }
  return { reason: null, limits: sources[0][1], source: sources[0][0] };
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
