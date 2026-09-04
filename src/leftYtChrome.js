/**
 * Left-column YouTube-style top chrome toolbar.
 * Wires Ask / Search / Mic / Music / Create / Bell to existing GEV surfaces (best-effort).
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

/** Local SoundHelix demos (royalty-free sample beds served from /music). */
const ROYALTY_FREE_MUSIC_URLS = [
  "/music/soundhelix-1.mp3",
  "/music/soundhelix-2.mp3",
  "/music/soundhelix-3.mp3",
];

/**
 * @param {Document} doc
 * @returns {{ toggle: () => Promise<void>, stop: () => void, isPlaying: () => boolean }}
 */
function createRoyaltyFreeMusicPlayer(doc) {
  /** @type {HTMLAudioElement | null} */
  let audio = null;
  let trackIndex = 0;

  const btn = () => doc.getElementById("left-yt-music");
  const icon = () => btn()?.querySelector(".material-symbols-outlined");

  const syncUi = (playing) => {
    const b = btn();
    if (!b) return;
    b.setAttribute("aria-pressed", playing ? "true" : "false");
    b.title = playing ? "Pause royalty-free music" : "Play royalty-free music";
    const ic = icon();
    if (ic) ic.textContent = playing ? "volume_up" : "volume_off";
  };

  const ensureAudio = () => {
    if (audio) return audio;
    audio = doc.createElement("audio");
    audio.id = "left-yt-music-audio";
    audio.preload = "none";
    audio.loop = false;
    audio.style.display = "none";
    audio.dataset.gevRoyaltyFreeMusic = "true";
    audio.addEventListener("ended", () => {
      trackIndex = (trackIndex + 1) % ROYALTY_FREE_MUSIC_URLS.length;
      if (!audio) return;
      audio.src = ROYALTY_FREE_MUSIC_URLS[trackIndex];
      audio.play().then(() => syncUi(true)).catch(() => syncUi(false));
    });
    audio.addEventListener("pause", () => {
      if (audio && !audio.ended) syncUi(false);
    });
    audio.addEventListener("play", () => syncUi(true));
    (doc.body || doc.documentElement).appendChild(audio);
    return audio;
  };

  return {
    isPlaying() {
      return Boolean(audio && !audio.paused && !audio.ended);
    },
    async toggle() {
      const a = ensureAudio();
      if (!a.paused && !a.ended) {
        a.pause();
        syncUi(false);
        softToast("Music paused");
        return;
      }
      if (!a.src) a.src = ROYALTY_FREE_MUSIC_URLS[trackIndex];
      try {
        await a.play();
        syncUi(true);
        softToast("Royalty-free music playing");
      } catch (err) {
        syncUi(false);
        softToast("Music failed to start — try again");
        console.warn("[left-yt-chrome] music play failed", err);
      }
    },
    stop() {
      try { audio?.pause?.(); } catch { /* ignore */ }
      try { audio?.remove?.(); } catch { /* ignore */ }
      audio = null;
      syncUi(false);
    },
  };
}

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
  const music = doc.getElementById('left-yt-music');
  const musicPlayer = createRoyaltyFreeMusicPlayer(doc);
  try {
    const ic = music?.querySelector('.material-symbols-outlined');
    if (ic) ic.textContent = 'volume_off';
  } catch { /* ignore */ }

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
  const onMusic = () => { musicPlayer.toggle(); };
  music?.addEventListener('click', onMusic);

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
      music?.removeEventListener('click', onMusic);
      try { musicPlayer.stop(); } catch { /* ignore */ }
      try { observer?.disconnect?.(); } catch { /* ignore */ }
    },
  };
}
