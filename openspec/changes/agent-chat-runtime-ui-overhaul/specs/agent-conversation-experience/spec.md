## ADDED Requirements

### Requirement: Unified live and historical conversation rendering

The renderer SHALL use the same conversation state and component contracts for live SSE updates and persisted conversation history.

#### Scenario: Reload completed conversation

- **WHEN** a conversation containing reasoning, Markdown, tool calls, citations, and confirmations is reloaded
- **THEN** it SHALL preserve the same part ordering and business presentation used during live generation

### Requirement: Run process is temporary-first and inspectable

The renderer SHALL group provider-approved reasoning, WeMail-generated progress, tool execution, confirmations, and recoverable errors into one ordered process disclosure per assistant run. The disclosure SHALL remain expanded while the run is active and SHALL collapse automatically when the run settles, stops, fails, or is interrupted. Final answers and artifacts SHALL remain outside the process disclosure.

#### Scenario: Run completes after streaming visible process

- **WHEN** reasoning, progress, and tools have streamed and the run settles
- **THEN** the final answer SHALL remain visible
- **AND** the complete process SHALL collapse into an inspectable terminal summary
- **AND** the summary SHALL show the terminal state and elapsed time derived from the run's server timestamps when available

#### Scenario: Active run appends another process event

- **WHEN** an active run adds reasoning, progress, a tool update, or a confirmation
- **THEN** the process disclosure SHALL remain expanded
- **AND** the new event SHALL appear in canonical event order without moving the final answer into the disclosure

#### Scenario: Completed conversation is reloaded

- **WHEN** history loads an assistant run that already settled, stopped, failed, or was interrupted
- **THEN** its process disclosure SHALL be collapsed by default
- **AND** the user SHALL be able to expand it to inspect the complete visible process

### Requirement: Final answers use safe Markdown

The renderer SHALL render final answer Markdown with headings, paragraphs, lists, blockquotes, tables, task lists, links, horizontal rules, emphasis, and code blocks while blocking raw HTML, scripts, iframes, executable components, and remote Markdown images. External links SHALL use WeMail's safe-link handling and open in the system browser. Code blocks SHALL support copying but SHALL NOT support execution.

#### Scenario: Answer contains unsafe HTML and a remote image

- **WHEN** an answer contains raw HTML, an iframe, or a remote image URL
- **THEN** the unsafe content SHALL NOT execute or load
- **AND** supported Markdown content SHALL continue to render

#### Scenario: User opens an external Markdown link

- **WHEN** the user selects an external link in an Agent answer
- **THEN** WeMail SHALL apply its safe-link policy and open the destination in the system browser
- **AND** the Agent renderer SHALL NOT navigate to the external page

#### Scenario: User copies a code block

- **WHEN** the user selects the copy action on a code block
- **THEN** the code text SHALL be copied to the clipboard
- **AND** no code SHALL execute

### Requirement: Tool executions update stable cards

The renderer SHALL update one tool card per `toolCallId` through argument, execution, partial-result, success, and failure states.

#### Scenario: Tool emits partial and final results

- **WHEN** a tool execution emits multiple updates followed by completion
- **THEN** one card SHALL update in place
- **AND** duplicate cards SHALL NOT be appended

### Requirement: Tool detail uses progressive disclosure

Successful read-only tools SHALL be collapsed by default, failed tools and confirmations SHALL be expanded, and raw tool JSON SHALL NOT be the default user presentation. The ordinary user interface SHALL NOT provide a global action that expands every tool execution at once.

#### Scenario: Read tool succeeds and write tool needs confirmation

- **WHEN** a read tool succeeds and a mutation requests confirmation
- **THEN** the read card SHALL show a collapsed human-readable summary
- **AND** the confirmation card SHALL remain expanded with exact affected objects and parameters

### Requirement: Follow-up composer remains available during generation

The composer SHALL remain editable while a run is active and SHALL allow users to send messages into a visible, editable, removable, and reorderable follow-up queue without steering the active run.

#### Scenario: User sends a second message during generation

- **WHEN** the user sends another message while the current run is active
- **THEN** the message SHALL enter the follow-up queue
- **AND** the active run SHALL NOT change direction

#### Scenario: User reorders queued follow-ups

- **WHEN** multiple follow-ups are waiting and the user changes their order
- **THEN** the persisted queue order SHALL update
- **AND** later execution SHALL follow the new order

### Requirement: Unsent composer drafts remain separate from the run queue

The renderer SHALL preserve an unsent text draft per conversation locally, and SHALL NOT persist it as an executable follow-up until the user explicitly sends it.

#### Scenario: User switches conversations with unsent text

- **WHEN** the user types text without sending and switches to another conversation
- **THEN** returning to the original conversation SHALL restore its unsent draft
- **AND** no Agent run SHALL have been queued from that draft

### Requirement: Structured citations navigate to sources

Answers SHALL render structured inline citations that navigate to original mail or attachment sources, and tool names alone SHALL NOT be treated as sources.

#### Scenario: User opens a mail citation

- **WHEN** the user selects an inline mail citation
- **THEN** WeMail SHALL open the cited message in the main mail area
- **AND** the citation SHALL retain an unavailable state if its source no longer exists

### Requirement: Pending operations remain linked to their conversation

Pending operations SHALL appear at their originating conversation location and SHALL be recoverable through a lightweight pending count in the AI panel header without being copied into the Action Center.

#### Scenario: User leaves a conversation with a pending operation

- **WHEN** the user navigates away before resolving a confirmation
- **THEN** the AI panel SHALL indicate the pending count
- **AND** selecting the indication SHALL return to the originating conversation and card

### Requirement: Pending operations expire explicitly

Every pending operation SHALL include an explicit expiry time. An expired operation SHALL become read-only, SHALL NOT execute, and SHALL require a newly generated operation before the user can proceed.

#### Scenario: User opens an expired confirmation card

- **WHEN** the current time is later than the operation's `expiresAt`
- **THEN** confirmation controls SHALL be disabled
- **AND** the card SHALL explain that the operation must be generated again

### Requirement: Background notifications minimize interruption

Successful completion SHALL primarily update in-app state, while failures and confirmation requests MAY produce Windows notifications only when the app is not focused or the relevant conversation is not visible.

#### Scenario: Confirmation is requested while app is minimized

- **WHEN** a run requests confirmation while WeMail is minimized
- **THEN** a privacy-safe Windows notification SHALL be eligible for display
- **AND** selecting it SHALL navigate to the relevant confirmation card

### Requirement: Temporary dual UI ends in complete replacement

The implementation SHALL use a temporary old/new UI feature flag for stage-one acceptance and SHALL remove the old UI and flag after stage-two acceptance.

#### Scenario: Final acceptance passes

- **WHEN** all stage-two merge gates pass
- **THEN** the old renderer, compatibility adapter, and UI feature flag SHALL be removed
