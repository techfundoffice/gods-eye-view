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

Other layers such as Cesium ion imagery/terrain, OpenAI voice control,
AISStream vessels, NASA FIRMS fires, and TomTom traffic are optional and remain
disabled or use their documented fallback behavior when their credentials are
not configured.

The globe requires a browser with working WebGL/GPU support. Some automated
preview or screenshot browsers expose WebGL but cannot initialize a Cesium
context; in that environment Cesium shows its standard WebGL error even though
the dev server and application configuration are healthy.

## Checks

```bash
npm run build
npm test
```