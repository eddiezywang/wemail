## ADDED Requirements

### Requirement: User-visible configuration issues use a central catalog
Every user-visible configuration issue code SHALL be registered with a category, safe default message, severity, responsibility, retryability, privacy classification, eligible recovery types, and notification policy.

#### Scenario: A handler returns an unregistered issue
- **WHEN** a configuration boundary receives an unregistered or unclassified failure
- **THEN** it SHALL map the failure to a stable unclassified system issue
- **AND** SHALL record telemetry without exposing raw exception content as the primary message

### Requirement: Configuration issue categories have stable semantics
The issue catalog SHALL distinguish missing information, unavailable dependency, unavailable provider, authentication, permission, unavailable resource, unsupported capability, validation, conflict, stale preview, capability drift, confirmation, policy, transient failure, execution failure, and unknown execution outcome.

#### Scenario: Optional executable is absent
- **WHEN** a requested configuration requires an optional local executable that is not available
- **THEN** the task SHALL be blocked with an unavailable-dependency issue
- **AND** SHALL NOT be classified as a generic execution failure

#### Scenario: Required user decision is missing
- **WHEN** a material configuration value cannot be inferred safely
- **THEN** the task SHALL need input rather than fail

### Requirement: Provider boundaries return structured operation results
Provider and tool adapters used by configuration workflows SHALL convert local exceptions into structured succeeded, unavailable, or failed operation results before returning to the workflow service.

#### Scenario: Provider throws an ordinary process error
- **WHEN** a provider catches a local process or transport exception
- **THEN** it SHALL return a registered issue with a declared effect state and retry policy
- **AND** raw error wording SHALL NOT determine the task status

### Requirement: Capability discovery tolerates partial provider availability
Capability discovery SHALL isolate provider results and return all available capabilities plus structured status for unavailable providers.

#### Scenario: Unrelated provider is unavailable
- **WHEN** one provider is unavailable but the requested goal uses another available provider
- **THEN** discovery SHALL retain the available capability
- **AND** the unrelated provider issue SHALL NOT block the task

#### Scenario: Required provider is unavailable
- **WHEN** the normalized goal depends on the unavailable provider
- **THEN** the workflow SHALL block at capability discovery
- **AND** SHALL preserve all earlier completed steps

### Requirement: Recovery actions are typed and policy-controlled
Every actionable issue SHALL expose typed recovery actions with labels, confirmation requirements, danger classification, and the earliest phase invalidated by successful recovery.

#### Scenario: Missing dependency has an installer
- **WHEN** a missing dependency has an approved optional installer
- **THEN** the issue MAY offer an install action requiring explicit confirmation
- **AND** cancellation SHALL leave unrelated product functionality available

#### Scenario: Authentication expires
- **WHEN** authentication is required to continue
- **THEN** the workflow SHALL offer an authentication or settings recovery action
- **AND** SHALL NOT attempt to authenticate without user interaction

### Requirement: Recovery revalidates derived facts
After recovery, the workflow SHALL resume from the earliest invalidated phase and revalidate active account, ownership, authentication, permissions, provider status, resource references, source revision, preview validity, capability fingerprints, and authorization as applicable.

#### Scenario: Dependency installation completes
- **WHEN** the user completes an optional dependency installation
- **THEN** the workflow SHALL rerun prerequisite and capability checks
- **AND** SHALL NOT blindly replay the previously failed tool invocation

### Requirement: Retry policy is effect-aware
The workflow SHALL automatically retry only read-only or explicitly idempotent operations with a retryable issue and a safe effect state.

#### Scenario: External mutation outcome is unknown
- **WHEN** an external mutation has an unknown effect state
- **THEN** the workflow SHALL prohibit automatic retry
- **AND** SHALL require reconciliation or user-directed recovery
