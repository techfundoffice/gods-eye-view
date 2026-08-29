import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  ADMIN_PLUGIN_DIR,
  ADMIN_PLUGIN_MANIFEST,
  buildAgentArgs,
  buildPluginPrompt,
  createPluginBuilder,
  normalizePluginName,
  parseAgentStreamLine,
} from './adminPluginBuilder.js';

/** A stand-in child process whose streams a test drives by hand. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

/**
 * Spawn stub that records invocations and hands each child to `script`.
 */
function scriptedSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = fakeChild();
    calls.push({ command, args, options, child });
    // Emit on a later tick so the caller has attached its listeners first.
    setImmediate(() => script(child, calls.length - 1));
    return child;
  };
  return { spawnImpl, calls };
}

function emitTurn(child, { sessionId = 'session-1', text = 'Built it.', code = 0 } = {}) {
  child.stdout.emit('data', `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`);
  child.stdout.emit('data', `${JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text }] },
  })}\n`);
  child.stdout.emit('data', `${JSON.stringify({
    type: 'result', subtype: 'success', session_id: sessionId, result: 'Done.',
  })}\n`);
  child.emit('close', code);
}

test('plugin names become a slug plus a display name', () => {
  assert.deepEqual(normalizePluginName('  Fleet   Watchlist '), { slug: 'fleet-watchlist', display: 'Fleet Watchlist' });
  assert.deepEqual(normalizePluginName('SIGINT/ELINT v2'), { slug: 'sigint-elint-v2', display: 'SIGINT/ELINT v2' });
  assert.equal(normalizePluginName('x'.repeat(200)).slug.length, 48);
  assert.throws(() => normalizePluginName('***'), /letters or numbers/);
  assert.throws(() => normalizePluginName(''), /letters or numbers/);
});

test('the build prompt names the module, the manifest, and the test to write', () => {
  const prompt = buildPluginPrompt({
    display: 'Fleet Watchlist',
    slug: 'fleet-watchlist',
    instructions: 'Track a saved list of vessels.',
  });
  assert.match(prompt, /Fleet Watchlist/);
  assert.ok(prompt.includes(`${ADMIN_PLUGIN_DIR}/fleet-watchlist.js`));
  assert.ok(prompt.includes(ADMIN_PLUGIN_MANIFEST));
  assert.ok(prompt.includes('fleet-watchlist.test.mjs'));
  assert.match(prompt, /Track a saved list of vessels\./);
});

test('an instruction-free build tells the agent to state its assumptions', () => {
  const prompt = buildPluginPrompt({ display: 'Watchlist', slug: 'watchlist' });
  assert.match(prompt, /say what you assumed/);
});

test('agent arguments stream JSON and resume only when a session exists', () => {
  const fresh = buildAgentArgs({ prompt: 'do the thing' });
  assert.deepEqual(fresh, [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions', 'do the thing',
  ]);
  assert.ok(!fresh.includes('--resume'));

  const resumed = buildAgentArgs({ prompt: 'next', resumeSessionId: 'abc', permissionMode: 'acceptEdits' });
  assert.deepEqual(resumed.slice(-3), ['--resume', 'abc', 'next']);
  assert.ok(resumed.includes('acceptEdits'));
});

test('stream lines become transcript events, and noise is skipped', () => {
  assert.deepEqual(
    parseAgentStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })),
    { role: 'system', text: 'Agent session started.', sessionId: 's1' },
  );
  assert.deepEqual(
    parseAgentStreamLine(JSON.stringify({
      type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: ' hello ' }] },
    })),
    { role: 'agent', text: 'hello', sessionId: 's1' },
  );
  assert.deepEqual(
    parseAgentStreamLine(JSON.stringify({
      type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', name: 'Edit' }] },
    })),
    { role: 'tool', text: 'Working: Edit', sessionId: 's1' },
  );
  assert.equal(parseAgentStreamLine(''), null);
  assert.equal(parseAgentStreamLine('not json'), null);
  assert.equal(parseAgentStreamLine(JSON.stringify({ type: 'user' })), null);
});

test('a failed result is marked as an error, a successful one is not', () => {
  const failure = parseAgentStreamLine(JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: 'blew up', session_id: 's1',
  }));
  assert.equal(failure.done, true);
  assert.equal(failure.isError, true);
  assert.equal(failure.role, 'system');

  const success = parseAgentStreamLine(JSON.stringify({
    type: 'result', subtype: 'success', result: 'all good', session_id: 's1',
  }));
  assert.deepEqual(success, { role: 'agent', text: 'all good', sessionId: 's1', done: true, isError: false });
});

test('starting a build spawns the agent in the repository root and records the turn', async () => {
  const { spawnImpl, calls } = scriptedSpawn((child) => emitTurn(child, { text: 'Wrote the plugin.' }));
  const builder = createPluginBuilder({ spawnImpl, cwd: '/repo', command: 'claude' });

  const job = builder.start({ name: 'Fleet Watchlist', instructions: 'Track vessels.' });
  assert.equal(job.slug, 'fleet-watchlist');
  assert.equal(job.status, 'running');
  assert.deepEqual(job.transcript.map((entry) => entry.role), ['admin']);

  await builder.idle();
  const finished = builder.get(job.id);
  assert.equal(finished.status, 'ready');
  assert.equal(finished.error, null);
  assert.ok(finished.transcript.some((entry) => entry.role === 'agent' && entry.text === 'Wrote the plugin.'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].options.cwd, '/repo');
  assert.ok(calls[0].args.at(-1).includes('Fleet Watchlist'));
});

