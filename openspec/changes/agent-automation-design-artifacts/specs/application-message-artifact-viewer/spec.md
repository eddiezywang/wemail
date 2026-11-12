## ADDED Requirements

### Requirement: Application messages may reference complete Message Artifacts
The system SHALL allow an application message to retain an optional validated artifact ID/version in addition to its existing safe structured content, source references, interactions, severity, and read/archive state.

#### Scenario: Automation publishes a designed report
- **WHEN** a Design Provider output is published
- **THEN** the message SHALL store a bounded title, preview, key metrics, source rule/run, and exact artifact reference
- **AND** the message-list response SHALL not embed the complete HTML bundle

#### Scenario: Message has no artifact
- **WHEN** an informational message uses only existing structured blocks
- **THEN** it SHALL continue to render without an artifact or viewer dependency

### Requirement: Every formal Agent artifact is persistently delivered
Every successful one-shot Agent execution that produces one or more formal report, chart, dashboard, brief, or deck artifacts SHALL create a persistent application message for each distinct artifact by default and SHALL return a structured artifact reference to the originating conversation.

#### Scenario: Agent generates a one-shot report
- **WHEN** the execution pipeline persists a formal artifact
- **THEN** the system SHALL create an account-scoped application message that references the exact artifact ID and version
- **AND** the Agent conversation SHALL display a structured artifact card for the same persisted result
- **AND** both entry points SHALL open the same isolated in-workbench viewer

#### Scenario: One execution produces multiple artifacts
- **WHEN** multiple distinct formal artifact references are present in the successful pipeline outputs
- **THEN** each artifact SHALL receive one idempotent application-message delivery
- **AND** the conversation SHALL expose each result without embedding its complete HTML

#### Scenario: Assistant also emits an HTML code block
- **WHEN** a formal structured artifact reference is available
- **THEN** the raw code block SHALL NOT be treated as the durable delivery mechanism
- **AND** only the validated structured reference SHALL be executable in the Artifact Viewer

#### Scenario: User requests a one-shot chart or report
- **WHEN** no durable automation rule is requested and the Agent has gathered a bounded structured dataset
- **THEN** the Agent SHALL call the direct trusted design-artifact publication capability
- **AND** the application-owned renderer SHALL create the HTML and charts
- **AND** the capability SHALL atomically persist the artifact and its application message before reporting success
- **AND** the Agent SHALL NOT require a multi-checkpoint automation configuration flow

### Requirement: Message-center list items remain lightweight
The desktop client SHALL display artifact-backed messages using bounded metadata and SHALL fetch artifact resources only after the user opens the complete result.

#### Scenario: User browses one hundred messages
- **WHEN** the message list contains artifact-backed and structured messages
- **THEN** listing SHALL not load every artifact HTML, dataset, chart specification, or asset
- **AND** unread counts and scrolling SHALL remain independent of artifact size

#### Scenario: Run was a delayed catch-up
- **WHEN** the source automation executed after its planned time because the application was closed
- **THEN** the list or detail surface SHALL visibly indicate delayed catch-up without presenting it as an on-time run

### Requirement: Complete artifacts open inside an isolated WeMail viewer
The client SHALL open validated artifacts inside the workbench using an opaque-origin sandboxed browser surface and SHALL support the interaction capabilities declared by the artifact manifest.

#### Scenario: User opens a report
- **WHEN** the selected artifact kind is `report` or `dashboard`
- **THEN** the viewer SHALL support vertical reading and only the declared trusted chart, filter, collapse, table, or copy interactions

#### Scenario: User opens a deck
- **WHEN** the selected artifact kind is `deck`
- **THEN** the viewer SHALL provide a fixed 16:9 stage, keyboard navigation, page count, optional fullscreen, and reduced-motion behavior

#### Scenario: Artifact is unavailable or invalid
- **WHEN** the artifact expired, is missing, fails hash validation, or cannot be rendered safely
- **THEN** the message SHALL remain readable from its persisted summary
- **AND** the viewer SHALL show an actionable unavailable state without executing partial content

### Requirement: Artifact resources are account-scoped and manifest-scoped
Artifact APIs SHALL return only resources declared by the exact authorized manifest after validating active-account ownership, artifact version, resource name, content hash, and safe content type.

#### Scenario: Another account requests an artifact
- **WHEN** a client requests an artifact belonging to a different account
- **THEN** the API SHALL return no manifest, HTML, data, chart, provenance, or asset content

#### Scenario: Client requests an undeclared path
- **WHEN** a client requests directory traversal, an arbitrary relative path, or a resource absent from the manifest
- **THEN** the API SHALL reject the request

### Requirement: Artifact viewing prohibits active remote and host-privileged behavior
The viewer SHALL prohibit remote network resources, arbitrary navigation, popups, forms, downloads unless explicitly provided by a reviewed host control, same-origin access, Node integration, preload access, Electron IPC, shell access, and permission prompts.

#### Scenario: Artifact attempts remote tracking
- **WHEN** artifact HTML or CSS references a remote image, font, stylesheet, script, frame, media resource, fetch endpoint, or WebSocket
- **THEN** the resource SHALL not load
- **AND** no account, mail, machine, or viewing metadata SHALL be sent remotely

#### Scenario: Artifact attempts host messaging
- **WHEN** an artifact posts an unsupported or spoofed message to its parent
- **THEN** the host SHALL reject it unless it comes from the exact active frame and matches an allowlisted typed event

### Requirement: Artifact interactions remain typed and policy-controlled
Artifact controls SHALL emit only registered navigation or local presentation interactions, and any requested mutation SHALL use the normal pending-action confirmation path.

#### Scenario: User opens a referenced email
- **WHEN** an artifact requests `openEmail` for an authorized source reference
- **THEN** WeMail SHALL navigate to that mail without granting other artifact privileges

#### Scenario: Artifact proposes an external upload
- **WHEN** an artifact offers a follow-up upload action
- **THEN** the host SHALL create an exact-parameter pending action under the current policy
- **AND** the artifact SHALL not execute the provider directly

### Requirement: Desktop notifications deep-link to persisted messages
Eligible desktop notifications for artifact-backed results SHALL be created only after the application message is persisted and SHALL contain only an allowlisted title, bounded preview, or count.

#### Scenario: User selects the desktop notification
- **WHEN** the notification is activated
- **THEN** WeMail SHALL restore the owning account and open the persisted application message
- **AND** the complete artifact SHALL load only through the authenticated viewer flow
