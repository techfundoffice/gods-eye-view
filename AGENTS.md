# Cloud Computer AI.com — Agent Instructions

Vanilla JS + CesiumJS + Vite globe. No framework, no TypeScript, no CSS-in-JS.
Read [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md) before changing runtime behavior — it is the source of truth, not this file.

Human setup and product docs: [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [DATA_SOURCES.md](DATA_SOURCES.md).

## Commands

| Command | What it does |
|---------|----------------|
| `npm install` | Install from `package-lock.json` |
| `npm run dev -- --host localhost --port 4173` | Dev server (default bind is localhost) |
| `./scripts/dev-fresh.sh` | macOS: clear Vite cache, pull keys from Keychain |
| `npm run build` | Production Vite build |
| `npm test` | Node unit tests (`src/**/*.test.mjs`) |
| `npm run test:track` | Tracking invariants against a **running** app at `:4173` |
| `node scripts/qa-<name>.mjs --url http://localhost:4173` | Headless visual/runtime harnesses |

Node **24.14.x or 26.x**. PR bar: `build`, `test`, and `test:track` all green.

## Architecture

```
index.html + style.css     DOM chrome (single CSS file; no component CSS)
src/main.js                Viewer bootstrap, WebGL gate, layer registration
src/ui.js                  Panels, HUD, styles, control facade — keep layer logic out
src/data/<layer>.js        One self-contained data layer per file
src/data/manager.js        Layer lifecycle, feed-state chips, toggle serialization
src/data/layerState.js     Durable layer enablement (`gev:layer-state:v2`)
src/overlays/              Screen-space world overlay (labels, collision)
src/annotations/           Voice/console whiteboard (GeoJSON + hybrid render)
src/voice/gevActions.js    Client execution of voice tools
src/styles/                GLSL post-process looks (CRT, NVG, FLIR, …)
src/scenes/                Cinematic scene director
src/admin*.js              Password-gated ADMIN console + plugin builder
vite.config.js             All server middleware / data proxies / voice tool schema
scripts/qa-*.mjs           Puppeteer harnesses (do not start the server)
```

There is **no separate backend**. Vite middleware in `vite.config.js` *is* the API (`/api/opensky`, `/api/ais-live`, `/api/admin`, `/api/youtube`, …).

Data flow: public feed → same-origin proxy (secrets stay on the server) → `src/data/<layer>.js` → Cesium primitives / `worldOverlay` → `ui.js` chips/panels. Voice: `GEV_REALTIME_TOOLS` in `vite.config.js` (schema + instructions) → `src/voice/gevActions.js` (execution).

## Layer contract

Register a default-exported module with `DataLayerManager`. Required:

- `id`, `name`, `icon`, `source`, `updateInterval`
- `init` / `enable` / `disable` / `update` / `destroy` / `getStats`

Optional: `getDetectableObjects`, `getAnalystRecords`, `getTrackedInfo`, `setParams`/`getParams`, `showInTogglePanel` (false keeps it addressable but off the DATA panel).

Copy an existing layer (`src/data/earthquakes.js` is the small template; `flights.js` is the tracking/model template). CCTV city packs: `config/cctv_sources.*.json` plus server-registered frame URLs.

**Feed honesty.** `getStats()` must report `loading`, `lastUpdate`, `error`/`unavailable` as they really are. A source that has never answered is **not** count `0`. Missing optional keys are a configured terminal state (`KEY REQUIRED`), not `LOAD FAILED`. Partial / delayed / simulated / reconstructed data must stay labeled.

Durable layer enablement is written only for origin `user` / `voice` / `tool`. Restores (`share-restore`, `local-restore`) must not look like an operator choice.

## Voice

- Schema lives in the `const GEV_REALTIME_TOOLS = [` **literal array** in `vite.config.js`. Unit tests parse that source text (sha256-pinned). Do not split, generate, or import it.
- Handlers live in `src/voice/gevActions.js`. Confirm only what actually happened; report partial failure as partial.
- Keep the tool surface tight. The first-run launcher is instruction-only — do not add tools for phrases already expressible with `set_layer_visibility` + `zoom_to_globe`.
- `"infrastructure mode"` is three layer toggles + `zoom_to_globe`. Do **not** re-add an Infrastructure first-run tile (it dumps ~5,700 entities on a full-earth view). See CURRENT-STATE.

## Render governor

`src/renderGovernor.js` puts Cesium in `requestRenderMode` when idle.

- Any **per-frame** animator must `holdContinuousRender(ownerId)` for its lifetime and `releaseContinuousRender` when it stops.
- Any **discrete** scene mutation must `governorRequestRender()`.
- Do not put per-frame `CallbackProperty` on static/clamped geometry (rebuilds primitives every frame). Gate: `scripts/qa-perf.mjs`.

## Code style

- ESM, 2-space indent, single quotes, semicolons.
- JSDoc on exported / public functions.
- Match surrounding comment density, naming, and idiom.
- Colocate tests as `<file>.test.mjs` next to the source; use `node:test` + `node:assert/strict`.
- Conventional-commit prefixes (`feat:`, `fix:`, `perf:`, `docs:`) appreciated, not required.

## Testing

- `npm test` discovers every `src/**/*.test.mjs`. Two allocation probes (`focusAllocations`, `worldOverlayAllocation`) run serialized with `--expose-gc` and **only on Node 24**; other runtimes skip them.
- `npm run test:track` needs the app already serving at `http://localhost:4173`. It shims live feeds; do not point it at production.
- Visual / GPU sign-off is the `scripts/qa-*.mjs` family. They never start the server. Headless SwiftShader pixels are CI evidence only; real-GPU `--headful` is the visual bar. Do not judge a screenshot unless the report says `tilesSettled: true`.
- UI / middleware changes: follow `.claude/skills/verify/SKILL.md` (this box's Chromium path, WebGL gate, ADMIN console). Do not leave `.gev-drive.mjs` (or similar) in the tree.

## Docs on behavior change

Same PR as the code:

1. [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md) — what the runtime does now
2. [CHANGELOG.md](CHANGELOG.md) — user-facing delta
3. [DATA_SOURCES.md](DATA_SOURCES.md) — if a source is added or its license/attribution changes

Do not vendor datasets you cannot redistribute; fetch at runtime.

## Security

- **Secret-bearing keys stay server-side** in `vite.config.js`. The browser may see only `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` (restrict them; they are visible in devtools). Never prefix private keys with `VITE_`.
- Proxies are not open relays: no client-supplied upstream URLs (CCTV fetches only **server-registered** frame URLs). Radio is not an audio relay.
- Default bind is localhost. `HOST=0.0.0.0` is an explicit LAN opt-in that lets anyone on the network spend the brokered keys.
- Public-data product. Do not scrape sources whose terms forbid it, add private/paywalled datasets, or present inference as authoritative intelligence.
- ADMIN console is **disabled** (503 `unconfigured`) until `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD` is set. That closed state is intended. Plugins go in `src/adminPlugins/` + `manifest.json`. Rewriting a plugin the page already imported triggers a Vite full reload.

## Environment

Copy `.env.example` → `.env` (gitignored). Required for the photoreal globe: `GOOGLE_MAPS_API_KEY` (Map Tiles API). Everything else is optional and must degrade honestly.

Replit preview uses `HOST=0.0.0.0 PORT=5000 npm run dev`. Local default is `:4173`.

## First-run launcher (`src/firstRunExperience.js`)

Do not "simplify" persistence. Missions may enable their own layers at `origin: 'user'` and may expand the Context panel. They must **not** write detection mode/density, 3D-model mode, feather, or `_detectionUserOverridden` (that flag kills CRT/NVG/FLIR auto-presets for the session). ESC arbitration is three independent rules — see CURRENT-STATE; do not collapse them.

## Gotchas

- `probeWebGLCapability()` in `src/main.js` can stop globe startup. ADMIN mounts **outside** that gate, so admin DOM is driveable headless even when the globe never renders.
- Unkeyed optional proxies logging 503s in the console are expected, not a regression.
- Layer toggle is serialized per entry (`manager.js`); do not reintroduce overlapping `init`/`update` that double-arms poll timers.
- `set_context_mode` speaks operator vocabulary (`contacts`), not the internal id (`flights`). Keep that translation in `gevActions.js`.
- Generated admin plugins import one-at-a-time (~750 ms cold). Wait for the expected menu item, not "DOM stopped changing".
- Churn under `src/` can stale Vite's dep optimizer (`504 Outdated Optimize Dep`); restart the dev server.
- Do not commit `.env`, `.gev-logs/`, `.gev-cache/`, `qa-shots/`, or one-off driver scripts.
