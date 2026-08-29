/**
 * YouTube Data API client and the small operator-facing YouTube workspace.
 * Browser code talks only to the same-origin server proxy.
 */

export const YOUTUBE_API_PREFIX = '/youtube/v3';
export const YOUTUBE_STORAGE_KEY = 'gev:youtube-live:v1';
export const YOUTUBE_DEFAULT_POLL_MS = 10_000;
export const YOUTUBE_MAX_FEED_ITEMS = 100;

export const YOUTUBE_RESOURCE_REGISTRY = Object.freeze([
  { id: 'channels', label: 'Channels', part: 'snippet,statistics,contentDetails', params: () => ({ mine: 'true' }) },
  { id: 'playlistItems', label: 'Upload items', part: 'snippet,contentDetails', params: (state) => state.uploadsId ? ({ playlistId: state.uploadsId }) : ({}) },
  { id: 'playlists', label: 'Playlists', part: 'snippet,contentDetails', params: () => ({ mine: 'true' }) },
  { id: 'search', label: 'Search', part: 'snippet', params: () => ({ forMine: 'true', type: 'video', q: 'live' }) },
  { id: 'videos', label: 'Videos', part: 'snippet,statistics,contentDetails,liveStreamingDetails,status', params: (state) => state.videoId ? ({ id: state.videoId }) : ({}) },
  { id: 'liveBroadcasts', label: 'Live broadcasts', part: 'snippet,contentDetails,status', params: () => ({ mine: 'true' }) },
  { id: 'liveStreams', label: 'Live streams', part: 'snippet,cdn,status', params: () => ({ mine: 'true' }) },
  { id: 'commentThreads', label: 'Comment threads', part: 'snippet,replies', params: (state) => state.videoId ? ({ videoId: state.videoId, order: 'time', textFormat: 'plainText' }) : ({}) },
  { id: 'comments', label: 'Comment replies', part: 'snippet', params: () => ({}) },
  { id: 'liveChatMessages', label: 'Live chat messages', part: 'snippet,authorDetails', params: (state) => state.liveChatId ? ({ liveChatId: state.liveChatId }) : ({}) },
  { id: 'activities', label: 'Activities', part: 'snippet,contentDetails', params: () => ({ mine: 'true' }) },
  { id: 'subscriptions', label: 'Subscriptions', part: 'snippet,contentDetails', params: () => ({ mine: 'true' }) },
  { id: 'captions', label: 'Caption tracks', part: 'snippet', params: (state) => state.videoId ? ({ videoId: state.videoId }) : ({}) },
  { id: 'channelSections', label: 'Channel sections', part: 'snippet,contentDetails', params: () => ({ mine: 'true' }) },
  { id: 'guideCategories', label: 'Guide categories', part: 'snippet', params: () => ({ regionCode: 'US' }) },
  { id: 'i18nLanguages', label: 'Languages', part: 'snippet', params: () => ({}) },
  { id: 'i18nRegions', label: 'Regions', part: 'snippet', params: () => ({}) },
  { id: 'videoCategories', label: 'Video categories', part: 'snippet', params: () => ({ regionCode: 'US' }) },
  { id: 'liveChatBans', label: 'Live chat bans', part: 'snippet', params: (state) => state.liveChatId ? ({ liveChatId: state.liveChatId }) : ({}) },
  { id: 'liveChatModerators', label: 'Live chat moderators', part: 'snippet', params: (state) => state.liveChatId ? ({ liveChatId: state.liveChatId }) : ({}) },
  { id: 'membershipsLevels', label: 'Membership levels', part: 'snippet', params: () => ({}) },
]);

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

