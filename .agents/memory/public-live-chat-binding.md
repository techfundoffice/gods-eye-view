---
name: Public live-chat binding
description: Security boundary for exposing active YouTube chat to the unauthenticated globe homepage.
---

The public homepage chat feed must derive its video identity from the shared server-side live session. Never accept a client-selected video ID, provider continuation bootstrap data, OAuth material, or raw YouTube payloads.

Control ownership stays separate: ADMIN is the manual-operation console. The homepage chatbot reads YouTube comments and routes approved view requests through the God’s Eye View MCP endpoints. Viewer guidance may explain that path, but existing local and ADMIN controls stay available.

**Why:** The broadcast capture browser and public viewers do not have operator OAuth cookies. A server-owned binding lets them read the current show without turning the route into an arbitrary YouTube proxy or exposing credentials. The explicit ownership boundary prevents layout work from accidentally removing operator controls or creating a second comment interpreter.

**How to apply:** Return only bounded normalized comment fields and validated view intents. Keep writes, account controls, keys, tokens, and arbitrary video selection behind authenticated server routes. Bind public stream links and tickers to the same server-owned active broadcast.