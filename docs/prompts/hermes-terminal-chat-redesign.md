# Prompt: Redesign the right-hand rail Hermes chat as a terminal conversation

Paste everything below the line into a fresh agent session in this repo.

---

## Task

Redesign the **right-hand context rail chat panel** (`#youtube-comments-panel`, "Youtube Chat")
so the Hermes agent conversation reads like a **terminal / CLI transcript** instead of a stack
of dashboard cards.

Think: a scrolling monospace log where each viewer request and each Hermes reply is a shell
turn, with a prompt sigil, not a rounded chat bubble in a bordered card.

## Where the code lives

- `index.html` lines ~51-129 — the whole panel markup: `#youtube-chat-brand`,
  `.panel-header`, `.youtube-chat-cards`, and the four `<section class="youtube-chat-card">`
  children (`#hermes-agent-card`, `.youtube-progress-card`, `.youtube-all-comments-card`,
  `.hermes-agent-diagnostics`).
- `style.css` — single stylesheet, no component CSS. The panel's rules are spread across
  several blocks; the relevant ones are roughly:
  - `~4893-5000` rail placement (`#right-context-rail #youtube-comments-panel`, `.layout-focus`)
  - `~7129-7270` `.youtube-feed-list`, `.youtube-comments-panel-inner`, `.youtube-comment-*`
  - `~13880-13940` `.youtube-chat-brand`, `.youtube-chat-activity` states
  - `~13964-14140` panel typography, `.youtube-conversation-list`, `.youtube-agent-role`,
    `.youtube-chat-col-title`, `.youtube-agent-reply`
  - `~14010-14960` the `#admin-stamp-stack` broadcast-layout overrides (a second, heavier
    skin of the same panel — **it must be redesigned too, or it will visibly diverge**)
  - `~1-56` `#hermes-agent-card` / `.hermes-agent-*` base rules
  - `~17099-17130` `.youtube-hermes-mode`, `.youtube-hermes-status`, `.youtube-hermes-detail`
- `src/youtubeHomepageInteraction.js` — builds every row: `appendCommentBody`,
  `appendConversationReply` (`.youtube-agent-reply`, `.youtube-conversation-turn`,
  `.youtube-agent-role`, `.youtube-agent-state-<state>`, `.youtube-feed-text`),
  `renderChatActivity`, `renderHermesAgent`.
- `src/youtubeLive.js:482` also writes into `#youtube-comments-list`.

## Target look

A terminal transcript, top-to-bottom, one scroll region:

- Monospace throughout (`var(--font-mono)`, already used by `.youtube-agent-role` and
  `.youtube-chat-col-title`). No mixed proportional text inside the log.
- Each turn is a **line-led block**, not a card:
  - viewer turn prefixed with a dim sigil + handle, e.g. `@handle ❯` (or `$`), timestamp
    right-aligned and dim
  - Hermes turn prefixed with a distinct sigil, e.g. `hermes ❯`, in the existing cyan accent
  - state (`INTERPRETING`, `REPLIED`, `FAILED`, `REJECTED`) rendered as an inline bracketed
    tag `[interpreting]`, not a pill/badge
- Remove card chrome inside the log: no per-row `border-radius`, no per-row background box,
  no drop shadows. Separation comes from a single hairline rule or just line spacing.
- Streaming/working state reads like a live process: a blinking block cursor `▋` on the
  in-flight Hermes line instead of the current animated card state.
- The follow-up countdown (`.youtube-followup-countdown`) becomes a terminal-style
  right-aligned `[0:27 to reply]` annotation on the turn line.
- The panel header keeps its collapse affordance but reads like a title bar:
  `hermes@cloudcomputer:~/chat` style, with the live count as `(N)`.
- The Hermes diagnostics section (`SEEING / INTERPRETING / ATTEMPTING / OBSERVING / LEARNING`
  + `PROVIDER / MODEL`, `CAPABILITIES`, `LATEST FAILURE`, `SAVED LESSONS`) becomes an aligned
  `key: value` block in the same monospace column — like `env` or `systemctl status` output —
  rather than a 2-up grid of bordered tiles.
