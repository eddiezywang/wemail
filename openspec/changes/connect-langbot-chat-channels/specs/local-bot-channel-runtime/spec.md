## ADDED Requirements

### Requirement: Bot channels run inside an invisible supervised process
The system SHALL run Feishu and WeCom channel adapters in an Electron utility process with no window and SHALL supervise readiness, heartbeat, restart, and graceful shutdown.

#### Scenario: User opens WeMail
- **WHEN** the Electron application starts with an enabled channel
- **THEN** Electron main starts Bot Core without opening another window and replays the channel configuration

#### Scenario: User hides WeMail to the tray
- **WHEN** the main window is hidden without an explicit application quit
- **THEN** Bot Core and configured long connections remain active

#### Scenario: Bot Core crashes
- **WHEN** the utility process exits or misses the heartbeat threshold
- **THEN** the supervisor restarts it with bounded backoff and replays enabled configuration

### Requirement: Qwen adapters are isolated behind a provider-neutral protocol
The system SHALL use the pinned Qwen Feishu and WeCom adapters for platform transport while exposing only versioned WeMail envelopes, sends, reactions, probes, and status messages outside Bot Core.

#### Scenario: Platform message arrives
- **WHEN** an adapter receives a supported direct or group message
- **THEN** Bot Core emits a normalized WeMail envelope without invoking Qwen’s agent bridge

#### Scenario: WeMail sends a message
- **WHEN** a delivery targets an enabled profile
- **THEN** Bot Core calls only that profile’s platform adapter and returns a sanitized success or classified failure

#### Scenario: WeMail updates a Feishu reaction
- **WHEN** the channel worker requests an add or remove reaction for an accepted Feishu message
- **THEN** Bot Core calls the official Feishu message-reaction API for that exact profile and message ID and returns only sanitized success or classified failure

### Requirement: Platform secrets remain outside renderer and SQLite
The system MUST store secrets using Electron safeStorage and MUST transfer plaintext credentials to Bot Core only over its private MessagePort.

#### Scenario: Configuration is inspected
- **WHEN** a renderer, API client, database reader, diagnostic logger, or crash report observes channel configuration
- **THEN** it receives secret presence/reference metadata and never the plaintext value

### Requirement: Inbound and outbound work remains durable
The system SHALL persist normalized inbound work before agent execution and SHALL queue outbound replies, initialization, tests, and automation messages through the existing delivery ledger.

#### Scenario: Duplicate inbound event arrives
- **WHEN** the same platform message ID is delivered again for the same profile
- **THEN** no additional agent run is created

#### Scenario: Delivery temporarily fails
- **WHEN** the adapter reports a retryable or ambiguous result
- **THEN** the existing bounded delivery retry policy applies without rerunning agent or automation computation

### Requirement: Runtime health is observable without message spam
The system SHALL expose configuration, process, adapter, last ingress, last egress, and queue observations without sending a chat message during ordinary detection.

#### Scenario: Startup detection runs
- **WHEN** WeMail performs its one silent startup detection
- **THEN** Bot Core probes configured adapters without sending initialization or test messages
