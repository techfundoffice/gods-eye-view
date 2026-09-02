# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`docs/CURRENT-STATE.md` is the authoritative runtime reference (~270 KB, dated entries newest-first at the top). Docs precedence when they conflict: `docs/CURRENT-STATE.md` → `docs/opensky-auth.md` → `CHANGELOG.md`. Historical planning notes elsewhere may not match runtime behavior.

**Maintenance rule enforced by the project:** if you change runtime behavior or architecture, update `docs/CURRENT-STATE.md` and `CHANGELOG.md` in the same change set. If you add or change a data source, update `DATA_SOURCES.md` with its license and attribution.

## Commands

Node 24.14.x or 26.x is required (`engines` in `package.json`).

```bash
npm install
npm run dev -- --host localhost --port 4173   # dev server (default port is 5173 unless PORT/.env says otherwise)
./scripts/dev-fresh.sh                        # macOS: clears Vite cache, pulls keys from Keychain, port 4173, CCTV packs preconfigured
npm run build                                 # vite build
npm test                                      # all unit tests (node:test)
npm run test:track                            # tracking-invariant regression; needs a dev server on :4173
```

Only `GOOGLE_MAPS_API_KEY` is required to boot (copy `.env.example` → `.env`). Everything else degrades to a labeled unavailable/simulated state rather than failing.

### Running one test

Unit tests are `*.test.mjs` files colocated with their source under `src/`, discovered by `scripts/run-unit-tests.mjs` and run with the built-in `node:test` runner:

```bash
node --test src/data/earthquakes.test.mjs
node --test --test-name-pattern 'analyst' src/data/earthquakes.test.mjs
```

Two files are **allocation microbenchmarks** and must run isolated, GC-bracketed, and serialized — `npm test` does this for you:

```bash
node --expose-gc --test --test-concurrency=1 src/data/focusAllocations.test.mjs
node --expose-gc --test --test-concurrency=1 src/overlays/worldOverlayAllocation.test.mjs
```

Their budgets are calibrated on Node 24. On any other major version `npm test` skips them with a warning; set `GEV_REQUIRE_ALLOCATION_GATE=1` to make an uncalibrated runtime a hard failure instead.

### Headless QA harnesses

`scripts/qa-*.mjs` drive the *real* app in headless Chromium (Puppeteer) against an already-running dev server — they never start the server. Conventions: `--url http://localhost:4173`, usually `--json <report>`, `--screenshots-dir`, and `--headful` (drops the SwiftShader flags and uses the real GPU). Headless pixels are A/B evidence only; **headful is the visual sign-off surface**, and a screenshot is only valid if its report frame records `tilesSettled: true`.

```bash
node scripts/qa-firms.mjs --url http://localhost:4173
node scripts/qa-focus-evidence.mjs --url http://localhost:4173 --json qa-shots/report.json
npm run qa:map-source-tray
```

Before a PR: `npm run build`, `npm test`, and `npm run test:track` must all be green, with no new console errors.

## Architecture

Vanilla ES modules — **no framework**. CesiumJS for the globe, Vite for build *and* backend, Google Photorealistic 3D Tiles for the planet, OpenAI Realtime (WebRTC) for voice.

### `vite.config.js` is the server (7k lines)

There is no separate backend. Every secret-bearing or quota-bearing upstream is a Vite plugin exposing an `/api/*` middleware, registered in the `plugins` array at the bottom of the file. Each plugin installs on **both** `configureServer` and `configurePreviewServer`, so `npm run preview` keeps the API surface. Routes include `/api/opensky`, `/api/adsblol/mil`, `/api/ais-live`, `/api/celestrak`, `/api/tomtom`, `/api/firms`, `/api/overpass`, `/api/route`, `/api/cctv`, `/api/radio`, `/api/launches`, `/api/terrain/heights`, `/api/realtime/token`, `/api/openai/hud-summary`.

The proxies carry real policy, not just forwarding: memory + disk caches (`.gev-cache/`), per-IP and global rate limiters, response byte caps, timeouts, an OpenSky credit governor with adaptive TTL, a TomTom daily tile budget, Overpass query sanitization and Douglas–Peucker simplification, and sanitized error bodies. Preserve these when touching a proxy.

**Key exposure is a hard boundary.** Only `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` reach the browser (via `define:` as `import.meta.env.*`). Everything else — OpenAI, AISStream, OpenSky OAuth, TomTom, FIRMS — stays server-side; the client gets ephemeral tokens or proxied responses. Proxy destinations are fixed or allowlisted; the CCTV proxy only fetches server-registered frame URLs, never client-supplied ones. Don't move a secret client-side to simplify a call path.

### Client composition (`src/main.js`)

`main.js` is the only wiring point: it creates the Cesium `Viewer` (default globe hidden, Google 3D tileset added as a primitive, 60 fps cap, `preserveDrawingBuffer` for screenshots), then constructs `MapStackController` → `StyleManager` → `DataLayerManager` → `SceneDirector` → annotations → voice, and hangs everything on `window.__godsEyeView`.

