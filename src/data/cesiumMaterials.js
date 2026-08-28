/**
 * @module cesiumMaterials
 * @description Explicit Cesium material construction for entity graphics.
 *
 * Cesium 1.138 wires every entity `material` / `depthFailMaterial` slot through
 * `createMaterialPropertyDescriptor`, whose setter infers a property type from
 * the raw value:
 *
 * ```js
 * function createMaterialProperty(value) {
 *   if (value instanceof Color) return new ColorMaterialProperty(value);
 *   if (typeof value === "string" || value instanceof Resource || …) { … }
 *   throw new DeveloperError(`Unable to infer material type: ${value}`);
 * }
 * ```
 *
 * The inference is an `instanceof` against the `Color` class of the Cesium
 * module instance that owns the descriptor. Anything it cannot place — a
 * `undefined` returned by `Color.fromCssColorString` for an unparseable string,
 * a plain `{red, green, blue}` object, a `Color` from a second Cesium copy —
 * becomes a thrown "Unable to infer material type" at entity-construction time,
 * inside a poll callback, with no layer-level recovery.
 *
 * Building the `ColorMaterialProperty` here removes the inference step
 * entirely: a value that already has `getValue` is passed straight through by
 * `createPropertyDescriptor`. The colour is validated first, so a bad hue
 * degrades to a visible fallback instead of killing the update that produced it.
 */
import * as Cesium from 'cesium';

/** @constant {Cesium.Color} Last-resort hue for an unparseable colour input. */
const FALLBACK_COLOR = Cesium.Color.WHITE;

/** @constant {number} Width used when a caller supplies no usable number. */
export const DEFAULT_LINE_WIDTH = 1;

/**
 * Cesium clamps `gl.lineWidth`-era widths against
 * `ContextLimits.maximumAliasedLineWidth`, and its polyline shaders divide by
 * the width. Zero, negative, NaN and Infinity all reach the GPU as a degenerate
 * quad. 64 is above every width this app draws, so the ceiling only ever
 * catches a computed value that has gone wrong.
 * @constant {number}
 */
const MAX_LINE_WIDTH = 64;

/**
 * Coerce any colour-ish input to a real `Cesium.Color`.
 * @param {Cesium.Color|string|null|undefined} color - Colour or CSS string.
 * @param {Cesium.Color} [fallback=Cesium.Color.WHITE] - Used when unparseable.
 * @returns {Cesium.Color} A usable colour, never undefined.
 */
export function toCesiumColor(color, fallback = FALLBACK_COLOR) {
  if (color instanceof Cesium.Color) return color;
  if (typeof color === 'string' && color.trim()) {
    // fromCssColorString returns undefined (not a throw) for junk input.
    const parsed = Cesium.Color.fromCssColorString(color.trim());
    if (parsed instanceof Cesium.Color) return parsed;
  }
  return fallback;
}

/**
 * Build the explicit `ColorMaterialProperty` an entity `material` /
 * `depthFailMaterial` slot requires.
 * @param {Cesium.Color|string|null|undefined} color - Colour or CSS string.
 * @param {number} [alpha] - Optional alpha override in [0, 1].
 * @returns {Cesium.ColorMaterialProperty} Never a bare Color.
 */
export function colorMaterial(color, alpha) {
  let resolved = toCesiumColor(color);
  if (Number.isFinite(alpha)) {
    resolved = resolved.withAlpha(Math.min(1, Math.max(0, Number(alpha))));
  }
  return new Cesium.ColorMaterialProperty(resolved);
}

/**
 * Normalize a polyline width to a value the renderer can use. Widths already
 * in range are returned unchanged, so intended appearance never shifts.
 * @param {number} width - Requested width in pixels.
 * @param {number} [fallback=DEFAULT_LINE_WIDTH] - Used for unusable input.
 * @returns {number} A finite width in [1, 64].
 */
export function normalizeLineWidth(width, fallback = DEFAULT_LINE_WIDTH) {
  const requested = Number(width);
  const safeFallback = Number.isFinite(fallback) && fallback >= DEFAULT_LINE_WIDTH
    ? Math.min(fallback, MAX_LINE_WIDTH)
    : DEFAULT_LINE_WIDTH;
  if (!Number.isFinite(requested) || requested <= 0) return safeFallback;
  return Math.min(Math.max(requested, DEFAULT_LINE_WIDTH), MAX_LINE_WIDTH);
}
