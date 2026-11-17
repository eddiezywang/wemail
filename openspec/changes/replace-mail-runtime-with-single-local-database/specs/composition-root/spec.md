## MODIFIED Requirements

### Requirement: Compose wemail services at app startup
The system SHALL use Electron Main as a lightweight supervisor and credential broker that starts DB Service, Mail Core, Bot Core, and lazy AI workers in dependency order, distributes scoped typed MessagePorts, and returns a lifecycle handle that stops them in reverse order. Main SHALL NOT construct or expose a shared writable SQLite database, DB Service mail API, synchronous mail read model, provider, queue runner, or intelligence processor on its own event loop.

#### Scenario: Successful composition
- **WHEN** Electron becomes ready with a canonical demo data directory
- **THEN** Main SHALL start DB Service and wait only for bounded readiness, start Mail Core and attach its Writer/client ports, attach trusted preload clients, and lazily admit optional workers
- **AND** DB Service SHALL be the only component that opens `wemail.sqlite`

#### Scenario: No account is logged in
- **WHEN** process composition completes without an authenticated account
- **THEN** Mail Core SHALL remain locally healthy without constructing an IMAP/SMTP provider
- **AND** saving credentials SHALL start only the affected account runtime

#### Scenario: Component shutdown
- **WHEN** application shutdown begins
- **THEN** Main SHALL stop accepting new client ports, request bounded worker shutdown, and terminate remaining children after deadlines
- **AND** it SHALL not wait indefinitely for a SQL, network, AI, or Renderer callback

## ADDED Requirements

### Requirement: Acyclic process requests
The runtime SHALL maintain an acyclic synchronous request graph: clients request DB Service, Main supervises and distributes ports, and DB Service publishes one-way events without synchronously calling a client.

#### Scenario: Writer publishes a commit
- **WHEN** Writer completes a transaction
- **THEN** DB Service SHALL publish a one-way change event after commit
- **AND** Writer or gateway SHALL not wait for Renderer, Mail Core, or AI acknowledgement

### Requirement: No control-loop blocking work
Electron Main, DB gateway, Mail Core control, Bot control, AI control, and Renderer event loops SHALL not execute SQL, MIME parsing, large serialization, unbounded iteration, or synchronous filesystem work on an interactive path.

#### Scenario: Large body is fetched
- **WHEN** Mail Core receives a large MIME message
- **THEN** parsing and persistence preparation SHALL run in a bounded worker path
- **AND** Mail Core control heartbeat SHALL continue independently