test('the agent session id is kept server-side and reused for the next turn', async () => {
  const { spawnImpl, calls } = scriptedSpawn((child) => emitTurn(child, { sessionId: 'sess-9' }));
  const builder = createPluginBuilder({ spawnImpl, cwd: '/repo' });

  const job = builder.start({ name: 'Watchlist' });
  await builder.idle();
  assert.equal(builder.get(job.id).sessionId, undefined, 'the public view never carries the session id');

  builder.send(job.id, 'Also add a CSV export.');
  await builder.idle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(-3), ['--resume', 'sess-9', 'Also add a CSV export.']);
  assert.ok(builder.get(job.id).transcript.some((entry) => entry.text === 'Also add a CSV export.'));
});

test('a non-zero exit marks the build failed and surfaces stderr', async () => {
  const { spawnImpl } = scriptedSpawn((child) => {
    child.stderr.emit('data', 'claude: command failed');
    child.emit('close', 127);
  });
  const builder = createPluginBuilder({ spawnImpl });
  const job = builder.start({ name: 'Broken' });
  await builder.idle();

  const finished = builder.get(job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /exited with code 127/);
  assert.match(finished.error, /command failed/);
});

test('an agent result flagged as an error fails the build even on a zero exit', async () => {
  const { spawnImpl } = scriptedSpawn((child) => {
    child.stdout.emit('data', `${JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true, result: 'tool loop', session_id: 's1',
    })}\n`);
    child.emit('close', 0);
  });
  const builder = createPluginBuilder({ spawnImpl });
  const job = builder.start({ name: 'Half Built' });
  await builder.idle();
  assert.equal(builder.get(job.id).status, 'failed');
});

test('a trailing line without a newline is still parsed at close', async () => {
  const { spawnImpl } = scriptedSpawn((child) => {
    child.stdout.emit('data', JSON.stringify({
      type: 'result', subtype: 'success', result: 'finished', session_id: 's1',
    }));
    child.emit('close', 0);
  });
  const builder = createPluginBuilder({ spawnImpl });
  const job = builder.start({ name: 'Trailing' });
  await builder.idle();
  assert.ok(builder.get(job.id).transcript.some((entry) => entry.text === 'finished'));
});

test('a missing agent binary is reported instead of throwing', async () => {
  const builder = createPluginBuilder({
    spawnImpl: () => { throw new Error('spawn ENOENT'); },
    command: 'no-such-agent',
  });
  const job = builder.start({ name: 'Doomed' });
  await builder.idle();
  const finished = builder.get(job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /no-such-agent/);
});

test('turns on one job are serialized rather than run concurrently', async () => {
  let live = 0;
  let maxLive = 0;
  const { spawnImpl } = scriptedSpawn((child) => {
    live += 1;
    maxLive = Math.max(maxLive, live);
    setImmediate(() => {
      live -= 1;
      emitTurn(child);
    });
  });
  const builder = createPluginBuilder({ spawnImpl });
  const job = builder.start({ name: 'Serial' });
  builder.send(job.id, 'one');
  builder.send(job.id, 'two');
  await builder.idle();
  assert.equal(maxLive, 1);
});

test('sending to an unknown build reports nothing rather than starting one', () => {
  const builder = createPluginBuilder({ spawnImpl: () => fakeChild() });
  assert.equal(builder.send('nope', 'hi'), null);
  assert.equal(builder.get('nope'), null);
  assert.equal(builder.cancel('nope'), false);
});

test('an empty follow-up message is ignored instead of spending an agent turn', async () => {
  const { spawnImpl, calls } = scriptedSpawn((child) => emitTurn(child));
  const builder = createPluginBuilder({ spawnImpl });
  const job = builder.start({ name: 'Quiet' });
  await builder.idle();
  builder.send(job.id, '   ');
  await builder.idle();
  assert.equal(calls.length, 1);
});

test('cancel signals the running child', async () => {
  let running;
  const { spawnImpl } = scriptedSpawn((child) => { running = child; });
  const builder = createPluginBuilder({ spawnImpl });
  const job = builder.start({ name: 'Long Job' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builder.cancel(job.id), true);
  assert.equal(running.killed, true);
  running.emit('close', 143);
  await builder.idle();
});

test('the list view is newest-first and carries only the latest line per build', async () => {
  const { spawnImpl } = scriptedSpawn((child) => emitTurn(child));
  const builder = createPluginBuilder({
    spawnImpl,
    now: (() => { let tick = 0; return () => (tick += 1000); })(),
  });
  builder.start({ name: 'First' });
  builder.start({ name: 'Second' });
  await builder.idle();
  const list = builder.list();
  assert.deepEqual(list.map((entry) => entry.name), ['Second', 'First']);
  assert.ok(list.every((entry) => entry.transcript.length <= 1));
});
