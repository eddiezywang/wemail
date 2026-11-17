## ADDED Requirements

### Requirement: Auto-approve only `ls` and `list`

The system SHALL classify a WeCLI command as `auto` if and only if its first positional argument is exactly `ls` or `list`; all other commands SHALL be classified `requires-confirmation`.

#### Scenario: ls is auto-approved

- **WHEN** `WecliCommandClassifier.classify({ args: ['ls', '--since', '7d'] })` is called
- **THEN** the result SHALL be `auto`

#### Scenario: anything else requires confirmation

- **WHEN** `WecliCommandClassifier.classify({ args: ['ticket', 'close', '123'] })` is called
- **THEN** the result SHALL be `requires-confirmation`

### Requirement: Confirmation enforced before mutation

The system SHALL refuse to execute a `requires-confirmation` command unless a matching `confirm` record exists from the current user within the confirmation token TTL.

#### Scenario: Execute without confirm is refused

- **WHEN** `execute` is invoked for a mutation command without a prior `confirm`
- **THEN** the runtime SHALL return an error indicating confirmation is required
- **AND** no process SHALL be spawned

#### Scenario: Execute after confirm proceeds

- **WHEN** `confirm` has been recorded within the TTL
- **THEN** `execute` SHALL spawn `wecli` with the approved args and `-f json` (unless an alternative format is explicitly present)

### Requirement: Every invocation is audited

The system SHALL append exactly one row to `wecli_audit_logs` for every WeCLI invocation attempt, including auto-approved, user-confirmed, refused-for-missing-confirmation, and failed executions.

#### Scenario: Auto-approved run produces an audit row

- **WHEN** an `ls` command runs to completion
- **THEN** a `wecli_audit_logs` row SHALL exist with classification `auto`, exit code, elapsed time, and outcome code

#### Scenario: Refused mutation produces an audit row

- **WHEN** a mutation command is refused for missing confirmation
- **THEN** a `wecli_audit_logs` row SHALL exist with classification `requires-confirmation` and outcome `refused`

### Requirement: JSON output where possible

The system SHALL invoke `wecli` with `-f json` when no format flag is specified, and SHALL attempt to parse the output as JSON.

#### Scenario: JSON parsing succeeds

- **WHEN** the `wecli` subcommand supports JSON output
- **THEN** the runtime SHALL return parsed JSON to the caller

### Requirement: No mail body in audit log

The system SHALL NOT write mail body or attachment bytes into `wecli_audit_logs`.

#### Scenario: Audit row stores only metadata

- **WHEN** any WeCLI invocation writes an audit row
- **THEN** the row SHALL contain command, args, classification, outcome, exit code, elapsed time, timestamps
- **AND** it SHALL NOT contain mail body or attachment content
