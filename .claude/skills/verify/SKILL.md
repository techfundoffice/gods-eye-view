---
name: verify
description: Build, launch, and drive Cloud Computer AI.com in a real browser to observe a change working. Use when verifying UI or server-middleware changes at runtime rather than through tests.
---

# Verifying Cloud Computer AI.com at runtime

The app is a Vite dev server: the UI is `index.html` + `src/`, and every server
API (`/api/admin`, `/api/youtube`, the data proxies) is Vite middleware defined
in `vite.config.js`. There is no separate backend to start.

## Launch

```bash
npx vite --host 127.0.0.1 --port 4207        # pick a port; 5000 is the workflow's
```

No API keys are needed to reach the UI. Without `GOOGLE_MAPS_API_KEY` the globe
degrades but the DOM is fully driveable, and unkeyed data proxies log 503s in
the console — that noise is expected, not a regression.

Poll for readiness; a failing `curl` returns instantly, so a bare retry loop
spins without waiting:

```bash
until curl -s -o /dev/null -m 2 http://127.0.0.1:4207/; do sleep 1; done
```

## Browser

`puppeteer` is a devDependency but its bundled Chrome **will not run here** —
it is missing `libglib-2.0.so.0`. Use the box chromium instead:

```bash
CHROME=/repl/tools/bin/chromium
$CHROME --version    # stable wrapper path; prefer it over a /nix/store hash
```

This stable wrapper survives image updates. Do **not** glob `/nix/store/*chromium*`
to find a binary — that scan walks the whole store and can hang for minutes
before returning, which looks like the app is wedged when nothing is wrong.

`npm run test:track` and the `scripts/qa-*.mjs` harnesses resolve Chrome through
puppeteer, so they fail at launch with "Could not find Chrome" unless you point
them at that binary explicitly:

```bash
PUPPETEER_EXECUTABLE_PATH=/repl/tools/bin/chromium npm run test:track
```

It then boots and passes the init checks, but the independent-GLB capability
probe can still time out (`Runtime.callFunctionOn timed out`) under SwiftShader.
That is a headless-GPU limit, not an app regression — confirm against a baseline
before blaming a change.

Launch flags that work headless on this box:

```js
puppeteer.launch({
  headless: 'new',
  executablePath: process.env.CHROME_PATH,
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=1440,900'],
});
```

Driver scripts must live **inside the repo** (e.g. `.gev-drive.mjs`) so
`import puppeteer` resolves — a script in a temp dir cannot see
`node_modules`. Delete them afterwards; they are not repository content.

The box has ~8 GB and the user's own dev server is usually running. Close every
browser between scenarios and kill strays (`pgrep -f chromium`) — once free
memory drops under ~500 MB, launches fail with "Timed out waiting for the WS
endpoint" or 30 s navigation timeouts that look like app bugs but are not.

## The WebGL gate

`probeWebGLCapability()` in `src/main.js` runs at module scope and can stop
startup with a compatibility screen — headless browsers often fail it. The
ADMIN console is deliberately mounted **outside** that gate (`src/main.js`,
near `initAdminConsole()`), so admin flows are driveable headless even when the
globe never renders. Anything that needs the globe itself wants a GPU browser.

## Driving the ADMIN console

```bash
ADMIN_PASSWORD='verify-pass' npx vite --host 127.0.0.1 --port 4207
```

With no `ADMIN_PASSWORD`/`ADMIN_PASSWORD_HASH` every admin route answers 503
`unconfigured` — that is the intended closed state, not a failure. Then:
click `#admin-launch` → type into `#admin-password` → submit
`#admin-login-form` → wait for `#admin-dashboard` to unhide.

To exercise the plugin builder without spending a real agent turn, point it at
a stub that does what the agent is told to do (write
`src/adminPlugins/<slug>.js`, register it in `manifest.json`) and emits the
same stream-json (`system/init`, `assistant`, `result`):

```bash
ADMIN_AGENT_COMMAND=/path/to/fake-agent.sh npx vite ...
```

## Gotchas that cost time

- **Generated plugin modules import one at a time**, ~750 ms each cold through
  the dev server. The menu is empty until they finish, so a settle check that
  only asks "did the DOM stop changing" reports the *initial* empty state as
  settled. Wait for the expected item, or wait several seconds first.
- **Rewriting a plugin file the page already imported triggers a Vite full page
  reload** (`[vite] (client) page reload src/adminPlugins/x.js`), which closes
  the console mid-run. Creating a *new* file does not. Give each scenario its
  own browser, launched after the files are written.
- **Churning files under `src/` can stale the dep optimizer**: the page then
  fails with `504 (Outdated Optimize Dep)` and nothing boots, so `#admin-launch`
  looks inert. Restart the dev server.
- Buttons inside a hidden `[data-admin-pane]` are not clickable; switch to that
  pane first, the way an operator would.
