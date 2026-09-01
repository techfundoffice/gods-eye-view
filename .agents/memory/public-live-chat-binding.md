---
name: Public live-chat binding
description: Security boundary for exposing active YouTube chat to the unauthenticated globe homepage.
---

The public homepage chat feed must derive its video identity from the shared server-side live session. Never accept a client-selected video ID, provider continuation bootstrap data, OAuth material, or raw YouTube payloads.

Control ownership stays separate: ADMIN is the manual-operation console. The homepage chatbot reads YouTube comments and routes approved view requests through the God’s Eye View MCP endpoints. Viewer guidance may explain that path, but existing local and ADMIN controls stay available.

Public slash-command execution requires an exact verified-live binding at lease issue and result acceptance. A stop, unverified fallback, video/generation change, executor rotation, or capture-epoch change must atomically cancel nonterminal work; persisted work is cancelled rather than replayed after restart.

**Why:** The broadcast capture browser and public viewers do not have operator OAuth cookies. A server-owned binding lets them read the current show without turning the route into an arbitrary YouTube proxy or exposing credentials. Checking only when a comment is admitted leaves a race where queued or executing work can survive verified-to-unverified transitions.

**How to apply:** Return only bounded normalized comment fields and validated view intents. Keep writes, account controls, keys, tokens, and arbitrary video selection behind authenticated server routes. Bind public stream links and tickers to the same server-owned active broadcast. Reconcile command state before status, lease, and result handling; authenticate the capture browser out-of-band on exact loopback executor routes.