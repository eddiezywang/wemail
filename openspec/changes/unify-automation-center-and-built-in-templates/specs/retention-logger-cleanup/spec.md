## ADDED Requirements

### Requirement: Automation run details and artifacts have explicit local retention

The retention service SHALL apply documented retention classes to automation step details, frozen manifests, generated artifacts, archived rules, and lightweight run summaries without using logout as a purge signal.

#### Scenario: Detailed run data reaches default expiry
- **WHEN** detailed step summaries, manifests, or generated artifacts are older than the default 30-day window and have no longer retention reference
- **THEN** the service SHALL remove eligible detail and artifact data
- **AND** it SHALL retain the lightweight run identity, status, timing, hashes, and explicit expired-detail marker

#### Scenario: Rule version is still referenced
- **WHEN** an application message, pending action, retained run, or current rule references an immutable rule or template version
- **THEN** retention SHALL preserve the referenced metadata required to explain that result

#### Scenario: Rule is archived
- **WHEN** a user archives an automation
- **THEN** retention SHALL not immediately delete its rule versions or run history
- **AND** permanent deletion SHALL remain a separate explicit operation

### Requirement: Automation observability never becomes a mail-body log

Automation run summaries, manifests, step audits, progress events, template metadata, and retention diagnostics SHALL exclude mail bodies, credentials, tokens, secret headers, and unrestricted local paths.

#### Scenario: Input manifest is persisted
- **WHEN** a run freezes selected mail
- **THEN** the manifest SHALL store account-qualified references, timestamps, selection reasons, and content hashes
- **AND** it SHALL not duplicate message bodies

#### Scenario: Artifact or source expires
- **WHEN** retained summary references data that has expired
- **THEN** the API SHALL return a typed unavailable/expired state
- **AND** logs SHALL not reconstruct or print the original content