export function normalizeCommentThread(thread) {
  const top = thread?.snippet?.topLevelComment?.snippet || thread?.snippet || {};
  const replies = Array.isArray(thread?.replies?.comments)
    ? thread.replies.comments.map((reply) => ({
      id: text(reply?.id),
      author: text(reply?.snippet?.authorDisplayName, 'UNKNOWN'),
      text: text(reply?.snippet?.textDisplay || reply?.snippet?.textOriginal),
      publishedAt: text(reply?.snippet?.publishedAt),
      likeCount: number(reply?.snippet?.likeCount),
    }))
    : [];
  return {
    id: text(thread?.id || thread?.snippet?.topLevelComment?.id),
    author: text(top.authorDisplayName, 'UNKNOWN'),
    text: text(top.textDisplay || top.textOriginal, '[NO TEXT]'),
    publishedAt: text(top.publishedAt),
    likeCount: number(top.likeCount),
    replyCount: number(thread?.snippet?.totalReplyCount),
    replies,
  };
}

export function normalizeLiveChatMessage(message) {
  const snippet = message?.snippet || {};
  const author = message?.authorDetails || {};
  const display = snippet.displayMessage || snippet.textMessageDetails?.messageText
    || snippet.superChatDetails?.userComment || '';
  return {
    id: text(message?.id),
    author: text(author.displayName, 'UNKNOWN'),
    text: text(display, '[NON-TEXT MESSAGE]'),
    publishedAt: text(snippet.publishedAt),
    type: text(snippet.type, 'textMessageEvent'),
    moderator: Boolean(author.isChatModerator),
    owner: Boolean(author.isChatOwner),
  };
}

