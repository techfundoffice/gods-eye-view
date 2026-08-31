---
name: Public live-chat binding
description: Security boundary for exposing active YouTube chat to the unauthenticated globe homepage.
---

The public homepage chat feed must derive its video identity from the shared server-side live session. Never accept a client-selected video ID, provider continuation bootstrap data, OAuth material, or raw YouTube payloads.

**Why:** The broadcast capture browser and public viewers do not have operator OAuth cookies. A server-owned binding lets them read the current show without turning the route into an arbitrary YouTube proxy or exposing credentials.

**How to apply:** Return only bounded normalized comment fields and validated view intents. Keep writes, account controls, keys, tokens, and arbitrary video selection behind authenticated server routes.