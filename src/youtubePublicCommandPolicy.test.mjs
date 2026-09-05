import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_COMMAND_REGISTRY,
  PUBLIC_GEV_TOOL_CATALOG,
  PUBLIC_GEV_TOOL_NAMES,
  PUBLIC_HELP_REPLY,
  PUBLIC_VIEW_PRESETS,
  parsePublicCommand,
  resolvePublicSlashTool,
  publicCommandLegend,
  toolsForPublicMode,
  validatePublicToolCall,
} from './youtubePublicCommandPolicy.js';

test('registry is deeply immutable, starts with /help, and includes /explore-manually plus 31 GEV tools', () => {
  assert.ok(Object.keys(PUBLIC_COMMAND_REGISTRY).includes('/fly'));
  assert.ok(Object.keys(PUBLIC_COMMAND_REGISTRY).includes('/cctv'));
  assert.ok(Object.keys(PUBLIC_COMMAND_REGISTRY).includes('/radio'));
  assert.ok(Object.keys(PUBLIC_COMMAND_REGISTRY).includes('/scene'));
  assert.ok(Object.keys(PUBLIC_COMMAND_REGISTRY).includes('/style-snow'));
  assert.equal(Object.keys(PUBLIC_COMMAND_REGISTRY)[0], '/help');
  assert.equal(publicCommandLegend()[0].command, '/help');
  assert.equal(PUBLIC_VIEW_PRESETS['/explore-manually'], 'explore');
  assert.equal(PUBLIC_GEV_TOOL_NAMES.length, 31);
  assert.ok(PUBLIC_GEV_TOOL_NAMES.includes('run_view_preset'));
  assert.ok(Object.isFrozen(PUBLIC_COMMAND_REGISTRY));
  assert.ok(Object.isFrozen(PUBLIC_COMMAND_REGISTRY['/x'].tools));
  assert.ok(Object.isFrozen(PUBLIC_GEV_TOOL_CATALOG.annotate_map.parameters.properties));
  assert.equal(PUBLIC_GEV_TOOL_NAMES.some((name) => name.includes('admin')), false);
  assert.equal(PUBLIC_COMMAND_REGISTRY['/x'].tools.length, PUBLIC_GEV_TOOL_NAMES.length);
});

test('mode allowlists are exact', () => {
  assert.deepEqual(PUBLIC_COMMAND_REGISTRY['/y'].tools, [
    'get_current_view_state', 'get_entity_context', 'analyst_query', 'next_iss_pass',
  ]);
  assert.deepEqual(PUBLIC_COMMAND_REGISTRY['/z'].tools, [
    'fly_to_location', 'select_nearest_aircraft', 'adjust_camera_zoom', 'zoom_to_globe',
    'move_camera', 'frame_overhead', 'fly_route', 'stop_tracking',
  ]);
  assert.deepEqual(PUBLIC_COMMAND_REGISTRY['/gods-eye-view'].tools, ['zoom_to_globe']);
  assert.deepEqual(toolsForPublicMode('analyze').map((tool) => tool.name), PUBLIC_COMMAND_REGISTRY['/y'].tools);
});

test('legend derives from the same registry', () => {
  assert.deepEqual(publicCommandLegend(), Object.values(PUBLIC_COMMAND_REGISTRY).map(
    ({ command, description, mode }) => ({ command, description, mode }),
  ));
});

test('pure parser recognizes only a leading complete token and enforces required body', () => {
  assert.deepEqual(parsePublicCommand('  /Y  how many flights? ').recognized, true);
  assert.equal(parsePublicCommand('  /Y  how many flights? ').request, 'how many flights?');
  assert.equal(parsePublicCommand('/x').reason, 'request-required');
  assert.equal(parsePublicCommand('/z   ').valid, false);
  assert.equal(parsePublicCommand('/gods-eye-view').valid, true);
  assert.equal(parsePublicCommand('/help').valid, true);
  assert.equal(parsePublicCommand('/help').command, '/help');
  assert.equal(parsePublicCommand('/live-contacts').command, '/live-contacts');
  assert.equal(parsePublicCommand('/explore-manually').valid, true);
  assert.equal(parsePublicCommand('/explore-manually').command, '/explore-manually');
  assert.equal(parsePublicCommand('hello /y question').recognized, false);
  assert.equal(parsePublicCommand('/xyz do it').recognized, false);
  assert.equal(parsePublicCommand('/y: question').recognized, false);
});

