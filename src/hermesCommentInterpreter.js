/**
 * Hermes comment interpreter — same contract as the OpenRouter interpreter:
 * one tool-call or a final text reply per invocation.
 *
 * @module hermesCommentInterpreter
 */

import { randomUUID } from 'node:crypto';
import { PUBLIC_COMMAND_LIMITS } from './youtubePublicCommandPolicy.js';
import { viewSafeToolsFrom, validateViewSafeToolCall } from './hermesViewSafeCatalog.js';
import { assembleLiveViewContext } from './liveViewContext.js';
import { openRouterFreeModel } from './openrouterFreeClient.js';

const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * @param {object} options
 * @param {object} options.bridge Hermes stdio bridge
 */
export function createHermesCommentInterpreter({
  bridge,
  tools = viewSafeToolsFrom(),
  model = openRouterFreeModel(),
  id = randomUUID,
} = {}) {
  if (!bridge || typeof bridge.request !== 'function') {
    throw new TypeError('Hermes interpreter requires a stdio bridge');
  }

  return async function interpret(input = {}) {
    const live = bridge.status?.();
    if (live && live.running === false) {
      throw Object.assign(new Error(live.lastError || 'Hermes is not running'), { kind: 'unconfigured' });
    }
    const turnId = bounded(input.previousResponseId || input.turnId || id(), 160);
    const liveContext = assembleLiveViewContext(input.viewContext, { model });
    if (!liveContext.ok) return liveContext;
    const frame = input.previousResponseId || input.callId
      ? {
        type: 'tool_result',
        turnId,
        callId: bounded(input.callId, 160),
        result: input.toolResult || {},
        viewContext: liveContext.context,
        content: liveContext.content,
        generatedSkill: input.generatedSkill || null,
        perception: {
          imageIncluded: liveContext.imageIncluded,
          imageOmitted: liveContext.imageOmitted,
          mediaFailures: liveContext.mediaFailures,
          capabilities: liveContext.capabilities,
          contentFormat: liveContext.capabilities.contentFormat,
        },
      }
      : {
        type: 'turn',
        turnId,
        comment: bounded(input.comment, PUBLIC_COMMAND_LIMITS.commentText),
        viewer: bounded(input.viewer, PUBLIC_COMMAND_LIMITS.viewerName),
        videoId: bounded(input.videoId, 80),
        viewContext: liveContext.context,
        content: liveContext.content,
        generatedSkill: input.generatedSkill || null,
        perception: {
          imageIncluded: liveContext.imageIncluded,
          imageOmitted: liveContext.imageOmitted,
          mediaFailures: liveContext.mediaFailures,
          capabilities: liveContext.capabilities,
          contentFormat: liveContext.capabilities.contentFormat,
        },
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema || tool.parameters,
        })),
      };
    const response = await bridge.request(frame);
    if (!response || typeof response !== 'object') {
      return { ok: false, kind: 'invalid', reason: 'Hermes returned no frame' };
    }
    if (response.type === 'error') {
      return {
        ok: false,
        kind: bounded(response.kind, 40) || 'hermes-error',
        reason: bounded(response.message || response.reason, 160) || 'Hermes returned an error',
      };
    }
    if (response.type === 'tool_request') {
      const checked = validateViewSafeToolCall(response.name, response.arguments);
      if (!checked.ok) return { ok: false, kind: 'invalid', reason: checked.reason };
      return {
        ok: true,
        kind: 'tool-call',
        call: {
          responseId: turnId,
          callId: bounded(response.callId || id(), 160),
          name: checked.name,
          arguments: checked.arguments,
        },
      };
    }
    if (response.type === 'final') {
      const text = bounded(response.text, 1000);
      return text
        ? { ok: true, kind: 'complete', text, responseId: turnId }
        : { ok: false, kind: 'invalid', reason: 'Hermes returned an empty reply' };
    }
    return { ok: false, kind: 'invalid', reason: 'Hermes protocol mismatch' };
  };
}

