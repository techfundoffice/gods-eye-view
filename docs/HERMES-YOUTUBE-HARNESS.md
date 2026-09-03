# Hermes YouTube comment harness

Nous Research Hermes Agent is the default interpreter for verified YouTube Live comments. It operates the visible globe through the view-safe GEV MCP catalog. The existing OpenRouter interpreter remains the fallback.

## What viewers get

1. A comment on the live chat starts **one** Hermes turn (author, text, broadcast id, current view).
2. Hermes may chain camera / layer / preset / search / track / overlay / display tools.
3. The capture page runs each tool through the existing GEV action runner and returns the real view.
4. The same final reply appears on the overlay and is posted back to that live chat (at most once).

## ADMIN

Plugin: **Youtube AI Comment Harness**

- Harness selector: **Hermes** (default) or **OpenRouter** (explicit fallback)
- Start / Stop Hermes
- Redacted status: ready, active turn, timeout, last error
- If Hermes preflight fails, ADMIN shows why and temporarily uses OpenRouter. That fallback is **not** saved as the new default.

## Persistent runtime

- Canonical executable: `.hermes/hermes-agent/venv/bin/hermes`
- Pinned release metadata: `hermes-runtime.lock.json`
- Idempotent restore: `bash scripts/install-hermes.sh`
- `scripts/dev-replit.sh` exports `HERMES_HOME` and `HERMES_BIN` to the
  workspace paths and restores the pinned runtime before starting Vite.
- The application never resolves Hermes from `/home/runner/.local/bin`.
  Replacing the runner home overlay therefore does not remove the runtime.

## Secrets (Replit)

- `OPENROUTER_API_KEY` — inference credential used by the real Hermes CLI
- `HERMES_BIN` — optional explicit override; the default is the persistent workspace runtime
- MCP API keys minted in ADMIN → MCP Server stay server-side. They never appear in HTML, public JSON, bridge frames, or logs.

## Profile and skill

- Profile name: `gev-youtube`
- Skill: `skills/gods-eye-view/SKILL.md` (version `1.1.0`, versioned with this repo)
- Startup reads that file and compares every backticked GEV tool name to the live view-safe catalog (`gevMcpToolDefinitions` / MCP `tools/list`). Missing names fail preflight. ADMIN MCP tools (`list_admin_plugins`, plugin builder) stay out of the YouTube path.

## Preflight

Hermes starts only when all of these pass:

- GEV skill file readable
- View-safe GEV catalog is non-empty
- Persistent Hermes CLI is executable
- YouTube live authorization is handled by the existing Go Live / chat ingest path

## Recovery

| Symptom | What to do |
|---|---|
| ADMIN shows skill missing | Confirm `skills/gods-eye-view/SKILL.md` is deployed |
| MCP disconnected | Enable MCP Server and mint a key; do not paste it into chat |
| Hermes runtime missing | Run `bash scripts/install-hermes.sh`; startup also restores it automatically |
| Hermes crash | ADMIN → Stop / Start. In-flight turns cancel and are not replayed |
| YouTube reply failed | Overlay still shows the reply; ADMIN last-error is redacted; globe actions are not repeated |
| Want the old path | Select OpenRouter in the harness dropdown (explicit override) |

## Out of scope for viewer turns

ADMIN, YouTube account/broadcast control, source code, shell, packages, deploy, credentials, messaging, cron, unrestricted network.
