/**
 * Server-only, cache-conscious source selection and optional commentary for a
 * public YouTube trend. This module deliberately exposes a small derived
 * contract: provider replies and transcripts never cross its boundary.
 */
import { parseYoutubeUrl, YOUTUBE_VIDEO_ID_RE } from './homeVideoModeration.js';

export const DEFAULT_YOUTUBE_TRENDING_CONFIG = Object.freeze({
  enabled: false, regionCode: 'US', refreshMinutes: 60, categoryIds: ['0'],
  maxResults: 10, analysisProvider: 'gemini', analysisModel: 'gemini-2.5-flash',
  voiceEnabled: false, avatarEnabled: true, manualVideoUrl: '',
});
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const clamp = (v, lo, hi, fallback) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback));

export function normalizeYoutubeTrendingConfig(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const ids = (Array.isArray(v.categoryIds) ? v.categoryIds : String(v.categoryIds ?? '').split(/[,\s]+/))
    .map((x) => text(x, 12)).filter((x) => /^\d+$/.test(x)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3);
  const manual = text(v.manualVideoUrl, 300);
  return {
    enabled: Boolean(v.enabled), regionCode: /^[A-Za-z]{2}$/.test(text(v.regionCode, 2)) ? text(v.regionCode, 2).toUpperCase() : 'US',
    refreshMinutes: clamp(v.refreshMinutes, 15, 1440, 60), categoryIds: ids.length ? ids : ['0'],
    maxResults: clamp(v.maxResults, 5, 25, 10),
    analysisProvider: text(v.analysisProvider, 32) === 'gemini' ? 'gemini' : 'gemini',
    analysisModel: text(v.analysisModel, 80) || 'gemini-2.5-flash',
    voiceEnabled: Boolean(v.voiceEnabled), avatarEnabled: v.avatarEnabled === undefined ? true : Boolean(v.avatarEnabled),
    manualVideoUrl: parseYoutubeUrl(manual).kind === 'video' ? manual : '',
  };
}

export function selectTrendingVideo(items) {
  return (Array.isArray(items) ? items : []).filter((x) => YOUTUBE_VIDEO_ID_RE.test(String(x?.id || ''))
    && x?.status?.embeddable !== false && String(x?.status?.privacyStatus || 'public') === 'public')
    .sort((a, b) => Number(b?.statistics?.viewCount || 0) - Number(a?.statistics?.viewCount || 0)
      || String(b?.snippet?.publishedAt || '').localeCompare(String(a?.snippet?.publishedAt || ''))
      || String(a.id).localeCompare(String(b.id)))[0] || null;
}
function source(item, regionCode, selectedAt, freshUntil) {
  const s = item.snippet || {};
  return { videoId: text(item.id, 11), url: `https://www.youtube.com/watch?v=${text(item.id, 11)}`,
    title: text(s.title, 300), channelId: text(s.channelId, 64), channelTitle: text(s.channelTitle, 160),
    publishedAt: text(s.publishedAt, 40), viewCount: String(Math.max(0, Number(item?.statistics?.viewCount) || 0)),
    regionCode, categoryId: text(s.categoryId, 12), selectedAt: new Date(selectedAt).toISOString(), freshUntil: new Date(freshUntil).toISOString() };
}
const publicAnalysis = (state) => ({ status: state.status, summary: text(state.summary, 800), segments: (state.segments || []).slice(0, 8).map((x) => ({ atSeconds: clamp(x?.atSeconds, 0, 86400, 0), text: text(x?.text, 240) })), generatedAt: state.generatedAt || null, provider: state.provider || null, model: state.model || null });

