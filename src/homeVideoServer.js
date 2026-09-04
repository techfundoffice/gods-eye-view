/**
 * Public routes for the home-page video player.
 *
 * `GET  /api/home-video`           ADMIN defaults + shared now-playing + queue
 * `POST /api/home-video/recommend` moderate a viewer URL, queue it if it passes
 * `POST /api/home-video/advance`   the current video ended; take the next one
 *
 * The queue is shared runtime state, so what one viewer queues is what the
 * capture page (and therefore the broadcast) plays. Nothing enters it without
 * clearing `moderateRecommendation`, and an unverifiable video is refused --
 * see `homeVideoModeration.js`.
 *
 * @module homeVideoServer
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  REASON_UNAVAILABLE,
  moderateRecommendation,
  normalizeHomeVideoConfig,
  parseYoutubeUrl,
} from './homeVideoModeration.js';

export const HOME_VIDEO_PREFIX = '/api/home-video';
export const ADMIN_STATE_FILE = '.gev-cache/admin-state.json';
export const HOME_VIDEO_MAX_BODY_BYTES = 8_000;
export const HOME_VIDEO_MAX_QUEUE = 20;
/** Per-address budget for the moderated route; it makes an upstream call. */
export const HOME_VIDEO_RATE_LIMIT = 10;
export const HOME_VIDEO_RATE_WINDOW_MS = 60_000;
export const HOME_VIDEO_MAX_NAME_LENGTH = 80;

/**
 * Read the ADMIN-persisted player settings straight off disk.
 *
 * This mirrors `readHermesYoutubeAdminConfig`: these routes are public and
 * hold no admin session, so the settings come from the same state file the
 * ADMIN console writes. A missing or hand-broken file degrades to defaults,
 * which means an empty approved list -- the fail-closed direction.
 *
 * @param {string} [file]
 * @returns {{ defaultVideoUrl: string, defaultPlaylistUrl: string, approvedChannels: string[] }}
 */
export function readHomeVideoConfig(file = ADMIN_STATE_FILE) {
  try {
    const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    return normalizeHomeVideoConfig(JSON.parse(fs.readFileSync(resolved, 'utf8'))?.homeVideo);
  } catch {
    return normalizeHomeVideoConfig(null);
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > HOME_VIDEO_MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Request must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const bounded = (value, max) => String(value ?? '').trim().slice(0, max);

/**
 * @param {object} [options]
 * @param {() => object} [options.readConfig] ADMIN-persisted settings.
 * @param {() => string} [options.readApiKey] Server-side YouTube Data API key.
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {{ middleware: Function, state: () => object, reset: () => void }}
 */
export function createHomeVideoServer(options = {}) {
  const {
    readConfig = () => readHomeVideoConfig(),
    readApiKey = () => process.env.YOUTUBE_API_KEY || '',
    fetchImpl = undefined,
    now = () => Date.now(),
  } = options;

  /** @type {{ videoId: string, url: string, title: string, channelTitle: string, requestedBy: string, at: number }[]} */
  let queue = [];
  let nowPlaying = null;
  const rate = new Map();

  function config() {
    return normalizeHomeVideoConfig(readConfig() || null);
  }

  function overRate(key) {
    const at = now();
    const entry = rate.get(key);
    if (!entry || at >= entry.resetAt) {
      rate.set(key, { count: 1, resetAt: at + HOME_VIDEO_RATE_WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > HOME_VIDEO_RATE_LIMIT;
  }

  function snapshot() {
    const current = config();
    return {
      defaultVideoUrl: current.defaultVideoUrl,
      defaultPlaylistUrl: current.defaultPlaylistUrl,
      // The UI says so out loud rather than pretending recommendations work.
      licenseCheckAvailable: Boolean(String(readApiKey() || '').trim()),
      approvedChannelCount: current.approvedChannels.length,
      nowPlaying,
      queue: queue.map(({ videoId, url, title, channelTitle, requestedBy }) => ({
        videoId, url, title, channelTitle, requestedBy,
      })),
    };
  }

  /**
   * Moderate one URL and queue it when it passes.
   *
   * @param {{ url?: string, requestedBy?: string }} input
   * @returns {Promise<object>} the viewer-facing result
   */
  async function recommend(input) {
    const current = config();
    const url = bounded(input?.url, 300);
    const requestedBy = bounded(input?.requestedBy, HOME_VIDEO_MAX_NAME_LENGTH);

    if (queue.length >= HOME_VIDEO_MAX_QUEUE) {
      return { allowed: false, reason: 'QUEUE IS FULL — try again after a few videos' };
    }
    const verdict = await moderateRecommendation(url, {
      approvedChannels: current.approvedChannels,
      apiKey: readApiKey(),
      fetchImpl,
    });
    // `allowed` goes last: spreading `verdict` over it would restore its own value.
    if (!verdict.allowed) return { ...verdict, allowed: false };

    if (queue.some((entry) => entry.videoId === verdict.videoId)
      || nowPlaying?.videoId === verdict.videoId) {
      return { ...verdict, allowed: false, reason: 'ALREADY QUEUED' };
    }
    const entry = {
      videoId: verdict.videoId,
      url: `https://www.youtube.com/watch?v=${verdict.videoId}`,
      title: verdict.title || verdict.videoId,
      channelTitle: verdict.channelTitle,
      requestedBy,
      at: now(),
    };
    queue.push(entry);
    return { ...verdict, allowed: true, queued: queue.length, title: entry.title };
  }

  /**
   * Advance only when the caller finished the item that is actually current.
   * Without that check any visitor could drain the queue by replaying the call.
   *
   * @param {{ finishedVideoId?: string }} input
   * @returns {object}
   */
  function advance(input) {
    const current = config();
    const playingId = nowPlaying?.videoId
      || parseYoutubeUrl(current.defaultVideoUrl).id
      || '';
    const finished = bounded(input?.finishedVideoId, 20);
    if (finished && playingId && finished !== playingId) {
      return { advanced: false, reason: 'STALE', ...snapshot() };
    }
    nowPlaying = queue.shift() || null;
    return { advanced: true, ...snapshot() };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {Function} next
   */
  async function middleware(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith(HOME_VIDEO_PREFIX)) return next();
    const rest = url.pathname.slice(HOME_VIDEO_PREFIX.length).replace(/\/+$/, '');

    try {
      if (rest === '' && req.method === 'GET') return send(res, 200, snapshot());

      if (rest === '/recommend' && req.method === 'POST') {
        const key = req.socket?.remoteAddress || 'unknown';
        if (overRate(key)) {
          return send(res, 429, { allowed: false, reason: 'TOO MANY REQUESTS — wait a minute' });
        }
        const body = await readBody(req);
        const result = await recommend(body);
        // An unverifiable video is a server-side gap, not the viewer's mistake.
        const status = result.allowed ? 200 : (result.reason === REASON_UNAVAILABLE ? 503 : 400);
        return send(res, status, result);
      }

      if (rest === '/advance' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        return send(res, 200, advance(body));
      }

      if (rest === '' || rest === '/recommend' || rest === '/advance') {
        return send(res, 405, { error: { kind: 'method', message: 'Method not allowed' } });
      }
    } catch (error) {
      return send(res, error?.status || 500, { error: { kind: 'request', message: error?.message || 'Request failed' } });
    }
    return next();
  }

  return {
    middleware,
    state: snapshot,
    recommend,
    advance,
    reset() {
      queue = [];
      nowPlaying = null;
      rate.clear();
    },
  };
}
