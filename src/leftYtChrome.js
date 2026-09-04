/**
 * Left-column YouTube-style top chrome toolbar.
 * Wires Ask / Search / Mic / Music / Create / Bell to existing GEV surfaces (best-effort).
 *
 * @module leftYtChrome
 */

import {
  EVENT as ROYALTY_FREE_MUSIC_EVENT,
  FALLBACK_URLS,
  getPlaylistUrls,
  loadLibrary,
  readConfig,
  resolvePlaylist,
  writeConfig,
} from './royaltyFreeMusic.js';

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

const MUSIC_SPEED_KEY = "gev:left-yt-music-speed";
const MUSIC_SPEEDS = [0.5, 0.75, 0.85, 1, 1.25, 1.5];

/**
 * @param {Document} doc
 * @returns {number}
 */
function readSpeed(doc) {
  const sel = doc.getElementById("left-yt-music-speed");
  let raw = sel?.value;
  if (raw == null || raw === "") {
    try { raw = globalThis.sessionStorage?.getItem(MUSIC_SPEED_KEY); } catch { /* ignore */ }
  }
  const n = Number.parseFloat(String(raw ?? "1"));
  if (MUSIC_SPEEDS.includes(n)) return n;
  return 1;
}

/**
 * @param {Document} doc
 * @param {number} rate
 */
function writeSpeed(doc, rate) {
  const sel = doc.getElementById("left-yt-music-speed");
  if (sel) sel.value = String(rate);
  try { globalThis.sessionStorage?.setItem(MUSIC_SPEED_KEY, String(rate)); } catch { /* ignore */ }
}

