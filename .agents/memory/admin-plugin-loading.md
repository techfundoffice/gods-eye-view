---
name: Admin plugin loading
description: Open goal — generated admin plugins are written to disk but never loaded into the ADMIN dashboard menu.
---

**Goal: close the ADMIN plugin loop so a built plugin actually appears in the
dashboard menu.**

`buildPluginPrompt` in `src/adminPluginBuilder.js` instructs the agent to write
`src/adminPlugins/<slug>.js` and register it in
`src/adminPlugins/manifest.json`, and `ADMIN_MENU_ITEMS` in
`src/adminConsole.js` is documented as "Generated plugins are appended after
these at runtime". Nothing reads that manifest: `ADMIN_PLUGIN_MANIFEST` has no
consumer, `adminConsole.js` contains no dynamic `import()`, the menu is a frozen
two-item list (`create-plugin`, `mcp-server`), and `src/adminPlugins/` does not
exist yet. A successful build therefore produces files the operator can only see
in the repository, never in the console that ordered them.

Done means: the manifest is discovered and its modules loaded (guarding a
missing/corrupt manifest and a module that fails to import), each entry renders
through the documented `{ id, label, description, render(container, context) }`
contract with its cleanup function honored on menu switch, the menu refreshes
after a build reaches `ready` without a full page reload, and the loader is
covered by a `src/adminPlugins*` unit test that `discoverUnitTestFiles` picks up.

**Why:** The plugin builder is the ADMIN console's headline feature and the one
the MCP endpoint exposes externally (`create_admin_plugin`), so the missing
loader is the difference between the feature working and the feature only
appearing to work.

**How to apply:** Treat the manifest contract in `adminPluginBuilder.js` as
fixed — the agent prompt, the console loader, and any test fixture must agree on
the same entry shape — and keep the loader failure-tolerant in the same spirit
as `createAdminStore`, which degrades to defaults rather than breaking startup.
See [[workspace-connector-authorization]] for the surrounding rule that
operator-scoped surfaces stay behind real authentication before they are exposed
publicly.
