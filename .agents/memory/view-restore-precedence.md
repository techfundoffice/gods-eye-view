---
name: View restore precedence
description: Durable startup ownership rules for shared, locally saved, and default globe views.
---

Use this startup order: a valid explicit share URL, then a valid versioned local whole-view snapshot, then Google 3D above Los Angeles. Continuous state changes persist locally and must not rewrite the address; copied links remain the explicit sharing mechanism. A restored view suppresses Mission Control unless `welcome=1` explicitly requests it, while `welcome=0` always suppresses it.

**Why:** Rewriting the URL on every camera change made an ordinary reload indistinguishable from opening a shared view, and Mission Control could cover the very state the operator intended to restore.

**How to apply:** Reuse the share codec for local snapshots so camera, visual, map-stack, layer, and panel state cannot drift into separate schemas. Reject malformed or out-of-range snapshots and fall through to the LA/Google 3D default.