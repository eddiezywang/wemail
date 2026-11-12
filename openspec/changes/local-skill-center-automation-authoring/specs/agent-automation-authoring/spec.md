## ADDED Requirements

### Requirement: Agent distinguishes one-shot execution from durable automation

The Agent SHALL classify whether the user requests an immediate one-time pipeline, a durable triggered rule, a preview revision, or Skill creation before starting a configuration workflow.

#### Scenario: User requests today's report once

- **WHEN** the user asks to organize today's related data and send an image now
- **THEN** the Agent SHALL use the relevant pipeline Skills without creating a trigger or durable rule

#### Scenario: User requests the report every day

- **WHEN** the user asks for the same report at a daily local time
- **THEN** the Agent SHALL start durable automation authoring

### Requirement: Triggers combine event, match, and timing

Automation triggers SHALL represent an activation event, optional matching conditions, and a timing policy so scheduled runs and delayed mail-event runs use one explicit model.

#### Scenario: Daily scheduled trigger

- **WHEN** the user requests execution every day at 21:00
- **THEN** the draft SHALL contain a scheduled event, daily timing, and the resolved IANA timezone

#### Scenario: Delayed invoice-mail trigger

- **WHEN** the user requests execution two hours after receiving an invoice mail
- **THEN** the draft SHALL contain a mail-received event, invoice matching semantics, and a two-hour delay policy

### Requirement: Automation authoring follows a canonical state machine

The system SHALL persist configuration state across intent collection, capability resolution, draft compilation, intermediate review, final confirmation, commit, verification, completion, failure, cancellation, and recovery.

#### Scenario: Application restarts during review

- **WHEN** WeMail restarts while a configuration waits for artifact feedback
- **THEN** the configuration session SHALL restore the current draft, preview version, review state, and next interaction

#### Scenario: Duplicate failure is observed

- **WHEN** the same phase, issue code, affected scope, and recovery are observed more than once
- **THEN** the workflow SHALL retain one current semantic issue and one set of recovery actions

### Requirement: Readiness is computed before final confirmation

The system SHALL permit final rule confirmation only when trigger, data scope, pipeline, capability availability, required current-version reviews, static validation, sample preview, delivery policy, and unresolved-issue checks all pass.

#### Scenario: Chart review is still pending

- **WHEN** the report artifact checkpoint has not been accepted
- **THEN** the Agent SHALL continue the review conversation
- **AND** SHALL not offer final rule creation

#### Scenario: Upstream revision invalidates an accepted preview

- **WHEN** a required accepted checkpoint becomes stale
- **THEN** readiness SHALL return false until a compatible new preview is accepted

### Requirement: Final rule creation requires a separate exact confirmation

Intermediate preview acceptance SHALL NOT create a rule. After all readiness gates pass, the Agent SHALL summarize the complete trigger, data, analysis, artifact, delivery, defaults, risks, and failure policy and require explicit authorization to create and enable the exact snapshot.

#### Scenario: User accepts a chart

- **WHEN** the user accepts the current chart preview
- **THEN** only the artifact checkpoint SHALL become accepted
- **AND** no automation rule SHALL be created

#### Scenario: User confirms final rule

- **WHEN** the user explicitly confirms the current complete rule preview
- **THEN** the system SHALL commit exactly the bound preview ID, rule hash, recipe hashes, Skill versions, capability contracts, account, and authorization scope

#### Scenario: User declines final rule

- **WHEN** the user declines or cancels at final confirmation
- **THEN** no rule SHALL be created or enabled

### Requirement: Commit success is verified before reporting completion

After mutation, the system SHALL reload the rule and runtime state and verify identity, version, enabled state, next occurrence, compiled recipes, Skill snapshots, and delivery policy before reporting configuration success.

#### Scenario: Commit returns but verification fails

- **WHEN** the create request returns without a matching persisted and scheduled rule
- **THEN** configuration SHALL be failed or blocked according to the observed effect state
- **AND** the Agent SHALL NOT report success

### Requirement: Confirmed automation runs without the general Agent

Each automatic occurrence SHALL load the immutable confirmed rule revision and execute its bounded capabilities and compiled recipes without invoking the general conversational Agent or dynamically selecting new Skills.

#### Scenario: Daily report occurrence begins

- **WHEN** the scheduler claims a confirmed daily report occurrence
- **THEN** the runtime SHALL collect data, run the fixed analysis recipe, render the accepted artifact recipe, publish, and deliver according to the stored pipeline
- **AND** SHALL not ask PI to redesign the workflow

### Requirement: Capability failures are localized

A missing, disconnected, unauthenticated, or unavailable optional capability SHALL block only the dependent pipeline portion and SHALL preserve unaffected draft work and reviews.

#### Scenario: No Bot is connected

- **WHEN** report generation is valid but no Feishu or WeCom Bot is connected
- **THEN** the Agent SHALL explain that only delivery is unresolved
- **AND** SHALL offer connection, message-center-only, or cancellation choices without claiming the entire authoring service is unavailable

#### Scenario: WeCLI is not installed

- **WHEN** a rule does not use a WeCLI capability
- **THEN** missing WeCLI SHALL have no effect on authoring or execution

#### Scenario: WeCLI is required

- **WHEN** the requested pipeline explicitly requires a known WeCLI-backed capability and WeCLI is not installed
- **THEN** only that step SHALL be blocked
- **AND** the Agent SHALL offer the policy-approved installation or adjustment path

### Requirement: Connected Bot resolution is explicit

Bot delivery SHALL resolve current Feishu and WeCom connection state and SHALL record an explicit destination or fallback policy before final confirmation.

#### Scenario: Exactly one Bot is connected

- **WHEN** exactly one supported Bot is ready
- **THEN** `bot.sendConnected` MAY resolve to that destination and disclose it in the final preview

#### Scenario: Both Bots are connected

- **WHEN** both Feishu and WeCom are ready and no preference is established
- **THEN** the Agent SHALL obtain whether to send to both or use a priority order before final confirmation

#### Scenario: Message Center succeeds and Bot fails

- **WHEN** an occurrence publishes its artifact locally but Bot delivery fails
- **THEN** the run SHALL record partial success and the failed delivery step
- **AND** SHALL not report the entire occurrence as fully successful

### Requirement: Chat projects the next user interaction

For active authoring, the system SHALL project a concise user message, current stage, completion impact, available actions, preview links, and optional technical details rather than exposing the full durable task object as the primary interaction.

#### Scenario: Capability resolution needs user action

- **WHEN** a real connection or authorization prerequisite blocks one step
- **THEN** the chat SHALL identify the affected stage and offer relevant inline actions
- **AND** technical codes and call identifiers SHALL remain collapsed unless requested