/**
 * In-process Hermes-style agent: OpenRouter + Cloud Computer AI.com skill + view-safe tools.
 * Used as the JSONL handler when the Hermes CLI is not installed.
 *
 * @param {object} options
 */
export function createHermesSkillAgent({
  postChat,
  model,
  skillText,
  tools = viewSafeToolsFrom(),
} = {}) {
  const sessions = new Map();

  return async function handle(frame) {
    if (!postChat) {
      return { type: 'error', turnId: frame?.turnId, message: 'Hermes model is not configured' };
    }
    const turnId = String(frame?.turnId || '');
    if (frame.type === 'turn') {
      sessions.set(turnId, {
        comment: frame.comment,
        viewer: frame.viewer,
        viewContext: frame.viewContext,
        content: frame.content,
        generatedSkill: frame.generatedSkill || null,
        results: [],
      });
    }
    const session = sessions.get(turnId);
    if (!session) return { type: 'error', turnId, message: 'Unknown Hermes turn' };
    if (frame.type === 'tool_result') {
      session.results.push({
        callId: frame.callId,
        result: frame.result,
        viewContext: frame.viewContext,
      });
      if (Array.isArray(frame.content)) session.content = frame.content;
      if (frame.generatedSkill) session.generatedSkill = frame.generatedSkill;
    }
    const openAiTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || tool.parameters || { type: 'object' },
      },
    }));
    const messages = [
      {
        role: 'system',
        content: `${skillText || HERMES_DEFAULT_SKILL}${
          session.generatedSkill
            ? `\nValidated generated learning for this turn:\n${JSON.stringify(session.generatedSkill).slice(0, 16_000)}`
            : ''
        }`,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
          comment: session.comment,
          viewer: session.viewer,
          viewContext: session.viewContext,
          priorResults: session.results,
            }).slice(0, 6000),
          },
          ...(Array.isArray(session.content)
            ? session.content.filter((part) => part?.type !== 'text').slice(0, 8)
            : []),
        ],
      },
    ];
    const result = await postChat({
      model,
      messages,
      tools: openAiTools,
      maxTokens: 700,
    });
    if (!result?.ok) {
      const err = result?.payload?.error;
      const fail = typeof err === 'string' ? err : (err?.message || 'Hermes model request failed');
      return { type: 'error', turnId, message: fail };
    }
    const message = result.payload?.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0];
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 1) {
      return { type: 'error', kind: 'invalid-model-output', turnId, message: 'Hermes returned multiple tool calls' };
    }
    if (toolCall?.function?.name) {
      let args = {};
      try {
        args = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : (toolCall.function.arguments || {});
      } catch {
        return { type: 'error', kind: 'invalid-model-output', turnId, message: 'Hermes tool arguments must be JSON' };
      }
      return {
        type: 'tool_request',
        turnId,
        callId: toolCall.id || `call-${session.results.length + 1}`,
        name: toolCall.function.name,
        arguments: args,
      };
    }
    sessions.delete(turnId);
    return {
      type: 'final',
      turnId,
      text: String(message?.content || '').trim(),
    };
  };
}

export const HERMES_DEFAULT_SKILL = `You are Cloud Computer AI.com on a live YouTube broadcast. Viewers type ordinary chat. You operate the visible globe through view-safe GEV functions only.

Inspect the current view, then act. Cities and countries use fly_to_location with viewMode overview so the place is visible (map-scale, not a 250 m white globe). Close is only for a named building or street. You may chain camera, layers, presets, search, track, overlay, and display tools until the requested scene is real.

Never claim success until a tool result confirms it. Never use ADMIN, credentials, shell, files, deploy, YouTube account writes, or unrestricted network tools. Address the viewer by username. Offer 2–5 real next views and tell them they have 90 seconds to reply. Keep the final reply short enough for live chat.`;
