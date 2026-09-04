# Prompt: Redesign the right-hand rail Hermes chat as a terminal conversation

Paste everything below the line into a fresh agent session in this repo.

> Revised 2026-09-04, after the rail overlap fix. The rail is now **fixed
> geometry** — that is a deliberate invariant, not an accident. Read
> "Non-negotiable: the rail is not responsive" before touching any sizing.

---

## Task

Redesign the **right-hand context rail chat panel** (`#youtube-comments-panel`,
"Youtube Chat") so the Hermes agent conversation reads like a **terminal / CLI
transcript** instead of a stack of dashboard cards.

Think: a scrolling monospace log where each viewer request and each Hermes reply
is a shell turn, with a prompt sigil, not a rounded chat bubble in a bordered card.

This is a **typographic and layout** redesign inside an existing, verified box
model. It is not a re-architecture of the rail's geometry.

## Where the code lives

Anchor on **selectors**, not line numbers — this stylesheet is ~18.8k lines and
line numbers drift. `grep -n '<selector>' style.css` to locate each rule; several
selectors below have **multiple** competing definitions and you must reconcile
all of them.

- `index.html` — the panel markup: `#youtube-chat-brand`, `.panel-header`,
  `.youtube-chat-cards`, and its four `<section class="youtube-chat-card">`
  children in DOM order: `#hermes-agent-card` (Hermes readout),
  `.youtube-progress-card` (LIVE COMMENTS IN PROGRESS),
  `.youtube-all-comments-card` (ALL LIVE COMMENTS), and
  `.hermes-agent-diagnostics` (SEEING/INTERPRETING/… + controls).
- `style.css` — single stylesheet, no component CSS. Key selectors:
  - `.youtube-chat-cards` — the four-track lane grid. **Three** rules define it
    (base, `#admin-stamp-stack`, and a later `#admin-stamp-stack` override that
    wins). They must stay in agreement.
  - `#admin-stamp-stack #youtube-comments-panel .youtube-chat-card` — shared
    card chrome, and the `.youtube-hermes-card` exception that follows it.
  - `#youtube-comments-panel #hermes-agent-card`,
    `#youtube-comments-panel .hermes-agent-diagnostics`, `.hermes-agent-*`
  - `.youtube-hermes-mode`, `.youtube-hermes-status`, `.youtube-hermes-detail`
  - `.youtube-agent-reply`, `.youtube-agent-role`, `.youtube-conversation-turn`,
    `.youtube-agent-state-*`, `.youtube-feed-text`, `.youtube-feed-meta`
  - `.youtube-followup-countdown`, `.youtube-chat-col-title`
  - `#admin-stamp-stack` — the broadcast rail container (fixed `19rem`).
- `src/youtubeHomepageInteraction.js` — builds every row: `appendCommentBody`,
  `appendConversationReply`, `renderChatActivity`, `renderHermesAgent`.
- `src/youtubeLive.js` — also writes into `#youtube-comments-list`.

## Non-negotiable: the rail is not responsive

The rail is a **fixed-geometry broadcast surface**. It renders one identical
composition at every window and stream size. Verified byte-identical at
1920×1080, 1600×900, 1440×800, 1366×768, and 1280×720.

Current lane grid (all three `.youtube-chat-cards` rules agree):

```css
grid-template-rows: max-content 22rem 26rem max-content;
```

Rules you must not break:

1. **No viewport units in rail sizing.** No `dvh`, `vh`, `vw` in the lane grid or
   card heights. `src/youtubeHomepageChat.test.mjs` asserts the fixed rem
   geometry *and* greps the track list for `dvh|vh|vw`. It will fail you.
2. **No media queries on this rail.** The `@media (max-height: 720px)` and
   `@media (max-width: 760px), (max-height: 720px)` track overrides were
   deliberately removed. Do not reintroduce them.
3. **Four cards means four tracks.** A three-track template drops the diagnostics
   card into an unsized implicit row and it collapses.
4. **Do not put `min-height: 0` + `overflow: hidden` on the Hermes cards.** That
   combination makes a box report a min-content height of **zero**, so its
   `max-content` track cannot grow — measured 54.7px against content needing
   146.7px and 563.9px, which is exactly how the old overlap bug looked. The two
   **feed lanes** are clipped scroll containers on purpose (unbounded comment
   lists); the two **Hermes cards** are `min-height: min-content` /
   `overflow: visible` because they carry prose.

If your redesign changes the *content height* of the Hermes cards (very likely —
terminal lines are a different rhythm than the current tiles), the correct move is
to **retune the `22rem` / `26rem` lane constants and keep the outer tracks
`max-content`**, then re-verify identical geometry across viewports. Do not
switch the outer tracks back to `auto` or `fr`.

## Target look

A terminal transcript, top-to-bottom, one scroll region:

- Monospace throughout (`var(--font-mono)`). No mixed proportional text in the log.
- Each turn is a **line-led block**, not a card:
  - viewer turn prefixed with a dim sigil + handle, e.g. `@handle ❯`, timestamp
    right-aligned and dim
  - Hermes turn prefixed with a distinct sigil, e.g. `hermes ❯`, in the cyan accent
  - state (`INTERPRETING`, `REPLIED`, `FAILED`, `REJECTED`) as an inline bracketed
    tag `[interpreting]`, not a pill/badge
- Remove card chrome **inside the log**: no per-row `border-radius`, no per-row
  background box, no drop shadows. Separation is a hairline rule or line spacing.
