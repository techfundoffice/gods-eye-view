import { PUBLIC_HELP_REPLY, validatePublicToolCall } from './youtubePublicCommandPolicy.js';

const BRIDGE_SOURCE = 'gev-chrome-extension';
const MAX_ACTIONS = 3;
const MAX_TEXT = 500;

function safeText(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function currentOrigin(windowRef) {
  return windowRef?.location?.origin || '';
}

function post(windowRef, payload) {
  const origin = currentOrigin(windowRef);
  windowRef?.postMessage?.({ source: BRIDGE_SOURCE, ...payload }, origin || '*');
}

/**
 * Page-side receiver for the viewer-local Chrome extension.
 *
 * The content script can only submit structured actions. This receiver validates
 * every action against the same public policy used by the server path, then
 * invokes the existing GEV action runner. It never evaluates page-provided code
 * or accepts a URL/selector/browser-control instruction.
 */
export function createGevExtensionBridge({
  windowRef = globalThis.window,
  nextchat = null,
  runner = null,
  now = Date.now,
} = {}) {
  let actionRunner = typeof runner === 'function' ? runner : null;
  let stopped = false;
  let listening = false;

  function setStatus(message) {
    nextchat?.setHarnessStatus?.(`EXT · ${safeText(message, 180)}`);
  }

  function publishComment(payload, replyState = 'interpreting') {
    const comment = {
      author: safeText(payload?.author, 80) || 'YouTube viewer',
      authorHandle: safeText(payload?.authorHandle, 80),
      text: safeText(payload?.text, MAX_TEXT),
      metadata: {
        source: 'youtube-extension',
        commentId: safeText(payload?.id, 160),
        videoId: safeText(payload?.videoId, 80),
        generation: 0,
        actionState: replyState,
        actionCount: Array.isArray(payload?.actions) ? payload.actions.length : 0,
        receivedAt: new Date(now()).toISOString(),
      },
    };
    nextchat?.publishViewerMessage?.(comment);
    nextchat?.upsertLiveComment?.({
      ...comment,
      commentId: comment.metadata.commentId,
      videoId: comment.metadata.videoId,
      generation: 0,
      replyState,
    });
    return comment;
  }

  async function handleCommand(payload) {
    if (stopped) return { ok: false, error: 'Extension bridge is stopped.' };
    const actions = Array.isArray(payload?.actions) ? payload.actions.slice(0, MAX_ACTIONS) : [];
    const command = safeText(payload?.command, 40);
    const commentId = safeText(payload?.id, 160);
    const videoId = safeText(payload?.videoId, 80);
    if (payload?.kind === 'help') {
      const comment = publishComment(payload, 'display');
      nextchat?.typeActionReply?.(PUBLIC_HELP_REPLY, {
        commentId,
        videoId,
        generation: 0,
        author: comment.author,
        authorHandle: comment.authorHandle,
      });
      setStatus('help sent to local chat');
      return { ok: true, answer: PUBLIC_HELP_REPLY };
    }
    if (!actions.length || !actionRunner) {
      publishComment(payload, 'failed');
      setStatus(actionRunner ? 'command rejected · no supported action' : 'waiting for globe runner');
      return { ok: false, error: actionRunner ? 'No supported action.' : 'GEV globe is not ready.' };
    }

    const comment = publishComment(payload, 'interpreting');
    for (const intent of actions) {
      const actionName = safeText(intent?.action, 80);
      const args = intent?.args && typeof intent.args === 'object' && !Array.isArray(intent.args)
        ? intent.args
        : {};
      const validation = validatePublicToolCall('/x', actionName, args)
        .ok
        ? { ok: true }
        : validatePublicToolCall('/z', actionName, args);
      if (!validation.ok) {
        nextchat?.updateAgentReply?.({
          commentId,
          videoId,
          generation: 0,
          replyState: 'rejected',
          replyText: safeText(validation.reason, 180),
        });
        return { ok: false, error: validation.reason };
      }
      try {
        const result = await actionRunner(actionName, args, {
          isCurrent: () => !stopped,
        });
        if (result?.ok === false) throw new Error(result.error || result.reason || 'GEV action rejected');
      } catch (error) {
        const message = safeText(error?.message || 'GEV action failed', 180);
        nextchat?.updateAgentReply?.({ commentId, videoId, generation: 0, replyState: 'failed', replyText: message });
        setStatus(`request failed · ${message}`);
        return { ok: false, error: message };
      }
    }
    const destination = actions.findLast?.((item) => item?.args?.query)?.args?.query
      || command
      || 'view';
    nextchat?.updateAgentReply?.({
      commentId,
      videoId,
      generation: 0,
      replyState: 'replied',
      replyText: `showing ${safeText(destination, 100)}`,
    });
    setStatus(`showing ${safeText(destination, 100)}`);
    return { ok: true };
  }

  function onMessage(event) {
    if (!windowRef || event?.source !== windowRef || event?.origin !== currentOrigin(windowRef)) return;
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE) return;
    if (data.type === 'GEV_EXTENSION_STOP') {
      stopped = true;
      setStatus('stopped');
      return;
    }
    if (data.type !== 'GEV_EXTENSION_COMMAND') return;
    stopped = false;
    void handleCommand(data.payload || {}).then((result) => {
      post(windowRef, {
        type: 'GEV_EXTENSION_RESULT',
        requestId: safeText(data.payload?.id, 160),
        result,
      });
    });
  }

  return {
    start() {
      if (listening || !windowRef?.addEventListener) return;
      windowRef.addEventListener('message', onMessage);
      listening = true;
    },
    stop() {
      if (listening) windowRef.removeEventListener?.('message', onMessage);
      listening = false;
      stopped = true;
    },
    setRunner(nextRunner) {
      actionRunner = typeof nextRunner === 'function' ? nextRunner : null;
    },
    getState() {
      return { listening, stopped, runnerReady: Boolean(actionRunner) };
    },
  };
}

export function initGevExtensionBridge(options = {}) {
  const bridge = createGevExtensionBridge(options);
  bridge.start();
  return bridge;
}