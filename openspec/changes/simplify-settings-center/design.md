## Context

The settings dialog currently has sixteen direct categories plus a history portal. It mixes user preferences, feature-management workspaces, read-only product information, developer integrations, and unfinished controls in one navigation. Several values in `useUserPreferences` have no renderer consumer outside their settings section, while other concepts are configured in multiple places.

The change spans navigation, preference presentation, AI-profile mapping, feature routes, MCP progressive disclosure, and migration of stored client preferences. Existing server APIs and stored data are usable and should remain compatible.

## Goals / Non-Goals

**Goals:**

- Make every primary setting understandable in terms of a user-visible outcome.
- Reduce direct settings destinations to Account, AI, Mail, Notifications, Appearance, and About.
- Put technical integrations and diagnostics behind an Advanced entry.
- Remove false, duplicate, unfinished, and contextual controls from the primary settings experience.
- Preserve existing account, AI-profile, digest, writing-style, automation, MCP, and preference data.
- Keep old settings links useful through explicit destination mapping.
- Add tests proving that every visible mutable setting has a real runtime consumer.

**Non-Goals:**

- Redesigning the underlying mail, AI, automation, digest, or MCP services.
- Deleting legacy preference fields or stored user data.
- Implementing full application internationalization, Gmail key bindings, custom shortcuts, or multi-account support.
- Changing MCP authorization, token, session, tool, or confirmation semantics.
- Introducing a new settings backend or external dependency.

## Decisions

### 1. Use outcome-based eligibility for primary settings

A control is eligible for the primary settings UI only when it changes an implemented, user-observable behavior; the choice is expected to persist across contexts; and a safe default cannot satisfy nearly all users.

Read-only diagnostics, planned features, feature CRUD, and controls without consumers do not qualify. This is preferred over retaining disabled or “coming soon” controls because placeholders create false expectations and increase scanning cost.

### 2. Reduce navigation and use progressive disclosure

The direct navigation becomes:

1. Account
2. AI
3. Mail
4. Appearance
5. About

Notifications appears between Mail and Appearance only when at least one channel is wired to a real application event. Advanced settings are opened from a secondary disclosure near About and contain AI service configuration, MCP/WeCLI integrations, Data & Privacy, and diagnostics. Advanced subsections are not mixed into the primary list.

### 3. Move feature management to the feature context

Automation-rule CRUD moves to a dedicated product route. Writing-style CRUD is reached from the compose style picker. Digest scheduling is managed in Summary Center. Action Center, Summary Center, and learning history remain product destinations rather than settings children.

Settings may contain a compact status and a link to these destinations, but SHALL NOT embed their full management UI.

### 4. Present one compact AI preference model

The AI page exposes:

- response style using a small preset set,
- one default output language whose default is “follow the message,”
- one optional natural-language “other requirements” field,
- personalization status and a reset action behind secondary disclosure.

The UI does not expose Markdown terminology. It derives the user identity from the current account sender name.

For compatibility, the preference adapter continues to use the existing AI-profile API. A selected output language writes the legacy summary, todo, and compose language fields consistently; “follow the message” clears them. Response-style presets map to `assistantPreference`. Existing `customInstructions` content remains editable under “other requirements.” Existing `userDisplayName` data remains stored but is no longer separately edited.

### 5. Keep model configuration compatible but advanced

Managed or already configured users see only AI service readiness in the primary AI page. Base URL, secret replacement, discovery, default model, and per-capability routing remain available in Advanced for BYOK and local deployments.

No API or secret-storage behavior changes. A compact setup flow leads with provider connection and uses per-capability routing only after an explicit “custom model routing” disclosure.

### 6. Simplify account identity and usage

The current account header and connected-mailbox row are combined into one identity card. Sender-name editing is the primary account action; mailbox replacement is a secondary destructive action. Disabled multi-account UI is removed until multi-account support exists.

AI usage shows a user-meaningful total and range. Processor versions, model identifiers, and category internals move to a diagnostics disclosure. Manual refresh is removed when query invalidation already keeps the view current.

### 7. Treat secure defaults as product behavior

Tracker blocking and link-safety checks are secure defaults, not global opt-out switches. Any future exception is contextual to the message or domain and must explain its consequence at action time.

The existing stored values are preserved during migration but no unsupported security promise is shown.

### 8. Preserve storage but correct product copy

Removing a control from the UI does not delete its local or server value. Legacy deep links map to the new location or the relevant product route. Unknown section values fall back to Account and may show a non-blocking migration notice.

Data & Privacy copy is derived from the actual retention constants or a shared policy description so Storage and About cannot contradict each other.

### 9. Make MCP an advanced integration with two layers

The first layer shows enablement, connection status, and a guided copyable client configuration. Port selection, endpoint details, token lifecycle metadata, sessions, pending operations, and tool catalog appear in a diagnostics disclosure.

This preserves expert control and all secure-mail-mcp requirements while preventing ordinary users from encountering tokens, ports, and protocol state during routine settings use.

### 10. Enforce truthfulness through tests

Tests shall cover both UI visibility and runtime effect. A preference control cannot be added merely because it can be persisted; its feature consumer must be exercised by a focused test. Planned features are represented in product planning, not as disabled settings.

## Risks / Trade-offs

- **Risk: Expert users perceive lost control** → Preserve technical controls in Advanced and provide stable direct links.
- **Risk: Existing bookmarks target removed sections** → Add a typed legacy-section destination map and route tests.
- **Risk: Moving automation and style management expands scope** → Reuse existing management components in new contextual shells rather than rewrite their behavior.
- **Risk: Legacy AI fields can diverge** → Centralize mapping in one adapter and test read/write migration from existing profiles.
- **Risk: Hidden security controls remove user agency** → Keep secure defaults, document behavior in Data & Privacy, and design contextual exceptions separately if evidence requires them.
- **Risk: Simplified usage hides debugging information** → Keep diagnostic details available under Advanced without presenting them as routine account decisions.

## Migration Plan

1. Add the new section identifiers, legacy destination map, and reduced navigation while retaining legacy components behind temporary internal routes.
2. Build the consolidated Account, AI, Mail, Notifications, Appearance, About, and Advanced surfaces.
3. Rehost automation, writing-style, digest, and history management in contextual destinations and update all inbound links.
4. Remove unsupported controls from navigation, preserving stored data and server contracts.
5. Correct retention/privacy copy and add consumer-backed settings tests.
6. Remove now-unused settings-only components after route and regression coverage passes.

Rollback is UI-only: restore the previous navigation and component routing. No data migration must be reversed because existing APIs and stored values are retained.

## Open Questions

- Whether AI usage should remain visible to all users or only when usage affects quota or cost.
- Whether the product distribution will offer a managed AI provider; this determines how prominent BYOK setup remains.
- Whether “Automation” should be a permanent primary-sidebar destination or a secondary workspace reached from application messages.
- Whether a future secure per-domain remote-image exception is required after tracker blocking is fully wired.
