---
name: Capture-only agent transport
description: Security and reliability rules for browser-executed multimodal agent turns.
---

Multimodal agent leases, validity checks, and results must form one capture-only transport: the trusted capture browser is the caller, every route shares its rotating credential boundary, and in-flight work is cancellable. Idle executor leases need the same continuous validity monitoring as viewer-agent leases.

**Why:** Securing only the server routes can make the real capture caller unable to reach them, while leaving body limits or cancellation on an older path breaks visual turns or allows idle work to outlive viewer preemption. Replit may expose one development app through both stable and session-suffixed hostnames; exact host matching can strand the trusted browser on the external origin where loopback credential injection cannot run.

**How to apply:** When changing this transport, review credential injection, capture-page routing, lease/result payload budgets, active-lease checks, and action cancellation as one contract. Normalize only same-project Replit hostname variants to loopback, verify the capture page's actual origin, and test media-bearing payloads in both directions.