import { randomUUID } from 'node:crypto';
import {
  PUBLIC_COMMAND_LIMITS,
  PUBLIC_HELP_REPLY,
  parsePublicCommand,
  toolsForPublicMode,
  validatePublicToolCall,
} from './youtubePublicCommandPolicy.js';

const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);


function isCameraTool(tool, result) {
  const name = String(tool?.name || result?.action || '');
  return name === 'fly_to_location' || name === 'zoom_to_globe' || name === 'move_camera'
    || name === 'frame_overhead' || name === 'fly_route';
}

function answerFromToolResult(tool, result) {
  const query = bounded(result?.label || result?.query || tool?.arguments?.query || tool?.name || 'view', 160);
  if (result?.ok === false) return bounded(result?.error || 'Action failed', 180);
  if (tool?.name === 'fly_to_location' || result?.action === 'fly_to_location') {
    return `Navigated to ${query}.`;
  }
  return bounded(result?.message || result?.answer || `Completed ${query}.`, 180);
}

function inferNavigateTool(comment) {
  const text = bounded(comment, PUBLIC_COMMAND_LIMITS.commentText);
  const match = text.match(/\b(?:navigate to|take me to|go to|fly to|zoom to|focus on|look at|show me|show|see|view|find|locate)\s+(?:me\s+)?(.{2,160})$/i);
  if (!match) return null;
  const query = bounded(match[1], 160).replace(/[.?!]+$/, '').trim();
  if (!query || /^(?:it|this|that|there|something|anything)$/i.test(query)) return null;
  return { name: 'fly_to_location', arguments: { query, viewMode: 'close' } };
}


/**
 * Model-first coordinator. It persists validated calls for a separate trusted
 * capture executor; it never imports or directly invokes the browser runner.
 */
