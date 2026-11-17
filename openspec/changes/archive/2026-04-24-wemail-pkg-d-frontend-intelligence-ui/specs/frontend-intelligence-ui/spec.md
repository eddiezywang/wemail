## ADDED Requirements

### Requirement: Summary, tags, and draft surfaces in the email detail view

The renderer SHALL display the per-message summary, smart tags, and smart draft for the currently open message, each with clearly distinguishable empty / pending / success / failed states.

#### Scenario: Pending job while waiting for LLM

- **WHEN** a message has an in-flight `summary` job
- **THEN** `EmailSummaryCard` SHALL render a "pending" state with a non-blocking indicator

#### Scenario: Failed job shows actionable message

- **WHEN** a message has a `summary` job in `failed` status with attempts exhausted
- **THEN** `EmailSummaryCard` SHALL render a "failed" state explaining that retries are exhausted, without showing the raw error body

### Requirement: Queue status badge

The renderer SHALL display a global queue status indicator showing the count of pending / in-flight / failed jobs.

#### Scenario: Badge reflects queue state

- **WHEN** `mail_jobs` has pending and failed rows
- **THEN** `QueueStatusBadge` SHALL show both counts, fetched from the queue API

### Requirement: Agent action confirm dialog

The renderer SHALL provide a reusable `AgentActionConfirmDialog` with props `{ title, command, rationale, risk, onApprove, onReject }`, used by WeCLI mutation commands and agent actions that require confirmation.

#### Scenario: Confirmation required for mutation command

- **WHEN** an agent or WeCLI flow requests a command that is not `ls/list`
- **THEN** `AgentActionConfirmDialog` SHALL be shown before execution
- **AND** nothing SHALL execute until `onApprove` is invoked

### Requirement: Existing read and draft flows unchanged

The renderer SHALL integrate the new components incrementally so that the existing mail read and compose flows continue to work when intelligence data is absent.

#### Scenario: Detail view works without intelligence data

- **WHEN** a message has no summary, tags, or draft records yet
- **THEN** `EmailPanel` SHALL still render the message with its existing read experience
- **AND** the new components SHALL show their empty states
