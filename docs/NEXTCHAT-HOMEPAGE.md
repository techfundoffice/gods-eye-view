# NextChat UX on the God's Eye View home page

Software specification for **grok CLI**. This is implementer instruction, not a
product pitch. The overlay is now in the runtime (`#gev-nextchat`,
`src/voice/nextchat.js`); `docs/CURRENT-STATE.md` is the source of truth for
what shipped.

## Goal

Put a recognizably **NextChat** chat surface on the God's Eye View **home page**
so an operator can type to the program, see a conversation, and have that typed
turn actually drive the globe. The home page remains the globe. The chat is
chrome on that globe, hooked into the shipped voice/tool path — not a mock
transcript and not a second product.

## Problem

The home page (`index.html`) is the Cesium globe plus operator chrome. Talk to
the program today by clicking **GEV MIC** (`#gev-voice-button` inside
`#gev-voice-control`, injected into `#command-dock` by
`createVoiceControl` in `src/voice/gevRealtime.js`). That starts an OpenAI
Realtime WebRTC session. Tool schemas live in the `const GEV_REALTIME_TOOLS = [`
literal array in `vite.config.js`. Client execution is `createGevActionRunner` /
`runGevAction` in `src/voice/gevActions.js`. Typed turns already exist:
`GevRealtimeController.sendTextCommand(text)` creates a user
`conversation.item` with `input_text` and requests a response. There is no
homepage composer. Tests and `window.__gevVoiceCommands` can call
`sendTextCommand`; a visitor on the home page cannot. ADMIN plugin-builder chat
(`#admin-transcript`) and YouTube live chat are different products — do not
reuse them.

## NextChat UX

Build the chat as vanilla-DOM chrome on the home page. Match NextChat's *shape*,
not ChatGPTNextWeb/NextChat's React/Next.js/TypeScript stack. Do not vendor or
embed that repository.

Required surface, all visible on the home page without leaving the globe:

1. **Session list.** A list of conversation sessions (id, title, recency). The
   operator can select one. Persist locally under the existing
   `godsEyeView.<feature>.<field>` convention (for example
   `godsEyeView.nextchat.sessions.v1`). Fail open if storage is blocked.
2. **New chat.** A control that starts a new empty session, makes it active, and
   does not replay the previous thread's messages into the live Realtime
   conversation (replaying would re-dispatch tools). New chat may stop-then-start
   the live Realtime session so the model is not still answering the old thread;
   if you keep one live connection, say so in the UI rather than pretending the
   model forgot.
3. **User/assistant thread.** The active session renders a chronological
   message thread with distinct **user** and **assistant** roles. User text
   appears in the thread when send is accepted, before the model answers.
4. **Composer with send.** A text composer (a real `textarea` or an element
   with `role="textbox"`) and a send control. Empty/whitespace-only send is a
   no-op. Enter sends; Shift+Enter inserts a newline. Space must type a space:
   `shouldHandlePushToTalkKeyDown` in `src/voice/gevRealtime.js` already ignores
   `input, textarea, select, [contenteditable], [role="textbox"]`. Use one of
   those so GEV MIC hold-Space push-to-talk does not fire while composing.
5. **Streaming or incremental replies.** Assistant text must appear as it
   arrives (token/delta streaming, or another incremental append of the live
   transcript). Do not wait for `response.done` to paint the first word. A
   stalled or failed turn is an error in the thread, not a silent blank bubble.

Optional NextChat-like polish that is allowed but not required: session rename,
delete, pin, markdown in assistant bubbles, a collapse control for the panel.
Do not take optional polish as a reason to add a framework.

Layout: an overlay or docked panel on the home page that does **not** replace
`#cesiumContainer`. The globe stays the page. Keep **GEV MIC** in `#command-dock`.
Styles go in `style.css` only (no component CSS, no CSS-in-JS). Hide or yield
with the existing exclusive surfaces (`cockpit-mode`, `scene-playback-mode`,
`recording-mode`, `ui-clean-view`) rather than inventing a fifth exclusive class.
Do not cover the first-run launcher or steal its ESC (see
`docs/CURRENT-STATE.md` ESC arbitration — three independent rules). Z-order:
panels live in the 100–139 band; the voice pill is 150; do not sit above
exclusive full-screen surfaces.

