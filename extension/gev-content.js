(function startGevContentBridge() {
  const SOURCE = 'gev-chrome-extension';
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GEV_EXTENSION_STOP') {
      window.postMessage({ source: SOURCE, type: 'GEV_EXTENSION_STOP' }, window.location.origin);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== 'GEV_EXTENSION_COMMAND' || !message.payload) return false;
    window.postMessage({
      source: SOURCE,
      type: 'GEV_EXTENSION_COMMAND',
      payload: message.payload,
    }, window.location.origin);
    sendResponse({ ok: true });
    return false;
  });
}());