test('server validator rejects mode violations, extra keys, bad types and ranges', () => {
  assert.equal(validatePublicToolCall('/y', 'fly_to_location', { query: 'Paris' }).ok, false);
  assert.equal(validatePublicToolCall('/z', 'analyst_query', { layers: ['flights'] }).ok, false);
  assert.equal(validatePublicToolCall('/gods-eye-view', 'zoom_to_globe', {}).ok, true);
  assert.equal(validatePublicToolCall('/gods-eye-view', 'zoom_to_globe', { relative: true }).ok, false);
  assert.equal(validatePublicToolCall('/z', 'fly_to_location', { latitude: 91, longitude: 0 }).ok, false);
  assert.equal(validatePublicToolCall('/z', 'adjust_camera_zoom', { direction: 'sideways' }).ok, false);
  assert.equal(validatePublicToolCall('/x', 'control_radio', { action: 'volume', volumePct: 101 }).ok, false);
  assert.equal(validatePublicToolCall('/help', 'zoom_to_globe', {}).ok, false);
  assert.equal(validatePublicToolCall('/live-contacts', 'run_view_preset', { preset: '/live-contacts' }).ok, true);
  assert.equal(validatePublicToolCall('/explore-manually', 'run_view_preset', { preset: '/explore-manually' }).ok, true);
  assert.equal(validatePublicToolCall('/explore-manually', 'set_context_mode', { mode: 'contacts' }).ok, false);
  assert.match(PUBLIC_HELP_REPLY, /\/fly/);
  assert.match(PUBLIC_HELP_REPLY, /\/cctv/);
  assert.match(PUBLIC_HELP_REPLY, /\/style-thermal/);
});

test('every schema is a strict server-safe validator', () => {
  for (const name of PUBLIC_GEV_TOOL_NAMES) {
    const schema = PUBLIC_GEV_TOOL_CATALOG[name].parameters;
    assert.equal(schema.type, 'object', name);
    assert.equal(schema.additionalProperties, false, name);
    assert.equal(validatePublicToolCall('/x', name, { __protoPollution: true }).ok, false, name);
  }
});
test('/youtube-channel carries a URL and reaches only the player tool', () => {
  const parsed = parsePublicCommand('/youtube-channel https://youtu.be/aqz-KE-bpKQ');
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.mode, 'youtube-channel');
  assert.equal(parsed.request, 'https://youtu.be/aqz-KE-bpKQ');
  assert.equal(parsed.valid, true);

  // A bare command has nothing to play.
  assert.deepEqual(parsePublicCommand('/youtube-channel').reason, 'request-required');

  assert.deepEqual(PUBLIC_COMMAND_REGISTRY['/youtube-channel'].tools, ['control_video_player']);
  assert.equal(toolsForPublicMode('youtube-channel').length, 1);
  assert.equal(validatePublicToolCall('/youtube-channel', 'control_video_player', { action: 'queue', url: 'https://youtu.be/aqz-KE-bpKQ' }).ok, true);
  // The mode must not become a second route to the whole catalog.
  assert.equal(validatePublicToolCall('/youtube-channel', 'fly_to_location', { query: 'Paris' }).ok, false);
  assert.equal(validatePublicToolCall('/youtube-channel', 'control_video_player', { action: 'delete' }).ok, false);
  assert.equal(validatePublicToolCall('/youtube-channel', 'control_video_player', {}).ok, false);
});


test("resolvePublicSlashTool maps left-nav verbs", () => {
  assert.equal(resolvePublicSlashTool("/fly Tokyo").tool?.name, "fly_to_location");
  assert.equal(resolvePublicSlashTool("/fly Tokyo").tool?.arguments?.query, "Tokyo");
  assert.equal(resolvePublicSlashTool("/layer flights off").tool?.arguments?.enabled, false);
  assert.equal(resolvePublicSlashTool("/layer cctv on").tool?.arguments?.layerId, "cctv");
  assert.equal(resolvePublicSlashTool("/cctv").tool?.arguments?.action, "enable");
  assert.equal(resolvePublicSlashTool("/radio next").tool?.arguments?.action, "next");
  assert.equal(resolvePublicSlashTool("/scene list").tool?.arguments?.action, "list");
  assert.equal(resolvePublicSlashTool("/style-thermal").tool?.arguments?.style, "thermal");
  assert.equal(resolvePublicSlashTool("/help").tool, null);
  assert.match(resolvePublicSlashTool("/help").reply || "", /\/fly/);
  assert.equal(resolvePublicSlashTool("hello").ok, false);
});
