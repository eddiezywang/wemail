## 1. Navigation and Migration Foundation

- [x] 1.1 Replace the current settings section union and navigation groups with Account, AI, Mail, Appearance, About, and Advanced section identifiers.
- [x] 1.2 Add a typed legacy-section destination map for custom AI, AI summary, AI learning, automation, writing styles, inbox, compose, storage, security, MCP, notifications, shortcuts, language, and AI usage.
- [x] 1.3 Route feature-management legacy sections to their contextual product destinations and route unsupported or unknown sections safely to Account.
- [x] 1.4 Add navigation tests covering the reduced primary list, secondary Advanced entry, legacy destinations, and unknown-section fallback.

## 2. Account Simplification

- [x] 2.1 Combine the WeMail account header and connected-mailbox row into one active-mailbox identity card.
- [x] 2.2 Retain sender-name editing and mailbox replacement on the identity card while removing the unavailable add-mailbox affordance.
- [x] 2.3 Simplify AI usage to a user-facing total, range, and understandable category summary.
- [x] 2.4 Move model, processor-version, and detailed usage rows into an explicit diagnostics disclosure under Advanced.
- [x] 2.5 Update account tests for one-card identity, sender-name editing, mailbox replacement, usage defaults, and absence of disabled multi-account controls.

## 3. Consolidated AI Experience

- [x] 3.1 Add an AI-profile presentation adapter that maps response-style presets, one output-language choice, and optional natural-language requirements onto the existing profile contract.
- [x] 3.2 Build the consolidated AI page with service readiness, response style, “follow the message” language default, and optional other requirements.
- [x] 3.3 Preserve existing custom instructions and legacy profile fields when reading and saving the simplified form.
- [x] 3.4 Remove the separate user-display-name editor and derive AI identity from the current sender display name.
- [x] 3.5 Move Base URL, API key replacement, model discovery, default model, and per-capability routing into Advanced AI service settings.
- [x] 3.6 Present AI personalization status and reset actions through secondary disclosure without raw signal JSON in the primary page.
- [x] 3.7 Add tests for default AI behavior, legacy profile hydration, unified language writes, response-style mapping, advanced model access, and preservation of stored fields.

## 4. Contextual Feature Management

- [x] 4.1 Rehost the existing automation-rule list and form in a dedicated product destination without changing CRUD, dry-run, or execution semantics.
- [x] 4.2 Update application-message and legacy settings links to open the dedicated automation destination.
- [x] 4.3 Add a “manage styles” action to the compose style picker and rehost the existing writing-style editor in that context.
- [x] 4.4 Move daily-summary enablement and delivery-time controls into Summary Center.
- [x] 4.5 Remove manual-summary availability, inactivity thresholds, default window hours, and daily window mode from user-facing settings while preserving their safe defaults.
- [x] 4.6 Remove Action Center, Summary Center, and Learning Center from settings navigation and retain them as product destinations.
- [x] 4.7 Add browser tests for automation, writing-style, digest, and history destination migrations.

## 5. Mail, Appearance, and Notification Truthfulness

- [x] 5.1 Build the Mail page around the implemented per-account signature preference and verify compose uses changes immediately.
- [x] 5.2 Remove inbox density, threading, reading-pane, and send-shortcut controls until runtime consumers exist.
- [x] 5.3 Remove tracker-pixel and link-safety switches while keeping secure behavior as the product default.
- [x] 5.4 Audit desktop notification, sound, and digest preference consumers; expose Notifications only for channels proven to deliver real events.
- [x] 5.5 Remove the duplicate daily-digest notification preference and use Summary Center as the single scheduled-summary control.
- [x] 5.6 Localize Appearance and reduce theme choices to supported product themes with “follow system” as the default where available.
- [x] 5.7 Add consumer-backed tests for every mutable control remaining on Mail, Notifications, and Appearance.

## 6. Advanced Integrations and Data

- [x] 6.1 Create the Advanced settings shell with AI Service, Integrations, Data & Privacy, and Diagnostics subsections.
- [x] 6.2 Rework MCP into a simple connection layer showing enablement, readiness, and guided configuration.
- [x] 6.3 Put MCP port, endpoint, token metadata, sessions, pending operations, and live tool catalog behind a diagnostics disclosure.
- [x] 6.4 Move WeCLI installation and health state from About to Advanced Integrations.
- [x] 6.5 Build Data & Privacy copy from the actual retention and credential-storage policy and remove contradictory 30-day mail-body claims.
- [x] 6.6 Keep runtime versions, executable paths, health output, and copyable diagnostics out of the primary About view.
- [x] 6.7 Add MCP tests for simple setup, one-time token handling, diagnostics disclosure, live state, revocation, and session termination.

## 7. Cleanup and Compatibility

- [x] 7.1 Remove obsolete settings navigation entries and settings-only components after all replacement destinations are covered.
- [x] 7.2 Preserve existing local and server preference values without destructive migration or automatic reset.
- [x] 7.3 Remove Gmail shortcut-style and custom-shortcut TODO controls and expose the live command reference through the command palette or a keyboard-help overlay.
- [x] 7.4 Remove the interface-language selector until complete application internationalization exists.
- [x] 7.5 Update About to show only product version, update state when available, license, and a link to Advanced diagnostics.
- [x] 7.6 Update screenshots, accessibility labels, and user-facing Chinese copy for the simplified information architecture.
- [x] 7.7 Clear stale email detail selection when navigation enters another product destination while preserving explicit message deep links.

## 8. Verification

- [x] 8.1 Run TypeScript type checking and focused renderer tests for settings, account, compose, AI profile, digests, automation, MCP, theme, and navigation.
- [x] 8.2 Run focused server tests for AI profile compatibility, digest defaults, retention policy, account identity, and MCP state.
- [x] 8.3 Run browser coverage for every primary destination, Advanced disclosure, contextual feature route, and legacy deep link.
- [ ] 8.4 Perform a desktop visual QA pass at supported window sizes and capture final Account, AI, Mail, Appearance, About, and Advanced screenshots.
- [x] 8.5 Confirm every visible mutable setting has a documented runtime consumer and remove any remaining placeholder or no-op control.
- [x] 8.6 Add renderer coverage for automatic email-detail collapse on product destinations and preservation on explicit message routes.
