# Running Cloud Computer AI.com on Replit

## Development

The Replit preview uses the `Start application` workflow:

```bash
HOST=0.0.0.0 PORT=5000 npm run dev
```

Dependencies are installed from `package-lock.json`, and the project uses the
Replit-provided Node.js 24 runtime.

## Required configuration

Set `GOOGLE_MAPS_API_KEY` as a Replit Secret before starting the app. The key
must have the Google Maps Platform Map Tiles API enabled and should be
restricted to the app's allowed referrers/APIs.

YouTube authorization is app-owned and must remain portable to a standalone VPS.
Do not add a Replit YouTube connector dependency. Operators connect YouTube from
ADMIN → Go Live using `YOUTUBE_OAUTH_CLIENT_ID`,
`YOUTUBE_OAUTH_CLIENT_SECRET`, `YOUTUBE_OAUTH_REDIRECT_URI`, and
`SESSION_SECRET`. Set `YOUTUBE_SESSION_PATH` to a durable VPS volume so the
encrypted refresh-token session survives process and host restarts.

Other layers such as Cesium ion imagery/terrain, OpenAI voice control,
AISStream vessels, NASA FIRMS fires, and TomTom traffic are optional and remain
disabled or use their documented fallback behavior when their credentials are
not configured.

The globe requires a browser with working WebGL/GPU support. Some automated
preview or screenshot browsers cannot initialize the WebGL features Cesium
requires. In that environment the app stops before globe startup and presents a
compatibility screen with browser/GPU troubleshooting steps. Open the preview
in a hardware-accelerated desktop browser for the full globe.

## Checks

```bash
npm run build
npm test
```

## Protected agent shells

Workspace launchers register Hermes, Claude, and Grok process trees so local
cleanup can refuse to terminate an agent or its owning shell:

```bash
hermes
bin/claude-protected
bin/grok-protected
bin/agent-process status
```

For a detached process that should restart after an unexpected exit:

```bash
bin/agent-process start --name hermes -- bin/hermes chat
bin/agent-process stop --name hermes
```

Use the guarded termination command for workspace cleanup:

```bash
bin/agent-process kill 1234
bin/agent-process kill --signal SIGKILL 1234
```

It refuses a target that is a protected process, contains one in its descendant
tree, or is an ancestor whose exit would also terminate one. The registry and
supervisor logs are stored under `.local/agent-processes/` and do not persist
command arguments, environment variables, or secret values. Foreground
launches use an isolated process group and retry once after an unexpected
nonzero exit. Detached sessions keep restarting until explicitly stopped.

This protects against accidental local cleanup only. It cannot prevent Replit
container replacement, host shutdown, out-of-memory termination, or a direct
privileged signal that bypasses the guarded command.