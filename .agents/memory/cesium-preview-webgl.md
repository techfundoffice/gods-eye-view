---
name: Cesium preview WebGL
description: Environment-specific behavior when validating the Cesium globe in automated Replit previews.
---

Automated preview or screenshot browsers can report WebGL support while still
failing to provide the capabilities Cesium needs. The app intentionally gates
startup on a usable context with vertex texture fetch support and shows a
compatibility screen when that gate fails.

**Why:** The preview browser may not have a usable GPU-backed WebGL context,
even though a normal user browser can render the globe.

**How to apply:** Treat the compatibility screen as the expected automated
preview result, verify the workflow and HTTP response separately, and validate
the full globe in a GPU-enabled browser.