/**
 * @module feedDiagnostics
 * @description Shared degradation primitives for upstream feeds.
 *
 * Three things were hand-rolled per layer and got them wrong in three different
 * ways, so they live here once:
 *
 *  1. **Error classification.** Every client call site collapsed timeout,
 *     rejected credential, exhausted quota and dead socket into one bare
 *     `catch` that produced "OpenSky network error". An operator cannot act on
 *     that. `classifyFeedError` names the kind so the surfaced diagnostic says
 *     which of the four actually happened.
 *  2. **Bounded backoff.** Layers kept a flat `_retryAt` cooldown, so a feed
 *     that had been failing for an hour still hit it on the same fixed cadence.
 *     `createBoundedBackoff` doubles with a hard ceiling and resets on success.
 *  3. **Rate-limited logging.** A failing 30 s poll wrote one identical
 *     `console.warn` every 30 s forever. `createRateLimitedLogger` emits the
 *     first occurrence of a message immediately, then at most one per interval,
 *     and reports how many were suppressed so nothing is silently lost.
 *
 * `configurationMissing` is separated from the transient kinds on purpose: an
 * absent optional credential is a terminal, non-fatal state, and the correct
 * response is to stop asking rather than to back off.
 */

/** @enum {string} Kinds of upstream feed failure, ordered by operator action. */
export const FEED_ERROR_KINDS = Object.freeze({
  /** The request was cancelled by the layer (teardown, session change). */
  aborted: 'aborted',
  /** No response inside the request deadline. */
  timeout: 'timeout',
  /** Credential missing/rejected upstream (401/403). */
  auth: 'auth',
  /** Rate limit or quota exhausted (429). */
  quota: 'quota',
  /** Optional credential is not configured on this deployment (503 no-key). */
  configurationMissing: 'configuration-missing',
  /** Upstream reachable but broken (5xx). */
  upstream: 'upstream',
  /** Other non-2xx response. */
  http: 'http',
  /** Response arrived but could not be interpreted. */
  malformed: 'malformed',
  /** Transport failure — DNS, socket, offline. */
  network: 'network',
});

/** Kinds that never improve by retrying on the normal cadence. */
const TERMINAL_KINDS = new Set([FEED_ERROR_KINDS.configurationMissing]);

/**
 * Whether a classified failure is a settled state rather than an outage.
 * @param {string} kind - A `FEED_ERROR_KINDS` value.
 * @returns {boolean} True when polling should stop instead of backing off.
 */
export function isTerminalFeedErrorKind(kind) {
  return TERMINAL_KINDS.has(kind);
}

/** Regexes for the credential-absent bodies this app's proxies return. */
const CONFIG_MISSING_PATTERN = /\bno_key\b|is not set|not configured|missing[-_ ]key|not found\. set it as an environment variable/i;

/**
 * Classify an upstream failure into an actionable kind.
 * @param {*} error - The caught value, if any.
 * @param {object} [context] - Response context.
 * @param {number} [context.status] - HTTP status, when a response arrived.
 * @param {string} [context.detail] - Server-supplied error text, when present.
 * @returns {string} A `FEED_ERROR_KINDS` value.
 */
export function classifyFeedError(error, { status, detail } = {}) {
  const name = String(error?.name || '');
  if (name === 'AbortError') return FEED_ERROR_KINDS.aborted;
  if (name === 'TimeoutError') return FEED_ERROR_KINDS.timeout;

  const message = String(error?.message || detail || '');
  const httpStatus = Number(status);
  if (Number.isFinite(httpStatus) && httpStatus > 0) {
    if (httpStatus === 401 || httpStatus === 403) return FEED_ERROR_KINDS.auth;
    if (httpStatus === 429) return FEED_ERROR_KINDS.quota;
    // 503 is overloaded: our own proxies use it for "optional key absent",
    // upstreams use it for "temporarily down". The body decides.
    if (httpStatus === 503 && CONFIG_MISSING_PATTERN.test(String(detail || message))) {
      return FEED_ERROR_KINDS.configurationMissing;
    }
    if (httpStatus >= 500) return FEED_ERROR_KINDS.upstream;
    if (httpStatus >= 400) return FEED_ERROR_KINDS.http;
  }
  if (CONFIG_MISSING_PATTERN.test(message)) return FEED_ERROR_KINDS.configurationMissing;
  if (/\btimed? ?out\b|\btimeout\b/i.test(message)) return FEED_ERROR_KINDS.timeout;
  if (/malformed|unexpected token|invalid json|not valid json/i.test(message)) {
    return FEED_ERROR_KINDS.malformed;
  }
  return FEED_ERROR_KINDS.network;
}

/**
 * Short operator-facing phrase for a classified failure. Used verbatim in
 * layer chips and console diagnostics so both name the same thing.
 * @param {string} kind - A `FEED_ERROR_KINDS` value.
 * @param {string} source - Human name of the upstream ("OpenSky").
 * @returns {string} One line, no trailing punctuation.
 */
export function describeFeedError(kind, source = 'upstream') {
  switch (kind) {
    case FEED_ERROR_KINDS.timeout: return `${source} timed out`;
    case FEED_ERROR_KINDS.auth: return `${source} rejected credentials`;
    case FEED_ERROR_KINDS.quota: return `${source} rate limited`;
    case FEED_ERROR_KINDS.configurationMissing: return `${source} not configured`;
    case FEED_ERROR_KINDS.upstream: return `${source} upstream error`;
    case FEED_ERROR_KINDS.malformed: return `${source} sent an unreadable response`;
    case FEED_ERROR_KINDS.http: return `${source} request rejected`;
    case FEED_ERROR_KINDS.aborted: return `${source} request cancelled`;
    default: return `${source} unreachable`;
  }
}