- The controls (`PAUSE / RESUME / INSPECT / CLEAR / ROLLBACK`) become low-chrome text buttons
  that look like commands, still full-width-stacked in the broadcast layout.

Keep the existing palette (cyan `#00d4ff` / `#7ef0ff` accents, near-black `rgba(0,16,25,…)`
grounds, `#51f6a6` ok, `#ff7588` error, `#ffd56b` warn). This is a **typographic and layout**
redesign, not a recolor.

## Hard constraints

1. **Do not change any element `id`, existing class name, or DOM ordering that JS queries.**
   `src/youtubeHomepageInteraction.js`, `src/youtubeLive.js`, and the tests select on
   `#youtube-comments-list`, `#youtube-progress-list`, `#hermes-agent-card`,
   `#youtube-hermes-status`, `#youtube-hermes-detail`, `#hermes-agent-*`,
   `.youtube-agent-reply`, `.youtube-conversation-turn`, `.youtube-feed-text`,
   `.youtube-feed-meta`. Add classes; don't rename or drop them.
2. **`src/youtubeHomepageChat.test.mjs` asserts on the literal text of `style.css`** — it
   regex-matches specific rules (see lines ~600-651: the stacked `#youtube-comments-panel
   #hermes-agent-card` column rules, the `.hermes-agent-mind` / `.hermes-agent-details` /
   `.hermes-agent-controls` column rules, the `#hermes-agent-lessons` wrapping rule, and the
   `#admin-stamp-stack … .youtube-chat-cards` `minmax(14rem, 42dvh)` / `minmax(18rem, 50dvh)`
   grid). Those rules encode real broadcast-layout requirements. Preserve the declarations the
   tests match, or change the test in the same commit **only** with a stated reason for why the
   layout invariant no longer applies.
3. **Feed honesty is unchanged.** `loading` / `lastUpdate` / `error` / `unavailable` states must
   still be visually distinct. A never-answered source is not `0`. Do not let terminal styling
   flatten `KEY REQUIRED` into `LOAD FAILED`.
4. **Accessibility survives.** `role="status"` + `aria-live="polite"` on
   `#youtube-chat-activity`, `#hermes-agent-status`, `#youtube-hermes-status`,
   `#youtube-progress-status`, `#youtube-comments-status` stay. Sigils and cursors are
   decorative — `aria-hidden="true"`. Contrast must stay legible in a 720p stream capture.
5. **Both skins.** The panel renders in the normal rail *and* under `#admin-stamp-stack`
   (broadcast composition) *and* has a `.collapsed` state and a `body.recording-mode` /
   `body.ui-clean-view` variant. All must stay coherent.
6. Scoped to `index.html` + `style.css` + presentational bits of
   `src/youtubeHomepageInteraction.js`. No new dependency, no CSS framework, no component CSS
   file — the project is one stylesheet, vanilla JS, 2-space indent, single quotes, semicolons.

## Deliverable

1. The redesign applied in-tree.
2. `npm test` green, `npm run build` green.
3. `npm run test:track` green against an already-running `:4173` (start it yourself; the QA
   harnesses do not start a server).
4. Screenshot evidence via `node scripts/qa-<name>.mjs --url http://localhost:4173` for the
   normal rail and the `#admin-stamp-stack` layout. Do not judge a screenshot unless the
   report says `tilesSettled: true`.
5. Docs updated in the same change: `docs/CURRENT-STATE.md` (what the panel does now) and
   `CHANGELOG.md` (user-facing delta).
6. Do not leave one-off driver scripts, `qa-shots/`, or `.gev-*` artifacts in the tree.

Before you start, read `docs/CURRENT-STATE.md` — it is the source of truth for current runtime
behavior — and open the panel in the running app so you are redesigning what actually renders,
not what the markup suggests.
