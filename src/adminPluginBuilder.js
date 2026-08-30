/**
 * "Create Plugin" — the chat-driven plugin builder.
 *
 * The ADMIN types a plugin name and a description; this module hands that to a
 * Claude Code agent running against the repository root, streams the agent's
 * turn back as chat transcript entries, and keeps the session id so follow-up
 * messages continue the same conversation instead of starting cold.
 *
 * The agent runs with write access to this checkout. Two things bound that:
 * the process is always spawned with `cwd` pinned to the repository root, and
 * every route that reaches this module sits behind an authenticated admin
 * session. Nothing here is reachable without a login.
 *
 * @module adminPluginBuilder
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Directory the generated plugin modules are asked to live in. */
export const ADMIN_PLUGIN_DIR = 'src/adminPlugins';
/** Manifest the admin menu reads to discover generated plugins. */
export const ADMIN_PLUGIN_MANIFEST = 'src/adminPlugins/manifest.json';
/** Transcript entries retained per job; older ones are dropped from the head. */
export const ADMIN_MAX_TRANSCRIPT_ENTRIES = 400;
/** A single agent turn is abandoned after this long. */
export const ADMIN_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Read the generated-plugin manifest off disk.
 *
 * The file only exists once an agent has finished a build, and it is written
 * by that agent rather than by this code, so every failure mode — absent,
 * unreadable, half-written, not JSON — is answered with an empty manifest.
 * Callers normalize the result with `normalizePluginManifest`.
 *
 * @param {object} [options]
 * @param {string} [options.file] Manifest path, absolute or repo-relative.
 * @param {typeof fs} [options.fsImpl] Injected for tests.
 * @param {string} [options.root] Repository root for a relative path.
 * @returns {unknown} Parsed manifest contents, or `[]`.
 */
export function readPluginManifest({ file = ADMIN_PLUGIN_MANIFEST, fsImpl = fs, root = process.cwd() } = {}) {
  const resolved = path.isAbsolute(file) ? file : path.join(root, file);
  try {
    return JSON.parse(fsImpl.readFileSync(resolved, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Turn a free-text plugin name into a stable slug plus a display name.
 *
 * @param {unknown} name Operator-typed plugin name.
 * @returns {{slug: string, display: string}}
 * @throws {TypeError} When the name has no usable characters.
 */
export function normalizePluginName(name) {
  const display = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const slug = display
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug) throw new TypeError('Plugin name must contain letters or numbers');
  return { slug, display };
}

/**
 * The opening instruction handed to the agent.
 *
 * It names the exact artifacts a plugin needs to become a working admin menu
 * item, because "add a plugin" alone leaves the agent guessing at this repo's
 * conventions — and a plugin that is written but never registered looks to the
 * operator like the build silently failed.
 *
 * @param {object} input
 * @param {string} input.display Human-facing plugin name.
 * @param {string} input.slug Kebab-case identifier.
 * @param {string} [input.instructions] What the operator wants it to do.
 * @returns {string}
 */
export function buildPluginPrompt({ display, slug, instructions = '' }) {
  const brief = String(instructions || '').trim();
  return [
    `You are extending God's Eye View from its own ADMIN console. Build a new admin menu plugin named "${display}".`,
    '',
    'Requirements:',
    `1. Create the plugin module at ${ADMIN_PLUGIN_DIR}/${slug}.js. It must export a default object`,
    '   shaped `{ id, label, description, render(container, context) }` — `render` receives the admin',
    '   content element and may return a cleanup function.',
    `2. Register it in ${ADMIN_PLUGIN_MANIFEST} (create the file as a JSON array if it does not exist)`,
    `   with an entry \`{ "id": "${slug}", "label": "${display}", "module": "./${slug}.js" }\` so the admin`,
    '   dashboard menu picks it up on the next load.',
    '3. Match the surrounding code: vanilla ES modules, JSDoc on exported functions, no new dependencies,',
    '   and the terminal/monospace visual language already in style.css.',
    `4. Add a unit test at ${ADMIN_PLUGIN_DIR}/${slug}.test.mjs covering the plugin's pure logic, using`,
    '   node:test and node:assert/strict like the other tests in src/.',
    '5. Run `npm test` when you are done and fix anything you broke.',
    '',
    brief
      ? `What this plugin should do:\n${brief}`
      : 'The operator gave no further detail; infer a sensible, genuinely useful feature from the name and say what you assumed.',
    '',
    'Report at the end: the files you created or changed, and whether the test run passed.',
  ].join('\n');
}

/**
 * Build the Claude Code CLI arguments for one turn.
 *
 * @param {object} input
 * @param {string} input.prompt Turn text.
 * @param {string} [input.resumeSessionId] Continue an existing agent session.
 * @param {string} [input.permissionMode] Claude Code permission mode.
 * @returns {string[]}
 */
export function buildAgentArgs({ prompt, resumeSessionId = '', permissionMode = 'bypassPermissions' }) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode,
  ];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push(String(prompt ?? ''));
  return args;
}

/**
 * Normalize one line of Claude Code `stream-json` output into a transcript
 * event. Unparseable or uninteresting lines return null so the caller can skip
 * them without special-casing.
 *
 * @param {string} line One newline-delimited JSON record.
 * @returns {{role: string, text: string, sessionId?: string, done?: boolean, isError?: boolean}|null}
 */
export function parseAgentStreamLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'system' && event.subtype === 'init') {
    return { role: 'system', text: 'Agent session started.', sessionId: String(event.session_id || '') };
  }
  if (event.type === 'assistant') {
    const parts = Array.isArray(event.message?.content) ? event.message.content : [];
    const spoken = parts
      .filter((part) => part?.type === 'text' && String(part.text || '').trim())
      .map((part) => String(part.text).trim())
      .join('\n\n');
    const tools = parts
      .filter((part) => part?.type === 'tool_use')
      .map((part) => String(part.name || 'tool'));
    if (spoken) return { role: 'agent', text: spoken, sessionId: String(event.session_id || '') };
    if (tools.length) {
      return { role: 'tool', text: `Working: ${tools.join(', ')}`, sessionId: String(event.session_id || '') };
    }
    return null;
  }
  if (event.type === 'result') {
    const isError = Boolean(event.is_error) || event.subtype !== 'success';
    const summary = String(event.result || '').trim();
    return {
      role: isError ? 'system' : 'agent',
      text: summary || (isError ? 'Agent turn failed.' : 'Agent turn complete.'),
      sessionId: String(event.session_id || ''),
      done: true,
      isError,
    };
  }
  return null;
}

