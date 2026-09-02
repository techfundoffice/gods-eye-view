import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  ENVIRONMENTAL_LABEL_CHOICE,
  EXCLUSIVE_SURFACE_CLASSES,
  FIRST_RUN_DATA_LAYERS,
  FIRST_RUN_MISSIONS,
  FIRST_RUN_SESSION_KEY,
  FIRST_RUN_STORAGE_KEY,
  environmentalLabel,
  exclusiveSurfaceActive,
  rememberFirstRunSessionDismissed,
  runFirstRunChoice,
  setFirstRunSuppressed,
  shouldShowFirstRun,
} from './firstRunExperience.js';

function memoryStorage(key, value = null) {
  const values = new Map(value == null ? [] : [[key, value]]);
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, next) => values.set(name, next),
    removeItem: (name) => values.delete(name),
    read: () => values.get(key) ?? null,
  };
}

const fresh = () => ({
  storage: memoryStorage(FIRST_RUN_STORAGE_KEY),
  sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
  location: { search: '' },
});

// ── Show policy ──────────────────────────────────────────────────────────────

test('a fresh session receives the launcher, and keeps receiving it', () => {
  assert.equal(shouldShowFirstRun(fresh()), true);
  // Not one-shot: a previous session's completion does not suppress a new one.
  const returning = fresh();
  returning.sessionStorageRef = memoryStorage(FIRST_RUN_SESSION_KEY);
  assert.equal(shouldShowFirstRun(returning), true);
});

test('dismissal never suppresses the chooser on reload in the same session', () => {
  const session = memoryStorage(FIRST_RUN_SESSION_KEY);
  const storage = memoryStorage(FIRST_RUN_STORAGE_KEY);

  rememberFirstRunSessionDismissed(session);
  assert.equal(session.read(), 'dismissed');
  assert.equal(shouldShowFirstRun({ storage, sessionStorageRef: session, location: { search: '' } }), true);
  assert.equal(shouldShowFirstRun({
    storage,
    sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
    location: { search: '' },
  }), true);
  // Session dismissal must never have written the durable key.
  assert.equal(storage.read(), null);
});

test('legacy suppression storage no longer hides the chooser', () => {
  const storage = memoryStorage(FIRST_RUN_STORAGE_KEY);
  setFirstRunSuppressed(true, storage);
  assert.equal(storage.read(), 'suppressed');
  assert.equal(shouldShowFirstRun({
    storage,
    sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
    location: { search: '' },
  }), true);

  // Unticking before dismissing takes the suppression back.
  setFirstRunSuppressed(false, storage);
  assert.equal(storage.read(), null);
  assert.equal(shouldShowFirstRun({
    storage,
    sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
    location: { search: '' },
  }), true);

  // A cleared/hard-reset profile shows it again — an accepted, documented cost.
  setFirstRunSuppressed(true, storage);
  assert.equal(shouldShowFirstRun({
    storage: memoryStorage(FIRST_RUN_STORAGE_KEY),
    sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
    location: { search: '' },
  }), true);
});

test('welcome=0 is the only explicit bypass; share and stored state still choose a view', () => {
  const suppressed = memoryStorage(FIRST_RUN_STORAGE_KEY, 'suppressed');
  const dismissed = memoryStorage(FIRST_RUN_SESSION_KEY, 'dismissed');
  // ?welcome=1 replays past the checkbox AND past a session dismissal.
  assert.equal(shouldShowFirstRun({
    storage: suppressed, sessionStorageRef: dismissed, location: { search: '?welcome=1' },
  }), true);
  // ?welcome=0 suppresses a session that would otherwise see it.
  assert.equal(shouldShowFirstRun({ ...fresh(), location: { search: '?welcome=0' } }), false);
  // Restored/share links are still interactive visits and must choose a view.
  assert.equal(shouldShowFirstRun({
    hasShareState: true, ...fresh(), location: { search: '?welcome=1' },
  }), true);
});

test('a share link still sees the launcher so every user chooses the view', () => {
  assert.equal(shouldShowFirstRun({ hasShareState: true, ...fresh() }), true);
});

test('privacy-restricted storage fails open and every write stays best-effort', () => {
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.equal(shouldShowFirstRun({ storage: blocked, sessionStorageRef: blocked }), true);
  assert.doesNotThrow(() => setFirstRunSuppressed(true, blocked));
  assert.doesNotThrow(() => rememberFirstRunSessionDismissed(blocked));
});

test('a THROWING storage getter still fails open — Safari private mode', () => {
  // The harder case, and the one a default parameter cannot survive: it is not
  // getItem that throws, it is reading `globalThis.localStorage` AT ALL. A
  // default like `storage = globalThis.localStorage` evaluates that getter
  // before the function body starts, so the SecurityError escapes every
  // try/catch in the module and the launcher silently never appears.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const savedSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const hostile = {
    configurable: true,
    get() { throw new Error('SecurityError: The operation is insecure.'); },
  };
  Object.defineProperty(globalThis, 'localStorage', hostile);
  Object.defineProperty(globalThis, 'sessionStorage', hostile);
  try {
    // No storage arguments at all: this is exactly how the app calls it.
    assert.doesNotThrow(
      () => shouldShowFirstRun({ location: { search: '' } }),
      'a hostile storage getter must not escape shouldShowFirstRun',
    );
    assert.equal(
      shouldShowFirstRun({ location: { search: '' } }),
      true,
      'a visitor whose storage throws must still SEE the launcher',
    );
    assert.doesNotThrow(() => setFirstRunSuppressed(true));
    assert.doesNotThrow(() => setFirstRunSuppressed(false));
    assert.doesNotThrow(() => rememberFirstRunSessionDismissed());
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
    if (savedSession) Object.defineProperty(globalThis, 'sessionStorage', savedSession);
    else delete globalThis.sessionStorage;
  }
});

