---
name: Cesium worker reconnects
description: Why transient Cesium geometry imports must not permanently stop rendering in Replit preview.
---

Treat a failed dynamic import under `/cesium/Workers/` as a bounded, recoverable preview transport interruption when the worker is otherwise being served.

**Why:** Replit preview proxy or Vite reconnects can interrupt Cesium's lazy geometry-module request. Cesium then stops its entire default render loop even though the asset becomes reachable again moments later.

**How to apply:** Keep WebGL and unrelated render errors fatal, but resume the render loop after a short delay for this exact worker-import signature, with a strict retry limit.