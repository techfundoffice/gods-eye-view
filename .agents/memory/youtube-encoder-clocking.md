---
name: YouTube encoder clocking
description: Stable FFmpeg settings for a Chromium screencast and public discovery of an auto-started broadcast.
---

For DevTools JPEG frames piped to FFmpeg, use FFmpeg real-time input pacing (`-re`) in addition to application-side frame cadence. Match YouTube's standard H.264/AAC contract: 30 fps, CBR, a two-second GOP, YUV420p, and explicit stereo audio.

**Why:** A standards-compliant generated test stream stayed connected with the same key and ingest host, proving account and destination validity. The unpaced image pipe connected briefly and was then closed; adding FFmpeg pacing made the real globe stream stable.

**How to apply:** Isolate ingest problems with a generated H.264/AAC reference stream before blaming credentials or another encoder. If an old video was deleted, resolve the channel handle's `/live` page and use its canonical watch URL for the replacement broadcast.

Starting FFmpeg with a saved stream key proves only ingest; it does not create, bind, or transition a public broadcast. Keep the authenticated broadcast transition independently retryable across app restarts and quota resets.

**Why:** A stable encoder sent thousands of frames while the public watch URL remained an archived video. Temporary retry shells disappeared on workspace restart, and repeated unclean restarts left orphaned FFmpeg/Chromium processes that exhausted the thread limit.

**How to apply:** Report “live” only after YouTube confirms the broadcast lifecycle or the public page is live. Before restarting a failed encoder stack, stop it through the controller and verify that only one FFmpeg and one Chromium capture tree remain.