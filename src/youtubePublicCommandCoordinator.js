import { randomUUID } from 'node:crypto';
import {
  PUBLIC_COMMAND_LIMITS,
  parsePublicCommand,
  toolsForPublicMode,
  validatePublicToolCall,
} from './youtubePublicCommandPolicy.js';
import {
  HOST_FOLLOWUP_SECONDS,
  atHandle,
  createHostSession,
  formatHostAsk,
  formatHostFollowupAsk,
  hostViewerIdentity,
  isViewChoiceComment,
} from './youtubePublicHostSession.js';

const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);


function isCameraTool(tool, result) {
  const name = String(tool?.name || result?.action || '');
  return name === 'fly_to_location' || name === 'zoom_to_globe' || name === 'move_camera'
    || name === 'frame_overhead' || name === 'fly_route';
}

function answerFromToolResult(tool, result, { handle, followup = false } = {}) {
  const query = bounded(result?.label || result?.query || tool?.arguments?.query || tool?.name || 'view', 160);
  if (result?.ok === false) return bounded(result?.error || 'Action failed', 180);
  if (!followup && (tool?.name === 'fly_to_location' || result?.action === 'fly_to_location')) {
    return formatHostAsk({ handle, place: query });
  }
  const summary = tool?.name === 'fly_to_location' || result?.action === 'fly_to_location'
    ? 'Moved'
    : bounded(result?.message || result?.answer || 'Updated the view', 80);
  return formatHostFollowupAsk({ handle, place: query, summary });
}

function inferNavigateTool(comment) {
  const text = bounded(comment, PUBLIC_COMMAND_LIMITS.commentText);
  const match = text.match(/\b(?:navigate to|take me to|go to|fly to|zoom to|focus on|look at|show me|show|see|view|find|locate)\s+(?:me\s+)?(.{2,160})$/i);
  if (!match) return null;
  const query = bounded(match[1], 160).replace(/[.?!]+$/, '').trim();
  if (!query || /^(?:it|this|that|there|something|anything)$/i.test(query)) return null;
  if (isViewChoiceComment(text)) return null;
  return { name: 'fly_to_location', arguments: { query, viewMode: 'overview' } };
}


/**
 * Model-first coordinator. It persists validated calls for a separate trusted
 * capture executor; it never imports or directly invokes the browser runner.
 */
export function createYoutubePublicCommandCoordinator({ ledger, interpret, now = Date.now, id = randomUUID } = {}) {
  if (!ledger || typeof interpret !== 'function') throw new TypeError('ledger and interpret are required');
  const host = createHostSession({ now });

  function succeedCamera(record, result) {
    const identity = hostViewerIdentity({}, record);
    const place = bounded(result?.label || result?.query || record.validatedTool?.arguments?.query, 80);
    const followup = host.isOwner(identity);
    host.open(identity, place || host.current()?.place, record.id);
    return {
      state: 'succeeded',
      nonce: null,
      executionResult: structuredClone(result),
      answer: answerFromToolResult(record.validatedTool, result, { handle: identity.handle, followup }),
      reason: '',
    };
  }

  async function register(comment, binding) {
    const parsed = parsePublicCommand(comment?.text);
    const overrideMode = bounded(comment?.agentMode, 32);
    const recognized = parsed.recognized || Boolean(overrideMode);
    const valid = parsed.recognized
      ? parsed.valid
      : Boolean(overrideMode && toolsForPublicMode(overrideMode).length);
    if (!recognized) return { recognized: false };
    const identity = hostViewerIdentity(comment);
    const active = host.current();
    const hold = valid && comment?.deferAgent !== true && host.shouldHold(identity);
    const record = {
      id: id(), videoId: bounded(binding?.videoId, 80), commentId: bounded(comment?.commentId, 160),
      generation: Number(binding?.generation), captureExecutorId: bounded(binding?.captureExecutorId, 160),
      viewer: bounded(comment?.author?.displayName, PUBLIC_COMMAND_LIMITS.viewerName),
      authorHandle: identity.handle,
      comment: bounded(comment?.text, PUBLIC_COMMAND_LIMITS.commentText),
      command: parsed.command || 'viewer-request',
      mode: parsed.mode || overrideMode,
      state: valid ? 'received' : 'rejected',
      reason: valid ? (hold
        ? `Queued until ${atHandle(active.handle)} replies (${HOST_FOLLOWUP_SECONDS}s window)`
        : '')
        : (parsed.reason || 'Unknown public command mode'),
      holdUntil: hold ? active.expiresAt : 0,
      expiresAt: now() + PUBLIC_COMMAND_LIMITS.totalMs,
      remainingTurns: PUBLIC_COMMAND_LIMITS.modelTurns,
      remainingTools: PUBLIC_COMMAND_LIMITS.toolCalls,
    };
    const inserted = await ledger.insert(record);
    if (!inserted.inserted || !valid) return { recognized: true, duplicate: !inserted.inserted, record: inserted.record };
    if (comment?.deferAgent === true || hold) {
      return { recognized: true, queued: Boolean(hold), record: await ledger.get(record.id) };
    }
    host.open(identity, host.current()?.place || identity.handle, record.id);
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
      await ledger.compareAndSet(record.id, record.state, succeedCamera(record, continuation.result));
      return { ok: true, record: await ledger.get(record.id) };
    }
    if ((record.remainingTurns || 0) <= 0 || (record.remainingTools || 0) <= 0) {
      await ledger.compareAndSet(record.id, record.state, {
        remainingTurns: Math.max(Number(record.remainingTurns) || 0, PUBLIC_COMMAND_LIMITS.modelTurns),
        remainingTools: Math.max(Number(record.remainingTools) || 0, PUBLIC_COMMAND_LIMITS.toolCalls),
      });
      record = await ledger.get(record.id);
    }
    if (continuation) {
      if (record.state !== 'awaiting-model' || continuation.responseId !== record.modelResponseId || continuation.callId !== record.functionCallId) return { ok: false, reason: 'continuation-mismatch' };
      await ledger.compareAndSet(record.id, 'awaiting-model', { state: 'interpreting' });
      record = await ledger.get(record.id);
    }
    let output;
    try {
      const identity = hostViewerIdentity({}, record);
      output = await interpret({
        mode: record.mode, comment: record.comment, viewer: record.viewer,
        videoId: record.videoId, generation: record.generation, startedAt: now(),
        remainingTurns: record.remainingTurns,
        hostSession: host.current(),
        followup: host.isOwner(identity),
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
      if (checkedForce.ok) {
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
      if (!chosen.ok) {
        await ledger.compareAndSet(record.id, 'interpreting', { state: 'rejected', reason: chosen.reason || checked.reason || 'Invalid tool call', remainingTurns: turns });
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
      await ledger.compareAndSet(record.id, 'executing', succeedCamera(record, result));
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
      await ledger.compareAndSet(record.id, 'executing', succeedCamera(record, result));
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
    tick: () => host.current(),
    hostSession: () => host.current(),
    cancelAfterRestart: ledger.cancelNonterminal,
  };
}