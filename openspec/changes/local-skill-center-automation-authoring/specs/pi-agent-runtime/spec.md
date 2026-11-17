## ADDED Requirements

### Requirement: PI loads product Skills on demand
The PI runtime SHALL obtain enabled Skill metadata from the local Skill Registry, resolve relevant Skills for the current request, and load only selected Skill bodies and declared dependencies rather than globally concatenating every product Skill into every system prompt.

#### Scenario: Automation authoring is selected
- **WHEN** a user requests a durable automation rule
- **THEN** PI SHALL load the automation-authoring Skill and only the composable Skills needed by the requested pipeline

#### Scenario: Personal Skill is explicitly selected
- **WHEN** a user explicitly invokes an enabled personal Skill
- **THEN** PI SHALL bind the run to that exact active Skill version
- **AND** SHALL retain system safety policy and tool restrictions

### Requirement: Configuration goal outcome controls the user-facing conclusion
When an Agent run is linked to a canonical configuration session, the final user-facing status SHALL be derived from the latest configuration goal outcome and SHALL not be replaced by generic turn-completion success.

#### Scenario: Agent turn ends with blocked configuration
- **WHEN** PI successfully completes its conversational turn but the linked configuration status is blocked
- **THEN** the user-facing conclusion SHALL state that configuration is incomplete and blocked
- **AND** SHALL not display `执行结果：成功`

#### Scenario: Configuration awaits confirmation
- **WHEN** the current configuration status is awaiting final confirmation
- **THEN** the conclusion SHALL ask for the required confirmation
- **AND** SHALL not claim that the rule exists

#### Scenario: Configuration is verified complete
- **WHEN** exact commit and post-commit verification succeed
- **THEN** the conclusion MAY report configuration success with the verified rule and next occurrence summary
