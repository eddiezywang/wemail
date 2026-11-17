## ADDED Requirements

### Requirement: The client guides platform-specific bot setup
The system SHALL provide a resumable onboarding flow that is fixed to Feishu or WeCom, links to the matching official platform console, collects only that adapter's required credentials, and verifies the local Bot Core connection.

#### Scenario: User selects Feishu
- **WHEN** the user chooses Feishu during onboarding
- **THEN** the system shows Feishu app creation, permission, event-subscription, publication, and credential guidance and configures only the Feishu adapter

#### Scenario: User selects WeCom
- **WHEN** the user chooses WeCom during onboarding
- **THEN** the system shows WeCom intelligent-bot creation, long-connection, permission, and credential guidance, collects only Bot ID and Bot Secret, uses the official adapter's default endpoint, and does not ask for a display name

#### Scenario: User resumes onboarding
- **WHEN** onboarding was interrupted after a durable step
- **THEN** the system resumes from the last completed step without requiring completed credentials or bot selection again

### Requirement: Every ready bot has one verified owner
The system MUST bind exactly one active owner identity to each ready bot profile and MUST verify that identity through a direct-message pairing event from the selected bot.

#### Scenario: Owner redeems a valid pairing code
- **WHEN** a person sends `/wemail connect <code>` in a direct chat with the matching bot before the code expires
- **THEN** the system records that connection, bot, platform, and platform user ID as the verified owner and atomically binds that owner to the active single mailbox

#### Scenario: Pairing is attempted from a group
- **WHEN** a valid code is sent from a group chat
- **THEN** the system rejects the pairing without assigning an owner

#### Scenario: Pairing is attempted through another bot
- **WHEN** a code issued for one bot profile arrives through another connection or bot UUID
- **THEN** the system rejects the pairing and keeps the code unredeemed until expiry or valid use

#### Scenario: Owner is changed
- **WHEN** an operator initiates owner replacement
- **THEN** the system requires a new pairing, revokes the former owner's mailbox bindings, binds the replacement owner to the active mailbox, increments the owner binding version, retains an audit record, and identifies dependent automation rules that require reauthorization

### Requirement: Pairing secrets are short-lived and single-use
The system MUST generate high-entropy pairing codes, persist only a secure hash, enforce expiration and attempt limits, and invalidate a code after successful redemption.

#### Scenario: Expired code is submitted
- **WHEN** a pairing event contains an expired code
- **THEN** the system rejects it without revealing the intended owner or mailbox

#### Scenario: Redeemed code is replayed
- **WHEN** a previously redeemed code is submitted again
- **THEN** the system rejects the replay without changing ownership

### Requirement: Successful owner verification triggers one initialization delivery
The system SHALL send a separate initialization message through the selected platform adapter to the verified owner and SHALL mark the bot profile ready only after that delivery succeeds.

#### Scenario: Initialization succeeds
- **WHEN** an owner has been verified and the platform adapter confirms delivery to that owner's direct chat
- **THEN** the system records the initialization version and sent timestamp and marks the profile ready

#### Scenario: Initialization fails transiently
- **WHEN** owner verification succeeds but initialization delivery has a retryable failure
- **THEN** the system keeps the profile in `initialization_pending`, retries through the delivery ledger, and allows an explicit retry

#### Scenario: Detection is rerun after readiness
- **WHEN** an operator reruns ordinary connection detection for a ready profile
- **THEN** the system does not resend the initialization message

#### Scenario: Owner changes
- **WHEN** a different owner is successfully paired
- **THEN** the system sends the current initialization message once to the new owner before restoring ready state

### Requirement: Initialization content is safe and actionable
The initialization message SHALL identify WeMail, the platform and bot display name, basic commands, current authorization scope, and where to manage the connection, and MUST NOT contain API keys, bot secrets, pairing codes, full internal identifiers, or mailbox content.

#### Scenario: Owner receives initialization
- **WHEN** the initialization message is rendered
- **THEN** it contains setup-success guidance and safe next steps without secret or mail disclosure

### Requirement: Diagnostics remain available after onboarding
The system SHALL retain a per-bot diagnostics entry that separates Bot Core process health, adapter authentication/connection, selected platform profile, last inbound event, and outbound delivery.

#### Scenario: Operator detects a healthy connection
- **WHEN** the operator runs connection detection
- **THEN** the system performs a non-mutating Bot Core and adapter check and displays stage-specific results with timestamps

#### Scenario: Operator sends a test message
- **WHEN** the operator explicitly selects “send test message” for a ready bot
- **THEN** the system queues a clearly labeled diagnostic delivery to the verified owner and records its result separately from initialization

#### Scenario: Outbound works but inbound has never been observed
- **WHEN** the bot and test delivery are healthy but no authenticated inbound event exists
- **THEN** the system reports outbound success and inbound unverified rather than presenting the whole connection as fully healthy

### Requirement: Verified ownership binds the active single mailbox
The system SHALL treat successful local owner pairing as authorization to use the active mailbox in the single-mailbox product and MUST NOT require a second mailbox-authorization step. Ordinary confirmation remains required for sensitive mailbox actions.

#### Scenario: Verified owner sends the first ordinary message
- **WHEN** initialization has completed and the verified owner sends a direct message
- **THEN** the system resolves the automatically created current-mailbox binding and invokes the agent
