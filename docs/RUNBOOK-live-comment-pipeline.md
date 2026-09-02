# Runbook — verifying the live comment pipeline on Replit

Proves that a YouTube comment moves the globe, and that it does so **using the
model selected in ADMIN**. Unit tests cover the wiring; this covers the path.

Six hops. Each has one observable and its own failure signature, so a stall
tells you which hop broke instead of leaving you guessing.

```
comment → ingest → registered → interpreting → model call → dispatched → globe moves
  H1        H1         H2           H3            H4           H5          H6
```

---

## Setup

Replit → Tools → Secrets:

| Secret | Why | Without it |
|---|---|---|
| `ADMIN_PASSWORD_HASH` (or `ADMIN_PASSWORD`) | Unlocks the ADMIN console | Console 503s `unconfigured` — intended closed state, but you cannot reach the pane |
| `GOOGLE_MAPS_API_KEY` | Photoreal globe | Globe never renders; ADMIN still mounts (it sits outside the WebGL gate) |
| `OPENROUTER_API_KEY` | Model calls | Can be set through the ADMIN pane instead |
| `YOUTUBE_CHANNEL_HANDLE` | Only if not `TechfundOffice` | Ingest looks at the wrong channel |

Run: `HOST=0.0.0.0 PORT=5000 bash scripts/dev-replit.sh`

You need an **actual live broadcast** on the channel with chat enabled. Ingest
discovers it from the public `/live` page — there is no way to point it at a
video by hand, by design.

---

## H0 · Pre-flight: does the selected model resolve? (no stream needed)

Do this first. It isolates the model-selection half of the change from all the
YouTube machinery, and takes ten seconds.

1. Open ADMIN → **OpenRouter**.
2. Confirm the status line reads `PRESENT · admin · <model>` (or `· env ·`).
3. The **Model** dropdown should show `Free Models Router · FREE` by default.
4. Switch it to `Gemini 2.5 Flash · PAID`. The message line should read
   `Model set to google/gemini-2.5-flash.`
5. Click **TEST**.

**Expected:** `HTTP 200 · google/gemini-2.5-flash` — the model string comes back
from OpenRouter's own response, so this is proof the selection reached the
provider, not just the database.

| Failure | Means |
|---|---|
| `Test failed · HTTP 401` | Key is wrong or has no credit |
| `Test failed · HTTP 402` | Paid model with no balance — the Gemini entries are all paid |
| Reports a model you did **not** select | Resolution order is broken. An ADMIN selection outranks `OPENROUTER_MODEL`, so a mismatch here is a real bug — capture it and stop |
| `HTTP 503 OPENROUTER_API_KEY is not set` | Neither admin store nor env has a usable key |
| Dropdown missing entirely | This build predates the change |

Reload the page and confirm the dropdown still shows Gemini — that proves the
value persisted rather than living in page state.

---

## H1 · Comment reaches ingest

Post a comment in the live chat. Then:

```
GET /api/youtube/homepage-chat/feed
```

**Expected:** `active: true`, `status: "live"`, `commandsEnabled: true`, and your
comment in `items[]`.

| Failure | Means |
|---|---|
| `status: "offline"` | Channel isn't live, or the `/live` page didn't parse |
| `status: "ended"` | Broadcast finished; ingest cleared the stream |
| `status: "unavailable"` + `error.kind` | InnerTube upstream problem — read `error.message` |
| `active: true` but `items` empty | Chat continuation never seeded; wait one poll (2–15 s) |
| `commandsEnabled: false` while live | Not verified-live — no command will ever register |

---

## H2 · Comment is registered

Same response, `commands[]` array.

**Expected:** a row with your `commentId`, `command: "viewer-request"`,
`state: "received"` (it may already have advanced past this).

**Test the batch fix here.** Post **three comments within one poll window**
(~2–15 s). All three must appear as separate rows.

| Failure | Means |
|---|---|
| Only the newest of the three appears | The `items.at(-1)` bug is still live — this build doesn't have the fix |
| Comment in `items` but no row in `commands` | Registration gate; check `commandsEnabled` |
| Duplicate rows for one comment | Ledger uniqueness broken — should be impossible |

Ledger on disk: `.local/youtube-public-command-ledger.json`

---

## H3 · Interpreting, and the model is called

The **homepage must be open in a browser** — it polls
`/api/youtube/homepage-chat/agent/lease`, and that poll is what drives
interpretation. Nothing advances with no viewer.

**Expected:** the row moves `received` → `interpreting` → one of
`awaiting-execution` (tool call), `succeeded` (prose reply), or `deferred`.

**Confirm the model:** open the OpenRouter dashboard → Activity. The request
should name the model you selected in H0. This is the definitive check that
ADMIN selection reaches the live comment path.

| Failure | Means |
|---|---|
| Stuck at `received` | Nobody is leasing — homepage not open, or the agent loop isn't running |
| `state: "deferred"`, reason `Upstream rate limit — queued for retry` | **Working as designed.** Note `retryAt`; it should resume on its own |
| `state: "failed"` | Interpreter error — the `reason` field names it |
| `state: "rejected"` + a validation reason | Model returned a malformed or disallowed tool call |
| Activity shows a different model than selected | Resolution order is broken — capture and stop |
| Nothing in Activity at all | Request never left; key unresolved |

---

## H4 · Action dispatched

**Expected:** `awaiting-execution` → `executing`, then the browser POSTs to
`/api/youtube/homepage-chat/agent/result` and the row reaches `succeeded`.

| Failure | Means |
|---|---|
| Stuck `awaiting-execution` | Lease issued but never redeemed — the runner isn't consuming it |
| `cancelled` · "Verified live binding changed" | The broadcast or generation changed mid-flight; re-test |
| `cancelled` · "Stored tool failed revalidation" | Tool args stopped validating between lease and result |

---

## H5 · The globe moves

**Expected:** the camera flies. In DevTools:

```js
window.__godsEyeView.viewer.camera.positionCartographic
```

Read it before and after; latitude/longitude should change.

**The failure that matters most:**

| Failure | Means |
|---|---|
| `succeeded` with a prose `answer`, globe never moved, and the row **never passed through `awaiting-execution`** | **The model replied in prose instead of calling a tool.** This is the tool-calling failure the allowlist exists to prevent. If it happens with an allowlisted model, that model's tool support is not what the catalog claims — report it, don't work around it |
| Row `succeeded` after `executing`, but no visible movement | Tool ran and the camera verb didn't take — a client-side problem, not a model one |
| Globe moves for `/x` but not plain English | Expected: plain comments register as `viewer-request` in `execute` mode; slash commands take a narrower tool set |

---

## What good looks like, end to end

1. H0 TEST reports the model you picked.
2. Three comments posted together → three rows.
3. Each row: `received` → `interpreting` → `awaiting-execution` → `executing` → `succeeded`.
4. OpenRouter Activity names your selected model.
5. Camera position changed.

## Deliberately exercising the deferral path

Free-tier accounts hit OpenRouter's own daily limit. When you do, the correct
observable is a `deferred` row with a future `retryAt` that **later resumes** —
not a red `rejected` row. If you see `rejected` with reason
`OpenRouter free rate limit`, this build predates the fix.

Restarting the app mid-deferral is worth testing: deferred rows must survive
hydration and executor rotation. Every other non-terminal row becomes
`cancelled` on restart, which is correct.
