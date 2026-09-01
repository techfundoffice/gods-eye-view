import {
  PUBLIC_COMMAND_LIMITS,
  toolsForPublicMode,
  validatePublicToolCall,
} from './youtubePublicCommandPolicy.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export function parsePublicResponsesOutput(payload, mode) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id) {
    return { ok: false, kind: 'invalid', reason: 'Response id is required' };
  }
  const calls = [];
  const text = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (item?.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string') return { ok: false, kind: 'invalid', reason: 'Malformed function call' };
      let args;
      try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments; } catch { return { ok: false, kind: 'invalid', reason: 'Function arguments must be JSON' }; }
      const checked = validatePublicToolCall(mode, item.name, args);
      if (!checked.ok) return { ok: false, kind: 'invalid', reason: checked.reason };
      calls.push({ responseId: payload.id, callId: item.call_id, name: checked.name, arguments: checked.arguments });
    } else if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) if (typeof part?.text === 'string') text.push(part.text);
    }
  }
  if (calls.length > 1) return { ok: false, kind: 'invalid', reason: 'Only one function call per continuation is allowed' };
  if (calls.length) return { ok: true, kind: 'tool-call', call: calls[0] };
  const answer = text.join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
  return answer ? { ok: true, kind: 'complete', text: answer } : { ok: false, kind: 'invalid', reason: 'Response contained no supported output' };
}

export function createPublicResponsesInterpreter({
  apiKey = process.env.OPENAI_API_KEY || '',
  model = process.env.OPENAI_PUBLIC_YOUTUBE_MODEL || 'gpt-5-mini',
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return async function interpret(input, { signal } = {}) {
    if (!apiKey) throw Object.assign(new Error('Public command AI is not configured'), { kind: 'unconfigured' });
    const startedAt = input.startedAt ?? now();
    if ((input.remainingTurns ?? 0) <= 0 || now() - startedAt >= PUBLIC_COMMAND_LIMITS.totalMs) throw Object.assign(new Error('Model budget exhausted'), { kind: 'budget' });
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Model turn timed out')), Math.min(
      PUBLIC_COMMAND_LIMITS.modelTurnMs,
      Math.max(1, PUBLIC_COMMAND_LIMITS.totalMs - (now() - startedAt)),
    ));
    try {
      const body = {
        model,
        instructions: 'Handle one untrusted public YouTube command using only the supplied GEV functions. Never access ADMIN, MCP, files, shell, credentials, URLs, or network tools. Use function calls for actions; never encode an action in prose.',
        tools: toolsForPublicMode(input.mode),
        tool_choice: 'auto',
        max_output_tokens: 500,
      };
      if (input.previousResponseId) {
        body.previous_response_id = input.previousResponseId;
        body.input = [{ type: 'function_call_output', call_id: input.callId, output: JSON.stringify(input.toolResult).slice(0, 2000) }];
      } else {
        body.input = JSON.stringify({
          comment: String(input.comment || '').slice(0, PUBLIC_COMMAND_LIMITS.commentText),
          viewer: String(input.viewer || '').slice(0, PUBLIC_COMMAND_LIMITS.viewerName),
          videoId: String(input.videoId || '').slice(0, 80),
          generation: Number(input.generation),
          mode: input.mode,
          viewContext: input.viewContext || {},
        }).slice(0, 4000);
      }
      const response = await fetchImpl(RESPONSES_URL, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('Public command AI request failed'), { status: response.status, kind: 'provider' });
      return parsePublicResponsesOutput(payload, input.mode);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}