---
name: YouTube encoder handoff
description: Operational constraint for replacing an encoder without ending the public broadcast.
---

To preserve an existing YouTube watch URL, release the bound ingest slot before starting the replacement encoder. Stop the old publisher or reset the exact stream key it uses; do not transition the broadcast to `complete`.

**Why:** YouTube can accept the RTMP handshake and initial frames, then close both primary and backup publishers when another source still owns the live session or the supplied key is not the bound key. Completing the broadcast ends the reusable watch target.

**How to apply:** During upgrades, keep an automatic FFmpeg supervisor ready, release or rotate the old publisher first, and let the replacement connect to primary ingest. Use backup ingest only for a correctly bound backup stream, with the key placed before `?backup=1`.