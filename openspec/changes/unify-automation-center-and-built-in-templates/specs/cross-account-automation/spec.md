## ADDED Requirements

### Requirement: Cross-account automation has explicit local-profile ownership

The system SHALL distinguish account-owned rules from local-profile-owned rules and SHALL not encode profile ownership using a fabricated account ID.

#### Scenario: Rule uses one account

- **WHEN** an automation is configured only for the current account
- **THEN** it MAY remain account-owned
- **AND** all reads and writes SHALL enforce that account

#### Scenario: Rule uses selected or all connected accounts

- **WHEN** an automation selects more than one account or all connected accounts
- **THEN** it SHALL be owned by the local profile
- **AND** its account scope SHALL be persisted separately from ownership

### Requirement: Account expansion is explicit before confirmation

The configuration workflow SHALL represent current account, selected accounts, and all connected accounts as distinct typed scopes and SHALL disclose the resolved accounts before final authorization.

#### Scenario: Template defaults to current account

- **WHEN** a user instantiates “邮箱速览” without choosing another scope
- **THEN** the draft SHALL select the current account
- **AND** it SHALL not silently scan every connected account

#### Scenario: User chooses all connected accounts

- **WHEN** the user selects all connected accounts
- **THEN** preview and final confirmation SHALL list or count the resolved accounts
- **AND** the immutable rule SHALL retain the dynamic-scope policy and confirmed authorization bounds

### Requirement: Cross-account manifests are fair, bounded, and frozen

The collector SHALL page eligible data per account with confirmed global and per-account limits and SHALL freeze account-qualified references and content hashes for the claimed occurrence.

#### Scenario: One account has far more mail

- **WHEN** one account contains enough candidates to exhaust the global limit
- **THEN** collection SHALL reserve fair bounded opportunity for other selected accounts
- **AND** run detail SHALL expose per-account scanned and selected counts

#### Scenario: Run retries

- **WHEN** a cross-account run is retried
- **THEN** it SHALL reuse the same frozen manifest
- **AND** it SHALL not substitute newly arrived mail

### Requirement: Every cross-account source reference is account-qualified

Mail, attachment, application-message, artifact-provenance, and typed-action references SHALL carry the source account ID together with the local object ID.

#### Scenario: User opens a source from another account

- **WHEN** a local-profile result links to an email outside the currently selected mailbox
- **THEN** WeMail SHALL switch or resolve the correct account and open that exact email

#### Scenario: Source account is disconnected

- **WHEN** a referenced account is no longer connected
- **THEN** the result SHALL retain a non-secret source label and unavailable state
- **AND** it SHALL not open a same-ID message from another account

### Requirement: Account connection changes do not silently change a claimed run

Connection changes MAY affect future dynamic-scope occurrences but SHALL not change an already claimed run or a fixed selected-account rule without explicit revision.

#### Scenario: Account disconnects after run claim

- **WHEN** an account disconnects after its references are frozen
- **THEN** the current run SHALL record account-unavailable according to partial/stop policy
- **AND** remaining account inputs MAY continue if the confirmed policy permits

#### Scenario: New account connects

- **WHEN** a new account is connected after an `allConnectedAccounts` rule was confirmed
- **THEN** the next occurrence MAY include it within the confirmed dynamic scope
- **AND** run detail SHALL record the resolved account set for that occurrence

### Requirement: Local-profile messages appear once and preserve account isolation

Message Center SHALL list a local-profile-owned automation result once while enforcing access to each account-qualified source.

#### Scenario: Cross-account result is listed

- **WHEN** “邮箱速览” publishes one result from three accounts
- **THEN** Message Center SHALL show one result rather than three duplicated account messages
- **AND** each source link SHALL enforce its own account ownership

#### Scenario: Unauthorized source is requested

- **WHEN** a route receives an account/reference pair outside the active local profile
- **THEN** it SHALL reject the request without revealing whether the source exists
