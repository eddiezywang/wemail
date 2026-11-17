## ADDED Requirements

### Requirement: Configuration workflow adoption is independently gated
WeMail SHALL independently gate canonical domain writes, Agent presentation, and Settings presentation so the new workflow can be shadowed, compared, enabled, and rolled back by surface.

#### Scenario: Canonical domain runs in shadow mode
- **WHEN** domain writes are enabled but new presentation is disabled
- **THEN** WeMail SHALL compare canonical and legacy outcomes
- **AND** SHALL expose only the legacy user interface

### Requirement: Legacy failures use compatibility adapters during migration
Existing Agent terminal failures, ordinary errors, provider errors, and REST errors SHALL pass through compatibility adapters that produce registered configuration issues for migrated flows.

#### Scenario: Adapter cannot classify a legacy error
- **WHEN** no registered mapping exists
- **THEN** the adapter SHALL use the unclassified system issue
- **AND** SHALL increment observable unclassified telemetry

### Requirement: Initial migration covers the highest-value recovery flows
The first migration cohort SHALL cover Agent automation create and update, automation provider discovery, WeCLI install and path recovery, mailbox authentication, supported external connections, stale previews, and capability drift.

#### Scenario: First cohort is enabled
- **WHEN** the first cohort feature flags are active
- **THEN** those flows SHALL use canonical task state across Agent and their corresponding Settings recovery entry points

### Requirement: Legacy paths are removed only after explicit gates pass
String-matched configuration outcomes and direct configuration writes SHALL remain available for rollback until parity, restart recovery, privacy, cross-surface consistency, unclassified-error, and no-duplicate-effect gates pass.

#### Scenario: Canonical and legacy outcomes disagree above threshold
- **WHEN** shadow telemetry shows disagreement above the release threshold
- **THEN** WeMail SHALL NOT switch the affected reader to the canonical workflow

### Requirement: Rollback preserves facts and effects
Disabling canonical readers or entry points SHALL retain task records and SHALL NOT delete committed configuration, replay effects, or invalidate independent audit data.

#### Scenario: Rollback follows a committed configuration
- **WHEN** feature flags are disabled after a canonical task committed a rule
- **THEN** the rule SHALL remain committed
- **AND** rollback SHALL only change routing and presentation behavior
