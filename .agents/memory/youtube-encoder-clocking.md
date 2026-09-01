---
name: YouTube encoder clocking
description: Stable FFmpeg settings for a Chromium screencast and public discovery of an auto-started broadcast.
---

For DevTools JPEG frames piped to FFmpeg, use FFmpeg real-time input pacing (`-re`) in addition to application-side frame cadence. Match YouTube's standard H.264/AAC contract: 30 fps, CBR, a two-second GOP, YUV420p, and explicit stereo audio.

**Why:** A standards-compliant generated test stream stayed connected with the same key and ingest host, proving account and destination validity. The unpaced image pipe connected briefly and was then closed; adding FFmpeg pacing made the real globe stream stable.

**How to apply:** Isolate ingest problems with a generated H.264/AAC reference stream before blaming credentials or another encoder. If an old video was deleted, resolve the channel handle's `/live` page and use its canonical watch URL for the replacement broadcast.