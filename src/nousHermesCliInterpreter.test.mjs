import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createNousHermesCliInterpreter,
  parseHermesCliOutput,
  buildHermesChatPrompt,
} from './nousHermesCliInterpreter.js';

test('Hermes CLI JSON tool call becomes a coordinator tool-call', () => {
  const out = parseHermesCliOutput('{"tool":"fly_to_location","arguments":{"query":"Los Angeles, CA","viewMode":"overview"},"reply":"@ada flying to LA"}');
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'tool-call');
  assert.equal(out.call.name, 'fly_to_location');
  assert.equal(out.call.arguments.query, 'Los Angeles, CA');
});

test('Hermes CLI JSON reply becomes a complete YouTube answer', () => {
  const out = parseHermesCliOutput('{"reply":"@ada I can take you next — downtown or orbit?"}');
  assert.equal(out.kind, 'complete');
  assert.match(out.text, /downtown/);
});

test('oneshot spawn uses the real hermes chat CLI', async () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', '{"tool":"fly_to_location","arguments":{"query":"Tokyo","viewMode":"overview"}}');
      child.emit('close', 0);
    });
    return child;
  };
  const interpret = createNousHermesCliInterpreter({
    bin: '/home/runner/.local/bin/hermes',
    spawnImpl,
  });
  const out = await interpret({ comment: 'navigate to tokyo', viewer: '@ada' });
  assert.equal(out.kind, 'tool-call');
  assert.equal(calls[0].command, '/home/runner/.local/bin/hermes');
  assert.ok(calls[0].args.includes('chat'));
  assert.ok(calls[0].args.includes('--oneshot'));
  assert.match(buildHermesChatPrompt({ comment: 'navigate to tokyo', viewer: '@ada' }), /tokyo/i);
});
