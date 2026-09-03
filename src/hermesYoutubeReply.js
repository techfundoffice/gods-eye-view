/**
 * Idempotent YouTube Live chat replies for finalized Hermes/OpenRouter answers.
 * Posts only to the verified active live chat. Never repeats globe actions.
 *
 * @module hermesYoutubeReply
 */

const MAX_CHAT = 200;
const MAX_ATTEMPTS = 3;

export function youtubeReplyPayload({ liveChatId, text }) {
  const messageText = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_CHAT);
  const chatId = String(liveChatId || '').trim();
  if (!chatId || !messageText) return null;
  return {
    snippet: {
      liveChatId: chatId,
      type: 'textMessageEvent',
      textMessageDetails: { messageText },
    },
  };
}

/**
 * @param {object} options
 * @param {Function} options.call YouTube Data API caller `(method, params, body) => Promise`
 */
export function createYoutubeLiveChatPoster({
  call,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const sent = new Set();

  async function post({ commandId, videoId, liveChatId, text, expectedVideoId }) {
    const id = String(commandId || '').trim();
    if (!id) return { ok: false, status: 'invalid', reason: 'command id is required' };
    if (sent.has(id)) return { ok: true, status: 'duplicate' };
    if (expectedVideoId && videoId && expectedVideoId !== videoId) {
      return { ok: false, status: 'stale', reason: 'Broadcast no longer matches' };
    }
    const body = youtubeReplyPayload({ liveChatId, text });
    if (!body) return { ok: false, status: 'invalid', reason: 'Live chat id or text is missing' };
    if (typeof call !== 'function') {
      return { ok: false, status: 'unavailable', reason: 'YouTube write path is not configured' };
    }
    let lastError = 'YouTube write failed';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await call('liveChatMessages.insert', { part: 'snippet' }, body);
        sent.add(id);
        return { ok: true, status: 'sent', attempt };
      } catch (error) {
        lastError = error?.message || lastError;
        if (Number(error?.status) === 404 || Number(error?.code) === 404) break;
      }
    }
    return { ok: false, status: 'failed', reason: lastError };
  }

  return { post, forget: (id) => sent.delete(id) };
}
