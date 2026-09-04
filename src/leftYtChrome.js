/**
 * Left-column YouTube-style top chrome toolbar.
 * Wires Ask / Search / Mic / Create / Bell to existing GEV surfaces (best-effort).
 *
 * @module leftYtChrome
 */

/**
 * @param {string} text
 */
function softToast(text) {
  try {
    const el = globalThis.document?.getElementById('toast');
    if (el) {
      el.textContent = text;
      el.classList.add('visible');
      globalThis.clearTimeout?.(softToast._t);
      softToast._t = globalThis.setTimeout?.(() => {
        el.classList.remove('visible');
      }, 2200);
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    console.info('[left-yt-chrome]', text);
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement | null | undefined} el
 */
function focusScroll(el) {
  if (!el) return false;
  try {
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  } catch {
    try { el.scrollIntoView?.(); } catch { /* ignore */ }
  }
  try {
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  } catch {
    try { el.focus?.(); } catch { /* ignore */ }
  }
  return true;
}

/**
 * @param {Document} doc
 */
function syncBellBadge(doc) {
  const badge = doc.getElementById('left-yt-bell-badge');
  const countEl = doc.getElementById('youtube-comments-count');
  if (!badge) return;
  let n = null;
  if (countEl) {
    const raw = (countEl.textContent || '').replace(/[^\d]/g, '');
    if (raw) n = Number.parseInt(raw, 10);
  }
  if (Number.isFinite(n) && n >= 0) {
    badge.textContent = String(n > 99 ? '99+' : n);
    badge.hidden = n <= 0;
    badge.classList.toggle('is-empty', n <= 0);
  }
}

/**
 * @param {Document} [doc]
 * @returns {{ stop: () => void } | null}
 */
export function initLeftYtChrome(doc = globalThis.document) {
  if (!doc?.getElementById) return null;
  const root = doc.getElementById('left-yt-chrome');
  if (!root) return null;

  const ask = doc.getElementById('left-yt-ask');
  const search = doc.getElementById('left-yt-search');
  const mic = doc.getElementById('left-yt-mic');
  const create = doc.getElementById('left-yt-create');
  const bell = doc.getElementById('left-yt-bell');

  const onAsk = () => {
    const comments = doc.getElementById('youtube-comments-panel');
    if (comments) {
      focusScroll(comments);
      return;
    }
    softToast('Youtube Chat panel not available');
    const admin = doc.getElementById('admin-launch');
    if (admin) {
      try { admin.click(); } catch { /* ignore */ }
    }
  };

  const onSearch = () => {
    const input = doc.getElementById('location-search');
    const toggle = doc.getElementById('search-toggle');
    if (input) {
      const style = globalThis.getComputedStyle?.(input);
      const hidden =
        !input.offsetParent ||
        (style && (style.visibility === 'hidden' || style.display === 'none' || Number.parseFloat(style.opacity || '1') === 0)) ||
        (!input.classList.contains('expanded') && input.clientWidth < 40);
      if (hidden && toggle) {
        try { toggle.click(); } catch { /* ignore */ }
      }
      focusScroll(input);
      try { input.focus(); } catch { /* ignore */ }
      return;
    }
    if (toggle) {
      try { toggle.click(); } catch { /* ignore */ }
      return;
    }
    softToast('Location search not available');
  };

  const onMic = () => {
    const voiceBtn = doc.getElementById('gev-voice-button');
    if (voiceBtn) {
      try { voiceBtn.click(); } catch { /* ignore */ }
      return;
    }
    const top = doc.getElementById('top-center-actions');
    let clicked = false;
    if (top) {
      const buttons = top.querySelectorAll('button');
      for (const btn of buttons) {
        const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.textContent || ''}`.toLowerCase();
        if (label.includes('mic') || label.includes('voice')) {
          try { btn.click(); clicked = true; } catch { /* ignore */ }
          break;
        }
      }
    }
    if (!clicked) softToast('Voice control not available');
  };

  const onCreate = () => {
    const admin = doc.getElementById('admin-launch');
    if (admin) {
      try { admin.click(); } catch { /* ignore */ }
      return;
    }
    softToast('Create / ADMIN entry not available');
  };

  const onBell = () => {
    syncBellBadge(doc);
    const comments = doc.getElementById('youtube-comments-panel');
    if (comments) {
      focusScroll(comments);
      return;
    }
    softToast('Youtube Chat panel not available');
  };

  ask?.addEventListener('click', onAsk);
  search?.addEventListener('click', onSearch);
  mic?.addEventListener('click', onMic);
  create?.addEventListener('click', onCreate);
  bell?.addEventListener('click', onBell);

  syncBellBadge(doc);
  let observer = null;
  const countEl = doc.getElementById('youtube-comments-count');
  if (countEl && globalThis.MutationObserver) {
    try {
      observer = new MutationObserver(() => syncBellBadge(doc));
      observer.observe(countEl, { characterData: true, childList: true, subtree: true });
    } catch {
      observer = null;
    }
  }

  return {
    stop() {
      ask?.removeEventListener('click', onAsk);
      search?.removeEventListener('click', onSearch);
      mic?.removeEventListener('click', onMic);
      create?.removeEventListener('click', onCreate);
      bell?.removeEventListener('click', onBell);
      try { observer?.disconnect?.(); } catch { /* ignore */ }
    },
  };
}
