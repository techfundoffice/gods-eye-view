import { randomUUID } from 'node:crypto';
import {
  PUBLIC_COMMAND_LIMITS,
  PUBLIC_HELP_REPLY,
  PUBLIC_VIEW_PRESETS,
  parsePublicCommand,
  validatePublicToolCall,
} from './youtubePublicCommandPolicy.js';

const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * Model-first coordinator. It persists validated calls for a separate trusted
 * capture executor; it never imports or directly invokes the browser runner.
 */
export function createYoutubePublicCommandCoordinator({ ledger, interpret, now = Date.now, id = randomUUID } = {}) {
  if (!ledger || typeof interpret !== 'function') throw new TypeError('ledger and interpret are required');

  async function register(comment, binding) {
    const parsed = parsePublicCommand(comment?.text);
    if (!parsed.recognized) return { recognized: false };
    const record = {
      id: id(), videoId: bounded(binding?.videoId, 80), commentId: bounded(comment?.commentId, 160),
      generation: Number(binding?.generation), captureExecutorId: bounded(binding?.captureExecutorId, 160),
      viewer: bounded(comment?.author?.displayName, PUBLIC_COMMAND_LIMITS.viewerName),
      authorHandle: bounded(comment?.author?.handle || comment?.authorHandle, 80),
      comment: bounded(comment?.text, PUBLIC_COMMAND_LIMITS.commentText),
      command: parsed.command, mode: parsed.mode, state: parsed.valid ? 'received' : 'rejected',
      reason: parsed.reason, expiresAt: now() + PUBLIC_COMMAND_LIMITS.totalMs,
    };
    const inserted = await ledger.insert(record);
    if (!inserted.inserted || !parsed.valid) return { recognized: true, duplicate: !inserted.inserted, record: inserted.record };
    await ledger.compareAndSet(record.id, 'received', { state: 'interpreting' });
    if (parsed.command === '/help') {
      await ledger.compareAndSet(record.id, 'interpreting', {
        state: 'succeeded',
        answer: PUBLIC_HELP_REPLY,
      });
      return { recognized: true, record: await ledger.get(record.id) };
    }
    if (PUBLIC_VIEW_PRESETS[parsed.command]) {
      const checked = validatePublicToolCall(parsed.command, 'run_view_preset', { preset: parsed.command });
      if (!checked.ok) {
        await ledger.compareAndSet(record.id, 'interpreting', { state: 'rejected', reason: checked.reason });
        return { recognized: true, record: await ledger.get(record.id) };
      }
      await ledger.compareAndSet(record.id, 'interpreting', {
        state: 'awaiting-execution',
        nonce: id(),
        validatedTool: checked,
      });
      return { recognized: true, record: await ledger.get(record.id) };
    }
    return advance(record.id, binding);
  }

  async function advance(commandId, binding, continuation = null) {
    let record = await ledger.get(commandId);
    if (!record || record.generation !== Number(binding?.generation) || record.videoId !== bounded(binding?.videoId, 80)) {
      if (record && !['succeeded', 'rejected', 'failed', 'cancelled'].includes(record.state)) await ledger.compareAndSet(record.id, record.state, { state: 'cancelled', reason: 'Live generation changed' });
      return { ok: false, reason: 'stale' };
    }
    if (record.expiresAt <= now() || record.remainingTurns <= 0) {
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
        videoId: record.videoId, generation: record.generation, startedAt: record.createdAt,
        remainingTurns: record.remainingTurns,
        ...(continuation ? {
          previousResponseId: continuation.responseId, callId: continuation.callId,
          toolResult: continuation.result,
          priorCall: record.validatedTool,
        } : {}),
      });
    } catch (error) {
      if (error?.kind === 'rate-limited') {
        await ledger.compareAndSet(record.id, 'interpreting', {
          state: 'rejected', reason: 'OpenRouter free rate limit',
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
      await ledger.compareAndSet(record.id, 'interpreting', { state: 'succeeded', answer: bounded(output.text, 1000), remainingTurns: turns });
    } else {
      const checked = validatePublicToolCall(record.mode, output.call?.name, output.call?.arguments);
      if (!checked.ok || record.remainingTools <= 0) {
        await ledger.compareAndSet(record.id, 'interpreting', { state: 'rejected', reason: checked.reason || 'Tool budget exhausted', remainingTurns: turns });
      } else {
        await ledger.compareAndSet(record.id, 'interpreting', {
          state: 'awaiting-execution', nonce: id(), modelResponseId: output.call.responseId,
          functionCallId: output.call.callId, validatedTool: checked,
          remainingTurns: turns, remainingTools: record.remainingTools - 1,
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
    if (PUBLIC_VIEW_PRESETS[record.command]) {
      const ok = result?.ok !== false;
      await ledger.compareAndSet(record.id, 'executing', {
        state: ok ? 'succeeded' : 'failed',
        nonce: null,
        executionResult: structuredClone(result),
        reason: ok ? '' : bounded(result?.error || 'View preset failed', 160),
        answer: ok ? bounded(record.command, 160) : '',
      });
      return { ok, record: await ledger.get(record.id) };
    }
    await ledger.compareAndSet(record.id, 'executing', { state: 'awaiting-model', nonce: null, executionResult: structuredClone(result) });
    return advance(record.id, binding, { responseId: record.modelResponseId, callId: record.functionCallId, result });
  }

  return { register, advance, acceptToolResult, cancelAfterRestart: ledger.cancelNonterminal };
}