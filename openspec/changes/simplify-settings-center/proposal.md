## Why

WeMail currently exposes implementation details, incomplete controls, duplicate concepts, and operational feature pages as first-class settings. Some preferences are persisted but not consumed by the product, which creates false expectations and makes it harder for users to understand the few decisions they actually need to make.

## What Changes

- Reduce the primary settings navigation to Account, AI, Mail, Appearance, and About, showing Notifications only when at least one notification channel is actually delivered, with an Advanced area for technical integrations and diagnostics.
- Merge the duplicate account identity surfaces, retain sender-name editing and mailbox replacement, and remove disabled multi-account affordances until the capability exists.
- Replace “Custom AI” with a concise “AI preferences” experience based on predictable outcomes: response style, one default output-language choice, and an optional natural-language instruction field.
- Move provider credentials, endpoint configuration, model routing, MCP, WeCLI, retention details, and diagnostics behind progressive disclosure in Advanced settings.
- Move automation rules, writing-style management, action history, digest history, and AI learning history out of settings and into their relevant product workflows.
- Remove or hide settings that are incomplete, have no runtime consumer, duplicate another control, or merely advertise planned work.
- Keep secure behavior enabled by default rather than asking users to weaken tracker and link protections globally.
- Simplify digest controls so manual summaries remain available without configuration and scheduled summaries expose only user-meaningful choices.
- Correct retention and privacy copy so every surface reflects actual product behavior.
- Add legacy-section routing so old settings links open the replacement destination instead of silently failing.
- **BREAKING**: Direct settings categories for automation rules, writing styles, history centers, language stubs, shortcut stubs, storage, security, MCP, and low-level model routing are removed or relocated.

## Capabilities

### New Capabilities

- `settings-information-architecture`: Defines the reduced navigation, progressive disclosure, truthful-control rules, contextual management links, legacy routing, and simplified Account, AI, Mail, Notifications, Appearance, Data & Privacy, and About surfaces.

### Modified Capabilities

- `secure-mail-mcp`: Changes the live MCP management UI from a primary settings category to an advanced integration flow with simple setup first and diagnostics available on demand.

## Impact

- Primary renderer areas: `app/components/settings`, `useUIStore`, settings deep links, compose style management, digest and automation navigation, notification preferences, and theme selection.
- Preference storage: legacy values remain readable during migration, but controls without runtime behavior are no longer presented as active settings.
- Server APIs remain compatible; no mailbox, AI-profile, digest, MCP, or retention data is deleted.
- Tests must cover navigation reduction, legacy redirects, truthful visibility of implemented settings, AI preference mapping, contextual management links, and advanced MCP access.
