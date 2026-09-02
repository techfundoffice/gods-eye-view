---
name: Public live-chat binding
description: Security boundary for exposing active YouTube chat to the unauthenticated globe homepage.
---

The public homepage chat feed must derive its video identity from the shared server-side live session. Never accept a client-selected video ID, provider continuation bootstrap data, OAuth material, or raw YouTube payloads.

Control ownership stays separate: ADMIN is the manual-operation console. The homepage chatbot reads YouTube comments, sends approved commands through the server-side public AI interpreter, and delivers validated GEV tool calls to the visible page action runner. The private capture executor remains a separate path.

Only the newest comment from each feed update starts a public agent turn. The visible page must supply a bounded current-view snapshot before initial interpretation, and should supply an updated snapshot with the tool result before continuation. Older comments remain displayable but must not create a replay flood.

Public slash-command execution requires an exact verified-live binding at lease issue and result acceptance. A stop, unverified fallback, video/generation change, executor rotation, or capture-epoch change must atomically cancel nonterminal work; persisted work is cancelled rather than replayed after restart.

**Why:** The broadcast capture browser and public viewers do not have operator OAuth cookies. A server-owned binding lets them read the current show without turning the route into an arbitrary YouTube proxy or exposing credentials. Checking only when a comment is admitted leaves a race where queued or executing work can survive verified-to-unverified transitions. Interpreting before the visible runner supplies context makes the model reason about a stale or imaginary view; replaying a whole retained chat window can trigger old comments after restart.

**How to apply:** Return only bounded normalized comment fields and validated view intents. Keep writes, account controls, keys, tokens, and arbitrary video selection behind authenticated server routes. Bind public stream links and tickers to the same server-owned active broadcast. Reconcile command state before status, lease, and result handling; atomically claim deferred comments before model work, pass the current view at lease time, and authenticate the capture browser out-of-band on exact loopback executor routes.