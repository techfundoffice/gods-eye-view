(function initPopup() {
  const target = document.getElementById('target');
  const enable = document.getElementById('enable');
  const pause = document.getElementById('pause');
  const stop = document.getElementById('stop');
  const status = document.getElementById('status');
  const forwarded = document.getElementById('forwarded');
  const rejected = document.getElementById('rejected');
  let state = null;

  const isGevUrl = (url) => [
    /^https:\/\/[^/]+\.replit\.app\//,
    /^https:\/\/[^/]+\.replit\.dev\//,
    /^https:\/\/[^/]+\.repl\.co\//,
    /^http:\/\/localhost(?::\d+)?\//,
    /^http:\/\/127\.0\.0\.1(?::\d+)?\//,
  ].some((pattern) => pattern.test(String(url || '')));

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function render() {
    if (!state) return;
    enable.textContent = state.enabled ? 'DISABLE' : 'ENABLE';
    pause.textContent = state.paused ? 'RESUME' : 'PAUSE';
    pause.disabled = !state.enabled;
    forwarded.textContent = String(state.forwarded || 0);
    rejected.textContent = String(state.rejected || 0);
    const selected = Number(state.targetTabId);
    const label = selected ? target.querySelector(`option[value="${selected}"]`)?.textContent : '';
    status.textContent = state.enabled
      ? `${state.paused ? 'PAUSED' : 'ACTIVE'} · ${label || 'select a GEV tab'}`
      : (label ? `STANDBY · ${label}` : 'STANDBY · choose a GEV tab');
  }

  async function loadTabs() {
    const tabs = await chrome.tabs.query({});
    const allowed = tabs.filter((tab) => isGevUrl(tab.url));
    target.replaceChildren();
    if (!allowed.length) {
      target.add(new Option('No allowed GEV tab found', ''));
      target.disabled = true;
      return;
    }
    target.disabled = false;
    for (const tab of allowed) {
      const option = new Option(`${tab.title || 'GEV'} · ${new URL(tab.url).hostname}`, String(tab.id));
      target.add(option);
    }
    if (state?.targetTabId && allowed.some((tab) => tab.id === state.targetTabId)) target.value = String(state.targetTabId);
    else target.value = String(allowed.find((tab) => tab.active)?.id || allowed[0].id);
  }

  async function refresh() {
    const response = await send({ type: 'GEV_POPUP_GET_STATE' });
    state = response?.state || null;
    await loadTabs();
    render();
  }

  target.addEventListener('change', async () => {
    const response = await send({ type: 'GEV_POPUP_SET_TARGET', tabId: Number(target.value) });
    if (!response?.ok) status.textContent = response?.error || 'Could not select that tab.';
    else { state = response.state; render(); }
  });
  enable.addEventListener('click', async () => {
    if (!state?.targetTabId && target.value) {
      const selected = await send({ type: 'GEV_POPUP_SET_TARGET', tabId: Number(target.value) });
      state = selected?.state || state;
    }
    const response = await send({ type: 'GEV_POPUP_SET_ENABLED', enabled: !state?.enabled });
    state = response?.state || state;
    render();
  });
  pause.addEventListener('click', async () => {
    const response = await send({ type: 'GEV_POPUP_SET_PAUSED', paused: !state?.paused });
    state = response?.state || state;
    render();
  });
  stop.addEventListener('click', async () => {
    const response = await send({ type: 'GEV_POPUP_STOP' });
    state = response?.state || state;
    render();
  });
  void refresh().catch(() => { status.textContent = 'Extension service worker unavailable.'; });
}());