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

## Secrets (Replit)

- `OPENROUTER_API_KEY` — model for the in-process Hermes worker when the Hermes CLI is not installed
- `HERMES_BIN` — optional path to the `hermes` CLI (`hermes -p gev-youtube`)
- MCP API keys minted in ADMIN → MCP Server stay server-side. They never appear in HTML, public JSON, bridge frames, or logs.

## Profile and skill

- Profile name: `gev-youtube`
- Skill: `skills/gods-eye-view/SKILL.md` (versioned with this repo)
- Startup copies/checks the skill and compares documented capabilities to the live GEV MCP catalog

## Preflight

Hermes starts only when all of these pass:

- GEV skill file readable
- View-safe GEV catalog is non-empty
- Hermes CLI **or** OpenRouter key present
- YouTube live authorization is handled by the existing Go Live / chat ingest path

## Recovery

| Symptom | What to do |
|---|---|
| ADMIN shows skill missing | Confirm `skills/gods-eye-view/SKILL.md` is deployed |
| MCP disconnected | Enable MCP Server and mint a key; do not paste it into chat |
| Hermes crash | ADMIN → Stop / Start. In-flight turns cancel and are not replayed |
| YouTube reply failed | Overlay still shows the reply; ADMIN last-error is redacted; globe actions are not repeated |
| Want the old path | Select OpenRouter in the harness dropdown (explicit override) |

## Out of scope for viewer turns

ADMIN, YouTube account/broadcast control, source code, shell, packages, deploy, credentials, messaging, cron, unrestricted network.
