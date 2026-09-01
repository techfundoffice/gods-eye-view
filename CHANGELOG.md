# Changelog

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased] — 2026-09-01

### Changed

- First-run Mission Control is a transparent left-rail overlay so the live
  globe stays visible while reading “Comment on YouTube chat to choose your
  view.” and picking a view. Heading, options, and status stay readable via
  cyan ink and a tight text halo rather than an opaque card.
- First-run Mission Control copy now uses one cyan: the heading, description,
  tile titles and subcopy, icons, ESC hint, and MIC tip match
  **MISSION CONTROL · FIRST LAUNCH**.

## [Unreleased] — 2026-08-31

### Changed

- Live chat on **our own YouTube Live page** no longer polls Data API
  `liveChatMessages.list`. YouTube Settings and the Youtube AI Comment Harness
  read that page's chat through same-origin `/api/youtube/live-chat` (the same
  watch-page chat YouTube already shows on our broadcast) so a long stream does
  not burn Data API quota. Those comments appear in the homepage ChatGPT-style
  overlay (`#gev-nextchat`) as viewer messages (author + full text). ENABLE
  starts that display even when Cursor cannot enforce a tool-less session;
  `#Task` globe actions stay gated. Sign-in is still required. Comments lists,
  video lists, and Go Live are unchanged.

## [Unreleased] — 2026-08-30

### Added

- ADMIN **Plugins** now includes **Youtube AI Comment Harness**: incoming
  YouTube comments and live chat appear in NextChat with the viewer's name,
  and only leading `#Task` comments may propose a validated globe view through
  the existing GEV action runner. Unsafe, ambiguous, duplicate, stale, and
  tool-seeking requests stay visible and do not change the globe. If the
  interpreter cannot run with an empty tool surface, the harness stays
  disabled and STATUS keeps that explanation; YouTube disconnected /
  unavailable stays on the connection row.

- The bottom LOCATION finder suggests matching places as you type. A query
  like `Disneyland` lists Anaheim, Florida, France, Japan, and other distinct
  parks with their addresses so you can pick the right one; choosing a row
  flies the globe there. Enter still searches. Without a Google Maps key, or
  when lookup fails, the list stays empty.
- ADMIN **Plugins** includes **Google Earth**: it reports Map Tiles key/tileset
  status honestly (`KEY REQUIRED` vs `LOAD FAILED` vs `DISPLAYING`) and can
  switch the globe onto Google Photorealistic 3D Tiles when the tileset loaded.
- A missing `GOOGLE_MAPS_API_KEY` no longer aborts globe startup; the app
  continues on OSM and labels Google Earth as `KEY REQUIRED` instead of
  presenting OSM as Google Earth.
- ADMIN login still offers native Replit Login, and a configured
  `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` can also unlock the console.

