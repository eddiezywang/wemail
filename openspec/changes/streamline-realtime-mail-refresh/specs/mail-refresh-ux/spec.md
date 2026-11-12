## ADDED Requirements

### Requirement: Single manual mail refresh

The workbench SHALL expose one account-scoped manual refresh action and SHALL NOT require the user to choose incremental, lightweight, deep, day-window, UID, or cursor synchronization strategies.

#### Scenario: User opens the mail toolbar

- **WHEN** mail synchronization is available for the active account
- **THEN** the toolbar SHALL show one refresh action
- **AND** it SHALL NOT show a synchronization strategy dropdown

#### Scenario: User requests a refresh

- **WHEN** the user activates the refresh action
- **THEN** the renderer SHALL request an immediate account reconciliation without supplying a mode, day count, or deep flag
- **AND** the action SHALL cover all folders admitted by the account synchronization policy

### Requirement: Refresh feedback represents only the user request

The refresh control SHALL represent the lifecycle of the user-requested refresh and SHALL remain independent of ordinary list fetching, historical synchronization, body hydration, and intelligence work.

#### Scenario: Local mail query refetches

- **WHEN** React Query refetches a local mail list without a manual refresh request
- **THEN** the manual refresh icon SHALL NOT enter its running animation solely because of that refetch

#### Scenario: Historical repair continues

- **WHEN** a manual refresh completes while historical repair remains active
- **THEN** the refresh control SHALL return to its idle state
- **AND** historical progress MAY remain available in diagnostics without keeping the toolbar action busy

### Requirement: Refresh outcomes use normal mail-client language

The workbench SHALL communicate refresh outcomes without exposing internal synchronization counts or algorithms.

#### Scenario: No new mail is found

- **WHEN** a manual refresh completes successfully without visible mailbox changes
- **THEN** the workbench SHALL either remain silent or briefly indicate that mail is up to date
- **AND** it SHALL NOT present inserted/updated implementation counters

#### Scenario: Mail is discovered manually

- **WHEN** a manual refresh discovers new mail
- **THEN** the affected lists, folders, categories, and unread counts SHALL update
- **AND** the foreground desktop notification policy SHALL NOT notify redundantly for that manual discovery

#### Scenario: Credentials are invalid

- **WHEN** a manual refresh receives the shared credential-invalid result
- **THEN** the existing credential recovery interaction SHALL be shown
- **AND** the workbench SHALL NOT instruct the user to choose a deeper synchronization mode

### Requirement: Historical repair is not a routine toolbar action

Historical synchronization and repair SHALL be automatic or diagnostics-only and SHALL NOT appear as a daily receive-mail choice.

#### Scenario: User needs explicit diagnostics

- **WHEN** an authorized diagnostics surface offers a repair action
- **THEN** it SHALL describe the action as repairing mail synchronization
- **AND** it SHALL explain that the operation can continue in the background
