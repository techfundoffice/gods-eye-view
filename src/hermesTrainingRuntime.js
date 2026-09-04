import { createIdleTrainingCoordinator } from './hermesIdleTraining.js';
import { createVersionedLessonStore } from './hermesLessonStore.js';
import { createGeneratedSkillManager } from './hermesGeneratedSkillManager.js';
import { createHermesTrainingControl } from './hermesTrainingControl.js';
import { isGevFunctionEnabled } from './gevFunctionToggles.js';
import { viewSafeToolsFrom } from './hermesViewSafeCatalog.js';

const PRACTICE_ACTIONS = Object.freeze([
  { name: 'get_current_view_state', args: {} },
  { name: 'zoom_to_globe', args: {} },
  { name: 'set_visual_style', args: { style: 'normal' } },
  { name: 'set_context_mode', args: { mode: 'off' } },
  { name: 'control_radio', args: { action: 'status' } },
  { name: 'control_cctv', args: { action: 'coverage' } },
  { name: 'show_data_layers_menu', args: {} },
]);

function nextPatchVersion(value) {
  const match = String(value || '0.0.0').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : '1.0.0';
}

/**
 * Connects task-56 persistence/control to the only trusted browser-action
 * path. Practice never calls browser code: it queues a validated action and
 * records a lesson only after the capture/browser reports its result.
 */
export function createHermesTrainingRuntime({
  commandRuntime,
  getBinding,
  hasPendingViewer = async () => false,
  now = Date.now,
  autoStart = true,
} = {}) {
  if (!commandRuntime || typeof getBinding !== 'function') throw new TypeError('commandRuntime and getBinding are required');
  let practiceIndex = 0;
  const lessons = createVersionedLessonStore({ now });
  const skills = createGeneratedSkillManager({
    now,
    replay: async (candidate, cases, { signal }) => {
      if (signal.aborted) throw signal.reason;
      if (!candidate.tools.every((name) => isGevFunctionEnabled(name))) return { ok: false, reasons: ['A proposed tool is disabled in ADMIN'] };
      if (!cases.length || cases.some((item) => item?.observed !== true || !candidate.tools.includes(item?.tool))) {
        return { ok: false, reasons: ['Replay requires an observed result for a declared view-safe tool'] };
      }
      return { ok: true, cases: cases.length };
    },
  });
  const training = createIdleTrainingCoordinator({
    now,
    train: async ({ signal, startedAt }) => {
      const binding = getBinding() || {};
      if (!binding.commandsEnabled || !binding.videoId) throw new Error('Practice unavailable: live browser is offline');
      if (await hasPendingViewer()) throw new Error('Practice unavailable: viewer work is pending');
      const enabledNames = new Set(viewSafeToolsFrom().map((tool) => tool.name));
      const available = PRACTICE_ACTIONS.filter((item) => enabledNames.has(item.name) && isGevFunctionEnabled(item.name));
      const action = available.length ? available[practiceIndex++ % available.length] : null;
      if (!action) throw new Error('Practice unavailable: no enabled view-safe action');
      const queued = await commandRuntime.enqueueTool({ ...action, source: 'idle-practice' }, binding);
      if (!queued.ok) throw new Error(queued.error?.message || 'Practice action was not queued');
      const observed = await commandRuntime.waitForObservedExecution(queued.command.id, binding, { signal });
      if (!observed.ok) throw new Error(observed.reason || 'Practice action was not observed in browser');
      const lesson = await lessons.add({
        summary: `Observed view-safe practice: ${action.name}`,
        action: action.name,
        arguments: action.args,
        preconditions: ['Verified live broadcast', 'No viewer work pending', 'Control enabled in ADMIN'],
        outcome: String(observed.result?.label || observed.result?.action || 'browser applied').slice(0, 160),
        modelRequirements: ['toolCalling'],
        trainingRunId: `training-${startedAt}`,
        recordedAt: now(),
      });
      const current = await skills.inspect();
      const candidate = {
        name: 'hermes-generated-view-skill',
        version: nextPatchVersion(current.active?.version),
        instructions: 'Operate only enabled view-safe live-interface controls. Inspect the observed result before recording success.',
        rules: [
          'Viewer work always preempts idle practice.',
          'Use the executable schema from the current generated catalog.',
          'Record a procedure only after a browser result is observed.',
        ],
        examples: [{ tool: action.name, arguments: action.args, observed: true }],
        tools: [...new Set([...(current.active?.tools || []), action.name])],
      };
      const skillDecision = await skills.propose(candidate, {
        rationale: `Validated idle practice ${action.name}`,
        cases: [{ tool: action.name, arguments: action.args, observed: true }],
      });
      if (!skillDecision.accepted) throw new Error(skillDecision.reasons?.join('; ') || 'Generated skill replay was rejected');
      return { action: action.name, observed: true, lessonRevision: lesson.revision, skillRevision: skillDecision.revision };
    },
  });
  const control = createHermesTrainingControl({ training, lessons, skills });
  if (autoStart) control.start();
  return control;
}