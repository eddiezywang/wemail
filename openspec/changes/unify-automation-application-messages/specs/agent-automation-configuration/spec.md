## ADDED Requirements

### Requirement: Agent automation capabilities match canonical rule capabilities
The built-in Agent SHALL discover and use the same supported triggers, schedules, conditions, scopes, processors, and actions as the UI and REST configuration surfaces.

#### Scenario: Collection processor becomes configurable
- **WHEN** a registered collection processor is enabled for user-created rules
- **THEN** Agent capability discovery and tool validation SHALL expose its canonical parameters
- **AND** the Agent SHALL NOT require a private alternate representation

#### Scenario: Capability is unavailable
- **WHEN** a user's request requires an unregistered or disabled capability
- **THEN** the Agent SHALL explain the unsupported portion
- **AND** SHALL NOT invent a type or silently substitute materially different behavior

### Requirement: Agent translates natural language into complete rule drafts
The Agent SHALL map user intent into canonical trigger, condition, scope, processing, action, delivery, timezone, and safety fields, using active-account and focused-mail context only according to the established scope rules.

#### Scenario: User requests a daily digest notification
- **WHEN** the user says “每天上午十点通知我过去一天重要邮件的摘要”
- **THEN** the Agent SHALL draft a daily calendar trigger in the user's timezone, a bounded 24-hour collection scope, the requested importance condition, a digest processor, and application-message delivery

#### Scenario: Material timing is ambiguous
- **WHEN** the user asks for “每天早上通知我” and no default time is established
- **THEN** the Agent SHALL request the missing time before proposing a persistent rule

### Requirement: Agent previews before proposing a mutation
The Agent SHALL obtain a canonical preview snapshot for every create or update proposal and SHALL use the preview identifier and hash for the pending action.

#### Scenario: Preview succeeds
- **WHEN** the draft validates and preview completes
- **THEN** the Agent SHALL present the normalized trigger, scope, conditions, processing, delivery, match estimate, and warnings
- **AND** a subsequent proposal SHALL reference that exact preview snapshot

#### Scenario: User changes the draft after preview
- **WHEN** the user changes any material rule field
- **THEN** the Agent SHALL create a new preview
- **AND** the earlier preview SHALL NOT authorize the changed rule

### Requirement: Agent rule mutations require exact confirmation
Creating, updating, enabling, disabling, deleting, or manually running an automation through the Agent SHALL create a WeMail-owned pending action that displays the exact normalized change and requires explicit user confirmation.

#### Scenario: User confirms rule creation
- **WHEN** the user confirms a valid unexpired create proposal
- **THEN** the system SHALL persist exactly the previewed rule revision
- **AND** future executions within that revision's scope SHALL run without PI participating in each execution

#### Scenario: Source rule changed before confirmation
- **WHEN** an update proposal's source rule revision no longer matches the persisted rule
- **THEN** confirmation SHALL fail with a stale-preview result
- **AND** the Agent SHALL re-read and re-preview before offering another confirmation

### Requirement: Agent supports iterative rule editing
The Agent SHALL preserve the current canonical draft across conversational refinements and SHALL modify the intended rule rather than creating duplicates unless the user asks for a new rule.

#### Scenario: User adds an attachment constraint
- **WHEN** the user says “只看有 PDF 附件的” while refining a pending digest rule
- **THEN** the Agent SHALL add the constraint to the current draft
- **AND** SHALL retain the previously selected trigger, scope, processor, and delivery

#### Scenario: User asks to edit an existing rule by description
- **WHEN** multiple existing rules could match the user's description
- **THEN** the Agent SHALL list concise candidates and request disambiguation before proposing a mutation

### Requirement: Agent can explain rules and execution history
The Agent SHALL be able to read and explain canonical rule configuration, next-run time, recent run status, matched counts, processor outcomes, published message references, and failures using user-facing language.

#### Scenario: User asks why no notification arrived
- **WHEN** a scheduled rule has a recent failed or skipped run
- **THEN** the Agent SHALL inspect the rule and run records
- **AND** SHALL explain whether the cause was schedule, no matches, model availability, processor validation, delivery, or another recorded reason

### Requirement: Agent does not bypass rule or action safety
The Agent SHALL NOT directly write automation rows, execute unconfirmed rule mutations, embed arbitrary HTML, or execute typed message interactions outside their registered confirmation policy.

#### Scenario: User asks Agent to skip confirmation
- **WHEN** the user asks PI to create or materially modify a persistent rule without showing confirmation
- **THEN** PI SHALL still create a pending action
- **AND** SHALL NOT persist the mutation directly

#### Scenario: Rule includes a high-risk follow-up action
- **WHEN** the proposed rule or application-message interaction includes send, deletion, mailbox mutation, or WeCLI mutation
- **THEN** the confirmation presentation SHALL disclose the risk and exact authorized scope
- **AND** any later user-invoked interaction SHALL follow its own normal confirmation policy
