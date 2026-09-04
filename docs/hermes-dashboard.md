# Hermes dashboard on Replit

The project uses the web dashboard bundled with its pinned Hermes Agent. It
does not install `nesquena/hermes-webui`, create a second Agent environment, or
replace the Hermes CLI used by the YouTube comment pipeline.

## Start and open it

The **Project** workflow starts two independently managed processes:

- **Start application** — the Cloud Computer AI.com globe on port 5000
- **Hermes dashboard** — the bundled dashboard on port 8000

Port 5000 remains the primary webview. To open Hermes, select port **8000** in
Replit Preview.

The first dashboard launch builds the bundled frontend if its build is missing.
Later launches reuse that build unless the pinned dashboard source changed.
The launch script never runs `hermes update` and never installs another Hermes
copy.

## Sign in

The dashboard binds to `0.0.0.0` so Replit Preview can reach it. Hermes requires
authentication for that bind and fails closed without it.

- Username: `admin` by default
- Password: the existing `ADMIN_PASSWORD` workspace secret
- Session signing: the existing `SESSION_SECRET` workspace secret

Set `HERMES_DASHBOARD_USERNAME` if a different username is desired. Do not put
the password or session secret in source files.

## Operate it

Start or restart the **Hermes dashboard** workflow from Replit. Stop that
workflow to stop only its foreground process.

From Shell, inspect the running bundled server with:

```bash
npm run hermes:dashboard:status
```

Hermes also provides `./bin/hermes dashboard --stop`, but that command stops
every detected Hermes dashboard and `serve` process. Prefer stopping the
Replit workflow so another intentional Hermes backend is not interrupted.

The dashboard uses the same project-local `HERMES_HOME` (`.hermes`) as the
existing Agent integration. Its Sessions page therefore reads the existing
session database, including automation sessions. Dashboard chat is an
additional caller of the same Agent; it is not routed through the YouTube
training-priority and viewer-admission gate, so operators must not use it to
circumvent an active training task.

## Production boundary

This is a development-workspace service. The current Reserved VM deployment
publishes only the app on port 5000. Public production access to the dashboard
would require a separately reviewed reverse-proxy and authentication design;
this workflow does not change deployment behavior.