## ADDED Requirements

### Requirement: Connection summaries represent independent integrations
The system SHALL expose separate normalized status entries for WeCLI, Feishu, and WeCom and SHALL NOT infer one entry from another entry or collapse them into one bot boolean.

#### Scenario: Integrations have mixed states
- **WHEN** WeCLI is healthy, Feishu is not configured, and WeCom is end-to-end ready
- **THEN** the summary reports WeCLI as connected, Feishu as not configured, and WeCom as connected

#### Scenario: Bot Core or one adapter is unavailable
- **WHEN** Bot Core is unavailable or one configured adapter check fails
- **THEN** each affected Feishu or WeCom entry reports its own transport-specific failure while the WeCLI entry remains unchanged

### Requirement: Connected means observed end-to-end readiness
The system MUST report WeCLI as connected only after a successful executable and doctor check and MUST report a chat channel as connected only after the selected bot, matching platform, verified owner, initialization delivery, and a fresh active detection all succeed.

#### Scenario: Configuration is merely saved
- **WHEN** platform configuration and credential references have been saved but no successful adapter check has completed
- **THEN** the affected channel does not report connected

#### Scenario: Channel setup is incomplete
- **WHEN** a matching bot exists but its owner is not verified or initialization has not been delivered
- **THEN** the channel reports an attention state with the next incomplete setup action

#### Scenario: Active detection fails
- **WHEN** a previously ready channel fails an explicit Bot Core or adapter check
- **THEN** the channel reports disconnected with a sanitized stage-specific reason

### Requirement: Connection observations restore before silent startup verification
The system SHALL persist the last completed connection observations, render them without waiting for health work, and run one background verification after each application startup without interval or focus-based probing.

#### Scenario: A new application session starts
- **WHEN** the application starts with persisted prior observations
- **THEN** the settings page and connected-only sidebar can render those observations before the startup probe completes

#### Scenario: Startup verification is running
- **WHEN** the silent startup probe has started but has not completed
- **THEN** the UI retains the last completed result and does not block, clear, or replace the application shell with loading state

#### Scenario: Startup verification changes a result
- **WHEN** the silent startup probe completes with a state or user-visible detail different from the retained observation
- **THEN** the settings page and sidebar update dynamically to the new completed observation

#### Scenario: Startup verification does not change a result
- **WHEN** the silent startup probe completes with the same normalized observation
- **THEN** the UI avoids an unnecessary visible transition while updating the observation timestamp

#### Scenario: The application remains open
- **WHEN** startup verification has completed and no real connection activity or explicit user action occurs
- **THEN** the system does not run another scheduled or window-focus probe

### Requirement: The client provides a primary connection settings section
The system SHALL provide a first-class “连接” settings section containing a WeCLI, Feishu, and WeCom list and a focused detail pane for the selected entry.

#### Scenario: User selects an unconfigured channel
- **WHEN** the user selects unconfigured Feishu or WeCom
- **THEN** the detail pane opens the resumable official-platform configuration, detection, owner, and initialization flow at the first incomplete step

#### Scenario: User selects a ready channel
- **WHEN** the user selects a ready Feishu or WeCom entry
- **THEN** the detail pane shows bot identity, owner, staged health, last observations, queue state, and explicit detect, test-message, re-pair, and disconnect actions

#### Scenario: User selects WeCLI
- **WHEN** the user selects WeCLI
- **THEN** the detail pane shows installation, binary, version, doctor result, last check, and the appropriate install or detect action

### Requirement: The sidebar shows only fresh connected integrations
The system SHALL show only freshly connected WeCLI, Feishu, and WeCom entries immediately above the existing account footer and SHALL keep unavailable integration states in the complete connection settings section instead of the sidebar.

#### Scenario: Sidebar filters the requested mixed state
- **WHEN** WeCLI and WeCom are connected and Feishu is not connected
- **THEN** the sidebar visibly labels WeCLI and 企业微信 as connected and does not render a 飞书 entry

#### Scenario: No integration is connected
- **WHEN** WeCLI, Feishu, and WeCom are all unconfigured, unavailable, stale, checking, or disconnected
- **THEN** the sidebar omits the complete connected-capabilities strip and leaves the existing account footer unchanged

#### Scenario: Full status remains discoverable
- **WHEN** an integration is omitted from the sidebar
- **THEN** its current state, reason, and repair action remain available under the primary “连接” settings section

#### Scenario: User opens connection settings
- **WHEN** the user activates the connected-capabilities heading
- **THEN** settings opens directly to the “连接” section

#### Scenario: User opens one integration
- **WHEN** the user activates an individual WeCLI, Feishu, or WeCom status
- **THEN** settings opens to that integration's detail pane

#### Scenario: Status is not conveyed by color alone
- **WHEN** a connected integration is rendered in the sidebar
- **THEN** the UI includes a connection mark, integration label, and accessible “已连接” text in addition to green color

### Requirement: Connection status updates silently from startup and real activity
The system SHALL run one low-priority background probe at application startup and SHALL thereafter update status only from actual inbound/outbound activity, attempted delivery, setup validation, or an explicit user detection action.

#### Scenario: Setup completes
- **WHEN** owner pairing and initialization delivery transition a channel to ready
- **THEN** the sidebar and settings summary update without requiring an application restart

#### Scenario: Settings opens
- **WHEN** the user opens the connection settings after startup verification
- **THEN** the system shows the current observation without automatically starting another probe

#### Scenario: User requests detection
- **WHEN** the user activates “检测连接”
- **THEN** the system runs one deduplicated active check and updates the observation

#### Scenario: Actual channel activity fails
- **WHEN** an inbound, outbound, or automation delivery attempt produces an authoritative connection failure
- **THEN** the affected integration status updates immediately without waiting for another scheduled probe
