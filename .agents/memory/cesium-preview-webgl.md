---
name: Cesium preview WebGL
description: Environment-specific behavior when validating the Cesium globe in automated Replit previews.
---

Automated preview or screenshot browsers can report WebGL support while still
failing to create the WebGL context Cesium needs. Treat Cesium's
`Error constructing CesiumWidget` / `WebGL initialization failed` screen as a
preview-environment limitation when the dev server is healthy and application
configuration is otherwise valid.

**Why:** The preview browser may not have a usable GPU-backed WebGL context,
even though a normal user browser can render the globe.

**How to apply:** Verify the workflow and HTTP response separately, and
validate the full globe in a GPU-enabled browser rather than changing app
logic solely to accommodate the automated screenshot browser.