export function createYoutubePublicCommandCoordinator({ ledger, interpret, now = Date.now, id = randomUUID } = {}) {
  if (!ledger || typeof interpret !== 'function') throw new TypeError('ledger and interpret are required');

  async function register(comment, binding) {
    const parsed = parsePublicCommand(comment?.text);
    const overrideMode = bounded(comment?.agentMode, 32);
    const recognized = parsed.recognized || Boolean(overrideMode);
    const valid = parsed.recognized
      ? parsed.valid
      : Boolean(overrideMode && toolsForPublicMode(overrideMode).length);
    if (!recognized) return { recognized: false };
    const record = {
      id: id(), videoId: bounded(binding?.videoId, 80), commentId: bounded(comment?.commentId, 160),
      generation: Number(binding?.generation), captureExecutorId: bounded(binding?.captureExecutorId, 160),
      viewer: bounded(comment?.author?.displayName, PUBLIC_COMMAND_LIMITS.viewerName),
      authorHandle: bounded(comment?.author?.handle || comment?.authorHandle, 80),
      comment: bounded(comment?.text, PUBLIC_COMMAND_LIMITS.commentText),
      command: parsed.command || 'viewer-request',
      mode: parsed.mode || overrideMode,
      state: valid ? 'received' : 'rejected',
      reason: valid ? '' : (parsed.reason || 'Unknown public command mode'),
      expiresAt: now() + PUBLIC_COMMAND_LIMITS.totalMs,
      remainingTurns: PUBLIC_COMMAND_LIMITS.modelTurns,
      remainingTools: PUBLIC_COMMAND_LIMITS.toolCalls,
    };
    const inserted = await ledger.insert(record);
    if (!inserted.inserted || !valid) return { recognized: true, duplicate: !inserted.inserted, record: inserted.record };
    if (parsed.command === '/help') {
      await ledger.compareAndSet(record.id, 'received', { state: 'interpreting' });
      await ledger.compareAndSet(record.id, 'interpreting', {
        state: 'succeeded',
        answer: PUBLIC_HELP_REPLY,
      });
      return { recognized: true, record: await ledger.get(record.id) };
    }
    if (comment?.deferAgent === true) {
      return { recognized: true, record: await ledger.get(record.id) };
    }
    await ledger.compareAndSet(record.id, 'received', { state: 'interpreting' });
    return advance(record.id, binding);
  }

  async function advance(commandId, binding, continuation = null, viewContext = {}) {
    let record = await ledger.get(commandId);
    if (!record || record.generation !== Number(binding?.generation) || record.videoId !== bounded(binding?.videoId, 80)) {
      if (record && !['succeeded', 'rejected', 'failed', 'cancelled'].includes(record.state)) await ledger.compareAndSet(record.id, record.state, { state: 'cancelled', reason: 'Live generation changed' });
      return { ok: false, reason: 'stale' };
    }
    if (record.state === 'received') {
      await ledger.compareAndSet(record.id, 'received', {
        state: 'interpreting',
        expiresAt: now() + PUBLIC_COMMAND_LIMITS.totalMs,
        remainingTurns: Math.max(Number(record.remainingTurns) || 0, PUBLIC_COMMAND_LIMITS.modelTurns),
        remainingTools: Math.max(Number(record.remainingTools) || 0, PUBLIC_COMMAND_LIMITS.toolCalls),
      });
      record = await ledger.get(record.id);
    }
    if (continuation?.result && continuation.result.ok !== false && isCameraTool(record.validatedTool, continuation.result)) {
      const answer = answerFromToolResult(record.validatedTool, continuation.result);
      await ledger.compareAndSet(record.id, record.state, {
        state: 'succeeded',
        answer,
        reason: '',
        executionResult: structuredClone(continuation.result),
      });
      return { ok: true, record: await ledger.get(record.id) };
    }
    if (record.remainingTurns <= 0 && record.remainingTools <= 0) {
      await ledger.compareAndSet(record.id, record.state, { state: 'failed', reason: 'Command budget exhausted' });
      return { ok: false, reason: 'budget' };
    }
    if (continuation) {
      if (record.state !== 'awaiting-model' || continuation.responseId !== record.modelResponseId || continuation.callId !== record.functionCallId) return { ok: false, reason: 'continuation-mismatch' };
      await ledger.compareAndSet(record.id, 'awaiting-model', { state: 'interpreting' });
      record = await ledger.get(record.id);
    }
    let output;
    try {
      output = await interpret({
        mode: record.mode, comment: record.comment, viewer: record.viewer,
        videoId: record.videoId, generation: record.generation, startedAt: now(),
        remainingTurns: record.remainingTurns,
        ...(continuation ? {
          previousResponseId: continuation.responseId, callId: continuation.callId,
          toolResult: continuation.result,
          priorCall: record.validatedTool,
        } : {}),
        viewContext: viewContext && typeof viewContext === 'object' ? viewContext : {},
      });
    } catch (error) {
      if (error?.kind === 'rate-limited') {
        await ledger.compareAndSet(record.id, 'interpreting', {
          state: 'rejected', reason: 'OpenRouter rate limit',
        });
        return { ok: false, reason: 'rate-limited' };
      }
      await ledger.compareAndSet(record.id, 'interpreting', { state: 'failed', reason: bounded(error?.message || 'Interpreter failed', 160) });
      return { ok: false, reason: 'interpreter' };
    }
    const turns = record.remainingTurns - 1;
    if (!output?.ok) {
      await ledger.compareAndSet(record.id, 'interpreting', { state: 'rejected', reason: bounded(output?.reason, 160), remainingTurns: turns });
    } else if (output.kind === 'complete') {
      const forced = inferNavigateTool(record.comment);
      const checkedForce = forced
        ? validatePublicToolCall(record.mode, forced.name, forced.arguments)
        : { ok: false };
      if (checkedForce.ok && record.remainingTools > 0) {
        await ledger.compareAndSet(record.id, 'interpreting', {
          state: 'awaiting-execution',
          nonce: id(),
          modelResponseId: output.responseId || record.modelResponseId || '',
          functionCallId: output.call?.callId || `forced-fly-${record.id}`,
          validatedTool: checkedForce,
          remainingTurns: Math.max(1, turns),
          remainingTools: Math.max(0, record.remainingTools - 1),
        });
      } else {
        await ledger.compareAndSet(record.id, 'interpreting', { state: 'succeeded', answer: bounded(output.text, 1000), remainingTurns: turns });
      }
    } else {
      const forced = inferNavigateTool(record.comment);
      const checkedForce = forced
        ? validatePublicToolCall(record.mode, forced.name, forced.arguments)
        : { ok: false };
      const checked = validatePublicToolCall(record.mode, output.call?.name, output.call?.arguments);
      const chosen = checkedForce.ok ? checkedForce : checked;
      if (!chosen.ok || record.remainingTools <= 0) {
        await ledger.compareAndSet(record.id, 'interpreting', { state: 'rejected', reason: chosen.reason || checked.reason || 'Tool budget exhausted', remainingTurns: turns });
      } else {
        await ledger.compareAndSet(record.id, 'interpreting', {
          state: 'awaiting-execution', nonce: id(), modelResponseId: output.call.responseId,
          functionCallId: output.call.callId, validatedTool: chosen,
          remainingTurns: Math.max(1, turns), remainingTools: Math.max(0, record.remainingTools - 1),
        });
      }
    }
    return { ok: true, record: await ledger.get(record.id) };
  }

  async function acceptToolResult(commandId, binding, result) {
    const record = await ledger.get(commandId);
    if (!record || record.state !== 'executing') return { ok: false, reason: 'state' };
    const checked = validatePublicToolCall(record.mode, record.validatedTool?.name, record.validatedTool?.arguments);
    const current = binding?.commandsEnabled === true
      && record.generation === Number(binding?.generation)
      && record.videoId === bounded(binding?.videoId, 80)
      && record.captureExecutorId === bounded(binding?.captureExecutorId, 160)
      && record.captureEpoch === bounded(binding?.captureEpoch, 160);
    if (!checked.ok || !current) {
      await ledger.compareAndSet(record.id, 'executing', {
        state: 'cancelled',
        reason: checked.ok ? 'Verified live binding changed' : 'Stored tool failed revalidation',
      });
      return { ok: false, reason: 'stale-or-invalid' };
    }
    if (result && result.ok !== false && isCameraTool(record.validatedTool, result)) {
      await ledger.compareAndSet(record.id, 'executing', {
        state: 'succeeded',
        nonce: null,
        executionResult: structuredClone(result),
        answer: answerFromToolResult(record.validatedTool, result),
        reason: '',
      });
      return { ok: true, record: await ledger.get(record.id) };
    }
    await ledger.compareAndSet(record.id, 'executing', { state: 'awaiting-model', nonce: null, executionResult: structuredClone(result) });
    return advance(record.id, binding, { responseId: record.modelResponseId, callId: record.functionCallId, result });
  }

  async function acceptViewerToolResult(commandId, binding, nonce, result, viewContext = {}) {
    const record = await ledger.get(commandId);
    if (!record || record.state !== 'executing') return { ok: false, reason: 'state' };
    if (bounded(nonce, PUBLIC_COMMAND_LIMITS.id) !== bounded(record.nonce, PUBLIC_COMMAND_LIMITS.id)) {
      return { ok: false, reason: 'nonce' };
    }
    const checked = validatePublicToolCall(record.mode, record.validatedTool?.name, record.validatedTool?.arguments);
    const current = binding?.commandsEnabled === true
      && record.generation === Number(binding?.generation)
      && record.videoId === bounded(binding?.videoId, 80)
      && record.captureExecutorId === bounded(binding?.captureExecutorId, 160);
    if (!checked.ok || !current) {
      await ledger.compareAndSet(record.id, 'executing', {
        state: 'cancelled',
        reason: checked.ok ? 'Verified live binding changed' : 'Stored tool failed revalidation',
      });
      return { ok: false, reason: 'stale-or-invalid' };
    }
    if (result && result.ok !== false && isCameraTool(record.validatedTool, result)) {
      await ledger.compareAndSet(record.id, 'executing', {
        state: 'succeeded',
        nonce: null,
        executionResult: structuredClone(result),
        answer: answerFromToolResult(record.validatedTool, result),
        reason: '',
      });
      return { ok: true, record: await ledger.get(record.id) };
    }
    await ledger.compareAndSet(record.id, 'executing', {
      state: 'awaiting-model',
      nonce: null,
      executionResult: structuredClone(result),
    });
    return advance(record.id, binding, {
      responseId: record.modelResponseId,
      callId: record.functionCallId,
      result,
    }, viewContext);
  }

  return {
    register,
    advance,
    acceptToolResult,
    acceptViewerToolResult,
    cancelAfterRestart: ledger.cancelNonterminal,
  };
}