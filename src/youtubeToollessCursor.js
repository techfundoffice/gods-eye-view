/**
 * Dedicated Cursor ACP harness for untrusted YouTube comment interpretation.
 *
 * Cursor's stock adapter exposes coding tools and its ACP implementation does
 * not yet support native tool filtering. This configuration instead declares
 * no host tools and supplies a complete permission-mode mapping. In ACP v1,
 * the presence of that mapping disables automatic tool approval; any native
 * tool request is suspended for approval and is never approved by this app.
 */
import { createACP } from '@ai-sdk/harness-acp';

export const TOOLLESS_CURSOR_MODE = Object.freeze({
  type: 'session-mode',
  modeId: 'ask',
});

export function createToollessCursorHarness() {
  return createACP({
    version: 'v1',
    harnessId: 'cursor-comment-interpreter',
    builtinTools: {},
    source: {
      type: 'install-command',
      command: 'curl https://cursor.com/install -fsS | bash',
    },
    executable: 'agent',
    args: ['--disable-auto-update', 'acp'],
    resolveModel: ({ model }) => ({
      args: ['--disable-auto-update', '--model', model, 'acp'],
    }),
    forwardEnv: ['CURSOR_API_KEY'],
    permissionModeMapping: {
      'allow-reads': TOOLLESS_CURSOR_MODE,
      'allow-edits': TOOLLESS_CURSOR_MODE,
      'allow-all': TOOLLESS_CURSOR_MODE,
    },
  });
}

export const toollessCursor = createToollessCursorHarness();

export function supportsVerifiedToolIsolation(harness = toollessCursor) {
  return harness?.harnessId === 'cursor-comment-interpreter'
    && Object.keys(harness?.builtinTools || {}).length === 0
    && harness?.supportsBuiltinToolApprovals === true;
}