test('no storage is touched from a default parameter position', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  // Comments stripped first: the block explaining this very defect quotes the
  // bad pattern, and matching prose instead of code would make the pin a liar.
  const code = module.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    code,
    /=\s*globalThis\.(local|session)Storage/,
    'storage must be resolved lazily inside a try, never as a default parameter',
  );
  // The only reads of the global areas live inside the guarded resolver.
  const globalReads = [...code.matchAll(/globalThis\.(local|session)Storage/g)];
  assert.equal(globalReads.length, 2, 'exactly two global storage reads, both in resolveStore');
  const resolver = code.slice(code.indexOf('function resolveStore'), code.indexOf('function readStored'));
  assert.equal(
    [...resolver.matchAll(/globalThis\.(local|session)Storage/g)].length,
    2,
    'both global storage reads must be inside resolveStore, inside its try',
  );
  assert.match(resolver, /try \{[\s\S]*globalThis\.sessionStorage[\s\S]*\} catch/);
  assert.match(code, /function readStored\(kind, injected, key\)/);
  assert.match(code, /function writeStored\(kind, injected, key, value\)/);
});

// ── ESC arbitration: one surface, one key, never an invisible handler ────────

test('the JS and CSS lists of screen-claiming surfaces stay in step', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');

  assert.deepEqual(
    [...EXCLUSIVE_SURFACE_CLASSES].sort(),
    ['cockpit-mode', 'recording-mode', 'scene-playback-mode', 'ui-clean-view'],
  );
  // A surface that hides the card in CSS but is missing from the JS list would
  // leave an invisible launcher holding the ESC handler — blocker 2 exactly.
  const hideRule = css.slice(
    css.indexOf('body.ui-clean-view #first-run-launcher'),
    css.indexOf('display: none', css.indexOf('body.ui-clean-view #first-run-launcher')),
  );
  const inCss = [...hideRule.matchAll(/body\.([a-z-]+) #first-run-launcher/g)].map((m) => m[1]);
  assert.deepEqual(
    inCss.sort(),
    [...EXCLUSIVE_SURFACE_CLASSES].sort(),
    'every screen-claiming surface must appear in BOTH lists',
  );
  assert.match(module, /export const EXCLUSIVE_SURFACE_CLASSES = Object\.freeze\(\[/);
});

test('exclusiveSurfaceActive reads the live body classes', () => {
  const make = (classes) => ({ body: { classList: { contains: (name) => classes.includes(name) } } });
  assert.equal(exclusiveSurfaceActive(make([])), false);
  for (const name of EXCLUSIVE_SURFACE_CLASSES) {
    assert.equal(exclusiveSurfaceActive(make([name])), true, `${name} must count as exclusive`);
  }
  assert.equal(exclusiveSurfaceActive(make(['some-other-class'])), false);
  assert.equal(exclusiveSurfaceActive(undefined), false);
  assert.equal(exclusiveSurfaceActive({}), false);
});

test('the key handler refuses to act for a card that is not really on screen', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  // Real visibility, not just the class: the class survives while CSS hides the
  // card, which is precisely how a Scene left an invisible ESC handler armed.
  assert.match(module, /const isTopmost = \(\) => root\.isConnected/);
  assert.match(module, /&& root\.getClientRects\(\)\.length > 0\s*\n\s*&& !coveredByOverlay\(\);/);
  const handler = module.slice(module.indexOf('function onKeyDown(event) {'));
  assert.match(
    handler.slice(0, handler.indexOf("if (event.key === 'Escape')")),
    /if \(closing \|\| !isTopmost\(\)\) return;/,
    'the handler must bail before consuming anything when it is not topmost',
  );
});

test('an overlay with NO class to watch still disarms the launcher', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');

  // The repro, pinned as the stacking it actually is: the attribution lightbox
  // is full-screen ABOVE the card and announces itself with nothing. The card
  // keeps its box, so getClientRects() alone called it visible, ESC dismissed a
  // buried launcher and wrote the session flag while the lightbox stayed open.
  const overlay = css.slice(css.indexOf('.cesium-credit-lightbox-overlay {'));
  assert.match(overlay.slice(0, overlay.indexOf('}')), /z-index: 200 !important/);
  const launcher = css.slice(css.indexOf('#first-run-launcher {'));
  assert.match(launcher.slice(0, launcher.indexOf('}')), /z-index: 147/);

  // Answered generically — a hit test at the card's own centre, NOT one more
  // class to keep in step with one more overlay.
  const covered = module.slice(
    module.indexOf('const coveredByOverlay = () => {'),
    module.indexOf('const isTopmost = ()'),
  );
  assert.ok(covered.length > 0, 'coveredByOverlay must exist');
  assert.match(covered, /rect\.left \+ rect\.width \/ 2/);
  assert.match(covered, /rect\.top \+ rect\.height \/ 2/);
  assert.match(covered, /return Boolean\(hit\) && !root\.contains\(hit\);/);

  // ...and every inconclusive answer is UNCOVERED, so a guard added to stop the
  // launcher acting under an overlay can never become why ESC stopped working.
  assert.match(covered, /if \(typeof documentRef\.elementFromPoint !== 'function'\) return false;/);
  assert.match(covered, /if \(!\(rect\.width > 0 && rect\.height > 0\)\) return false;/);
  assert.match(covered, /\} catch \{\s*\n\s*return false;\s*\n\s*\}/);
});

