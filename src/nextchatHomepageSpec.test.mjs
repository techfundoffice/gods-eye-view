/**
 * Pins the shipped NextChat homepage software spec.
 *
 * Reads docs/NEXTCHAT-HOMEPAGE.md from disk (not a copy). A later grok CLI
 * implementer follows that file; if the required audience, NextChat UX,
 * live-program hookup names, or stack constraints disappear, this fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SPEC_URL = new URL('../docs/NEXTCHAT-HOMEPAGE.md', import.meta.url);
const spec = readFileSync(SPEC_URL, 'utf8');

test('the shipped spec is implementer instruction for grok CLI', () => {
  assert.match(spec, /grok CLI/);
  assert.match(spec, /^## Goal/m);
  assert.match(spec, /home page/);
  assert.match(spec, /NextChat/);
});

test('the shipped spec requires NextChat UX on the home page', () => {
  assert.match(spec, /NextChat/);
  assert.match(spec, /home page/);
  assert.match(spec, /session list/i);
  assert.match(spec, /new chat/i);
  assert.match(spec, /user\/assistant/i);
  assert.match(spec, /\bthread\b/i);
  assert.match(spec, /\bcomposer\b/i);
  assert.match(spec, /\bsend\b/i);
  assert.match(spec, /streaming|incremental/i);
});

test('the shipped spec hooks chat into the live GEV voice/tool path', () => {
  assert.match(spec, /sendTextCommand/);
  assert.match(spec, /GEV_REALTIME_TOOLS/);
  assert.match(spec, /gevActions/);
});

test('the shipped spec records constraints a later implementer must not violate', () => {
  assert.match(spec, /vanilla JS/);
  assert.match(spec, /CesiumJS/);
  assert.match(spec, /\bVite\b/);
  assert.match(spec, /[Nn]o framework/);
  assert.match(spec, /[Nn]o TypeScript/);
  assert.match(spec, /[Ss]ecrets stay server-side/);
  assert.match(spec, /[Kk]eyless installs degrade honestly/);
  assert.match(spec, /GEV MIC stays/);
  assert.match(spec, /home page remains the globe/);
  assert.match(spec, /chat-only app/);
});
