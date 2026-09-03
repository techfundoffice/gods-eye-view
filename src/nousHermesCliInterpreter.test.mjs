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


test('Hermes can call any GEV capability, not only fly_to_location', () => {
  const prompt = buildHermesChatPrompt({ comment: 'turn on flights', viewer: '@ada' });
  assert.match(prompt, /set_layer_visibility/);
  assert.match(prompt, /set_visual_style/);
  assert.match(prompt, /control_cockpit/);
  assert.match(prompt, /run_view_preset/);
  assert.match(prompt, /EVERY God's Eye View capability/i);
  const out = parseHermesCliOutput('{"tool":"set_layer_visibility","arguments":{"layerId":"flights","enabled":true},"reply":"Flights on"}');
  assert.equal(out.kind, 'tool-call');
  assert.equal(out.call.name, 'set_layer_visibility');
  assert.equal(out.call.arguments.layerId, 'flights');
});
