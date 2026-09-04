const sanitizeError = (error) => String(error?.message || error || 'Training failed').slice(0, 240);

export function createIdleTrainingCoordinator({
  train,
  idleMs = 30_000,
  maxRunMs = 20_000,
  minIntervalMs = 60_000,
  maxRunsPerWindow = 4,
  windowMs = 60 * 60_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof train !== 'function') throw new TypeError('train callback is required');
  if (![idleMs, maxRunMs, minIntervalMs, windowMs].every((n) => Number.isFinite(n) && n >= 0)
    || !Number.isInteger(maxRunsPerWindow) || maxRunsPerWindow < 1) {
    throw new TypeError('Training bounds must be non-negative finite numbers');
  }
  let enabled = false;
  let timer = null;
  let active = null;
  let lastViewerAt = now();
  let lastRunAt = null;
  let lastResult = null;
  let lastError = '';
  let runs = [];
  let preemptions = 0;

  const clearScheduled = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const prune = () => { runs = runs.filter((time) => now() - time < windowMs); };
  const allowedAt = () => {
    prune();
    const idleAt = lastViewerAt + idleMs;
    const intervalAt = lastRunAt == null ? 0 : lastRunAt + minIntervalMs;
    const windowAt = runs.length < maxRunsPerWindow ? 0 : runs[0] + windowMs;
    return Math.max(idleAt, intervalAt, windowAt);
  };
  const schedule = () => {
    clearScheduled();
    if (!enabled || active) return;
    const wait = Math.max(0, allowedAt() - now());
    timer = setTimer(() => {
      timer = null;
      void trigger('idle');
    }, wait);
    timer?.unref?.();
  };
  const trigger = async (reason = 'manual') => {
    if (!enabled) return { started: false, reason: 'disabled' };
    if (active) return active.promise;
    const wait = allowedAt() - now();
    if (wait > 0) {
      schedule();
      return { started: false, reason: 'rate-or-idle-limit', retryAt: now() + wait };
    }
    clearScheduled();
    const controller = new AbortController();
    const startedAt = now();
    runs.push(startedAt);
    lastRunAt = startedAt;
    let timeout;
    const run = {
      controller,
      startedAt,
      reason,
      promise: null,
    };
    run.promise = (async () => {
      try {
        timeout = setTimer(() => controller.abort(new Error('Training time limit exceeded')), maxRunMs);
        timeout?.unref?.();
        // Abort is cooperative: once a run has started, wait for its complete
        // execution/observation/learning transaction to settle. This prevents a
        // viewer lease from racing a lesson or generated-skill commit.
        const value = await train({ signal: controller.signal, reason, startedAt, deadline: startedAt + maxRunMs });
        lastResult = value == null ? null : structuredClone(value);
        lastError = '';
        return { started: true, ok: true, result: lastResult };
      } catch (error) {
        lastError = sanitizeError(error);
        return { started: true, ok: false, cancelled: controller.signal.aborted, error: lastError };
      } finally {
        if (timeout) clearTimer(timeout);
        if (active === run) active = null;
        schedule();
      }
    })();
    active = run;
    return run.promise;
  };
  const viewerActivity = (reason = 'viewer activity') => {
    lastViewerAt = now();
    clearScheduled();
    // Viewer work postpones the next run, but never interrupts the training
    // task that is already executing.
    void reason;
    schedule();
    return status();
  };
  const status = () => {
    prune();
    return {
      enabled,
      state: active ? 'training' : timer !== null ? 'waiting' : 'idle',
      active: Boolean(active),
      startedAt: active?.startedAt ?? null,
      nextEligibleAt: enabled ? allowedAt() : null,
      lastViewerAt,
      lastRunAt,
      runsInWindow: runs.length,
      maxRunsPerWindow,
      preemptions,
      lastResult: lastResult == null ? null : structuredClone(lastResult),
      lastError,
    };
  };
  return {
    start() { enabled = true; schedule(); return status(); },
    stop(reason = 'Training stopped') {
      enabled = false;
      clearScheduled();
      active?.controller.abort(new Error(reason));
      return status();
    },
    pause(reason) { return this.stop(reason || 'Training paused'); },
    resume() { return this.start(); },
    trigger,
    notifyViewerActivity: viewerActivity,
    preemptForViewerActivity: viewerActivity,
    cancel(reason = 'Training cancelled') {
      clearScheduled();
      active?.controller.abort(new Error(reason));
      if (enabled) schedule();
      return status();
    },
    status,
  };
}