Order matters in two places: `dataManager.finalizeRegistrations(LAYER_STATE_REGISTRY)` seals the registry *before* any persisted layer state is restored, and `installRenderGovernor(viewer)` runs *after* every module has had a chance to register pre-install render holds.

### Data layers

One self-contained module per layer in `src/data/<layer>.js`, default-exporting an object with `id`, `name`, `icon`, `source`, `updateInterval` and the lifecycle `init/enable/disable/update(/destroy)`, plus `getStats()` and optionally `getDetectableObjects()` / `getAnalystRecords()`. Copy an existing layer (`earthquakes.js` is the smallest) as a template and register it in `main.js`.

`src/data/manager.js` owns the lifecycle, the toggle panel, and `layerFeedState()` — the function that turns heterogeneous `getStats()` shapes into one honest chip state (`nominal/loading/degraded/stale/fallback/unavailable`). Feed honesty is a product requirement, not cosmetics: a missing optional key must surface as `KEY REQUIRED`, a simulation must say it is simulated, and partial success must never be reported as success.

`src/data/layerState.js` (`LayerStateCoordinator`) persists layer enablement to `localStorage['gev:layer-state:v2']`, but **only for `origin: 'user' | 'voice' | 'tool'`** — restores and internal effects must not become durable state. Its parsers reject out-of-grammar or oversized payloads wholesale rather than salvaging a prefix. `src/sharelink.js` serializes camera, style, layers, and one tracked target into the URL.

### UI vs. layer logic

`src/ui.js` (~10k lines) holds `StyleManager` plus the panels, HUD, cockpit, and the control facade that voice and scenes call through; `src/hud.js` is the intelligence HUD and AI scene summary. Keep UI in `ui.js` and layer behavior in `src/data/`. Visual styles are GLSL post-process shaders in `src/styles/` (`1`–`7` in the app).

### Voice

The tool surface is **split across the trust boundary**: the 28 tool schemas live server-side as `GEV_REALTIME_TOOLS` in `vite.config.js` (handed to OpenAI when minting the session token at `/api/realtime/token`), and the executors live client-side in `src/voice/gevActions.js`. Adding or changing a tool means editing both. `src/voice/gevRealtime.js` owns the WebRTC session, viewport-screenshot capture (pixel- and byte-capped), and the cost tracker (`voiceCost.js`: warns at $2, hard $5 session cap). Rules: confirm only what actually happened, and never invent labels from a screenshot.

`src/data/contextStore.js` (`window.__gevContextStore`) is the decoupling seam — layers publish selected/tracked entity context into it and voice reads from it, so voice never imports layer internals.

### Rendering and performance

Performance work is load-bearing here and easy to regress:

- `src/renderGovernor.js` flips the scene into `requestRenderMode` whenever nothing animates. Anything with a per-frame animator must take a `holdContinuousRender(...)` and release it. If you add a `CallbackProperty`, you have probably added a per-frame animator.
- `src/overlays/worldOverlay.js` is a shared canvas overlay with a cohort/collision budget per source, and an allocation budget covered by the microbenchmarks above.
- Ground truth for entity heights runs through a real vertical datum (`src/data/geoid.js`, `groundFloor.js`, `meshFloorSampler.js`) sampled against the *rendered* mesh — that's why aircraft sit on aprons and cameras stand on corners.
- `src/data/iconOrientation.js` projects true world headings into screen space per frame, so icons stay world-stable at any camera angle.
- Live feeds arrive every 15–30 s; the globe deliberately renders one poll interval behind and interpolates (`motionModel.js`), with dead reckoning across gaps.

`docs/PERFORMANCE.md` has the measured baselines; `src/data/earthquakes.js` carries a worked example of a 32 ms/frame → 1.4 ms/frame fix and the rule it established.

### Debug handles (dev console)

`window.__godsEyeView` (viewer, styleManager, dataManager, sceneDirector, mapStackController, annotations, `getRenderGovernorDiagnostics`, `requestRender`), `window.__gevAnnotations` (`tour()`, `demo()`, `clear()`, `count()` — deterministic annotation testing without a mic), `window.__gevVoiceCommands`, `window.__gevContextStore`, `window.__gevWorldOverlay`, `window.__gevGizmoDebug`. `TESTING.md` is the manual field-test script for annotations and tracking.

## Conventions

- ES modules, 2-space indent, single quotes, semicolons. JSDoc on exported/public functions.
- Comments in this codebase record *why*, often with the measurement or the regression that forced the decision. Match that density; don't strip those comments when refactoring.
- Conventional-commit prefixes (`feat:`, `fix:`, `perf:`, `docs:`) are appreciated, not required.
- Never bundle data you don't have the right to redistribute — fetch it at runtime instead. Bundled datasets live in `src/data/local_data/` with per-folder provenance.

## Project line

This models events, assets, infrastructure, and systems — aircraft, vessels, satellites, fires, cameras, cities. It does **not** do named-person search, face recognition, or tracking individuals, and changes that cross that line are not accepted. Don't add scraping of sources whose terms forbid it, and don't present public-data inference as authoritative intelligence.
