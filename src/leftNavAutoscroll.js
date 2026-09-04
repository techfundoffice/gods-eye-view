/**
 * Left-nav Auto Scroll: tippy-top checkbox drives yo-yo scroll on
 * #left-panel-stack (down to bottom, then back to top).
 *
 * @module leftNavAutoscroll
 */

const STORAGE_KEY = 'gev:left-nav-autoscroll';
const SPEED_PX_PER_SEC = 48;
const RESUME_DELAY_MS = 1500;

/**
 * @returns {boolean}
 */
function prefersReducedMotion() {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/**
 * @param {HTMLElement} stack
 * @returns {number}
 */
function maxScrollTop(stack) {
  return Math.max(0, stack.scrollHeight - stack.clientHeight);
}

/**
 * @param {Document} [doc]
 * @returns {{ stop: () => void } | null}
 */
export function initLeftNavAutoscroll(doc = globalThis.document) {
  const stack = doc.getElementById('left-panel-stack');
  const checkbox = doc.getElementById('left-nav-autoscroll');
  if (!stack || !checkbox) return null;

  let enabled = false;
  let direction = 1; // 1 down, -1 up
  let raf = 0;
  let lastTs = 0;
  let paused = false;
  let resumeTimer = 0;
  let running = false;

  try {
    const saved = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    // Default ON. Only an explicit '0' turns it off across the session.
    if (saved === '0') checkbox.checked = false;
    else checkbox.checked = true;
  } catch {
    checkbox.checked = true;
  }

  function stopLoop() {
    running = false;
    lastTs = 0;
    if (raf) {
      globalThis.cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function tick(ts) {
    if (!running || !enabled) {
      stopLoop();
      return;
    }
    if (paused || prefersReducedMotion()) {
      lastTs = ts;
      raf = globalThis.requestAnimationFrame(tick);
      return;
    }
    const max = maxScrollTop(stack);
    if (max <= 1) {
      lastTs = ts;
      raf = globalThis.requestAnimationFrame(tick);
      return;
    }
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.064, (ts - lastTs) / 1000);
    lastTs = ts;
    let next = stack.scrollTop + direction * SPEED_PX_PER_SEC * dt;
    if (next >= max) {
      next = max;
      direction = -1;
    } else if (next <= 0) {
      next = 0;
      direction = 1;
    }
    stack.scrollTop = next;
    raf = globalThis.requestAnimationFrame(tick);
  }

  function startLoop() {
    if (running || !enabled) return;
    if (prefersReducedMotion()) return;
    running = true;
    lastTs = 0;
    raf = globalThis.requestAnimationFrame(tick);
  }

  function syncFromCheckbox() {
    enabled = Boolean(checkbox.checked) && !prefersReducedMotion();
    try {
      globalThis.sessionStorage?.setItem(STORAGE_KEY, checkbox.checked ? '1' : '0');
    } catch {
      /* ignore */
    }
    stack.classList.toggle('left-nav-autoscroll-on', enabled);
    checkbox.setAttribute('aria-checked', checkbox.checked ? 'true' : 'false');
    if (enabled) {
      if (stack.scrollTop >= maxScrollTop(stack) - 1) direction = -1;
      else if (stack.scrollTop <= 0) direction = 1;
      startLoop();
    } else {
      stopLoop();
    }
  }

  function pauseForInteraction() {
    paused = true;
    if (resumeTimer) globalThis.clearTimeout(resumeTimer);
    resumeTimer = globalThis.setTimeout(() => {
      paused = false;
      resumeTimer = 0;
    }, RESUME_DELAY_MS);
  }

  checkbox.addEventListener('change', syncFromCheckbox);
  stack.addEventListener('pointerenter', () => { if (enabled) paused = true; });
  stack.addEventListener('pointerleave', () => {
    if (!enabled) return;
    if (resumeTimer) globalThis.clearTimeout(resumeTimer);
    resumeTimer = globalThis.setTimeout(() => {
      paused = false;
      resumeTimer = 0;
    }, RESUME_DELAY_MS);
  });
  stack.addEventListener('pointerdown', pauseForInteraction, { capture: true });
  stack.addEventListener('wheel', pauseForInteraction, { passive: true });
  stack.addEventListener('keydown', pauseForInteraction, true);

  // If reduced motion, keep checkbox usable but force off motion.
  try {
    const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    mq?.addEventListener?.('change', syncFromCheckbox);
  } catch {
    /* ignore */
  }

  syncFromCheckbox();

  return {
    stop() {
      stopLoop();
      if (resumeTimer) globalThis.clearTimeout(resumeTimer);
    },
  };
}
