## ADDED Requirements

### Requirement: Application messages are persistent and account-scoped
The system SHALL persist each application message with account ownership, source type, optional source rule and run, message type, title, preview, structured content, typed interactions, severity, unread state, and timestamps.

#### Scenario: Automation publishes a digest
- **WHEN** a collection automation successfully publishes a digest
- **THEN** exactly one application message SHALL be stored for that rule run
- **AND** it SHALL reference the source rule, run, and included email IDs

#### Scenario: Another account requests the message
- **WHEN** a client requests a message that belongs to a different account
- **THEN** the API SHALL return no message content or references

### Requirement: Message content uses a safe rich-content model
The system SHALL render application-message detail from allowlisted structured blocks and SHALL reject or remove arbitrary scripts, event handlers, remote active embeds, unsafe URLs, and unscoped model-generated HTML.

#### Scenario: Processor returns Markdown
- **WHEN** a registered processor returns Markdown-compatible content
- **THEN** the system SHALL parse and sanitize it into allowlisted blocks before persistence or rendering

#### Scenario: Content contains hostile HTML
- **WHEN** content contains a script, inline event handler, iframe, remote image beacon, or executable URL
- **THEN** the unsafe content SHALL NOT execute or load
- **AND** safe surrounding text MAY remain visible

### Requirement: Users can browse and manage message history
The desktop client SHALL provide a sidebar entry with unread count, a paginated message list, filtering by read/type/source, and a detail surface for persistent application messages.

#### Scenario: User opens an unread message
- **WHEN** the user selects an unread message from the list
- **THEN** its rich detail SHALL open inside the WeMail workbench
- **AND** its unread state SHALL be cleared consistently

#### Scenario: User returns later
- **WHEN** the application restarts and the user opens the message center
- **THEN** prior non-expired messages and their read/archive state SHALL remain available

### Requirement: Message references are inspectable
The system SHALL retain typed references from an application message to source emails, attachments, automation rules, rule runs, drafts, or audited external operations without embedding unrestricted source content.

#### Scenario: Digest theme references source mail
- **WHEN** a digest section cites one or more source emails
- **THEN** the detail UI SHALL allow the user to open the referenced mail within the owning account

#### Scenario: Referenced mail is no longer available
- **WHEN** a referenced email has been deleted or expired
- **THEN** the message SHALL remain readable
- **AND** the unavailable reference SHALL be shown as unavailable rather than causing detail failure

### Requirement: Message interactions are typed and policy-controlled
The system SHALL allow only registered typed interactions in application messages and SHALL apply the normal risk and confirmation policy when an interaction causes a mutation.

#### Scenario: User opens a filtered mail list
- **WHEN** a message interaction only navigates to referenced mail
- **THEN** it SHALL execute without a mutation confirmation

#### Scenario: User chooses to upload analyzed invoices
- **WHEN** a message interaction proposes a WeCLI upload
- **THEN** the system SHALL create an exact-parameter pending action
- **AND** SHALL NOT execute the upload before confirmation

### Requirement: Desktop delivery projects persisted messages
The system SHALL route eligible application-message desktop delivery through the shared notification coordinator only after the application message is persisted and SHALL deep-link notification selection to that message.

#### Scenario: Desktop notifications are enabled
- **WHEN** a new eligible application message is published while WeMail is not focused
- **THEN** the OS notification SHALL contain only an allowlisted title and short preview or count
- **AND** selecting it SHALL restore WeMail and open the persisted message

#### Scenario: An application message is informational
- **WHEN** a digest, analysis, success result, or other application message does not require user action
- **THEN** it SHALL remain available and unread in the application message center
- **AND** it SHALL NOT emit a Windows notification by default

#### Scenario: An application message requires intervention
- **WHEN** an automation result enters a durable state that explicitly requires user intervention
- **THEN** action-required desktop delivery SHALL be eligible by default
- **AND** the notification SHALL expose only a safe summary and a review deep link
- **AND** it SHALL NOT approve or execute a risky mutation directly