test('one ESC does one thing — the radio disclosure stops the launcher outright', () => {
  const ui = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');

  // stopPropagation() does NOT stop later listeners on the SAME document, so the
  // disclosure's earlier capture handler closed the disclosure and the launcher
  // dismissed itself off the same key. The earlier listener is the only one that
  // can stop the later one — and only the immediate form does it.
  const radioEsc = ui.slice(ui.indexOf("if (event.key !== 'Escape' || !this._contextRadioDock"));
  const claim = radioEsc.slice(0, radioEsc.indexOf('setRadioDisclosure(false'));
  assert.match(claim, /event\.preventDefault\(\);/);
  assert.match(claim, /event\.stopImmediatePropagation\(\);/);
  assert.doesNotMatch(claim, /event\.stopPropagation\(\);/,
    'the plain form leaves the launcher listening and is the defect itself');

  // Belt on the launcher side: a key another surface already marked is not ours,
  // whether or not that surface remembered to silence us.
  const handler = module.slice(module.indexOf('function onKeyDown(event) {'));
  assert.match(
    handler.slice(0, handler.indexOf("if (event.key === 'Escape')")),
    /if \(event\.defaultPrevented\) return;/,
    'a marked key must be somebody else\'s key',
  );
});

test('legacy suppression helpers remain best-effort but do not control visibility', () => {
  const blocked = {
    getItem: () => null,
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.equal(setFirstRunSuppressed(true, blocked), false);
  assert.equal(setFirstRunSuppressed(false, blocked), false);
  // No storage area at all is a refusal too — nothing was persisted either way.
  assert.equal(setFirstRunSuppressed(true, null), false);
  assert.equal(setFirstRunSuppressed(false, null), false);
  const working = memoryStorage(FIRST_RUN_STORAGE_KEY);
  assert.equal(setFirstRunSuppressed(true, working), true);
  assert.equal(working.read(), 'suppressed');
  assert.equal(setFirstRunSuppressed(false, working), true);
  assert.equal(working.read(), null);
  assert.equal(shouldShowFirstRun({
    storage: working,
    sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY, 'dismissed'),
    location: { search: '' },
  }), true);
});

test('a surface class that never clears is an ACCEPTED no-show, not a timer', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const state = fs.readFileSync(new URL('../docs/CURRENT-STATE.md', import.meta.url), 'utf8');

  // A "reveal anyway after N seconds" would trade a benign no-show for the card
  // punching through a recording in progress — recordings run long, and none of
  // the four classes is restored at startup, so a blocked init is an error path.
  // The slice deliberately spans the note AND the function it governs: a pin
  // that stopped at the comment would let a timer be added one line below the
  // paragraph saying there isn't one.
  const accepted = module.slice(
    module.indexOf('ACCEPTED, DELIBERATELY NOT TIMED OUT'),
    module.indexOf('  const onViewportResize'),
  );
  assert.ok(accepted.length > 0, 'the acceptance must be written where the next editor will read it');
  assert.match(accepted, /const syncToExclusiveSurfaces = \(\) => \{/,
    'the pin must cover the function the note governs, not just the note');
  assert.doesNotMatch(accepted, /setTimeout|setInterval/,
    'the acceptance is the decision NOT to time this out');
  assert.match(accepted, /docs\/CURRENT-STATE\.md/);
  assert.match(state, /a surface class that never clears means no launcher for that page/i);
});

test('the scroll fade only appears when the list really overflows', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  // A fade on a card where all five tiles fit promises a sixth mission that does
  // not exist, which is worse than no affordance at all.
  assert.match(module, /const overflows = choiceList\.scrollHeight > choiceList\.clientHeight \+ 1;/);
  assert.match(module, /choiceList\.dataset\.scrollable = String\(overflows\);/);
  // ...and the CSS must be gated on that flag, never on the media query alone.
  assert.match(css, /\.first-run-choices\[data-scrollable='true'\] \{[\s\S]*?mask-image/);
  const bareFade = css.match(/^\s*\.first-run-choices \{[\s\S]*?\n\}/m)?.[0] || '';
  assert.doesNotMatch(bareFade, /mask-image/, 'the fade must never apply unconditionally');
  // Rotating a phone changes which tiles fit, so it re-measures.
  assert.match(module, /addEventListener\?\.\('resize', onViewportResize\)/);
  assert.match(module, /removeEventListener\?\.\('resize', onViewportResize\)/);
});

test('the launcher yields on engage and waits when a surface is already up', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  // Both directions from one observer: yield if it is up and something takes
  // the screen; wait to reveal if something already has it.
  assert.match(
    module,
    /if \(revealed && blocked\) yieldToExclusiveSurface\(\);\s*\n\s*else if \(!revealed && !blocked\) reveal\(\);/,
  );
  // Yielding is session-scoped and must not steal focus from the new surface.
  assert.match(module, /dismiss\(\{ restoreFocus: false \}\)/);
  // A cheap attribute watch, not a per-frame poll — the render governor must
  // not see a new hold because of onboarding chrome.
  assert.match(module, /attributes: true, attributeFilter: \['class'\]/);
  assert.match(module, /surfaceObserver\?\.disconnect\(\)/);
  assert.doesNotMatch(module, /setInterval|requestAnimationFrame\(function poll/);
});