/**
 * Bounded exponential backoff with jitter and explicit reset.
 *
 * The ceiling is the point of the whole thing: an outage that lasts an hour
 * must not produce an hour of polls, and must not produce an unbounded wait
 * that outlives the outage either.
 *
 * @param {object} [options] - Backoff shape.
 * @param {number} [options.baseMs=20000] - Delay after the first failure.
 * @param {number} [options.maxMs=300000] - Hard ceiling on the delay.
 * @param {number} [options.factor=2] - Growth per consecutive failure.
 * @param {number} [options.jitter=0.2] - Fractional random spread, 0 disables.
 * @param {function(): number} [options.now] - Clock (injected in tests);
 *   defaults to reading `Date.now` per call, never capturing the reference.
 * @param {function(): number} [options.random=Math.random] - RNG (injected in tests).
 * @returns {{fail: function(number=): number, succeed: function(): void,
 *   blockedFor: function(): number, isBlocked: function(): boolean,
 *   consecutiveFailures: function(): number, delayMs: function(): number}}
 *   Backoff handle.
 */
export function createBoundedBackoff({
  baseMs = 20_000,
  maxMs = 300_000,
  factor = 2,
  jitter = 0.2,
  // Read through to the global on every call rather than capturing the
  // function object: a test (or a fake-timer library) that swaps Date.now
  // AFTER this module loads must still drive the clock this backoff sees.
  now = () => Date.now(),
  random = () => Math.random(),
} = {}) {
  let failures = 0;
  let retryAt = 0;
  let delay = 0;

  return {
    /**
     * Record a failure and arm the cooldown.
     * @param {number} [floorMs] - Minimum wait for this failure — a server's
     *   Retry-After, or a per-kind cooldown. The ceiling still wins, so
     *   neither a hostile header nor a long server directive can park the
     *   feed indefinitely.
     * @returns {number} Milliseconds until the next attempt is allowed.
     */
    fail(floorMs) {
      failures += 1;
      const grown = baseMs * Math.pow(factor, failures - 1);
      const floored = Number.isFinite(floorMs) && floorMs > 0
        ? Math.max(grown, Number(floorMs))
        : grown;
      const requested = Math.min(maxMs, floored);
      const spread = jitter > 0 ? requested * jitter * (random() - 0.5) * 2 : 0;
      // Clamp AFTER jitter: a "bounded" backoff whose spread could push it
      // past the ceiling is not bounded. At the cap, jitter only ever reduces.
      delay = Math.min(maxMs, Math.max(0, Math.round(requested + spread)));
      retryAt = now() + delay;
      return delay;
    },
    /** Clear the cooldown after a good response. */
    succeed() {
      failures = 0;
      retryAt = 0;
      delay = 0;
    },
    /** @returns {number} Milliseconds remaining in the cooldown, 0 when clear. */
    blockedFor() {
      return Math.max(0, retryAt - now());
    },
    /** @returns {boolean} True while the caller must skip its poll. */
    isBlocked() {
      return retryAt > now();
    },
    /** @returns {number} Consecutive failures since the last success. */
    consecutiveFailures() {
      return failures;
    },
    /** @returns {number} The most recently armed delay. */
    delayMs() {
      return delay;
    },
  };
}

/**
 * A console writer that says a thing once, then at most once per interval.
 *
 * Repetition is what makes a degraded optional feed read as a broken app. The
 * suppressed count is appended on the next emission so the signal that it is
 * still happening survives.
 *
 * @param {object} [options] - Logger shape.
 * @param {string} [options.prefix=''] - Tag prepended to every line.
 * @param {number} [options.intervalMs=300000] - Minimum gap between repeats.
 * @param {function(...*): void} [options.write] - Sink (defaults to console.warn).
 * @param {function(): number} [options.now] - Clock (injected in tests);
 *   defaults to reading `Date.now` per call, never capturing the reference.
 * @returns {{warn: function(string, string=, ...*): boolean, reset: function(string=): void}}
 *   Logger handle; `warn` returns true when the line was actually written.
 */
export function createRateLimitedLogger({
  prefix = '',
  intervalMs = 300_000,
  write,
  now = () => Date.now(),
} = {}) {
  const sink = write || ((...args) => console.warn(...args));
  /** @type {Map<string, {at: number, suppressed: number}>} */
  const seen = new Map();

  return {
    /**
     * @param {string} message - The diagnostic line.
     * @param {string} [key] - Dedupe key; defaults to the message itself, so
     *   a changing message (a new failure kind) is always reported at once.
     * @param {...*} details - Extra values passed through to the sink.
     * @returns {boolean} Whether the line was written.
     */
    warn(message, key = message, ...details) {
      const at = now();
      const entry = seen.get(key);
      if (entry && at - entry.at < intervalMs) {
        entry.suppressed += 1;
        return false;
      }
      const suppressed = entry?.suppressed || 0;
      seen.set(key, { at, suppressed: 0 });
      const suffix = suppressed > 0 ? ` (${suppressed} similar suppressed)` : '';
      sink(`${prefix}${prefix ? ' ' : ''}${message}${suffix}`, ...details);
      return true;
    },
    /** Forget one key, or all of them, so recovery reports immediately. */
    reset(key) {
      if (key === undefined) seen.clear();
      else seen.delete(key);
    },
  };
}