- Working state reads like a live process: a blinking block cursor `▋` on the
  in-flight Hermes line.
- `.youtube-followup-countdown` becomes a right-aligned `[0:27 to reply]`
  annotation on the turn line.
- Panel header reads like a title bar: `hermes@cloudcomputer:~/chat`, live count
  as `(N)`. Keep the collapse affordance.
- Diagnostics (`SEEING / INTERPRETING / ATTEMPTING / OBSERVING / LEARNING` +
  `PROVIDER / MODEL`, `CAPABILITIES`, `LATEST FAILURE`, `SAVED LESSONS`) become an
  aligned `key: value` block — like `env` or `systemctl status` — not a 2-up grid
  of bordered tiles.
- Controls (`PAUSE / RESUME / INSPECT / CLEAR / ROLLBACK`) become low-chrome text
  buttons that read like commands, still full-width-stacked.

Keep the existing palette (cyan `#00d4ff` / `#7ef0ff`, near-black
`rgba(0,16,25,…)` grounds, `#51f6a6` ok, `#ff7588` error, `#ffd56b` warn).
Not a recolor.

## Hard constraints

1. **Do not change any element `id`, existing class name, or DOM ordering that JS
   queries.** `src/youtubeHomepageInteraction.js`, `src/youtubeLive.js`, and the
   tests select on `#youtube-comments-list`, `#youtube-progress-list`,
   `#hermes-agent-card`, `#youtube-hermes-status`, `#youtube-hermes-detail`,
   `#hermes-agent-*`, `.youtube-agent-reply`, `.youtube-conversation-turn`,
   `.youtube-feed-text`, `.youtube-feed-meta`. Add classes; don't rename or drop.
2. **`src/youtubeHomepageChat.test.mjs` asserts on the literal text of
   `style.css`.** It pins the stacked single-column rules for
   `#hermes-agent-card` / `.hermes-agent-mind` / `.hermes-agent-details` /
   `.hermes-agent-controls`, the `#hermes-agent-lessons` wrapping rule, and the
   fixed lane geometry. Those encode real broadcast-layout requirements.
   Preserve the declarations they match, or change a test in the same commit
   **only** with a stated reason why the invariant no longer applies.
3. **Feed honesty is unchanged.** `loading` / `lastUpdate` / `error` /
   `unavailable` stay visually distinct. A never-answered source is not `0`. Do
   not let terminal styling flatten `KEY REQUIRED` into `LOAD FAILED`.
4. **Accessibility survives.** `role="status"` + `aria-live="polite"` on
   `#youtube-chat-activity`, `#hermes-agent-status`, `#youtube-hermes-status`,
   `#youtube-progress-status`, `#youtube-comments-status` stay. Sigils and cursors
   are decorative — `aria-hidden="true"`. Contrast must survive 720p stream
   compression.
5. **Both skins and all states.** The panel renders in the normal rail *and* under
   `#admin-stamp-stack`, and has `.collapsed`, `body.recording-mode`, and
   `body.ui-clean-view` variants. All must stay coherent.
6. Scope: `index.html` + `style.css` + presentational parts of
   `src/youtubeHomepageInteraction.js`. No new dependency, no CSS framework, no
   component CSS file. ESM, 2-space indent, single quotes, semicolons.

## Verification (this box)

Puppeteer's bundled Chrome will not run here (missing `libglib-2.0.so.0`). Use:

```bash
CHROME_PATH=/repl/tools/bin/chromium          # for your own driver scripts
PUPPETEER_EXECUTABLE_PATH=/repl/tools/bin/chromium npm run test:track
```

Do **not** glob `/nix/store/*chromium*` — that scan hangs for minutes. Driver
scripts must live inside the repo so `import puppeteer` resolves; delete them
afterwards. See `.claude/skills/verify/SKILL.md`.

Deliverable:

1. The redesign applied in-tree.
2. `npm test` green **relative to baseline**. Four failures are pre-existing on
   this branch and are NOT yours to fix — confirm by stashing your changes and
   re-running before blaming yourself:
   - `youtubePublicCommandPolicy` (2 — `/help` string drifted from the runtime's
     current style-command list)
   - `youtubeLive` — "the comments panel lives in the right rail"
   - `cockpitMarkup` — mobile Cockpit
   - `panelStackLayout` — command dock columns / Clear Selected Layers
3. `npm run build` green.
4. **Geometry proof**: a script that measures `.youtube-chat-cards`
   `grid-template-rows` plus every card box at 1920×1080, 1600×900, 1440×800,
   1366×768, 1280×720 and asserts (a) the computed row list is **identical** at
   every size, (b) zero sibling box overlap, (c) zero *visible* text overlap —
   intersect each text rect with its scrollable ancestors before comparing, or
   scrolled-out rows produce false positives. Seed both lanes with content first;
   an empty rail proves nothing.
5. Screenshots of the normal rail and the `#admin-stamp-stack` layout, inspected.
   `npm run test:track` is GPU-flaky here (SwiftShader): it fails at *different*
   points across runs on unmodified code, so treat it as signal only when it
   fails the same way repeatedly and baseline does not.
6. Docs in the same change: `docs/CURRENT-STATE.md` and `CHANGELOG.md`.
7. No leftover driver scripts, `qa-shots/`, or `.gev-*` artifacts.

Read `docs/CURRENT-STATE.md` first — the 2026-09-04 entry documents this rail's
current geometry and why — and open the panel in the running app so you are
redesigning what actually renders, not what the markup suggests.