/**
 * Strip a job to the shape the browser is allowed to see.
 *
 * The agent session id stays server-side: it is a handle to a resumable
 * process with write access, not something a page needs.
 *
 * @param {object} job
 * @returns {object}
 */
export function publicJob(job) {
  return {
    id: job.id,
    slug: job.slug,
    name: job.name,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null,
    transcript: job.transcript.map((entry) => ({ role: entry.role, text: entry.text, at: entry.at })),
  };
}

/**
 * Plugin-builder job registry.
 *
 * @param {object} [options]
 * @param {typeof nodeSpawn} [options.spawnImpl] Injected for tests.
 * @param {string} [options.cwd] Repository root the agent may edit.
 * @param {string} [options.command] Agent executable.
 * @param {string} [options.permissionMode] Claude Code permission mode.
 * @param {() => number} [options.now] Clock injection.
 * @param {number} [options.timeoutMs] Per-turn timeout.
 * @returns {object} Builder facade used by the admin middleware.
 */
export function createPluginBuilder({
  spawnImpl = nodeSpawn,
  cwd = process.cwd(),
  command = process.env.ADMIN_AGENT_COMMAND || 'claude',
  permissionMode = process.env.ADMIN_AGENT_PERMISSION_MODE || 'bypassPermissions',
  now = () => Date.now(),
  timeoutMs = ADMIN_AGENT_TIMEOUT_MS,
} = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();

  function stamp() {
    return new Date(now()).toISOString();
  }

  function append(job, role, text) {
    const body = String(text ?? '').trim();
    if (!body) return;
    job.transcript.push({ role, text: body, at: stamp() });
    if (job.transcript.length > ADMIN_MAX_TRANSCRIPT_ENTRIES) {
      job.transcript.splice(0, job.transcript.length - ADMIN_MAX_TRANSCRIPT_ENTRIES);
    }
    job.updatedAt = stamp();
  }

  /**
   * Run one agent turn against a job, streaming its output into the transcript.
   *
   * @param {object} job
   * @param {string} prompt
   * @returns {Promise<void>} Resolves when the turn settles (never rejects).
   */
  function runTurn(job, prompt) {
    const args = buildAgentArgs({
      prompt,
      resumeSessionId: job.sessionId,
      permissionMode,
    });
    job.status = 'running';
    job.error = null;
    job.updatedAt = stamp();

    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(command, args, {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        job.status = 'failed';
        job.error = `Could not start the agent (${command}): ${error?.message || error}`;
        append(job, 'system', job.error);
        resolve();
        return;
      }

      job.child = child;
      let settled = false;
      let stdoutBuffer = '';
      let stderrTail = '';

      const timer = setTimeout(() => {
        append(job, 'system', 'Agent turn exceeded its time limit and was stopped.');
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }, timeoutMs);
      // A live child already holds the event loop open, so this watchdog never
      // needs to. Unreffed, it also cannot keep a process alive for half an
      // hour after the agent has gone.
      timer.unref?.();

      const finish = (status, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.child = null;
        job.status = status;
        if (message) {
          job.error = status === 'failed' ? message : null;
          append(job, 'system', message);
        }
        job.updatedAt = stamp();
        resolve();
      };

      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on?.('data', (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const event = parseAgentStreamLine(line);
          if (!event) continue;
          if (event.sessionId) job.sessionId = event.sessionId;
          append(job, event.role, event.text);
          if (event.done) job.turnFailed = Boolean(event.isError);
        }
      });

      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on?.('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-2000);
      });

      child.on?.('error', (error) => {
        finish('failed', `Agent process error: ${error?.message || error}`);
      });

      child.on?.('close', (code) => {
        const trailing = parseAgentStreamLine(stdoutBuffer);
        if (trailing) {
          if (trailing.sessionId) job.sessionId = trailing.sessionId;
          append(job, trailing.role, trailing.text);
          if (trailing.done) job.turnFailed = Boolean(trailing.isError);
        }
        if (code === 0 && !job.turnFailed) {
          finish('ready');
          return;
        }
        const detail = stderrTail.trim();
        finish('failed', detail
          ? `Agent exited with code ${code}. ${detail}`
          : `Agent exited with code ${code}.`);
      });
    });
  }

  /**
   * Start a new plugin build.
   *
   * @param {object} input
   * @param {string} input.name Plugin name typed by the ADMIN.
   * @param {string} [input.instructions] Extra detail from the chat box.
   * @returns {object} The public job view, already running.
   */
  function start({ name, instructions = '' }) {
    const { slug, display } = normalizePluginName(name);
    const job = {
      id: randomUUID(),
      slug,
      name: display,
      status: 'running',
      createdAt: stamp(),
      updatedAt: stamp(),
      sessionId: '',
      transcript: [],
      error: null,
      child: null,
      turnFailed: false,
      queue: Promise.resolve(),
    };
    jobs.set(job.id, job);
    const prompt = buildPluginPrompt({ display, slug, instructions });
    append(job, 'admin', instructions?.trim() ? `${display} — ${instructions.trim()}` : display);
    job.queue = job.queue.then(() => runTurn(job, prompt));
    return publicJob(job);
  }

  /**
   * Continue a build conversation with another operator message.
   *
   * @param {string} jobId
   * @param {string} message
   * @returns {object|null} Public job view, or null when the id is unknown.
   */
  function send(jobId, message) {
    const job = jobs.get(jobId);
    if (!job) return null;
    const text = String(message ?? '').trim();
    if (!text) return publicJob(job);
    append(job, 'admin', text);
    job.turnFailed = false;
    job.status = 'running';
    // Turns are serialized per job: the agent session is a single resumable
    // conversation, and two concurrent `--resume` runs would interleave edits.
    job.queue = job.queue.then(() => runTurn(job, text));
    return publicJob(job);
  }

  /**
   * @param {string} jobId
   * @returns {object|null}
   */
  function get(jobId) {
    const job = jobs.get(jobId);
    return job ? publicJob(job) : null;
  }

  /** @returns {object[]} Newest build first. */
  function list() {
    return [...jobs.values()]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map((job) => ({ ...publicJob(job), transcript: job.transcript.slice(-1).map((entry) => ({
        role: entry.role, text: entry.text, at: entry.at,
      })) }));
  }

  /**
   * @param {string} jobId
   * @returns {boolean} Whether a running turn was signalled.
   */
  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job?.child) return false;
    try { job.child.kill('SIGTERM'); } catch { return false; }
    append(job, 'system', 'Stopped by the operator.');
    return true;
  }

  /** @returns {Promise<void>} Settles once every queued turn has finished. */
  function idle() {
    return Promise.all([...jobs.values()].map((job) => job.queue)).then(() => undefined);
  }

  return { start, send, get, list, cancel, idle, command, cwd };
}
