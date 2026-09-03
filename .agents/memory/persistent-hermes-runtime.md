---
name: Persistent Hermes runtime
description: Durability and watcher constraints for running the real Hermes CLI on Replit.
---

Keep the pinned Hermes checkout and virtual environment on the persistent
workspace filesystem, resolve it independently of `HOME` and `PATH`, and fail
closed when the real executable or provider is unavailable. Never label an
in-process model fallback as Hermes.

**Why:** The runner home overlay can be replaced while the workspace survives.
Placing a large source checkout under the workspace also makes Vite recursively
watch it unless both the runtime and package caches are explicitly ignored,
which can exhaust Linux file watchers and crash the preview.

**How to apply:** Pin the upstream source identity, provide an idempotent
workspace installer, run empty-`HOME` checks, and keep `.hermes` plus package
caches out of frontend watcher scope.