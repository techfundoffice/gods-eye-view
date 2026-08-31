/**
 * Reproducible Chromium and FFmpeg discovery for ADMIN Go Live.
 *
 * The encoder already searches PATH. This module makes the chosen binaries
 * explicit on `process.env` so a Nix store accident is not the only way the
 * capture path works, without committing a hashed store path.
 *
 * @module encoderRuntime
 */

import { accessSync, constants } from 'node:fs';
import { resolveChromiumPath, resolveFfmpegPath } from './liveStream.js';

function defaultExists(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const CHROMIUM_FALLBACKS = Object.freeze([
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/local/bin/chromium',
  '/usr/local/bin/google-chrome',
]);

const FFMPEG_FALLBACKS = Object.freeze([
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
]);

/**
 * First executable path among explicit env, PATH search, then known prefixes.
 *
 * @param {object} [options]
 * @returns {{chromium: string, ffmpeg: string}}
 */
export function discoverEncoderRuntime({
  env = process.env,
  exists = defaultExists,
  chromiumFallbacks = CHROMIUM_FALLBACKS,
  ffmpegFallbacks = FFMPEG_FALLBACKS,
} = {}) {
  const chromium = resolveChromiumPath(env, exists)
    || chromiumFallbacks.find((candidate) => exists(candidate))
    || '';
  const ffmpeg = resolveFfmpegPath(env, exists)
    || ffmpegFallbacks.find((candidate) => exists(candidate))
    || '';
  return { chromium, ffmpeg };
}

/**
 * Copy discovered binaries into `CHROME_PATH` / `FFMPEG_PATH` when unset.
 *
 * Existing explicit env values always win. Returns the effective paths.
 *
 * @param {object} [options]
 * @returns {{chromium: string, ffmpeg: string, applied: boolean}}
 */
export function applyEncoderRuntimeEnv({
  env = process.env,
  exists,
} = {}) {
  const found = discoverEncoderRuntime({ env, exists });
  let applied = false;
  if (found.chromium && !String(env.CHROME_PATH || '').trim()) {
    env.CHROME_PATH = found.chromium;
    applied = true;
  }
  if (found.ffmpeg && !String(env.FFMPEG_PATH || '').trim()) {
    env.FFMPEG_PATH = found.ffmpeg;
    applied = true;
  }
  return {
    chromium: String(env.CHROME_PATH || found.chromium || ''),
    ffmpeg: String(env.FFMPEG_PATH || found.ffmpeg || ''),
    applied,
  };
}