// ── Per-mission behavior ─────────────────────────────────────────────────────

function missionSpy({ contextOk = true, layerResult = () => true, globe = async () => ({ ok: true }) } = {}) {
  const calls = { contextModes: [], layerIds: [], globeFlights: 0 };
  return {
    calls,
    deps: {
      setContextMode: async (mode) => {
        calls.contextModes.push(mode);
        return contextOk ? { ok: true, mode } : { ok: false, failedLayerIds: ['rocket-launches'] };
      },
      setLayerEnabled: async (layerId) => {
        calls.layerIds.push(layerId);
        return layerResult(layerId);
      },
      flyToGlobe: async () => {
        calls.globeFlights += 1;
        return globe();
      },
    },
  };
}

test('the menu is the four owner-ordered missions', () => {
  // INFRASTRUCTURE was removed after the field tested it: enabling all
  // three bundled layers at once put ~5,700 entities on a full-earth view and
  // tanked the frame rate. The layers stay reachable by hand and by voice; what
  // went is the one-click globe-scale dump. Restoring the tile needs the
  // globe-LOD declutter first.
  assert.deepEqual(Object.keys(FIRST_RUN_MISSIONS), [
    'contacts', 'space-missions', 'environmental', 'explore',
  ]);
  assert.equal(FIRST_RUN_MISSIONS.infrastructure, undefined,
    'the infrastructure mission must be gone, not dormant');
});

