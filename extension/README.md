# Cloud Computer AI.com Chrome extension

This Manifest V3 extension gives a viewer-local Chrome tab a safe bridge from
YouTube live chat to Cloud Computer AI.com. It does not control a browser remotely,
read credentials, run arbitrary JavaScript, or navigate to arbitrary URLs.

## Install for local development

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension/` directory.
4. Open a YouTube live chat and a Cloud Computer AI.com tab on an allowed Replit/local origin.
5. Open the extension popup, choose the Cloud Computer AI.com tab, enable the bridge, and use
   **Pause** or **STOP** whenever needed.

The extension starts disabled. Only recognized, bounded commands are forwarded:

- `/help`
- `/live-contacts`
- `/space-missions`
- `/environmental`
- `/explore-manually`
- `/gods-eye-view`
- `/x globe`
- `/x zoom in little`
- `/x zoom out medium`
- `/x location Tokyo`
- `/z fly to San Francisco`

Ordinary chat remains ordinary chat. The Cloud Computer AI.com page still runs every action
through its existing validated action runner.