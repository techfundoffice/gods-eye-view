export const WEBGL_COMPATIBILITY_REASONS = Object.freeze({
  unavailable: 'webgl-unavailable',
  insufficientVertexTextures: 'vertex-texture-fetch-unavailable',
});

function unsupported(reason, details = {}) {
  return {
    supported: false,
    reason,
    contextType: null,
    maxVertexTextureImageUnits: 0,
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

/**
 * Check the minimum WebGL capability used by Cesium primitives before the
 * application constructs its real viewer.
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

  let maxVertexTextureImageUnits = 0;
  try {
    maxVertexTextureImageUnits = Number(
      gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    );
  } catch {
    maxVertexTextureImageUnits = 0;
  } finally {
    releaseProbeContext(gl);
  }

  if (!Number.isFinite(maxVertexTextureImageUnits) || maxVertexTextureImageUnits < 1) {
    return unsupported(
      WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures,
      { contextType, maxVertexTextureImageUnits: 0 },
    );
  }

  return {
    supported: true,
    reason: null,
    contextType,
    maxVertexTextureImageUnits,
  };
}

/** Whether a thrown Cesium startup error describes WebGL context creation. */
export function isWebGLInitializationError(error) {
  const text = [
    error?.name,
    error?.message,
    error?.stack,
    typeof error === 'string' ? error : '',
  ].filter(Boolean).join(' ');
  return /\bwebgl\b|constructing cesiumwidget|vertex texture fetch/i.test(text);
}

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
  loaderStatus.textContent = reason === WEBGL_COMPATIBILITY_REASONS.insufficientVertexTextures
    ? 'This browser cannot provide the GPU features required by the 3D globe.'
    : 'A usable WebGL graphics context could not be created.';
  loaderStatus.setAttribute('role', 'alert');
  loaderStatus.setAttribute('aria-live', 'assertive');
  const details = loadingScreen.querySelector('.webgl-compatibility');
  if (details) details.hidden = false;
  return true;
}