test('Mission Control keeps DATA LAYERS toggles under the mission tiles', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const layerState = fs.readFileSync(new URL('./data/layerState.js', import.meta.url), 'utf8');
  const launcherHtml = html.slice(
    html.indexOf('id="first-run-launcher"'),
    html.indexOf('</aside>', html.indexOf('id="first-run-launcher"')),
  );

  assert.match(launcherHtml, /class="first-run-kicker">MISSION CONTROL</);
  assert.match(launcherHtml, /class="first-run-layers-kicker">DATA LAYERS</);
  const layerOrder = [...launcherHtml.matchAll(/data-mc-layer="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(layerOrder, FIRST_RUN_DATA_LAYERS.map((entry) => entry.id));
  assert.equal((html.match(/data-first-run-choice=/g) || []).length, 4);

  for (const entry of FIRST_RUN_DATA_LAYERS) {
    if (entry.layerId) {
      assert.match(layerState, new RegExp(`id: '${entry.layerId}'`), `${entry.layerId} must already be a shipped layer`);
    }
    if (entry.stackId) {
      assert.equal(entry.stackId, 'photoreal');
    }
  }

  const toggle = module.slice(module.indexOf('const onLayerToggle = async'), module.indexOf('for (const button of buttons)'));
  assert.match(toggle, /setEnabled\(entry\.layerId, next, \{ origin: 'user' \}\)/);
  assert.match(toggle, /setMapStack\?\.\(next \? entry\.stackId : 'osm'\)/);
  assert.doesNotMatch(toggle, /flyToGlobe|setContextMode|setWindowState\('minimized'/);

  const nav = css.slice(css.indexOf('#mission-control-nav {'), css.indexOf('#first-run-launcher {'));
  const widthMatch = nav.match(/width:\s*min\(([\d.]+)rem/);
  assert.ok(widthMatch, 'desktop Mission Control must declare a rem width');
  assert.ok(
    Number(widthMatch[1]) < 22,
    `desktop Mission Control width ${widthMatch[1]}rem must be narrower than 22rem`,
  );
  assert.doesNotMatch(nav, /min\(22rem/);

  assert.match(css, /--youtube-mc-band:\s*min\(17rem/);
  const hudStart = css.indexOf('/* Left HUD never shares Mission Control');
  assert.ok(hudStart >= 0, 'left HUD / Mission Control band rule exists');
  const hud = css.slice(hudStart, hudStart + 420);
  assert.match(hud, /var\(--youtube-mc-band\)/);

  const list = css.slice(css.indexOf('.first-run-layers-list {'), css.indexOf('.first-run-layers-list button {'));
  assert.doesNotMatch(list, /max-height:\s*8\.5rem/);
  assert.doesNotMatch(list, /overflow-y:\s*(auto|scroll)/);
  assert.match(list, /overflow:\s*visible/);
  assert.match(list, /max-height:\s*none/);
});

test('a successful choice stays visible until the visitor explicitly dismisses it', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const successPath = module.slice(
    module.indexOf('if (outcome?.ok) {'),
    module.indexOf('const failed = outcome?.failedLayerIds'),
  );
  assert.doesNotMatch(successPath, /dismiss\(/);
  assert.match(successPath, /setBusy\(false\)/);
  assert.match(successPath, /press ESC to close/);
  assert.doesNotMatch(successPath, /setWindowState\('minimized'/);
  assert.doesNotMatch(successPath, /dismiss\(/);
});

test('Live Contacts and Space Missions go through the one setContextMode facade', async () => {
  for (const [choice, mode] of [['contacts', 'contacts'], ['space-missions', 'space-missions']]) {
    const spy = missionSpy();
    const outcome = await runFirstRunChoice(choice, spy.deps);
    assert.equal(outcome.ok, true);
    assert.deepEqual(spy.calls.contextModes, [mode]);
    // A Context mission owns no layers and no camera of its own — the facade does.
    assert.deepEqual(spy.calls.layerIds, []);
    assert.equal(spy.calls.globeFlights, 0);
  }
});

test('Environmental enables its unified and specialist feeds and pulls out to the globe', async () => {
  const spy = missionSpy();
  const outcome = await runFirstRunChoice('environmental', spy.deps);
  assert.equal(outcome.ok, true);
  assert.deepEqual(spy.calls.layerIds, ['natural-hazards', 'earthquakes', 'local-firms']);
  assert.equal(spy.calls.globeFlights, 1);
});

test('the tile is the FULLY CONFIGURED experience: quakes and fires together', () => {
  // Product decision, 2026-08-23: the launcher optimizes for the configured app, so
  // ENVIRONMENTAL means live USGS earthquakes AND NASA FIRMS active fires.
  const environmental = FIRST_RUN_MISSIONS.environmental;
  assert.deepEqual(environmental.layerIds, ['natural-hazards', 'earthquakes', 'local-firms']);

  // Keyless, the honest surface is the LAYER ROW ("KEY REQUIRED"), which the
  // FIRMS layer already reports. The misleading part is the GLOBAL chip folding
  // that row into LOAD FAILED — a defect in the shared state machine, ledgered
  // post-launch, and the note must stay where the next editor will read it
  // rather than being re-discovered as a launcher bug.
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const table = module.slice(module.indexOf('  environmental: Object.freeze({'), module.indexOf('  explore:'));
  assert.match(table, /KEY REQUIRED/);
  assert.match(table, /src\/loadingFeedback\.js/);
  assert.match(table, /LEDGERED post-launch/);
});

test('every visitor gets the same tile — there is no degraded keyless variant', async () => {
  // The mission does not branch on configuration: it asks for both layers for
  // everyone, and a keyless FIRMS reports its own state at its own row rather
  // than changing what the tile does.
  const spy = missionSpy({ layerResult: () => true });
  const outcome = await runFirstRunChoice('environmental', spy.deps);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.failedLayerIds, []);
  assert.deepEqual(spy.calls.layerIds, ['natural-hazards', 'earthquakes', 'local-firms']);
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    module.slice(module.indexOf('export async function runFirstRunChoice')),
    /FIRMS_MAP_KEY|hasKey|keyless\s*\?/,
    'the mission must not fork on whether a key is configured',
  );
});

test('a refused layer fails the mission by name, and a stalled flight never does', async () => {
  const refused = missionSpy({ layerResult: (id) => id !== 'earthquakes' });
  const outcome = await runFirstRunChoice('environmental', refused.deps);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.failedLayerIds, ['earthquakes']);

  // The globe flight is framing. A cancelled or throwing flight is not a failure.
  const flightDown = missionSpy({ globe: () => { throw new Error('cancelled'); } });
  assert.equal((await runFirstRunChoice('environmental', flightDown.deps)).ok, true);
});

test('Explore manually touches nothing at all, and an unknown choice is inert', async () => {
  const spy = missionSpy();
  assert.equal((await runFirstRunChoice('explore', spy.deps)).ok, true);
  assert.deepEqual(spy.calls, { contextModes: [], layerIds: [], globeFlights: 0 });
  assert.equal((await runFirstRunChoice('nope', spy.deps)).ok, false);
  assert.deepEqual(spy.calls, { contextModes: [], layerIds: [], globeFlights: 0 });
});

test('a failed Context mission reports the layers the facade named', async () => {
  const spy = missionSpy({ contextOk: false });
  const outcome = await runFirstRunChoice('space-missions', spy.deps);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.result.failedLayerIds, ['rocket-launches']);
});

test('the fires/quakes tile name is switchable from one constant', () => {
  assert.equal(environmentalLabel('ENVIRONMENTAL').title, 'ENVIRONMENTAL');
  assert.equal(environmentalLabel('EARTH_WATCH').title, 'EARTH WATCH');
  assert.equal(environmentalLabel('ACTIVE_EVENTS').title, 'ACTIVE EVENTS');
  assert.equal(environmentalLabel('nonsense').title, 'ENVIRONMENTAL');
  assert.equal(environmentalLabel().title, environmentalLabel(ENVIRONMENTAL_LABEL_CHOICE).title);
});

// ── Defaults interplay: what a mission is allowed to persist ─────────────────

test('no mission writes a preference the visitor did not choose by picking it', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  const code = module.slice(module.indexOf('export function shouldShowFirstRun'));

  // Layer enables ARE durable in this app and a mission tile IS that choice, so
  // they run at the same origin a click on those rows uses.
  assert.match(code, /setEnabled\(layerId, true, \{ origin: 'user' \}\)/);

  // Detection is owned by the reasonable-defaults landing and, while Contacts is
  // active, by contactsDetectionPolicy. A mission has no opinion on any of it.
  for (const forbidden of [
    '_detectionUserOverridden',
    '_setDetectionMode',
    '_applyDetectionPreset',
    '_setDetectionAllocation',
    'setDetectionTuning',
    // 3D models and feather default to origin 'user' and would persist a choice
    // nobody made by picking a mission.
    '_setModels3dEnabled',
    '_setModels3dMode',
    '_setModels3dParams',
    'setFeather',
  ]) {
    assert.doesNotMatch(code, new RegExp(forbidden), `a mission must never touch ${forbidden}`);
  }

  // The only durable panel write is the Context reveal, and only on the Context
  // missions — the globe missions open no panel at all.
  const panelWrites = code.match(/setPanelCollapsed/g) || [];
  assert.equal(panelWrites.length, 1, 'exactly one panel reveal, on the Context path');
  const contextPath = code.slice(code.indexOf('setContextMode: async (mode)'), code.indexOf('setLayerEnabled:'));
  assert.match(contextPath, /result\?\.ok[\s\S]*?setPanelCollapsed\?\.\('global-context-panel', false, \{ explicit: true \}\)/);
});

test('the decision table is written down where the next editor will read it', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  assert.match(module, /MISSION → APP STATE, AND WHAT IT IS ALLOWED TO PERSIST/);
  for (const row of ['TOUCHED, DURABLE', 'TOUCHED, SESSION', 'NOT TOUCHED']) {
    assert.ok(module.includes(row), `decision table is missing its "${row}" rows`);
  }
  assert.match(module, /SHOW POLICY/);
});

// ── Markup, startup ordering, accessibility ─────────────────────────────────

test('markup, startup ordering and accessibility remain pinned', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');

  assert.match(html, /id="first-run-launcher"[^>]*role="region"[^>]*aria-label="Mission Control"[^>]*hidden/);
  assert.equal((html.match(/data-first-run-choice=/g) || []).length, 4);
  assert.match(html, /data-first-run-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /data-first-run-suppress|Don't show this again/);
  assert.match(html, /<strong data-first-run-environmental-title>/);
  // Subcopy must name BOTH feeds the tile turns on — a tile that promised only
  // half of what it does is the defect this replaced. Only the VISIBLE <small>
  // text counts; the comment beside it naturally says the words too.
  const envTile = html.slice(html.indexOf('data-first-run-choice="environmental"'));
  const visible = envTile.slice(envTile.indexOf('<small>'), envTile.indexOf('</small>'));
  assert.match(visible, /earthquakes/i);
  assert.match(visible, /fires?/i, 'the tile must promise the fires it enables');

  // Owner 2026-09-01: Mission Control is chrome, not marketing copy.
  const launcherHtml = html.slice(
    html.indexOf('id="first-run-launcher"'),
    html.indexOf('</aside>', html.indexOf('id="first-run-launcher"')),
  );
  assert.doesNotMatch(launcherHtml, /Comment on YouTube chat to choose your view/);
  assert.doesNotMatch(launcherHtml, /forbidden cockpit/);
  assert.doesNotMatch(launcherHtml, /GEV MIC button in the dock/);
  assert.doesNotMatch(launcherHtml, /ESC to dismiss/i);
  assert.doesNotMatch(launcherHtml, /id="first-run-title"|id="first-run-description"|first-run-scanline/);
  const statusMarkup = launcherHtml.slice(
    launcherHtml.indexOf('data-first-run-status'),
    launcherHtml.indexOf('</p>', launcherHtml.indexOf('data-first-run-status')),
  );
  assert.doesNotMatch(statusMarkup, /Tip:/);

  // Menu order is the owner's, read straight off the markup.
  const order = [...html.matchAll(/data-first-run-choice="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['contacts', 'space-missions', 'environmental', 'explore']);
  assert.doesNotMatch(html, /data-first-run-choice="infrastructure"/,
    'the removed tile must leave no markup behind');

  const startup = main.slice(main.indexOf('void Promise.all(['), main.indexOf('// Expose for debugging'));
  assert.match(startup, /styleManager\.initialRestorePromise/);
  assert.ok(startup.indexOf("loadingScreen.classList.add('hidden')") < startup.indexOf('initFirstRunExperience'));
  assert.match(startup, /initFirstRunExperience\(\{ styleManager, dataManager \}\)/);

  assert.match(css, /body\.ui-clean-view #first-run-launcher/);
  assert.match(css, /body\.recording-mode #first-run-launcher/);
  // Scoped, not a bare search: style.css has other reduced-motion blocks, and
  // matching one of THOSE would let the launcher's own opt-out be deleted.
  const reducedMotion = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((match) => match[1]);
  assert.ok(
    reducedMotion.some((block) => block.includes('#first-run-launcher') && block.includes('.first-run-choices')),
    'the launcher must keep its OWN prefers-reduced-motion block, covering the card and the scrolling list',
  );
  // The card must be click-through until revealed and again while it fades out.
  const base = css.slice(css.indexOf('#first-run-launcher {'), css.indexOf('#first-run-launcher.visible'));
  assert.match(base, /pointer-events: none/);
  assert.match(css, /#first-run-launcher\.visible \{[\s\S]*?pointer-events: auto/);
  // The card is a flex column so its mission list can scroll on a short
  // viewport — and an AUTHOR `display` on this id outranks the UA's
  // `[hidden] { display: none }`, which would strand the card in the
  // accessibility tree until it is revealed or removed.
  assert.match(base, /display: flex/);
  assert.match(base, /max-height: min\(92dvh/);
  assert.match(css, /#mission-control-nav \{[\s\S]*?bottom:\s*auto;[\s\S]*?width:/);
  assert.match(css, /#first-run-launcher\[hidden\] \{\s*display: none;\s*\}/);
  // Only the mission list may scroll: the heading, checkbox and status line
  // have to stay on screen at every height.
  const choicesStart = css.indexOf('.first-run-choices {\n  display: grid');
  assert.ok(choicesStart >= 0, 'mission tile list must keep its grid rule');
  const choiceBlock = css.slice(choicesStart, css.indexOf('.first-run-choices button {', choicesStart));
  assert.match(choiceBlock, /flex:\s*0 0 auto/);
  assert.match(choiceBlock, /overflow:\s*visible/);
  const maximizedChoices = css.slice(
    css.indexOf('#first-run-launcher.is-maximized .first-run-choices {'),
    css.indexOf('.first-run-header,', css.indexOf('#first-run-launcher.is-maximized .first-run-choices {')),
  );
  assert.match(maximizedChoices, /flex:\s*0 0 auto/);
  // Card copy, icons and hints share the kicker cyan — not a mix of white,
  // dim grey and brighter cyan. The token is the MISSION CONTROL · FIRST LAUNCH
  // color; descendants must consume it rather than inventing their own.
  assert.match(base, /--first-run-ink: rgba\(54, 220, 255, 0\.86\)/);
  assert.match(base, /color: var\(--first-run-ink\)/);
  for (const selector of [
    '.first-run-kicker',
    '.first-run-layers-kicker',
    '.first-run-window-control',
    '.first-run-choices button',
    '.first-run-choices small',
    '.first-run-arrow',
    '.first-run-note',
  ]) {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} must keep a color rule`);
    const block = css.slice(start, css.indexOf('}', start) + 1);
    assert.match(block, /color: var\(--first-run-ink\)/, `${selector} must use the shared first-run ink`);
  }

  assert.match(html, /id="mission-control-nav" aria-label="Mission Control"/);
  assert.match(html, /id="first-run-launcher"[^>]*class="is-maximized"/);
  assert.match(html, /id="first-run-maximize"[^>]*class="first-run-window-control"[^>]*aria-pressed="true"/);
});


test('Mission Control is left-rail chrome with a reserved fill over the live globe', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');

  // Placement and click-through: the rail never captures globe clicks; only the
  // revealed card does. A full-screen scrim would both hide the globe and steal
  // pointer events from it.
  const nav = css.slice(css.indexOf('#mission-control-nav {'), css.indexOf('#first-run-launcher {'));
  assert.match(nav, /pointer-events: none/);
  assert.match(nav, /z-index: 147/);
  assert.match(nav, /bottom:\s*auto/);
  assert.match(nav, /left: max\(0\.65rem, env\(safe-area-inset-left\)\)/);
  assert.doesNotMatch(nav, /pointer-events:\s*auto/);
  assert.doesNotMatch(html, /first-run-scrim|mission-control-scrim/);

  const base = css.slice(css.indexOf('#first-run-launcher {'), css.indexOf('#first-run-launcher.visible'));
  // Reserved fill so globe HUD cannot show through type or tiles. Not a modal
  // scrim and not the previous near-transparent overlay.
  assert.match(base, /--first-run-ink: rgba\(54, 220, 255, 0\.86\)/);
  assert.match(base, /--first-run-read:/);
  assert.match(base, /text-shadow: var\(--first-run-read\)/);
  assert.match(base, /background: rgba\(6, 15, 22, 0\.76\)/);
  assert.match(base, /border: 1px solid rgba\(54, 220, 255, 0\.22\)/);
  assert.match(base, /backdrop-filter: blur\(12px\) saturate\(1\.2\)/);
  assert.doesNotMatch(base, /linear-gradient\(145deg, rgba\(8, 28, 38, 0\.14\)/);
  assert.doesNotMatch(base, /blur\(3px\)|blur\(28px\)/);
  assert.match(base, /pointer-events: none/);
  assert.doesNotMatch(css, /\.first-run-scanline\s*\{/);
  assert.match(css, /\.first-run-header,[\s\S]*?flex-shrink: 0/);
  const choices = css.slice(css.indexOf('.first-run-choices {'), css.indexOf('.first-run-choices::-webkit-scrollbar'));
  assert.match(choices, /position: relative/);
  assert.doesNotMatch(choices, /position:\s*absolute/);

  const rows = css.slice(css.indexOf('.first-run-choices button {'), css.indexOf('.first-run-choices button:hover'));
  assert.match(rows, /background: rgba\(6, 15, 22, 0\.55\)/);
  assert.match(rows, /flex-shrink: 0/);
  assert.match(rows, /min-height: 1\.95rem/);
  assert.doesNotMatch(rows, /rgba\(54, 220, 255, 0\.045\)/);

  const hover = css.slice(css.indexOf('.first-run-choices button:hover'), css.indexOf('.first-run-choices button[aria-disabled'));
  assert.match(hover, /background: rgba\(54, 220, 255, 0\.12\)/);

  const maximized = css.slice(css.indexOf('#first-run-launcher.is-maximized {'), css.indexOf('#first-run-launcher.is-maximized .first-run-choices'));
  assert.match(maximized, /position: relative/);
  assert.match(maximized, /height: auto/);
  assert.match(maximized, /min-height: 0/);
  assert.doesNotMatch(maximized, /min-height: min\(36rem/);
  assert.doesNotMatch(maximized, /position:\s*fixed/);

  // Window states, short/narrow viewports, and reduced-motion stay distinct.
  assert.match(css, /#first-run-launcher\.is-minimized \{/);
  assert.match(css, /#first-run-launcher\.is-maximized \{/);
  assert.match(css, /@media \(max-width: 620px\) \{[\s\S]*?#first-run-launcher/);
  assert.match(css, /@media \(max-height: 620px\) \{[\s\S]*?#first-run-launcher \{ padding:/);
  assert.match(css, /#first-run-launcher\[data-state='loading'\] \.first-run-note/);

  // Choosing a view tucks to the chip; it does not remove the chooser.
  const successPath = module.slice(
    module.indexOf('if (outcome?.ok) {'),
    module.indexOf('const failed = outcome?.failedLayerIds'),
  );
  assert.doesNotMatch(successPath, /setWindowState\('minimized'/);
  assert.doesNotMatch(successPath, /dismiss\(/);
  assert.match(module, /setWindowState\(root\.classList\.contains\('is-maximized'\) \? 'normal' : 'maximized'\)/);
  const revealStart = module.indexOf('const reveal = () => {');
  assert.ok(revealStart >= 0, 'reveal() must exist');
  assert.match(module.slice(revealStart, revealStart + 600), /setWindowState\('maximized'\)/);
});

test('the launcher keeps focus, restores it, and never disables the focused button', () => {
  const module = fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
  // Tiles stay clickable during a launch so a second view can supersede the
  // first. Never the `disabled` property: disabling a focused button drops the
  // keyboard to <body> and strands the visitor outside the launcher.
  assert.match(module, /root.setAttribute\('aria-busy', String\(next\)\)/);
  assert.match(module, /Tiles stay clickable during a launch/);
  assert.doesNotMatch(module, /button\.disabled = /);
  assert.doesNotMatch(module, /setAttribute\('aria-disabled'/);
  // Tab is confined to the launcher, and ESC always releases it.
  assert.match(module, /event\.key !== 'Tab'/);
  assert.match(module, /event\.key === 'Escape'/);
  assert.match(module, /previouslyFocused\?\.focus/);
  // Capture phase, so the app's global letter hotkeys cannot eat the launcher's keys.
  assert.match(module, /addEventListener\('keydown', onKeyDown, true\)/);
});

test('the DISPLAY rail starts collapsed on a first run, and a stored choice wins', () => {
  const ui = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  // The rail opened by default to advertise HUD / DETECT / 3D. Those default ON
  // now, so it was opening to offer controls for things already happening —
  // while competing with the mission card for the one first impression there is.
  assert.match(
    ui,
    /if \(panelId === 'pp-toggles' && stored === null\) collapsed = true;/,
    'first run must leave DISPLAY collapsed',
  );
  // The first-run default may only apply when NOTHING is stored: a visitor who
  // opened the rail keeps it open, and one who closed it keeps it closed.
  const block = ui.slice(ui.indexOf('stored = localStorage.getItem(this._panelCollapseStorageKey(panelId))'));
  const guard = block.slice(0, block.indexOf('panelEl.classList.toggle'));
  assert.match(guard, /if \(stored === '1'\) collapsed = true;/);
  assert.match(guard, /if \(stored === '0'\) collapsed = false;/);
  assert.ok(
    guard.indexOf("stored === '0'") < guard.indexOf('pp-toggles'),
    'the stored-state reads must come before the first-run default',
  );
});

// ── Voice: mission layer ids stay inside the shipped tool schema ────────────

test('the voice TOOL SCHEMA matches the shipped natural-hazards baseline', () => {
  const src = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  const start = src.indexOf('const GEV_REALTIME_TOOLS = [');
  assert.ok(start > 0, 'GEV_REALTIME_TOOLS must still be a single literal array');
  const end = src.indexOf('\n];\n', start);
  const block = src.slice(start, end + 4);

  assert.equal(block.length, 31215, 'tool schema byte length drifted from the frozen baseline');
  assert.equal(
    crypto.createHash('sha256').update(block).digest('hex'),
    '93348389aafb39c7ad2c6200c15547156dddb6eaaf719bf1c6b373a78f56de19',
    'the natural-hazards layer must stay in the audited shipped tool schema',
  );

  // ...and the mapping that makes them reachable by voice is one instruction
  // string, whose rollback is deleting that string. Anchored to a LIVE array
  // entry — a quote at the start of its own line — so commenting the paragraph
  // out reads as the removal it is, not as a passing substring match.
  assert.match(
    src,
    /\n\s+'NAMED VIEWS are shorthand/,
    'the mission mapping must be an active instruction entry, not commented out',
  );
  const mapping = src.slice(src.indexOf('NAMED VIEWS are shorthand'));
  const paragraph = mapping.slice(0, mapping.indexOf("',\n"));
  for (const layerId of [
    'local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms', 'earthquakes',
  ]) {
    assert.ok(paragraph.includes(layerId), `mapping must name the existing ${layerId} enum value`);
  }
  assert.ok(paragraph.includes('zoom_to_globe'));
  assert.ok(paragraph.includes('set_layer_visibility'));
});

test('every layer a mission drives is already in the shipped set_layer_visibility enum', () => {
  const src = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  const tool = src.slice(src.indexOf("name: 'set_layer_visibility'"), src.indexOf("name: 'show_data_layers_menu'"));
  const missionLayerIds = Object.values(FIRST_RUN_MISSIONS).flatMap((mission) => mission.layerIds || []);
  assert.ok(missionLayerIds.length > 0);
  for (const layerId of missionLayerIds) {
    assert.ok(tool.includes(`'${layerId}'`), `${layerId} must already be an allowed enum value`);
  }
});
