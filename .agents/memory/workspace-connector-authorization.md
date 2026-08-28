---
name: Workspace connector authorization
description: Security and UX boundary for account-backed Replit connectors used by the app.
---

Replit-managed connector authorization and reauthorization must be completed in the workspace Integrations UI; application code can use a bound connector but cannot launch that OAuth flow itself. Without independent application authentication, keep account-scoped connector routes limited to the workspace preview rather than exposing them in a public deployment.

**Why:** A workspace connector represents the operator's account, not each visitor. Same-origin checks alone do not turn a public application visitor into the connector owner.

**How to apply:** For future account-backed connector features, either retain the single-operator preview boundary and provide honest in-app guidance, or add end-user application authentication plus per-user OAuth before enabling the feature publicly.