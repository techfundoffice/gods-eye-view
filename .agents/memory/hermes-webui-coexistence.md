---
name: Hermes WebUI coexistence
description: Constraints for adding Hermes WebUI without replacing the project’s Hermes Agent or bypassing viewer-work scheduling.
---

Keep one pinned Hermes Agent installation and point Hermes WebUI at that existing source tree and interpreter; disable WebUI’s automatic Agent installation and upgrades. Run WebUI as a separate foreground service with its own UI state and port.

**Why:** A contained upstream WebUI startup successfully reused the existing Agent environment and existing session schema, but a freshly initialized profile exposed a schema-compatibility warning. More importantly, WebUI embeds Agent execution in a separate process while YouTube invokes the CLI independently, so the current in-process training/viewer admission gate does not coordinate WebUI turns.

**How to apply:** Preserve the existing YouTube CLI wiring. Treat WebUI as an additional Agent caller, keep it away from YouTube-owned sessions unless a shared cross-process admission mechanism is added, and never let WebUI bootstrap replace or update the pinned Agent runtime.