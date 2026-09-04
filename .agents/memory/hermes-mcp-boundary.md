---
name: Hermes MCP boundary
description: Why viewer-facing Hermes uses live MCP discovery without bypassing the public command authorization pipeline.
---

Viewer-facing Hermes must obtain its current tool catalog from the existing Cloud Computer AI MCP server. Privileged and disabled tools are filtered before the catalog reaches the model.

Hermes-generated viewer actions must continue through the public command coordinator and executor rather than executing directly through MCP `tools/call`.

**Why:** Direct MCP execution would create a separate synthetic command and could bypass the active viewer owner, FIFO queue, generation binding, nonce redemption, and final browser-executor checks.

**How to apply:** Reuse the exact MCP server instance for `initialize` and `tools/list`; refresh enabled-tool filtering at prompt time. Route the selected action through the existing viewer command lifecycle. Keep owner/admin Hermes authority separate.