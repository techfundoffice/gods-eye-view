---
name: Detached Vite port ownership
description: A manually backgrounded Vite dev server can outlive the managed workflow and claim port 5000.
---

A failed managed Vite workflow may be caused by an older manually detached `npm run dev` process still owning port 5000.

**Why:** The managed workflow cannot start while that independent process remains, even when the workflow itself is marked failed.

**How to apply:** Before changing application code for a port-in-use failure, inspect process ownership and stop only the detached development-server process tree; leave unrelated build processes running.