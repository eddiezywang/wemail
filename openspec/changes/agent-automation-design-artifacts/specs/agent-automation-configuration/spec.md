## MODIFIED Requirements

### Requirement: Agent automation capabilities match canonical rule capabilities
The built-in Agent SHALL discover and use the same Provider Registry descriptors, triggers, schedules, conditions, collection scopes, typed values, bindings, processors, actions, design capabilities, and delivery sinks as the UI and REST configuration surfaces.

#### Scenario: Provider capability becomes configurable
- **WHEN** a registered provider capability is enabled for user-created rules
- **THEN** Agent discovery and tool validation SHALL expose its canonical identity, parameters, output, risk, preview behavior, and fingerprint
- **AND** the Agent SHALL NOT require a private alternate representation

#### Scenario: WeCLI command exists but has no hard-coded action
- **WHEN** the installed WeCLI exposes a supported command through discovery
- **THEN** the Agent MAY configure it using the discovered command template and typed bindings
- **AND** WeMail SHALL NOT require a business-command-specific action branch

#### Scenario: Capability is unavailable
- **WHEN** a user's request requires an unregistered, disabled, missing, or ambiguous capability
- **THEN** the Agent SHALL explain the unsupported portion
- **AND** SHALL NOT invent a provider, capability, action type, parameter, or materially different substitute

### Requirement: Agent translates natural language into complete rule drafts
The Agent SHALL map user intent into a complete canonical V2 rule including trigger, timing, timezone, restart catch-up, condition, bounded scope, ordered pipeline, structured bindings, design mode or recipe where requested, delivery, authorization limits, and safety metadata.

#### Scenario: User requests a daily chart report
- **WHEN** the user says “每天上午九点汇总客户投诉邮件，生成趋势图并通知我”
- **THEN** the Agent SHALL draft a daily trigger in the user's timezone, latest-eligible catch-up, a bounded previous-schedule collection scope, complaint matching, dataset processing, a report or dashboard design step, and application-message delivery

#### Scenario: User requests invoice upload on receipt
- **WHEN** the user asks to upload matching PDF invoices after mail receipt
- **THEN** the Agent SHALL discover the actual WeCLI capability, select attachments in an earlier typed step, and bind those references to the discovered command template
- **AND** SHALL not create a raw `wecliCommand` or free-form `${attachments}` string

#### Scenario: A material default is absent
- **WHEN** timing, timezone, collection boundary, or another behavior-changing value is neither stated nor safely established by product defaults
- **THEN** the Agent SHALL obtain or clearly disclose the chosen value before confirmation

### Requirement: Agent previews before proposing a mutation
The Agent SHALL obtain a canonical two-level preview for every create or material update proposal: static compilation followed by a side-effect-free sample dry-run using the same matching and pipeline semantics as production.

#### Scenario: Static compilation succeeds
- **WHEN** the draft has valid provider capabilities, schemas, bindings, expansion, bounds, risk, and fingerprints
- **THEN** preview SHALL continue to a sample run and show resolved windows, matches, step plans, planned side effects, output summaries, warnings, and design preview where applicable

#### Scenario: Static compilation fails
- **WHEN** the draft contains an unknown action, invalid path, incompatible type, unavailable capability, or unbounded operation
- **THEN** preview SHALL return path-specific structured errors with expected values and repair guidance
- **AND** SHALL not collapse the result to only a generic invalid-action message

#### Scenario: Preview includes an external mutation
- **WHEN** a pipeline contains a WeCLI upload or another mutation
- **THEN** preview SHALL display the bounded resolved plan and risk without executing the mutation

### Requirement: Agent repair is bounded and preserves user intent
The Agent MAY automatically repair structured preview failures at most twice, SHALL submit a materially changed draft on each retry, and SHALL not remove core requested behavior, widen scope, lower risk, or substitute another action merely to pass validation.

#### Scenario: First draft uses an unsupported action type
- **WHEN** preview reports an unknown provider or action type
- **THEN** the Agent SHALL rediscover capabilities and repair the affected step
- **AND** MAY re-preview once the draft materially changes

#### Scenario: Two repairs fail
- **WHEN** two materially different repair attempts still fail
- **THEN** the Agent SHALL stop retrying, identify the blocking capability or schema, and state that no rule was created or enabled

### Requirement: Agent rule mutations require exact confirmation
Creating, materially updating, enabling after drift, disabling, deleting, or manually running an automation through the Agent SHALL use a WeMail-owned pending action; create and update confirmation SHALL commit exactly the unexpired preview snapshot identified by account, preview ID, rule hash, source revision, provider fingerprints, and authorization scope.

#### Scenario: User confirms rule creation
- **WHEN** the user confirms the structured card
- **THEN** the system SHALL persist exactly the previewed rule revision and runtime state
- **AND** future executions within that confirmed scope SHALL run without PI participating in each execution

#### Scenario: Preview or capability changed before confirmation
- **WHEN** the preview expired, source revision changed, rule hash differs, or a material capability drift occurred
- **THEN** confirmation SHALL fail closed
- **AND** the Agent SHALL rediscover and re-preview before offering another confirmation

#### Scenario: Confirmation contains defaults and risks
- **WHEN** a rule uses product defaults, restart catch-up, collection limits, external mutations, or design output
- **THEN** the confirmation SHALL disclose those values, ordered steps, sample results, warnings, side effects, and exact authorized capabilities