function createRoyaltyFreeMusicPlayer(doc) {
  /** @type {HTMLAudioElement | null} */
  let audio = null;
  let trackIndex = 0;
  /** @type {string[]} */
  let playlistUrls = [...FALLBACK_URLS];

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

  const refreshPlaylist = async () => {
    try {
      const urls = await getPlaylistUrls();
      playlistUrls = Array.isArray(urls) && urls.length ? urls : [...FALLBACK_URLS];
    } catch (err) {
      console.warn("[left-yt-chrome] playlist resolve failed", err);
      playlistUrls = [...FALLBACK_URLS];
    }
    if (trackIndex >= playlistUrls.length) trackIndex = 0;
    return playlistUrls;
  };

  const ensureAudio = () => {
    if (audio) return audio;
    audio = doc.createElement("audio");
    audio.id = "left-yt-music-audio";
    audio.preload = "none";
    audio.playbackRate = readSpeed(doc);
    audio.preservesPitch = true;
    audio.loop = false;
    audio.style.display = "none";
    audio.dataset.gevRoyaltyFreeMusic = "true";
    audio.addEventListener("ended", () => {
      if (!playlistUrls.length) {
        syncUi(false);
        return;
      }
      trackIndex = (trackIndex + 1) % playlistUrls.length;
      if (!audio) return;
      audio.src = playlistUrls[trackIndex];
      audio.play().then(() => syncUi(true)).catch(() => syncUi(false));
    });
    audio.addEventListener("pause", () => {
      if (audio && !audio.ended) syncUi(false);
    });
    audio.addEventListener("play", () => syncUi(true));
    (doc.body || doc.documentElement).appendChild(audio);
    return audio;
  };

  const onConfigChanged = () => {
    void (async () => {
      const wasPlaying = Boolean(audio && !audio.paused && !audio.ended);
      await refreshTitles();
      await refreshPlaylist();
      syncTrackSelect();
      if (!audio) return;
      if (!playlistUrls.length) {
        try { audio.pause(); } catch { /* ignore */ }
        syncUi(false);
        softToast("Music beds disabled");
        return;
      }
      if (wasPlaying) {
        trackIndex = 0;
        audio.src = playlistUrls[0];
        try {
          await audio.play();
          syncUi(true);
        } catch {
          syncUi(false);
        }
      }
      // If paused, updated list applies on next play / ended.
    })();
  };

  /** @type {Map<string, string>} */
  let titleByUrl = new Map();

  const refreshTitles = async () => {
    try {
      const library = await loadLibrary();
      const map = new Map();
      const tracks = Array.isArray(library?.tracks) ? library.tracks : [];
      for (const t of tracks) {
        const url = String(t?.url || "").trim();
        const title = String(t?.title || "").trim();
        if (url && title) map.set(url, title);
      }
      titleByUrl = map;
    } catch (err) {
      console.warn("[left-yt-chrome] loadLibrary titles failed", err);
    }
  };

  const labelForUrl = (url, i) => {
    const known = titleByUrl.get(url);
    if (known) return known;
    const name = (url.split("/").pop() || url)
      .replace(/\.mp3$/i, "")
      .replace(/soundhelix-/i, "SoundHelix Song ");
    return name || `Track ${i + 1}`;
  };

  const syncTrackSelect = () => {
    const sel = doc.getElementById("left-yt-music-track");
    if (!sel) return;
    const current = playlistUrls[trackIndex] || "";
    const opts = playlistUrls.map((url, i) => {
      const label = labelForUrl(url, i);
      return `<option value="${url.replace(/"/g, "&quot;")}">${label}</option>`;
    });
    sel.innerHTML = opts.length
      ? opts.join("")
      : '<option value="">No tracks</option>';
    if (current) {
      try { sel.value = current; } catch { /* ignore */ }
    }
  };

  try {
    globalThis.document?.addEventListener?.(ROYALTY_FREE_MUSIC_EVENT, onConfigChanged);
    globalThis.addEventListener?.(ROYALTY_FREE_MUSIC_EVENT, onConfigChanged);
  } catch { /* ignore */ }

  // Fill TRACK with real SoundHelix titles ASAP (never leave "Loading…")
  syncTrackSelect();
  void (async () => {
    await refreshTitles();
    syncTrackSelect();
    await refreshPlaylist();
    syncTrackSelect();
  })();

  return {
    syncTrackSelect,
    isPlaying() {
      return Boolean(audio && !audio.paused && !audio.ended);
    },
    setRate(rate) {
      const n = Number.parseFloat(String(rate));
      const speed = MUSIC_SPEEDS.includes(n) ? n : 1;
      writeSpeed(doc, speed);
      if (audio) {
        audio.playbackRate = speed;
        audio.preservesPitch = true;
      }
    },
    async playTrackUrl(url) {
      const target = String(url || "").trim();
      if (!target) return;
      await refreshPlaylist();
      let idx = playlistUrls.indexOf(target);
      if (idx < 0) {
        playlistUrls = [target, ...playlistUrls.filter((u) => u !== target)];
        idx = 0;
      }
      trackIndex = idx;
      const a = ensureAudio();
      a.src = playlistUrls[trackIndex];
      a.playbackRate = readSpeed(doc);
      a.preservesPitch = true;
      try {
        await a.play();
        syncUi(true);
        syncTrackSelect();
      } catch (err) {
        syncUi(false);
        softToast("Music failed to start — try again");
        console.warn("[left-yt-chrome] playTrackUrl failed", err);
      }
    },
    getPlaylist() {
      return playlistUrls.slice();
    },
    async toggle() {
      const a = ensureAudio();
      a.playbackRate = readSpeed(doc);
      a.preservesPitch = true;
      if (!a.paused && !a.ended) {
        a.pause();
        syncUi(false);
        softToast("Music paused");
        return;
      }
      await refreshPlaylist();
      if (!playlistUrls.length) {
        syncUi(false);
        softToast("No music beds enabled — check ADMIN → Royalty-Free Music");
        return;
      }
      if (trackIndex >= playlistUrls.length) trackIndex = 0;
      // Always bind to the resolved playlist entry so ADMIN Save takes effect.
      a.src = playlistUrls[trackIndex];
      try {
        await a.play();
        syncUi(true);
        syncTrackSelect();
        softToast("Royalty-free music playing");
      } catch (err) {
        syncUi(false);
        softToast("Music failed to start — try again");
        console.warn("[left-yt-chrome] music play failed", err);
      }
    },
    stop() {
      try {
        globalThis.document?.removeEventListener?.(ROYALTY_FREE_MUSIC_EVENT, onConfigChanged);
        globalThis.removeEventListener?.(ROYALTY_FREE_MUSIC_EVENT, onConfigChanged);
      } catch { /* ignore */ }
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
  try { musicPlayer.syncTrackSelect?.(); } catch { /* ignore */ }
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
  const trackSel = doc.getElementById('left-yt-music-track');
  const onMusicTrack = () => {
    const url = String(trackSel?.value || '').trim();
    if (!url) return;
    void musicPlayer.playTrackUrl?.(url);
  };
  trackSel?.addEventListener('change', onMusicTrack);

  const speedSel = doc.getElementById('left-yt-music-speed');
  if (speedSel) {
    try {
      const saved = readSpeed(doc);
      speedSel.value = String(saved);
      musicPlayer.setRate(saved);
    } catch { /* ignore */ }
  }
  const onMusicSpeed = () => {
    const rate = Number.parseFloat(String(speedSel?.value || '1')) || 1;
    musicPlayer.setRate(rate);
    softToast(`Music speed ${rate}x`);
  };
  speedSel?.addEventListener('change', onMusicSpeed);

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
      trackSel?.removeEventListener('change', onMusicTrack);
      speedSel?.removeEventListener('change', onMusicSpeed);
      try { musicPlayer.stop(); } catch { /* ignore */ }
      try { observer?.disconnect?.(); } catch { /* ignore */ }
    },
  };
}
