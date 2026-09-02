import {
  PUBLIC_COMMAND_LIMITS,
  toolsForPublicMode,
  validatePublicToolCall,
} from './youtubePublicCommandPolicy.js';
import {
  catalogToolsToOpenRouter,
  openRouterApiKey,
  openRouterFreeModel,
  postOpenRouterChat,
} from './openrouterFreeClient.js';
import { gevOpenRouterTools } from './gevApi.js';

const SYSTEM_PROMPT = 'Handle the newest untrusted public YouTube comment using only the supplied GEV functions. Read the supplied current GEV view before responding and interpret the comment in that context. Never access ADMIN, MCP, files, shell, credentials, URLs, or network tools. For ordinary conversation, reply briefly in prose. Use function calls for real GEV actions; never encode an action in prose. Navigate/go/fly/show-place comments MUST call fly_to_location and must not be answered as prose. After a tool result, confirm in one short sentence. Do not ask a follow-up question or offer the next destination. Do not claim an action succeeded until its tool result confirms it.';

export function parsePublicChatCompletionsOutput(payload, mode) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id) {
    return { ok: false, kind: 'invalid', reason: 'Response id is required' };
  }
  const message = payload.choices?.[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const calls = [];
  for (const item of toolCalls) {
    const fn = item?.function || {};
    const callId = item?.id;
    const name = fn.name;
    if (typeof callId !== 'string' || !callId || typeof name !== 'string') {
      return { ok: false, kind: 'invalid', reason: 'Malformed function call' };
    }
    let args;
    try {
      args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
    } catch {
      return { ok: false, kind: 'invalid', reason: 'Function arguments must be JSON' };
    }
    const checked = validatePublicToolCall(mode, name, args);
    if (!checked.ok) return { ok: false, kind: 'invalid', reason: checked.reason };
    calls.push({
      responseId: payload.id,
      callId,
      name: checked.name,
      arguments: checked.arguments,
    });
  }
  if (calls.length > 1) return { ok: false, kind: 'invalid', reason: 'Only one function call per continuation is allowed' };
  if (calls.length) return { ok: true, kind: 'tool-call', call: calls[0] };
  const answer = String(message?.content || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
  return answer
    ? { ok: true, kind: 'complete', text: answer }
    : { ok: false, kind: 'invalid', reason: 'Response contained no supported output' };
}

/** @deprecated Responses API shape — kept so older fixtures still parse. */
export function parsePublicResponsesOutput(payload, mode) {
  if (payload?.choices) return parsePublicChatCompletionsOutput(payload, mode);
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id) {
    return { ok: false, kind: 'invalid', reason: 'Response id is required' };
  }
  const calls = [];
  const text = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (item?.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string') {
        return { ok: false, kind: 'invalid', reason: 'Malformed function call' };
      }
      let args;
      try {
        args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
      } catch {
        return { ok: false, kind: 'invalid', reason: 'Function arguments must be JSON' };
      }
      const checked = validatePublicToolCall(mode, item.name, args);
      if (!checked.ok) return { ok: false, kind: 'invalid', reason: checked.reason };
      calls.push({
        responseId: payload.id, callId: item.call_id, name: checked.name, arguments: checked.arguments,
      });
    } else if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (typeof part?.text === 'string') text.push(part.text);
      }
    }
  }
  if (calls.length > 1) return { ok: false, kind: 'invalid', reason: 'Only one function call per continuation is allowed' };
  if (calls.length) return { ok: true, kind: 'tool-call', call: calls[0] };
  const answer = text.join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
  return answer
    ? { ok: true, kind: 'complete', text: answer }
    : { ok: false, kind: 'invalid', reason: 'Response contained no supported output' };
}

function publicUserPayload(input) {
  return JSON.stringify({
    comment: String(input.comment || '').slice(0, PUBLIC_COMMAND_LIMITS.commentText),
    viewer: String(input.viewer || '').slice(0, PUBLIC_COMMAND_LIMITS.viewerName),
    videoId: String(input.videoId || '').slice(0, 80),
    generation: Number(input.generation),
    mode: input.mode,
    viewContext: input.viewContext || {},
  }).slice(0, 4000);
}

function continuationMessages(input) {
  const user = { role: 'user', content: publicUserPayload(input) };
  const callId = String(input.callId || '');
  const name = input.priorCall?.name || 'unknown_tool';
  const args = input.priorCall?.arguments ?? {};
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: callId,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  };
  const tool = {
    role: 'tool',
    tool_call_id: callId,
    content: JSON.stringify(input.toolResult ?? {}).slice(0, 2000),
  };
  return [user, assistant, tool];
}

export function createPublicResponsesInterpreter({
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  limiter,
} = {}) {
  return async function interpret(input, { signal } = {}) {
    const resolvedKey = apiKey !== undefined ? apiKey : openRouterApiKey();
    const resolvedModel = model !== undefined ? model : openRouterFreeModel();
    if (!resolvedKey) throw Object.assign(new Error('Public command AI is not configured'), { kind: 'unconfigured' });
    const startedAt = input.startedAt ?? now();
    if ((input.remainingTurns ?? 0) <= 0 && !input.toolResult) {
      throw Object.assign(new Error('Model budget exhausted'), { kind: 'budget' });
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Model turn timed out')), PUBLIC_COMMAND_LIMITS.modelTurnMs);
    try {
      const tools = input.mode === 'execute'
        ? gevOpenRouterTools()
        : catalogToolsToOpenRouter(toolsForPublicMode(input.mode));
      const messages = input.previousResponseId || input.callId
        ? [{ role: 'system', content: SYSTEM_PROMPT }, ...continuationMessages(input)]
        : [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: publicUserPayload(input) },
        ];
      const result = await postOpenRouterChat({
        apiKey: resolvedKey,
        model: resolvedModel,
        messages,
        tools,
        maxTokens: 500,
        fetchImpl,
        signal: controller.signal,
        limiter,
      });
      if (!result.ok) {
        throw Object.assign(new Error(result.payload?.error || 'Public command AI request failed'), {
          status: result.status,
          kind: result.kind || 'provider',
        });
      }
      return parsePublicChatCompletionsOutput(result.payload, input.mode);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
