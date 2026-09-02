importScripts('commands.js');

const STORAGE_KEY = 'gevExtensionState';
const MAX_SEEN = 500;
const GLOBAL_COOLDOWN_MS = 4_000;
const VIEWER_COOLDOWN_MS = 8_000;
const GEV_PATTERNS = [
  /^https:\/\/[^/]+\.replit\.app\//,
  /^https:\/\/[^/]+\.replit\.dev\//,
  /^https:\/\/[^/]+\.repl\.co\//,
  /^http:\/\/localhost(?::\d+)?\//,
  /^http:\/\/127\.0\.0\.1(?::\d+)?\//,
];
const DEFAULT_STATE = {
  enabled: false,
  paused: false,
  targetTabId: null,
  lastForwardAt: 0,
  forwarded: 0,
  rejected: 0,
};
const seen = new Set();
const viewerLastForward = new Map();

function isGevUrl(url) {
  return GEV_PATTERNS.some((pattern) => pattern.test(String(url || '')));
}

async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(stored[STORAGE_KEY] || {}) };
}

async function setState(patch) {
  const state = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  await broadcastState(state);
  return state;
}

async function broadcastState(state) {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*'] }).catch(() => []);
  await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'GEV_EXTENSION_STATE', state }).catch(() => {})));
}

function remember(id) {
  seen.add(id);
  while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
}

async function forwardComment(comment) {
  const state = await getState();
  if (!state.enabled || state.paused || !Number.isInteger(state.targetTabId)) return;
  const tab = await chrome.tabs.get(state.targetTabId).catch(() => null);
  if (!tab || !isGevUrl(tab.url)) {
    await setState({ targetTabId: null, enabled: false, paused: false });
    return;
  }
  const id = `${comment.id}:${comment.text}`;
  if (seen.has(id)) return;
  remember(id);
  const now = Date.now();
  if (now - Number(state.lastForwardAt || 0) < GLOBAL_COOLDOWN_MS
    || now - Number(viewerLastForward.get(comment.author) || 0) < VIEWER_COOLDOWN_MS) {
    await setState({ rejected: Number(state.rejected || 0) + 1 });
    return;
  }
  const parsed = globalThis.GevExtensionPolicy.parse(comment.text);
  if (!parsed.recognized) return;
  viewerLastForward.set(comment.author, now);
  try {
    await chrome.tabs.sendMessage(state.targetTabId, {
      type: 'GEV_EXTENSION_COMMAND',
      payload: { ...comment, ...parsed, receivedAt: now },
    });
    await setState({ lastForwardAt: now, forwarded: Number(state.forwarded || 0) + 1 });
  } catch {
    await setState({ targetTabId: null, enabled: false, paused: false });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'GEV_YOUTUBE_COMMENT') {
      await forwardComment(message.comment || {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'GEV_POPUP_GET_STATE') {
      sendResponse({ ok: true, state: await getState() });
      return;
    }
    if (message?.type === 'GEV_POPUP_SET_TARGET') {
      const tab = await chrome.tabs.get(Number(message.tabId)).catch(() => null);
      if (!tab || !isGevUrl(tab.url)) {
        sendResponse({ ok: false, error: 'Select an allowed GEV tab.' });
        return;
      }
      sendResponse({ ok: true, state: await setState({ targetTabId: tab.id }) });
      return;
    }
    if (message?.type === 'GEV_POPUP_SET_ENABLED') {
      sendResponse({ ok: true, state: await setState({ enabled: Boolean(message.enabled), paused: false }) });
      return;
    }
    if (message?.type === 'GEV_POPUP_SET_PAUSED') {
      sendResponse({ ok: true, state: await setState({ paused: Boolean(message.paused) }) });
      return;
    }
    if (message?.type === 'GEV_POPUP_STOP') {
      const state = await getState();
      if (Number.isInteger(state.targetTabId)) {
        await chrome.tabs.sendMessage(state.targetTabId, { type: 'GEV_EXTENSION_STOP' }).catch(() => {});
      }
      seen.clear();
      viewerLastForward.clear();
      sendResponse({ ok: true, state: await setState({ enabled: false, paused: false, targetTabId: null }) });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown extension message.' });
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.targetTabId === tabId) await setState({ targetTabId: null, enabled: false, paused: false });
});