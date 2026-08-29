---
name: Admin plugin loading
description: How a generated ADMIN plugin gets from the builder's manifest into the dashboard menu, and the contract both halves must agree on.
---

The ADMIN plugin loop is closed: a plugin the builder writes appears in the
dashboard menu without a page reload.

**The contract, held in three places that must agree:**

- `buildPluginPrompt` (`src/adminPluginBuilder.js`) tells the agent to write
  `src/adminPlugins/<slug>.js` and register
  `{ id, label, module }` in `src/adminPlugins/manifest.json`.
- `GET /api/admin/menu` (`src/adminServer.js`) reads that file through
  `readPluginManifest`, normalizes it, and returns it. It re-reads per request,
  so a finished build needs no restart, and it sits behind the admin session
  like every other dashboard route.
- `src/adminPluginRegistry.js` turns entries into menu items: a module path
  must be a plain `.js` filename inside `src/adminPlugins/` (an absolute path,
  a `..` escape, or anything with a scheme is refused, not rewritten), and the
  module must default-export `{ id, label, description, render(container,
  context) }`. `render` may return a cleanup function, which the console runs
  when the operator leaves that menu item.

**Why:** The manifest is written by an agent into a checkout an operator can
also hand-edit, so every layer degrades instead of throwing — a bad entry costs
that one plugin its menu slot and nothing else. The registry deliberately
imports no `node:fs`, because both the browser console and the server route
share its normalization.

**How to apply:** Change all three together, and keep the console's menu
delegated (`this.root` click handler) rather than bound per button — generated
items are appended long after bind time. Related: [[cesium-preview-webgl]] for
what automated preview browsers can and cannot verify here.
