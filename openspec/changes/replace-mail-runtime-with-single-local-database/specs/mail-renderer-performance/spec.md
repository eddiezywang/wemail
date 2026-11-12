## ADDED Requirements

### Requirement: Local-first message opening
Renderer SHALL render committed local metadata immediately and SHALL never wait for IMAP before displaying the message shell. Missing content SHALL affect only the body region.

#### Scenario: Cached body exists
- **WHEN** the user opens a message whose body is ready
- **THEN** Renderer SHALL read metadata and content from the Detail Reader
- **AND** cached body completion SHALL meet the defined P95 latency budget

#### Scenario: Body is missing
- **WHEN** the user opens a message whose body is missing
- **THEN** Renderer SHALL show local metadata and a body placeholder
- **AND** it SHALL atomically ensure or promote the P0 body job

### Requirement: Commit-event detail refresh
Renderer SHALL refresh content from exact post-commit change events and MUST NOT poll body state on a fixed interval.

#### Scenario: Body commit event arrives
- **WHEN** Renderer receives a content change containing message ID and commit version
- **THEN** it SHALL refetch only the affected committed detail
- **AND** no account-wide invalidation or one-second body poll SHALL be required

#### Scenario: Renderer misses events
- **WHEN** a client reconnects after its last commit version falls outside retained changes
- **THEN** it SHALL perform a bounded cache invalidation and establish a new version
- **AND** it SHALL not infer readiness from an uncommitted network result

### Requirement: Normalized bounded caches
Renderer SHALL store summaries once by public ID, store view caches as bounded ordered ID lists, bound detail retention with LRU, and release obsolete bodies, image resources, and blob URLs.

#### Scenario: Message belongs to multiple views
- **WHEN** the same message appears in Inbox, Important, and a tag
- **THEN** those views SHALL reference one normalized summary object
- **AND** they SHALL not retain three complete body objects

### Requirement: Rapid interaction cancellation
Mail selection, category switching, and search SHALL use cancellation or generation IDs so stale requests and renders cannot overwrite the latest user intent.

#### Scenario: User rapidly selects A, B, then C
- **WHEN** A or B finishes after C becomes selected
- **THEN** its result SHALL not replace C in the visible detail
- **AND** any completed body may still be committed for future local use

### Requirement: Bounded list and body rendering
Mail lists SHALL be virtualized and keyset-paginated. MIME parsing, charset conversion, sanitization, and other expensive preparation SHALL occur outside the Renderer event loop; sandboxed body layout work SHALL be bounded and frame-batched.

#### Scenario: Large HTML mail opens
- **WHEN** sanitized content exceeds the normal rendering budget
- **THEN** Renderer SHALL preserve metadata interactivity and progressively render or require explicit expansion
- **AND** no main-thread task SHALL exceed the configured long-task acceptance threshold without failure evidence

### Requirement: Interactive latency budgets
On the acceptance dataset, list DB P95 SHALL be below 50 ms, cached category switch P95 below 100 ms, cached detail metadata P95 below 100 ms, cached body completion P95 below 300 ms, P0 claim P95 below 50 ms, and default FTS first page P95 below 300 ms.

#### Scenario: Performance acceptance runs
- **WHEN** representative rapid interaction and background load scenarios execute
- **THEN** every stated P95 budget SHALL be measured end to end
- **AND** averages alone SHALL not satisfy acceptance

