---
name: Cursor ACP isolation
description: Security boundary required when Cursor interprets untrusted viewer comments.
---

Do not treat `activeTools: []` on the stock Cursor ACP adapter as a tool-less runtime. It rejects native built-in filtering, and `HarnessAgent` cannot create an ACP session without a separate network sandbox provider.

**Why:** Viewer comments are untrusted, prompt instructions are not a security boundary, and running Cursor directly in the application process would expose the project and its credentials.

**How to apply:** For narrow untrusted-text classification, prefer a non-agent model API with no declared tools and strict output validation. Use ACP only with a deliberately provisioned external network sandbox, and keep the feature fail-closed otherwise.