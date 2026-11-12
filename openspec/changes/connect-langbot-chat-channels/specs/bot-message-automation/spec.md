## ADDED Requirements

### Requirement: Automation targets an explicit platform bot profile
The system SHALL provide a canonical `publishBotMessage` automation action that references one stable ready bot profile whose platform is explicitly `feishu` or `wecom`.

#### Scenario: User configures a bot-message action
- **WHEN** the automation editor lists available targets
- **THEN** it displays the platform, bot name, verified owner, and last observed health and stores the selected bot profile ID rather than a generic webhook URL

#### Scenario: A ready bot has a temporary health failure
- **WHEN** an administratively ready profile was last observed disconnected
- **THEN** the editor keeps it visible with a warning rather than deleting the configured target or silently selecting another bot

#### Scenario: Selected bot becomes unavailable
- **WHEN** a rule executes after its bot profile is disabled, removed, incompatible, or no longer ready
- **THEN** the action fails closed and does not fall back to another Feishu or WeCom bot

### Requirement: Automation targets a verified owner or observed eligible conversation
The system SHALL allow a bot-message action to target the verified owner or an eligible conversation previously observed through the selected bot profile. Owner destinations MUST persist the binding version authorized with the rule.

#### Scenario: Rule targets the owner
- **WHEN** a rule with destination type `owner` executes
- **THEN** the system verifies that the active owner binding version matches the confirmed action and creates a person delivery through that exact bot

#### Scenario: Rule targets an observed conversation
- **WHEN** a rule selects an eligible direct or group conversation previously observed through the same bot profile
- **THEN** validation stores its typed platform destination and delivery uses that exact profile and conversation

#### Scenario: Rule supplies an arbitrary destination
- **WHEN** a rule draft supplies a user or chat identifier that was not observed and marked eligible for that profile
- **THEN** validation rejects it and does not permit a generic webhook or cross-profile destination

#### Scenario: Owner changes after rule confirmation
- **WHEN** the active owner binding version differs from the version stored in a confirmed rule
- **THEN** the system blocks delivery, marks the rule as needing reauthorization, identifies the affected rule, and does not send to the new owner

#### Scenario: Owner change is reauthorized
- **WHEN** the user confirms a rule revision using the current owner binding version
- **THEN** subsequent executions may deliver to that verified owner

### Requirement: Automation messages use bounded typed content
The system SHALL render automation messages from approved processor output, application-message summaries, or bounded mail templates and MUST NOT accept arbitrary executable markup or expose secrets and hidden agent content.

#### Scenario: Collection processor publishes a summary
- **WHEN** a collection rule produces an approved digest and executes `publishBotMessage`
- **THEN** the system renders a bounded plain-text message and queues it through the channel delivery ledger

#### Scenario: Per-message rule publishes mail fields
- **WHEN** a per-message rule uses an approved template
- **THEN** only allowlisted fields such as sender, subject, received time, and bounded snippet are interpolated

### Requirement: Bot delivery does not rerun automation processing
The system SHALL freeze rendered bot content, link each delivery to the automation rule, run, action, bot profile, and owner version, and SHALL retry delivery independently from mail matching and processor execution.

#### Scenario: Platform adapter is temporarily unavailable
- **WHEN** automation processing succeeds but bot delivery receives a retryable error
- **THEN** the delivery is retried without rerunning the rule conditions or AI processor

#### Scenario: Delivery succeeds
- **WHEN** the platform adapter confirms the send operation
- **THEN** automation audit state records the selected platform, bot profile, destination type, and delivered status without message secrets

#### Scenario: Local backend exits with queued delivery
- **WHEN** a delivery was persisted before the local WeMail backend stopped
- **THEN** the delivery remains queued and resumes without rerunning the automation when the backend next starts

### Requirement: Automation delivery uses the send as its connection observation
The system SHALL NOT require a separate active health preflight before an automation delivery and SHALL update the persisted integration observation from the actual send result.

#### Scenario: Delivery succeeds without a preflight
- **WHEN** an eligible automation delivery is due
- **THEN** the system sends it directly through the selected profile and records the successful send as a connection observation

#### Scenario: Delivery reports an authoritative connection failure
- **WHEN** the platform adapter returns an authentication, removed/disabled bot, or platform-mismatch failure
- **THEN** the system records the delivery failure and updates the affected integration status so connected-only UI projections refresh

#### Scenario: Delivery has a retryable failure
- **WHEN** the actual send times out or receives another classified transient failure
- **THEN** the system retries only the frozen delivery with bounded attempts and records an explicitly ambiguous outcome when exactly-once delivery cannot be proven

### Requirement: External bot delivery is authorized
The system SHALL classify `publishBotMessage` as an external request and SHALL require the existing automation authorization and confirmation path when a rule is created or materially changes bot, platform, owner binding version, or content scope.

#### Scenario: Rule changes from Feishu to WeCom
- **WHEN** an existing rule is edited to use a WeCom bot instead of its Feishu bot
- **THEN** the system treats the edit as a material external-delivery change requiring renewed confirmation
