## ADDED Requirements

### Requirement: One authoritative runtime health model
The system SHALL report DB lanes, Writer queue, account session roles, circuit breakers, durable queue counts, current work, next due work, last metadata/body success, restart counts, event-loop lag, and resource state from the active runtime. Legacy worker status SHALL NOT be exposed as current state.

#### Scenario: Mail Core owns body work
- **WHEN** an account worker has queued or active body work
- **THEN** sync status SHALL report that Mail Core state
- **AND** it SHALL not report a stopped legacy body worker as the authoritative status

### Requirement: Whole-process resource governance
Electron Main SHALL aggregate memory and CPU across the repository Electron process tree, while utility processes SHALL publish heap, event-loop, queue, and active-work metrics. Admission MUST NOT rely on one process's working set.

#### Scenario: Aggregate memory crosses high water
- **WHEN** total private memory reaches the configured pressure threshold
- **THEN** background AI, attachments, history, caches, and idle workers SHALL be shed in order
- **AND** P0 interaction and realtime metadata capacity SHALL be preserved

### Requirement: Bounded failure isolation and restart
Health supervision SHALL restart the smallest failed unit and SHALL apply restart budgets and circuit breaking to prevent process restart storms.

#### Scenario: Detail Reader heartbeat expires
- **WHEN** only the Detail Reader misses its heartbeat
- **THEN** DB Service SHALL restart that reader
- **AND** it SHALL not restart DB Service, Mail Core, IMAP, or Renderer

#### Scenario: Utility process repeatedly crashes
- **WHEN** a utility process exceeds its restart budget
- **THEN** Main SHALL open a degraded circuit state and surface actionable diagnostics
- **AND** it SHALL not continue an unbounded restart loop

### Requirement: End-to-end mail-open tracing
The system SHALL correlate click, local query, ensure/promotion, claim, provider fetch, parse, Writer queue, commit, change event, local refetch, and body paint using redacted trace IDs and P50/P95/P99 timings.

#### Scenario: Uncached body is slow
- **WHEN** an open-mail trace exceeds its latency target
- **THEN** diagnostics SHALL identify queue versus handler versus network versus render time
- **AND** no body content or credential SHALL appear in telemetry

### Requirement: Reference memory acceptance
On the reference Windows device, total private memory P95 SHALL remain below 500 MB while reading and below 600 MB during background sync, with a 650 MB hard pressure threshold unless an updated measured budget is explicitly accepted.

#### Scenario: Concurrency acceptance
- **WHEN** history sync, rapid opening, search, new mail, local mutations, and AI run together
- **THEN** memory, event-loop, heartbeat, queue, and restart budgets SHALL remain within acceptance
- **AND** the system SHALL produce a failure report for any breach

