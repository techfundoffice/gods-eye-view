---
name: Admin password precedence
description: How the ADMIN credential resolver should behave when hash and plaintext environment values coexist.
---

A valid `ADMIN_PASSWORD_HASH` takes precedence, but a malformed or dotenv-corrupted hash must fall back to `ADMIN_PASSWORD` when one is configured.

**Why:** dotenv expansion and stale workspace variables can leave an invalid hash beside a valid local password; treating the invalid hash as terminal makes ADMIN appear to reject every password.

**How to apply:** Validate the hash first, warn without exposing credential contents, and only mark ADMIN unconfigured when neither a valid hash nor a password fallback exists.