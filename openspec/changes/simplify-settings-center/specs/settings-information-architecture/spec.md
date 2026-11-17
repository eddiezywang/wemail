## ADDED Requirements

### Requirement: Reduced primary settings navigation
The settings dialog SHALL expose Account, AI, Mail, Appearance, and About as direct user-facing destinations, SHALL expose Notifications only when at least one channel is delivered by the application, and SHALL place technical integrations, data details, and diagnostics behind a secondary Advanced entry.

#### Scenario: User opens settings
- **WHEN** a user opens the settings dialog
- **THEN** the primary navigation contains no direct entries for model routing, automation CRUD, writing-style CRUD, storage, security switches, MCP protocol management, shortcut stubs, language stubs, or history centers
- **AND** Advanced is visually secondary to the primary destinations

### Requirement: Visible controls are truthful and effective
Every mutable control presented in settings SHALL change an implemented user-observable behavior and SHALL have automated coverage for both persistence and its runtime consumer.

#### Scenario: A preference has no runtime consumer
- **WHEN** a preference can be stored but no product surface consumes it
- **THEN** the preference SHALL NOT be presented as an active setting

#### Scenario: A feature is planned but unavailable
- **WHEN** a feature is not implemented
- **THEN** settings SHALL NOT display an enabled, disabled, or selectable placeholder for it

### Requirement: Simplified account identity
The Account destination SHALL present the active mailbox identity once and SHALL provide sender-name editing and mailbox replacement without duplicate account cards or unavailable multi-account affordances.

#### Scenario: One mailbox is connected
- **WHEN** the user opens Account with one active mailbox
- **THEN** one identity card shows sender name and address
- **AND** editing the sender name and replacing the mailbox are available from that card
- **AND** no disabled add-mailbox control is shown

### Requirement: User-meaningful AI usage
The Account destination SHALL show AI usage in user-meaningful totals and SHALL hide processor versions, model identifiers, and internal category details from the default view.

#### Scenario: User reviews AI usage
- **WHEN** usage exists for the selected account and period
- **THEN** the default view shows the total and an understandable breakdown
- **AND** implementation diagnostics require an explicit Advanced disclosure

### Requirement: Consolidated AI preferences
The AI destination SHALL expose response style, one default output-language choice, and one optional natural-language requirements field without requiring users to understand Markdown or prompt construction.

#### Scenario: User has no explicit AI preference
- **WHEN** the AI profile has no user-defined language or style
- **THEN** the page shows “follow the message” and a safe default response style
- **AND** AI features remain usable without configuration

#### Scenario: User changes output language
- **WHEN** the user selects a default AI output language
- **THEN** summary, todo, and compose language compatibility fields are updated consistently

#### Scenario: Existing custom instructions are present
- **WHEN** a profile already contains custom instructions
- **THEN** the same content remains available in the optional natural-language requirements field
- **AND** no stored profile data is discarded

### Requirement: AI service details use progressive disclosure
The primary AI destination SHALL show service readiness and a setup action, while provider endpoints, secrets, discovery, and per-capability model routing SHALL be available only in Advanced.

#### Scenario: AI service is already configured
- **WHEN** the configured model is reachable
- **THEN** the primary AI page shows a concise ready state
- **AND** it does not show Base URL, API key, or routing fields by default

#### Scenario: User needs custom model routing
- **WHEN** the user explicitly opens Advanced AI service settings
- **THEN** the existing provider and routing controls remain available

### Requirement: Contextual feature management
Automation rules, writing styles, digest schedules, action history, digest history, and AI learning history SHALL be managed in their relevant product workflows rather than as primary settings categories.

#### Scenario: User manages a writing style
- **WHEN** the user chooses to manage styles from the compose style picker
- **THEN** the existing writing-style management flow opens without requiring navigation through settings

#### Scenario: User manages an automation rule
- **WHEN** the user follows an automation management link
- **THEN** a dedicated automation destination opens with existing CRUD and dry-run capabilities

#### Scenario: User leaves the current mail context
- **WHEN** the user navigates to a different product destination while an email detail is open
- **THEN** the stale email detail selection SHALL be cleared automatically so the destination receives its full workspace width
- **AND** an explicit `/message/:id` deep link SHALL preserve the requested email detail

#### Scenario: User configures a scheduled summary
- **WHEN** the user manages daily summary delivery
- **THEN** Summary Center exposes only enablement and delivery time as primary choices
- **AND** manual summary availability and internal window calculations require no configuration

### Requirement: Mail settings contain persistent mail preferences
The Mail destination SHALL contain the implemented account signature preference and SHALL not expose inbox layout, threading, reading-pane, or send-shortcut controls until those values have runtime consumers.

#### Scenario: User edits the signature
- **WHEN** the user enables or edits the active account signature
- **THEN** subsequent compose flows use the updated signature

### Requirement: Secure behavior is enabled by default
Tracker protection and link-safety behavior SHALL use secure product defaults and SHALL not be represented by unsupported global switches.

#### Scenario: Security implementation has no configurable consumer
- **WHEN** the renderer does not consume a tracker or link-safety preference
- **THEN** settings shows no switch claiming to change that behavior

### Requirement: Notifications expose only delivered behavior
The Notifications destination SHALL display only notification channels and events that the application actually delivers.

#### Scenario: Daily digest notification is not wired
- **WHEN** no scheduler or notification consumer uses the daily-digest notification preference
- **THEN** no daily-digest notification switch is shown

#### Scenario: Desktop new-mail notifications are wired
- **WHEN** the application can deliver new-mail desktop notifications
- **THEN** the user can enable them and complete the required operating-system permission flow

### Requirement: Appearance uses supported themes
The Appearance destination SHALL use localized labels and SHALL offer only supported product themes, with following the operating-system theme as the default when available.

#### Scenario: User has not selected a theme
- **WHEN** the application can read the operating-system theme
- **THEN** Appearance defaults to following the system

### Requirement: Accurate data and privacy information
Data & Privacy and About surfaces SHALL describe retention, credential storage, and local data behavior consistently with the running implementation.

#### Scenario: Mail bodies are retained long-term
- **WHEN** the retention policy has no mail-body expiry
- **THEN** every user-facing retention description states that mail bodies remain until a future explicit cleanup policy or user action removes them
- **AND** no surface claims automatic 30-day mail-body deletion

### Requirement: Legacy settings destinations migrate safely
Legacy settings section identifiers and inbound links SHALL resolve to the new settings destination or contextual product route without deleting user data.

#### Scenario: Legacy automation settings link is opened
- **WHEN** a link targets the former automation settings section
- **THEN** the dedicated automation destination opens

#### Scenario: Unknown settings section is opened
- **WHEN** a section identifier is unsupported
- **THEN** settings falls back to Account without crashing

### Requirement: Existing preference data is preserved
Removing a setting from the visible UI SHALL NOT delete its local or server-stored value during this change.

#### Scenario: User previously selected an unfinished preference
- **WHEN** the simplified settings UI is first opened after upgrade
- **THEN** the legacy value remains stored for compatibility
- **AND** no active control is shown unless the behavior is implemented