## Program hookup

The web chat is hooked into the live program. A typed send must mutate the globe
through the same path a spoken command uses.

**Send path (required):**

1. If the Realtime session is not connected, start it the same way GEV MIC does
   (`GevRealtimeController.start` / `window.__gevVoiceCommands.start`). Do not
   invent a parallel HTTP chat completions (or Responses) endpoint that bypasses
   tools.
2. Put the user text in the active session's thread.
3. Call `sendTextCommand` on the live `GevRealtimeController` with that text.
   `sendTextCommand` already: trims; no-ops empty strings; throws
   `GEV voice is not connected` when the data channel is not open; supersedes
   an in-flight response so a late tool from the old turn is refused; defers
   `response.create` when a response is active (`requestUserTextResponse`).
   Keep those invariants. Do not reimplement a second `conversation.item.create`
   client.
4. Tool calls from that turn dispatch through existing
   `handleRealtimeEvent` → `extractFunctionCalls` → `this.runner(...)` which is
   `runGevAction` from `src/voice/gevActions.js`, against schemas in
   `GEV_REALTIME_TOOLS`. Layers, camera, annotations, and the other shipped
   tools must actually run. Confirm in the thread only what the tool result
   reported — same honesty as voice.

**Reply path (required):**

`handleRealtimeEvent` today does not paint a homepage transcript. Subscribe
there (or to a small callback it invokes) and append assistant text as Realtime
events arrive. Prefer the session's existing audio-transcript deltas (inspect
`.gev-logs/realtime-conversations.jsonl` / `/api/realtime/debug-log` for the
live event names, e.g. `response.output_audio_transcript.delta` or the then-
current equivalent). Do not add a second model just to get text. Session-config
tweaks in `/api/realtime/token` are allowed only if `GEV_REALTIME_TOOLS` stays
the `const GEV_REALTIME_TOOLS = [` **literal array** in `vite.config.js` (do not
split, generate, or import it; unit tests sha256-pin that source text) and
`gevActions.js` remains the executor.

**Connection and keys:**

Without `OPENAI_API_KEY`, `/api/realtime/token` returns 503 and GEV MIC already
surfaces that. Chat must degrade the same way: the composer can exist, send
must not fake a reply, and the thread/status must say the voice path is
unavailable. Do not mint or ship `OPENAI_API_KEY` to the browser. The browser
may see only the existing ephemeral Realtime client secret from
`/api/realtime/token`. **Secrets stay server-side.**

**What "hooked in" means (implementation acceptance):**

Typing `show earthquakes` (or `zoom to the globe`, `annotate downtown Austin`,
or any other phrase the shipped tools already handle) and sending from the
homepage composer causes `sendTextCommand` to run, causes `gevActions` to run
the matching tool (`set_layer_visibility`, `zoom_to_globe`, `annotate_map`,
…), and the globe mutates. A disconnected mock that only appends bubbles fails
this spec.

## Constraints

A later implementer must not violate these:

- **Stack:** vanilla JS + CesiumJS + Vite. No framework. No TypeScript. ESM,
  2-space indent, single quotes, semicolons. JSDoc on exported/public functions.
  Colocate tests as `<file>.test.mjs` with `node:test` + `node:assert/strict`.
- **Home page remains the globe.** This is not a chat-only app and not a new
  top-level route that hides `#cesiumContainer`. NextChat UX is overlay chrome
  on the existing home page.
- **GEV MIC stays.** Do not replace, hide-as-deleted, or remove the OpenAI
  Realtime voice control in `#command-dock`. Voice and typed chat share one
  program hookup.
- **Secrets stay server-side.** No `VITE_` prefix on private keys. No
  client-supplied upstream URLs. Proxies in `vite.config.js` remain the API.
- **Keyless installs degrade honestly.** Missing `OPENAI_API_KEY` is a
  configured terminal state for chat/voice, not a mocked assistant and not
  `LOAD FAILED` on unrelated layers. Feed honesty in `getStats()` is unchanged.