#### Scenario: OS delivery fails or is disabled
- **WHEN** the Windows notification cannot be emitted
- **THEN** the application message SHALL remain persisted and unread in the message center

### Requirement: Desktop delivery uses two explicit policies
The system SHALL maintain independent action-required and new-mail notification preferences. Action-required delivery SHALL default to enabled. New-mail delivery SHALL default to disabled.

#### Scenario: New-mail notifications are disabled
- **WHEN** a genuinely live message arrives and the new-mail preference is disabled
- **THEN** the message SHALL update the inbox and unread state
- **AND** it SHALL NOT emit a Windows notification or create an application message

#### Scenario: New-mail notifications are enabled
- **WHEN** a genuinely live message arrives and the new-mail preference is enabled
- **THEN** it SHALL be eligible for Windows delivery regardless of focus, importance, VIP status, category, smart tag, or AI classification
- **AND** the notification SHALL contain sender and subject only

#### Scenario: WeMail is focused
- **WHEN** an otherwise eligible live message or action-required event occurs while the WeMail window is focused
- **THEN** Windows delivery SHALL remain eligible
- **AND** the renderer SHALL NOT emit a duplicate in-app new-mail toast

#### Scenario: Existing preferences are migrated
- **WHEN** an existing installation first loads the two-policy notification settings
- **THEN** the prior desktop-notification value SHALL become the new-mail notification value
- **AND** action-required delivery SHALL default to enabled
- **AND** the prior notification-sound value SHALL be preserved

#### Scenario: Several live messages arrive together
- **WHEN** more than one live message arrives for one account inside the aggregation window
- **THEN** the coordinator SHALL emit or update one grouped notification with the total count and a bounded sender/subject preview
- **AND** it SHALL NOT create an unbounded stack of individual notifications

### Requirement: Historical synchronization never becomes a mail-notification burst
The system SHALL model initial synchronization, historical backfill, folder rebuilding, and manual full synchronization as resumable synchronization sessions with one in-app progress state and one final in-app summary.

#### Scenario: Initial synchronization imports historical mail
- **WHEN** an initial synchronization imports any number of historical messages
- **THEN** those messages SHALL NOT enter live new-mail notification delivery
- **AND** progress SHALL update one in-app synchronization state
- **AND** completion SHALL produce at most one in-app summary and no Windows completion notification

#### Scenario: Live mail arrives during historical synchronization
- **WHEN** a message arrives beyond the session's live-delivery watermark while historical synchronization remains active
- **THEN** the message SHALL follow the ordinary new-mail notification preference

### Requirement: Windows notification activation is safe and exact
The system SHALL use typed activation targets and stable delivery keys for Windows notifications and SHALL preserve source state when delivery or activation fails.

#### Scenario: User opens a notification target
- **WHEN** the user selects a mail, aggregate, account-recovery, automation, or Agent-confirmation notification
- **THEN** WeMail SHALL restore the window, select the owning account, and open the exact available target

#### Scenario: Notification target is already resolved
- **WHEN** the user selects a notification whose pending action has already been resolved
- **THEN** WeMail SHALL show the resolved owning surface
- **AND** it SHALL NOT recreate or reauthorize the action

#### Scenario: A delivery event repeats after reconnect
- **WHEN** the coordinator receives an event with a stable delivery key that is still retained
- **THEN** it SHALL update the existing grouped notification or suppress duplicate delivery

### Requirement: Application message retention is explicit
The system SHALL apply a configurable retention policy to application messages and SHALL not expose expired source content through retained references.

#### Scenario: Message reaches retention expiry
- **WHEN** a message reaches its configured expiry and is not protected by a supported retention state
- **THEN** scheduled cleanup SHALL remove or tombstone it according to policy
- **AND** SHALL update unread counts without affecting source mail retention independently
