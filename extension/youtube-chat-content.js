(function startYoutubeChatObserver() {
  const policy = globalThis.GevExtensionPolicy;
  if (!policy) return;
  const seen = new Set();
  let observer = null;
  let badge = null;
  const videoId = new URL(location.href).searchParams.get('v') || '';

  function ensureBadge() {
    if (badge || !document.body) return;
    badge = document.createElement('div');
    badge.textContent = 'CLOUD COMPUTER AI.COM BRIDGE · STANDBY';
    Object.assign(badge.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      padding: '7px 10px',
      border: '1px solid rgba(38, 205, 255, .5)',
      borderRadius: '4px',
      background: 'rgba(5, 12, 22, .9)',
      color: '#82eaff',
      font: '11px monospace',
      letterSpacing: '.08em',
      pointerEvents: 'none',
    });
    document.body.appendChild(badge);
  }

  function setBadge(text, active) {
    ensureBadge();
    if (!badge) return;
    badge.textContent = `CLOUD COMPUTER AI.COM BRIDGE · ${text}`;
    badge.style.color = active ? '#9dffbf' : '#82eaff';
  }

  function readRenderer(renderer) {
    const message = renderer.querySelector('#message');
    const author = renderer.querySelector('#author-name');
    const text = policy.clean(message?.innerText || message?.textContent || '', policy.MAX_COMMENT);
    const name = policy.clean(author?.innerText || author?.textContent || 'Viewer', policy.MAX_NAME) || 'Viewer';
    const id = policy.clean(renderer.getAttribute('id') || '', policy.MAX_ID)
      || `${name}:${text}`.slice(0, policy.MAX_ID);
    if (!text || seen.has(id)) return null;
    seen.add(id);
    while (seen.size > 500) seen.delete(seen.values().next().value);
    const parsed = policy.parse(text);
    if (!parsed.recognized) return null;
    return {
      id,
      author: name,
      authorHandle: '',
      text,
      command: parsed.command,
      kind: parsed.kind,
      answer: parsed.answer || '',
      actions: parsed.actions || [],
      videoId: policy.clean(videoId, 80),
      publishedAt: new Date().toISOString(),
    };
  }

  function inspect(root) {
    const renderers = [];
    if (root?.matches?.('yt-live-chat-text-message-renderer')) renderers.push(root);
    root?.querySelectorAll?.('yt-live-chat-text-message-renderer').forEach((item) => renderers.push(item));
    for (const renderer of renderers) {
      const comment = readRenderer(renderer);
      if (comment) chrome.runtime.sendMessage({ type: 'GEV_YOUTUBE_COMMENT', comment }).catch(() => {});
    }
  }

  function start() {
    ensureBadge();
    inspect(document);
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) inspect(node);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GEV_EXTENSION_STATE') {
      const state = message.state || {};
      setBadge(state.enabled ? (state.paused ? 'PAUSED' : 'ACTIVE') : 'STANDBY', Boolean(state.enabled && !state.paused));
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}());