export function mergeUniqueById(existing, incoming, max = YOUTUBE_MAX_FEED_ITEMS) {
  const seen = new Set();
  const result = [];
  for (const item of [...(incoming || []), ...(existing || [])]) {
    const id = text(item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

export function computePollDelay(pollingIntervalMillis, backoffMs = 0) {
  const providerDelay = number(pollingIntervalMillis, YOUTUBE_DEFAULT_POLL_MS);
  return Math.max(5_000, Math.min(60_000, providerDelay + Math.max(0, number(backoffMs))));
}

/**
 * Derive the rail comments panel readouts from loaded state. Kept pure so the
 * empty, disconnected, and paging cases are testable without a DOM.
 *
 * @param {object} input Loaded comment state.
 * @param {string} [input.connection] Controller connection phase.
 * @param {object|null} [input.video] Selected video resource, when one exists.
 * @param {Array<object>} [input.comments] Normalized comment threads.
 * @param {string} [input.nextPageToken] Page token for the next comment page.
 * @param {boolean} [input.loading] Whether a comment request is in flight.
 * @returns {{count: number, subject: string, status: string, canLoadMore: boolean}}
 */
export function summarizeCommentsPanel({
  connection = 'disconnected',
  video = null,
  comments = [],
  nextPageToken = '',
  loading = false,
} = {}) {
  const threads = Array.isArray(comments) ? comments : [];
  const count = threads.length;
  const title = text(video?.snippet?.title);
  const live = Boolean(video?.liveStreamingDetails?.activeLiveChatId);
  const subject = title ? `${title}${live ? ' · LIVE' : ''}` : 'NO VIDEO SELECTED';
  const replies = threads.reduce((total, thread) => total + number(thread?.replyCount), 0);
  let status;
  if (connection === 'unavailable') status = 'YOUTUBE UNAVAILABLE';
  else if (connection === 'reconnect') status = 'RECONNECT YOUTUBE TO LOAD COMMENTS';
  else if (connection !== 'connected') status = 'CONNECT YOUTUBE TO LOAD COMMENTS';
  else if (loading) status = 'LOADING COMMENTS';
  else if (!video) status = 'SELECT A VIDEO IN YOUTUBE SETTINGS';
  else if (!count) status = 'NO COMMENTS ON THIS VIDEO';
  else status = `${count} THREAD${count === 1 ? '' : 'S'}${replies ? ` · ${replies} REPLIES` : ''}`;
  return {
    count,
    subject,
    status,
    canLoadMore: Boolean(video) && Boolean(text(nextPageToken)),
  };
}

export function createYoutubeClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('YouTube client requires fetch');
  async function get(resource, params = {}, signal) {
    const query = new URLSearchParams();
    query.set('part', text(params.part, 'snippet'));
    for (const [key, value] of Object.entries(params)) {
      if (key === 'part' || value === undefined || value === null || value === '') continue;
      query.set(key, String(value));
    }
    const response = await fetchImpl(`/api/youtube${YOUTUBE_API_PREFIX}/${encodeURIComponent(resource)}?${query}`, {
      method: 'GET',
      signal,
      headers: { Accept: 'application/json' },
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* proxy always intends JSON */ }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'YouTube request failed');
      error.kind = payload?.error?.kind || 'upstream';
      error.status = response.status;
      error.reasons = payload?.error?.reasons || [];
      throw error;
    }
    return payload;
  }
  return { get };
}

async function getYoutubeAuthStatus(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/youtube/auth/status', {
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'YouTube sign-in status unavailable');
    error.kind = payload?.error?.kind || 'upstream';
    throw error;
  }
  return payload;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function readStoredState() {
  try {
    const value = JSON.parse(localStorage.getItem(YOUTUBE_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeStoredState(state) {
  try {
    localStorage.setItem(YOUTUBE_STORAGE_KEY, JSON.stringify({
      videoId: state.videoId || '',
      resource: state.resource || 'videos',
      pollMs: state.pollMs || YOUTUBE_DEFAULT_POLL_MS,
    }));
  } catch { /* private browsing can disable storage */ }
}

/**
 * Right-rail view over the comment threads the settings panel has loaded.
 *
 * It owns presentation only: sign-in, channel, and video selection stay with
 * YouTubePanelController, so the rail can never disagree with the settings
 * panel about which video's comments are on screen. Its own collapse button is
 * left to StyleManager's panel chrome, which also drives the rail layout.
 */
export class YouTubeCommentsPanelView {
  constructor(root, { onRefresh, onLoadMore } = {}) {
    this.root = root || null;
    this._refreshButton = this._el('youtube-comments-refresh');
    this._moreButton = this._el('youtube-comments-more');
    this._list = this._el('youtube-comments-list');
    this._status = this._el('youtube-comments-status');
    this._subject = this._el('youtube-comments-video');
    this._count = this._el('youtube-comments-count');
    if (typeof onRefresh === 'function') {
      this._refreshButton?.addEventListener('click', () => onRefresh());
    }
    if (typeof onLoadMore === 'function') {
      this._moreButton?.addEventListener('click', () => onLoadMore());
    }
  }

  _el(id) { return this.root?.querySelector(`#${id}`) || null; }

  /**
   * @param {object} state Comment state as passed by the controller.
   * @returns {void}
   */
  render(state) {
    if (!this.root) return;
    const summary = summarizeCommentsPanel(state);
    setText(this._subject, summary.subject);
    setText(this._status, summary.status);
    setText(this._count, String(summary.count));
    if (this._moreButton) this._moreButton.disabled = !summary.canLoadMore;
    if (this._refreshButton) this._refreshButton.disabled = !state?.video;
    if (!this._list) return;
    this._list.replaceChildren();
    const threads = Array.isArray(state?.comments) ? state.comments : [];
    if (!threads.length) {
      const empty = document.createElement('li');
      empty.className = 'youtube-feed-empty';
      empty.textContent = summary.status;
      this._list.append(empty);
      return;
    }
    for (const thread of threads) this._list.append(this._renderThread(thread));
  }

  _renderThread(thread) {
    const row = document.createElement('li');
    row.className = 'youtube-feed-item youtube-comment-thread';
    const meta = document.createElement('span');
    meta.className = 'youtube-feed-meta';
    meta.textContent = `${thread.author} · ${formatTime(thread.publishedAt)}`
      + (thread.likeCount ? ` · ${thread.likeCount} LIKES` : '');
    const body = document.createElement('span');
    body.className = 'youtube-feed-text';
    body.textContent = thread.text;
    row.append(meta, body);
    const replies = Array.isArray(thread.replies) ? thread.replies : [];
    if (replies.length) {
      const list = document.createElement('ol');
      list.className = 'youtube-comment-replies';
      for (const reply of replies) {
        const item = document.createElement('li');
        item.className = 'youtube-comment-reply';
        const replyMeta = document.createElement('span');
        replyMeta.className = 'youtube-feed-meta';
        replyMeta.textContent = `${reply.author} · ${formatTime(reply.publishedAt)}`;
        const replyBody = document.createElement('span');
        replyBody.className = 'youtube-feed-text';
        replyBody.textContent = reply.text;
        item.append(replyMeta, replyBody);
        list.append(item);
      }
      row.append(list);
    } else if (thread.replyCount) {
      // The API returns replies only on the pages that carry them; say so
      // rather than implying the thread has none.
      const hint = document.createElement('span');
      hint.className = 'youtube-comment-reply-hint';
      hint.textContent = `${thread.replyCount} REPLIES NOT LOADED`;
      row.append(hint);
    }
    return row;
  }
}

/**
 * Small DOM controller kept separate from StyleManager so YouTube polling does
 * not become coupled to globe rendering or share-link state.
 */
export class YouTubePanelController {
  constructor(root, { client = createYoutubeClient(), commentsPanel = null } = {}) {
    this.root = root;
    this.client = client;
    this.state = {
      channel: null,
      videos: [],
      videoId: '',
      uploadsId: '',
      liveChatId: '',
      mode: 'chat',
      resource: 'videos',
      pollMs: YOUTUBE_DEFAULT_POLL_MS,
      enabled: false,
      chat: [],
      comments: [],
      chatPageToken: '',
      commentsNextPageToken: '',
      generation: 0,
      pollTimer: null,
      abortController: null,
      backoffMs: 0,
      account: null,
      commentsLoading: false,
    };
    this._stored = readStoredState();
    this.state.videoId = text(this._stored.videoId);
    this.state.resource = text(this._stored.resource, 'videos');
    this.state.pollMs = Math.max(5_000, Math.min(60_000, number(this._stored.pollMs, YOUTUBE_DEFAULT_POLL_MS)));
    this.state.connection = 'disconnected';
    // Built before the first render so the rail mirrors this same state pass.
    this.commentsPanel = commentsPanel
      ? new YouTubeCommentsPanelView(commentsPanel, {
        onRefresh: () => void this._loadComments(true),
        onLoadMore: () => void this._loadComments(false),
      })
      : null;
    this._bind();
    this._populateResources();
    this._render();
  }

  _el(id) { return this.root?.querySelector(`#${id}`); }

  _bind() {
    if (!this.root) return;
    const collapseButton = this.root.querySelector('.panel-collapse-btn[data-collapse-target="youtube-panel"]');
    if (collapseButton && collapseButton.dataset.collapseBound !== 'true') {
      collapseButton.dataset.collapseBound = 'true';
      collapseButton.addEventListener('click', () => {
        const collapsed = this.root.classList.toggle('collapsed');
        collapseButton.textContent = collapsed ? '+' : '−';
        collapseButton.setAttribute('aria-expanded', String(!collapsed));
        collapseButton.setAttribute('aria-label', collapsed ? 'Expand YouTube settings' : 'Collapse YouTube settings');
      });
    }
    this._el('youtube-connect-btn')?.addEventListener('click', () => {
      window.location.assign('/api/youtube/auth/start');
    });
    this._el('youtube-signout-btn')?.addEventListener('click', () => void this.signOut());
    this._el('youtube-refresh-btn')?.addEventListener('click', () => void this.refresh());
    this._el('youtube-chat-toggle')?.addEventListener('click', () => {
      this.state.enabled = !this.state.enabled;
      if (this.state.enabled) void this._startChat(true);
      else this._stopChat();
      this._render();
    });
    this._el('youtube-channel-select')?.addEventListener('change', () => {
      this.state.videoId = '';
      void this._loadVideos();
    });
    this._el('youtube-video-select')?.addEventListener('change', () => {
      this.state.videoId = this._el('youtube-video-select').value;
      writeStoredState(this.state);
      void this._selectVideo();
    });
    this._el('youtube-poll-select')?.addEventListener('change', () => {
      this.state.pollMs = Math.max(5_000, Math.min(60_000, number(this._el('youtube-poll-select').value)));
      writeStoredState(this.state);
      if (this.state.enabled) {
        this._stopChat({ preserveEnabled: true });
        void this._startChat(true);
      }
    });
    this._el('youtube-chat-tab')?.addEventListener('click', () => this._setMode('chat'));
    this._el('youtube-comments-tab')?.addEventListener('click', () => {
      this._setMode('comments');
      void this._loadComments(true);
    });
    this._el('youtube-api-tab')?.addEventListener('click', () => this._setMode('api'));
    this._el('youtube-resource-select')?.addEventListener('change', () => {
      this.state.resource = this._el('youtube-resource-select').value;
      writeStoredState(this.state);
    });
    this._el('youtube-api-load-btn')?.addEventListener('click', () => void this._loadResource());
    this._el('youtube-comments-next')?.addEventListener('click', () => void this._loadComments(false));
  }

  _populateResources() {
    const select = this._el('youtube-resource-select');
    if (!select) return;
    select.replaceChildren();
    for (const resource of YOUTUBE_RESOURCE_REGISTRY) {
      const option = document.createElement('option');
      option.value = resource.id;
      option.textContent = resource.label;
      option.selected = resource.id === this.state.resource;
      select.append(option);
    }
  }

  async refresh() {
    try {
      const auth = await getYoutubeAuthStatus();
      this.state.account = auth.account || null;
      if (!auth.authenticated) {
        this.state.connection = auth.configured ? 'disconnected' : 'unavailable';
        this.state.channel = null;
        this.state.videos = [];
        this.state.liveChatId = '';
        this._setStatus(auth.configured ? 'SIGN IN TO LOAD CHANNEL' : 'YOUTUBE SIGN-IN NOT CONFIGURED');
        this._render();
        return;
      }
    } catch (error) {
      this.state.connection = 'unavailable';
      this._setStatus('SIGN-IN STATUS UNAVAILABLE');
      this._render();
      return;
    }
    this.state.connection = 'connecting';
    setText(this._el('youtube-connection-state'), 'SYNCING');
    this._setStatus('SYNCING CHANNEL');
    this._setBusy(true);
    this._stopChat();
    this.state.generation += 1;
    try {
      const payload = await this.client.get('channels', {
        part: 'snippet,statistics,contentDetails',
        mine: 'true',
        maxResults: 1,
      });
      const channel = payload?.items?.[0];
      if (!channel) {
        this.state.channel = null;
        this.state.videos = [];
        this._setStatus('NO CHANNEL AVAILABLE');
        this._render();
        return;
      }
      this.state.channel = channel;
      this.state.connection = 'connected';
      this.state.uploadsId = text(channel?.contentDetails?.relatedPlaylists?.uploads);
      this._render();
      await this._loadVideos();
      setText(this._el('youtube-connection-state'), 'CONNECTED');
      this._setStatus('CONNECTED');
    } catch (error) {
      this.state.channel = null;
      this.state.connection = error?.kind === 'authentication' ? 'reconnect' : 'unavailable';
      setText(this._el('youtube-connection-state'), error?.kind === 'authentication' ? 'RECONNECT' : 'UNAVAILABLE');
      this._setStatus(this._friendlyError(error));
    } finally {
      this._setBusy(false);
      this._render();
    }
  }

  async signOut() {
    this._setBusy(true);
    try {
      await fetch('/api/youtube/auth/signout', { method: 'POST', headers: { Accept: 'application/json' } });
    } finally {
      this._stopChat();
      this.state.account = null;
      this.state.channel = null;
      this.state.videos = [];
      this.state.videoId = '';
      this.state.liveChatId = '';
      this.state.connection = 'disconnected';
      this._setStatus('SIGNED OUT · SIGN IN TO LOAD CHANNEL');
      this._setBusy(false);
      this._render();
    }
  }

  async _loadVideos() {
    if (!this.state.uploadsId) return;
    this._setStatus('LOADING VIDEOS');
    const [uploadPage, livePage] = await Promise.all([
      this.client.get('playlistItems', {
        part: 'snippet,contentDetails',
        playlistId: this.state.uploadsId,
        maxResults: 25,
      }),
      this.client.get('liveBroadcasts', {
        part: 'snippet,contentDetails,status',
        mine: 'true',
        maxResults: 25,
      }).catch(() => ({ items: [] })),
    ]);
    const ids = [...new Set([
      ...(uploadPage?.items || []).map((item) => text(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId)),
      ...(livePage?.items || []).map((item) => text(item?.id)),
    ].filter(Boolean))].slice(0, 50);
    if (!ids.length) {
      this.state.videos = [];
      this._render();
      return;
    }
    const details = await this.client.get('videos', {
      part: 'snippet,statistics,contentDetails,liveStreamingDetails,status',
      id: ids.join(','),
      maxResults: 50,
    });
    this.state.videos = details?.items || [];
    if (!this.state.videos.some((video) => video.id === this.state.videoId)) {
      this.state.videoId = this.state.videos[0]?.id || '';
    }
    writeStoredState(this.state);
    this._render();
    await this._selectVideo();
  }

  async _selectVideo() {
    this._stopChat({ preserveEnabled: true });
    this.state.generation += 1;
    const video = this.state.videos.find((candidate) => candidate.id === this.state.videoId);
    this.state.liveChatId = text(video?.liveStreamingDetails?.activeLiveChatId);
    this.state.chat = [];
    this.state.comments = [];
    this.state.chatPageToken = '';
    this.state.commentsNextPageToken = '';
    this._render();
    if (!video) {
      this._setStatus('SELECT A VIDEO');
      return;
    }
    await this._loadComments(true);
    if (this.state.enabled && this.state.liveChatId) await this._startChat(true);
  }

  async _loadComments(reset) {
    if (!this.state.videoId) return;
    const generation = this.state.generation;
    if (reset) {
      this.state.comments = [];
      this.state.commentsNextPageToken = '';
    }
    this.state.commentsLoading = true;
    this._setStatus('LOADING COMMENTS');
    this._render();
    let status;
    try {
      const payload = await this.client.get('commentThreads', {
        part: 'snippet,replies',
        videoId: this.state.videoId,
        order: 'time',
        textFormat: 'plainText',
        maxResults: 25,
        pageToken: reset ? '' : this.state.commentsNextPageToken,
      });
      if (generation !== this.state.generation) return;
      const items = (payload?.items || []).map(normalizeCommentThread);
      this.state.comments = mergeUniqueById(this.state.comments, items);
      this.state.commentsNextPageToken = text(payload?.nextPageToken);
      status = 'COMMENTS READY';
    } catch (error) {
      if (generation !== this.state.generation) return;
      status = this._friendlyError(error);
    } finally {
      // A superseded load must not clear the flag a newer one just set.
      if (generation === this.state.generation) this.state.commentsLoading = false;
    }
    this._setStatus(status);
    this._render();
  }

  async _startChat(reset = false) {
    if (!this.state.liveChatId) {
      this._setStatus('NO ACTIVE LIVE CHAT');
      this._render();
      return;
    }
    const generation = this.state.generation;
    this._stopChat({ preserveEnabled: true });
    if (reset) {
      this.state.chat = [];
      this.state.chatPageToken = '';
      this.state.backoffMs = 0;
    }
    const poll = async () => {
      if (!this.state.enabled || generation !== this.state.generation) return;
      const controller = new AbortController();
      this.state.abortController = controller;
      try {
        const payload = await this.client.get('liveChatMessages', {
          part: 'snippet,authorDetails',
          liveChatId: this.state.liveChatId,
          maxResults: 200,
          pageToken: this.state.chatPageToken,
        }, controller.signal);
        if (this.state.abortController === controller) this.state.abortController = null;
        if (!this.state.enabled || generation !== this.state.generation) return;
        this.state.chat = mergeUniqueById(this.state.chat, (payload?.items || []).map(normalizeLiveChatMessage));
        this.state.chatPageToken = text(payload?.nextPageToken);
        this.state.backoffMs = 0;
        this._setStatus('LIVE CHAT · ' + this.state.chat.length);
        this._render();
        const delay = Math.max(this.state.pollMs, computePollDelay(payload?.pollingIntervalMillis));
        this.state.pollTimer = setTimeout(poll, delay);
      } catch (error) {
        if (this.state.abortController === controller) this.state.abortController = null;
        if (error?.name === 'AbortError') return;
        if (!this.state.enabled || generation !== this.state.generation) return;
        this.state.backoffMs = Math.min(60_000, Math.max(5_000, this.state.backoffMs ? this.state.backoffMs * 2 : 5_000));
        this._setStatus(this._friendlyError(error));
        this._render();
        this.state.pollTimer = setTimeout(poll, computePollDelay(this.state.pollMs, this.state.backoffMs));
      }
    };
    await poll();
  }

  _stopChat({ preserveEnabled = false } = {}) {
    if (this.state.pollTimer) clearTimeout(this.state.pollTimer);
    this.state.abortController?.abort();
    this.state.abortController = null;
    this.state.pollTimer = null;
    if (!preserveEnabled) this.state.enabled = false;
  }

  destroy() {
    this.state.generation += 1;
    this._stopChat();
  }

  async _loadResource() {
    const registry = YOUTUBE_RESOURCE_REGISTRY.find((item) => item.id === this.state.resource);
    if (!registry) return;
    const params = {
      part: registry.part,
      maxResults: registry.id === 'commentThreads' ? 25 : 25,
      ...registry.params(this.state),
    };
    if (registry.id === 'comments' && !params.parentId) {
      this._setStatus('SELECT A COMMENT REPLY ID');
      this._render();
      return;
    }
    this._setStatus(`LOADING ${registry.label.toUpperCase()}`);
    try {
      const payload = await this.client.get(registry.id, params);
      this._setStatus(`${registry.label.toUpperCase()} READY`);
      this._renderApiPayload(payload);
    } catch (error) {
      this._setStatus(this._friendlyError(error));
      this._render();
    }
  }

  _setMode(mode) {
    this.state.mode = mode;
    this._render();
  }

  _setStatus(status) {
    setText(this._el('youtube-feed-status'), status);
  }

  _setBusy(busy) {
    const button = this._el('youtube-refresh-btn');
    if (button) button.disabled = busy;
  }

  _friendlyError(error) {
    const messages = {
      authentication: 'CONNECTION NEEDS ATTENTION',
      quota: 'YOUTUBE QUOTA EXHAUSTED',
      'comments-disabled': 'COMMENTS DISABLED',
      'not-found': 'VIDEO UNAVAILABLE',
      forbidden: 'PERMISSION NOT GRANTED',
      'rate-limit': 'RATE LIMITED · BACKING OFF',
    };
    return messages[error?.kind] || 'YOUTUBE UNAVAILABLE';
  }

  _renderApiPayload(payload) {
    const output = this._el('youtube-api-output');
    if (output) output.textContent = JSON.stringify(payload, null, 2);
    this._render();
  }

  _render() {
    if (!this.root) return;
    const channelSelect = this._el('youtube-channel-select');
    if (channelSelect) {
      channelSelect.replaceChildren();
      const option = document.createElement('option');
      option.value = this.state.channel?.id || '';
      option.textContent = this.state.channel?.snippet?.title || 'No channel connected';
      channelSelect.append(option);
    }
    const videoSelect = this._el('youtube-video-select');
    if (videoSelect) {
      videoSelect.replaceChildren();
      for (const video of this.state.videos) {
        const option = document.createElement('option');
        option.value = video.id;
        option.textContent = `${video.liveStreamingDetails?.activeLiveChatId ? 'LIVE · ' : ''}${text(video.snippet?.title, video.id)}`;
        option.selected = video.id === this.state.videoId;
        videoSelect.append(option);
      }
      videoSelect.disabled = !this.state.videos.length;
    }
    const channel = this.state.channel;
    setText(this._el('youtube-channel-summary'), channel
      ? `${text(channel.snippet?.title, 'CHANNEL')} · ${number(channel.statistics?.subscriberCount).toLocaleString()} SUBS · ${number(channel.statistics?.videoCount).toLocaleString()} VIDEOS`
      : 'Connect YouTube to load your channel');
    const video = this.state.videos.find((item) => item.id === this.state.videoId);
    setText(this._el('youtube-video-summary'), video
      ? `${text(video.snippet?.title, 'VIDEO')} · ${number(video.statistics?.viewCount).toLocaleString()} VIEWS · ${this.state.liveChatId ? 'LIVE CHAT READY' : 'NO ACTIVE CHAT'}`
      : 'Select a video to inspect comments and live state');
    const chatToggle = this._el('youtube-chat-toggle');
    if (chatToggle) {
      chatToggle.textContent = this.state.enabled ? 'STOP CHAT' : 'START CHAT';
      chatToggle.disabled = !this.state.liveChatId;
      chatToggle.setAttribute('aria-pressed', String(this.state.enabled));
    }
    const connectButton = this._el('youtube-connect-btn');
    if (connectButton) {
      const connected = this.state.connection === 'connected';
      connectButton.textContent = connected ? 'CONNECTED' : this.state.connection === 'reconnect' ? 'RECONNECT' : 'SIGN IN WITH YOUTUBE';
      connectButton.disabled = false;
      connectButton.setAttribute('aria-label', connected ? 'Reconnect YouTube account' : 'Sign in with your YouTube account');
    }
    const signoutButton = this._el('youtube-signout-btn');
    if (signoutButton) {
      signoutButton.hidden = !this.state.account;
      signoutButton.disabled = !this.state.account;
    }
    const account = this._el('youtube-account');
    if (account) {
      account.hidden = !this.state.account;
      account.textContent = this.state.account
        ? `ACCOUNT · ${this.state.account.name}${this.state.account.email ? ` · ${this.state.account.email}` : ''}`
        : '';
    }
    const poll = this._el('youtube-poll-select');
    if (poll) poll.value = String(this.state.pollMs);
    for (const [name, active] of [['chat', this.state.mode === 'chat'], ['comments', this.state.mode === 'comments'], ['api', this.state.mode === 'api']]) {
      const button = this._el(`youtube-${name}-tab`);
      button?.classList.toggle('active', active);
      button?.setAttribute('aria-selected', String(active));
    }
    const feed = this._el('youtube-feed-list');
    if (feed) {
      feed.replaceChildren();
      const items = this.state.mode === 'comments' ? this.state.comments : this.state.chat;
      if (this.state.mode !== 'api' && !items.length) {
        const empty = document.createElement('li');
        empty.className = 'youtube-feed-empty';
        empty.textContent = this.state.mode === 'comments' ? 'NO COMMENTS LOADED' : 'START CHAT TO READ LIVE MESSAGES';
        feed.append(empty);
      }
      for (const item of items) {
        const row = document.createElement('li');
        row.className = 'youtube-feed-item';
        const meta = document.createElement('span');
        meta.className = 'youtube-feed-meta';
        meta.textContent = `${item.author} · ${formatTime(item.publishedAt)}${item.replyCount ? ` · ${item.replyCount} REPLIES` : ''}`;
        const body = document.createElement('span');
        body.className = 'youtube-feed-text';
        body.textContent = item.text;
        row.append(meta, body);
        feed.append(row);
      }
    }
    const api = this._el('youtube-api-view');
    if (api) api.hidden = this.state.mode !== 'api';
    const feedView = this._el('youtube-feed-view');
    if (feedView) feedView.hidden = this.state.mode === 'api';
    const next = this._el('youtube-comments-next');
    if (next) next.disabled = !this.state.commentsNextPageToken || this.state.mode !== 'comments';
    this.commentsPanel?.render({
      connection: this.state.connection,
      video: video || null,
      comments: this.state.comments,
      nextPageToken: this.state.commentsNextPageToken,
      loading: this.state.commentsLoading,
    });
  }
}

export function initYouTubePanel({
  root = document.getElementById('youtube-panel'),
  commentsPanel = document.getElementById('youtube-comments-panel'),
  client,
} = {}) {
  if (!root) return null;
  const controller = new YouTubePanelController(root, {
    client: client || createYoutubeClient(),
    commentsPanel,
  });
  void controller.refresh();
  return controller;
}