- DATA panel now includes globe-relevant feeds selected from the
  [public-apis/public-apis](https://github.com/public-apis/public-apis)
  catalog: **Air Quality (OpenAQ)**, **EV Chargers**, **Biodiversity (GBIF)**,
  **USGS Water Sites**, **NWS Alerts**, **SenseBoxes**, **PurpleAir**,
  **iDigBio**, **AQI Cities**, **NL Air Quality**, **PM2.5 Sensors**,
  **REFUGE Restrooms**, **FAA Airports**, **US National Parks**, and
  **Recreation Sites**. Each is a toggleable runtime layer with a density cap.
  Optional keys degrade as `KEY REQUIRED`. Non-geo, APILayer commercial,
  lookup-only, and already-plotted catalog rows are rejected by a shipped
  relevance filter rather than omitted. USGS Water clamps camera bboxes to the
  IV product limit of 25 square degrees.

- Added a NextChat-style chat overlay on the globe home page: session list,
  new chat, user/assistant thread, and a text composer with send. Typed
  messages use the existing GEV MIC Realtime path (`sendTextCommand` → tools
  in `gevActions`). Assistant replies stream from live transcript deltas.
  Without a connected voice session or `OPENAI_API_KEY`, send does not fake a
  reply. GEV MIC remains in the command dock. Spec:
  [`docs/NEXTCHAT-HOMEPAGE.md`](docs/NEXTCHAT-HOMEPAGE.md).

### Fixed

- ADMIN **Go Live** now runs the full YouTube Live path instead of calling the
  encoder LIVE as soon as ffmpeg starts. Create or select a broadcast from the
  signed-in YouTube account; the stream key is fetched and held on the server
  and is never returned in status, logs, or the form. The pane shows separate
  readiness for YouTube account, broadcast, capture, encoder, ingest, and
  YouTube confirmation, including **YouTube has not received the stream yet**.
  Chromium captures this origin (or `LIVE_CAPTURE_URL`) through the Replit
  preview proxy with a deterministic viewport, and ffmpeg publishes H.264 + AAC
  over FLV/RTMP with a 2-second GOP.

### Changed

- LOCATION and VISUAL PRESETS start pinned and expanded on a first visit, so
  their contents are visible without a click or hover. Unpin still uses the
  existing pin control and is remembered. A stored unpin/collapse or a
  share-link panel field still wins over that default.

- The ADMIN console is now a two-column control panel: a persistent left
  navigation rail (Core: **Create Plugin**, **MCP Server**, **Go Live**; then a
  separate **Plugins** group for generated manifest entries) and a focused
  content workspace. Narrow screens open the rail as a drawer; Escape closes
  the drawer when it is open and otherwise still closes the console. SIGN OUT
  stays in the shell header. Native Replit Login, server-side authorization,
  plugin builder, MCP, and live-stream controls are unchanged.

## [Unreleased] — 2026-08-29

### Fixed

- ADMIN console now accepts a `.env` `ADMIN_PASSWORD_HASH` (or `ADMIN_PASSWORD`)
  that contains `$`. Vite's dotenv-expand previously stripped those characters,
  so a pasted `scrypt$...` hash left the console stuck on
  `ADMIN NOT CONFIGURED`. An empty inherited admin env var no longer shadows
  the file either.

### Added

- The operator **YouTube Settings** panel can go live on YouTube Live through
  ffmpeg — no OBS or other encoder app. Create a broadcast from the connected
  YouTube account, or paste a Studio ingest URL and stream key, then start or
  stop the globe capture. The stream key never appears in status, encoder logs,
  or on-screen copy. A missing ffmpeg or capture browser is reported as an
  error rather than a silent live state.

## [Unreleased] — 2026-08-24

### Added

- Added an `ADMIN` label to the app chrome that opens a password-gated admin
  console. The console is disabled unless `ADMIN_PASSWORD_HASH` (or
  `ADMIN_PASSWORD`) is configured; sign-in uses a scrypt-hashed password, an
  HttpOnly `SameSite=Strict` session cookie, and per-client login backoff.
  Generate a hash with `node scripts/admin-password-hash.mjs`.
- Added the dashboard's **Create New Admin Menu Plugin** item: a chat interface
  where the operator names a plugin and a Claude Code agent writes it into this
  checkout, registers it in the admin menu manifest, and reports back in the
  transcript. Follow-up messages continue the same agent session.
- Added the dashboard's **MCP Server** setting: an operator-toggled JSON-RPC
  endpoint at `POST /api/admin/mcp` that lets an external MCP client list,
  start, read, and continue plugin builds with an API key. Keys are displayed
  once and stored only as hashes.
- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- Clicking **ADMIN** while signed out now opens a login page only. Plugin
  menu items, the plugin builder, MCP settings, Go Live, and SIGN OUT stay
  unpainted until a correct admin password succeeds. A `hidden` attribute
  alone was not enough: `.admin-dashboard { display: flex }` had already
  beaten the UA rule once, so the lock is now a class on `#admin-console`.
- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