export function createYoutubeTrendingCommentary({ readConfig = () => null, getOwnerCall = async () => null, fetchImpl = globalThis.fetch, now = () => Date.now(), readGeminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '' } = {}) {
  let cache = null; let inflight = null;
  const commentary = (cfg) => ({ aiGenerated: true, label: 'AI-GENERATED COMMENTARY',
    voiceEnabled: cfg.voiceEnabled, avatarEnabled: cfg.avatarEnabled,
    // These are client presentation capabilities, not claims about Gemini.
    voice: { status: cfg.voiceEnabled ? 'browser-client-required' : 'disabled' },
    avatar: { status: cfg.avatarEnabled ? 'abstract-avatar' : 'disabled' } });
  async function callJson(call, params) {
    const response = await call('videos', params);
    if (!response || typeof response.json !== 'function') return response || {};
    let payload = {};
    try { payload = await response.json(); } catch { /* Upstream may return an empty body. */ }
    if (!response.ok) {
      const error = new Error(text(payload?.error?.message, 160) || `YouTube request failed (${response.status || 'unknown'})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  async function analyze(src, cfg) {
    const key = text(readGeminiKey(), 500);
    if (!key || typeof fetchImpl !== 'function') {
      const subject = [src.title, src.channelTitle].filter(Boolean).join(' by ') || 'this selected video';
      return { status: 'metadata', summary: `Metadata-only original commentary: ${subject} is trending in ${src.regionCode}. This is not transcript analysis.`, segments: [], generatedAt: null, provider: null, model: null };
    }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.analysisModel)}:generateContent`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [
        { file_data: { file_uri: src.url } },
        { text: 'Return only JSON: {"summary":"short original commentary","segments":[{"atSeconds":0,"text":"short original commentary"}]}. Do not quote or reproduce a transcript. Use at most four short segments.' },
      ] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 600 } }) });
      if (!response?.ok) throw new Error('Gemini request failed');
      const raw = await response.json(); const parsed = JSON.parse(raw?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
      if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.segments)) throw new Error('Invalid Gemini response');
      return publicAnalysis({ status: 'ready', summary: parsed.summary, segments: parsed.segments, generatedAt: new Date(now()).toISOString(), provider: 'gemini', model: cfg.analysisModel });
    } catch { return { status: 'unavailable', summary: 'Commentary provider is temporarily unavailable.', segments: [], generatedAt: null, provider: 'gemini', model: cfg.analysisModel }; } finally { clearTimeout(timer); }
  }
  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const cfg = normalizeYoutubeTrendingConfig(readConfig()); const until = now() + cfg.refreshMinutes * 60_000;
      if (!cfg.enabled) return cache;
      try {
        const call = await getOwnerCall(); if (!call) throw new Error('YouTube owner authorization unavailable');
        let items;
        if (cfg.manualVideoUrl) { const id = parseYoutubeUrl(cfg.manualVideoUrl).id; const r = await callJson(call, { params: { part: 'snippet,statistics,status', id } }); items = r?.items; }
        else {
          const results = await Promise.allSettled(cfg.categoryIds.map(async (videoCategoryId) => {
            const r = await callJson(call, { params: { part: 'snippet,statistics,status', chart: 'mostPopular', regionCode: cfg.regionCode, videoCategoryId, maxResults: cfg.maxResults } });
            return Array.isArray(r?.items) ? r.items : [];
          }));
          const pages = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
          if (!pages.length) throw results[0]?.reason || new Error('YouTube trending categories unavailable');
          const seen = new Set(); items = pages.flat().filter((item) => {
            const id = String(item?.id || ''); if (!id || seen.has(id)) return false; seen.add(id); return true;
          });
        }
        const picked = selectTrendingVideo(items); if (!picked) throw new Error('No embeddable public video available');
        const src = source(picked, cfg.regionCode, now(), until); const revision = `${src.videoId}:${src.publishedAt}:${src.viewCount}`;
        const analysis = cache?.revision === revision ? cache.analysis : await analyze(src, cfg);
        cache = { revision, source: src, analysis, freshUntil: until, error: null }; return cache;
      } catch (error) {
        if (cache?.source) {
          cache.error = { kind: 'source-refresh', message: 'Source refresh failed; serving the cached YouTube video.' };
          return cache;
        }
        // Cache the failure briefly: otherwise an unavailable owner/API can
        // turn every public page view into another quota-consuming request.
        cache = {
          source: null,
          analysis: { status: 'unavailable', summary: '', segments: [], generatedAt: null, provider: null, model: null },
          freshUntil: 0,
          retryUntil: now() + 60_000,
          error: { kind: 'source-unavailable', message: 'Trending source is temporarily unavailable.' },
        };
        return cache;
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }
  async function snapshot({ force = false } = {}) {
    const cfg = normalizeYoutubeTrendingConfig(readConfig());
    if (!cfg.enabled) {
      return { enabled: false, status: 'disabled', source: null,
        analysis: publicAnalysis({ status: 'disabled', summary: '', segments: [] }),
        commentator: commentary(cfg), error: null, cache: { fresh: false, freshUntil: null } };
    }
    const needsRefresh = !cache || (cache.source ? now() >= cache.freshUntil : now() >= (cache.retryUntil || 0));
    if (force) await refresh();
    else if (needsRefresh) {
      // Public callers never wait on upstream APIs. The one shared promise
      // means concurrent page loads still cause only one refresh.
      void refresh();
      if (!cache) return { enabled: true, status: 'loading', source: null, analysis: publicAnalysis({ status: 'loading', summary: '', segments: [] }), commentator: commentary(cfg), error: null, cache: { fresh: false, freshUntil: null } };
    }
    const c = cache;
    const fresh = Boolean(c?.source && now() < c.freshUntil);
    return { enabled: cfg.enabled, status: c?.source ? (fresh && !c.error ? 'ready' : 'stale') : 'unavailable', source: c?.source || null, analysis: publicAnalysis(c?.analysis || { status: 'unavailable', summary: '', segments: [] }), commentator: commentary(cfg), error: c?.error || null, cache: { fresh, freshUntil: c?.source?.freshUntil || null } };
  }
  return { snapshot, refresh, state: () => cache };
}