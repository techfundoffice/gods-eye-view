import { randomUUID } from 'node:crypto';
import {
  PUBLIC_COMMAND_LIMITS,
  PUBLIC_HELP_REPLY,
  parsePublicCommand,
  toolsForPublicMode,
  validatePublicToolCall,
} from './youtubePublicCommandPolicy.js';

/** Backoff floor and ceiling for a deferred retry. */
export const DEFER_BASE_MS = 2_000;
export const DEFER_MAX_MS = 120_000;

/**
 * How long a rate-limited command waits before its next interpret attempt.
 *
 * The upstream's own `Retry-After` wins when present — OpenRouter knows when
 * its window reopens and we do not. Otherwise back off exponentially, with
 * jitter so a burst of comments deferred by the same 429 does not come back as
 * one synchronised herd.
 *
 * @param {number} deferrals Deferrals already recorded for this command.
 * @param {number} [retryAfterMs] Upstream hint; 0 when absent.
 * @param {() => number} [random] Injected for deterministic tests.
 * @returns {number} Milliseconds to wait.
 */
export function deferralDelayMs(deferrals, retryAfterMs = 0, random = Math.random) {
  const hint = Number(retryAfterMs) || 0;
  if (hint > 0) return Math.min(hint, DEFER_MAX_MS);
  const attempt = Math.max(0, Number(deferrals) || 0);
  const backoff = Math.min(DEFER_BASE_MS * (2 ** attempt), DEFER_MAX_MS);
  return Math.round(backoff * (0.5 + (random() * 0.5)));
}

const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

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
        viewContext: viewContext && typeof viewContext === 'object' ? viewContext : {},
      });
    } catch (error) {
      if (error?.kind === 'rate-limited') {
        // Wait the window out instead of killing the comment. No model turn
        // was spent, so remainingTurns is untouched; expiresAt is pushed past
        // the retry because the 20s command budget measures model latency, not
        // time spent queued behind somebody else's rate limit.
        const deferrals = (Number(record.deferrals) || 0);
        const delay = deferralDelayMs(deferrals, error?.retryAfterMs);
        const retryAt = now() + delay;
        await ledger.compareAndSet(record.id, 'interpreting', {
          state: 'deferred',
          reason: 'Upstream rate limit — queued for retry',
          deferrals: deferrals + 1,
          retryAt,
          expiresAt: retryAt + PUBLIC_COMMAND_LIMITS.totalMs,
        });
        return { ok: false, reason: 'rate-limited', retryAt, record: await ledger.get(record.id) };
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

  /**
   * Put one due deferred command back through the interpreter.
   *
   * @param {string} commandId
   * @param {object} binding Verified live binding.
   * @param {object} [viewContext]
   * @returns {Promise<object>}
   */
  async function resumeDeferred(commandId, binding, viewContext = {}) {
    // Re-stamp the executor: the command outlived the session that was current
    // when it was deferred, and the lease filters match on this id.
    const claimed = await ledger.compareAndSet(commandId, 'deferred', {
      state: 'interpreting',
      captureExecutorId: bounded(binding?.captureExecutorId, 160),
    });
    if (!claimed.changed) return { ok: false, reason: 'state' };
    return advance(commandId, binding, null, viewContext);
  }

  return {
    register,
    advance,
    resumeDeferred,
    acceptToolResult,
    acceptViewerToolResult,
    cancelAfterRestart: ledger.cancelNonterminal,
  };
}