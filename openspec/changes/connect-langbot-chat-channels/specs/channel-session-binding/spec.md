## ADDED Requirements

### Requirement: The verified owner inherits the active single mailbox
The system MUST automatically create an enabled current-mailbox binding when the platform owner is verified. Non-owner identities still require an explicit allowlisted binding before channel input can invoke the agent.

#### Scenario: Bound direct-message sender writes
- **WHEN** a direct-message event matches an enabled connection, bot, sender, and account binding
- **THEN** the system dispatches it using only the bound WeMail account

#### Scenario: Existing paired owner starts after the upgrade
- **WHEN** a verified owner exists without a binding and WeMail starts with an active mailbox
- **THEN** the system backfills the owner binding without requiring re-pairing or another authorization step

#### Scenario: Unknown identity writes
- **WHEN** an event does not match an enabled binding
- **THEN** the system does not invoke the agent or reveal whether any mailbox account exists

### Requirement: Bindings are tenant and bot scoped
The system SHALL include the bot profile, adapter/platform, chat kind, chat identifier, and required sender identifier in binding lookup keys.

#### Scenario: Same platform user appears under two bots
- **WHEN** the same external sender ID sends messages through two different bot UUIDs
- **THEN** the system resolves each message independently and never reuses a binding solely because the sender IDs match

#### Scenario: Same chat identifier appears on two connections
- **WHEN** Feishu and WeCom or two historical profiles report the same external chat identifier
- **THEN** the system isolates their bindings by platform and bot-profile identity

### Requirement: Conversation scope protects participant context
The system SHALL map direct messages to a conversation per bot and sender and SHALL map group messages to a conversation per bot, group, and sender by default.

#### Scenario: Direct-message conversation continues
- **WHEN** a bound sender sends a later direct message through the same bot
- **THEN** the system reuses that sender's bound agent conversation

#### Scenario: Two group participants use the bot
- **WHEN** two bound senders message the same group
- **THEN** the system uses separate agent conversations unless an explicit trusted shared-conversation policy is configured

### Requirement: Binding lifecycle follows authorization lifecycle
The system SHALL support binding creation, disablement, revocation, and invalidation when its WeMail account or bot profile is removed.

#### Scenario: Binding is revoked
- **WHEN** an operator revokes a binding
- **THEN** subsequent events for that identity stop invoking the agent while historical audit records remain attributable

#### Scenario: Mail account is removed
- **WHEN** the WeMail account referenced by a binding is removed
- **THEN** the system invalidates the binding before accepting additional agent work for it

### Requirement: Binding administration is auditable
The system SHALL record the actor, timestamp, target scope, and result of binding changes without recording platform secrets.

#### Scenario: Operator changes a binding
- **WHEN** a binding is created, disabled, or revoked
- **THEN** the system emits a sanitized audit event containing the affected connection, bot, external scope, and WeMail account identifier
