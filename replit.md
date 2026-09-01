# Running God's Eye View on Replit

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