- **Do not add voice tools** for phrases already expressible with
  `set_layer_visibility` + `zoom_to_globe`. Do not re-add an Infrastructure
  first-run tile. Do not write detection mode/density, 3D-model mode, feather,
  or `_detectionUserOverridden` from this feature (that flag kills CRT/NVG/FLIR
  auto-presets for the session).
- **Render governor:** chat DOM updates are not Cesium work. Any discrete scene
  mutation still goes through existing tools (which already request renders).
  Do not add a per-frame `CallbackProperty` or an unearned
  `holdContinuousRender` for the transcript.
- **Layer contract and ui.js:** keep layer logic out of `src/ui.js`. Prefer a
  new module (e.g. `src/voice/nextchat.js`) mounted from `src/main.js` /
  `initGevVoiceCommands`. Do not dump the thread into ADMIN.
- **Durable layer enablement** from chat/voice tools stays origin `voice` as
  `gevActions` already passes. Do not pretend a chat send is `share-restore`.

## Out of scope

- Vendoring or embedding ChatGPTNextWeb/NextChat (React/Next.js/TypeScript).
- Full NextChat feature parity: masks/prompt templates, i18n, PWA, artifacts,
  plugin marketplace, multi-provider model picker, desktop/iOS, WebDAV sync.
- Replacing or removing GEV MIC / OpenAI Realtime voice.
- Adding new `GEV_REALTIME_TOOLS` entries, first-run tiles, or ADMIN
  plugin-builder changes.
- A second LLM backend, MCP-over-chat, or ADMIN-console chat on the home page.
- Rewriting `docs/CURRENT-STATE.md` as if this UX already shipped (update it in
  the implementation PR, when the runtime actually does it).
- Changing default bind, making proxies open relays, or spending brokered keys
  from the browser.

## Suggested implementation sequence

1. Mount a home-page panel (session list, new chat, user/assistant thread,
   composer/send) in vanilla DOM + `style.css`. Wire send to a stub that only
   calls `window.__gevVoiceCommands.sendTextCommand`. Prove the stub is the
   live controller, not a fake.
2. On send, start the Realtime session if idle; surface 503/unconnected the
   same way GEV MIC does.
3. Stream assistant transcript deltas from `handleRealtimeEvent` into the
   active thread.
4. Persist sessions locally. New chat does not replay old messages into
   Realtime.
5. Unit-test the shipped functions (composer send → `sendTextCommand`;
   transcript delta → thread append; unconnected/503 honesty). Add a qa harness
   only if you can drive the real homepage composer without claiming SwiftShader
   pixels as visual sign-off.
6. Update `docs/CURRENT-STATE.md` and `CHANGELOG.md` in that implementation PR
   for the runtime behavior that actually landed.

## Files a later grok CLI run should expect to touch

| Path | Why |
|------|-----|
| `index.html` | Optional mount node on the home page chrome; `#command-dock` / GEV MIC stay |
| `style.css` | Panel, session list, thread, composer |
| `src/voice/nextchat.js` (new) or equivalent | Session store, thread render, composer |
| `src/voice/gevRealtime.js` | `sendTextCommand` send path; transcript deltas out of `handleRealtimeEvent` |
| `src/main.js` | Mount next to `initGevVoiceCommands` |
| `src/voice/nextchat.test.mjs` (new) | Pins against shipped functions |
| `docs/CURRENT-STATE.md`, `CHANGELOG.md` | Only when the UX is actually in the runtime |

Do not modify the `GEV_REALTIME_TOOLS` literal unless a session-config comment
next to it is strictly required; prefer leaving that array byte-identical.

## Verification the implementation PR must satisfy

- Operator can open the home page, see the globe, open the NextChat surface,
  create a new chat, type in the composer, and send.
- A connected send of a shipped command mutates the globe via `sendTextCommand`
  → `GEV_REALTIME_TOOLS` → `gevActions` (not a mock).
- Assistant text streams or otherwise appears incrementally in the
  user/assistant thread.
- Session list lists threads; new chat starts a fresh one.
- GEV MIC is still in the command dock and still starts Realtime voice.
- Keyless / no `OPENAI_API_KEY`: no fake replies; honest unavailable state.
- `npm test` green; `npm run build` green. `test:track` still green if you
  touched tracking. Visual qa only with `tilesSettled: true` on a real GPU.
