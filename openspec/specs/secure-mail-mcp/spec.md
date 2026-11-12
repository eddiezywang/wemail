# secure-mail-mcp Specification

## Purpose
TBD - created by archiving change expose-secure-mail-mcp. Update Purpose after archive.
## Requirements
### Requirement: Opt-in loopback Streamable HTTP transport

The system SHALL expose a standards-compatible Streamable HTTP MCP endpoint from the existing local API process only while MCP is enabled, SHALL bind it to a stable configurable loopback listener independent from the renderer API's ephemeral port, and SHALL preserve that endpoint across normal application restarts.

#### Scenario: Disabled MCP is unreachable

- **WHEN** the user has not enabled MCP or has disabled it
- **THEN** `/mcp` SHALL NOT accept initialization or tool calls
- **AND** no reusable MCP access token SHALL be created implicitly

#### Scenario: Desktop restarts with MCP enabled

- **WHEN** WeMail restarts normally with MCP enabled and the configured MCP port available
- **THEN** the MCP listener SHALL return on the same loopback endpoint
- **AND** previously copied host configuration SHALL not require an ephemeral-port update

#### Scenario: Configured MCP port is occupied

- **WHEN** the stable MCP loopback port cannot be bound
- **THEN** MCP SHALL remain unavailable and the panel SHALL expose a safe actionable port-conflict state
- **AND** the normal renderer API and mailbox UI SHALL still start

#### Scenario: Client initializes a supported session

- **WHEN** an authenticated client sends `initialize` with a supported protocol version
- **THEN** the server SHALL return its server identity, negotiated protocol version, and accurately advertised capabilities
- **AND** the returned session id SHALL be cryptographically random, bearer-bound, and idle-expiring

#### Scenario: Unsupported protocol feature is requested

- **WHEN** a client requests an unadvertised Resources, Prompts, Tasks, Sampling, or other unsupported method
- **THEN** the server SHALL return a protocol-correct method or capability error
- **AND** it SHALL NOT execute a fallback operation

#### Scenario: Session is terminated

- **WHEN** a client deletes its MCP session, the token is revoked, the idle timeout elapses, or WeMail shuts down
- **THEN** the server SHALL cancel cancellable in-flight reads and release session resources
- **AND** it SHALL NOT cancel a provider mutation whose durable commit has already begun

### Requirement: Revocable MCP access credentials

The system SHALL authenticate every MCP protocol request using an MCP-specific bearer token and SHALL support one-time token display, rotation, revocation, and redacted metadata.

#### Scenario: Token is created

- **WHEN** the user explicitly creates an MCP token in WeMail
- **THEN** the plaintext token SHALL be shown exactly once
- **AND** persisted state SHALL contain only secret-store material, a verifier or fingerprint, status, and lifecycle timestamps

#### Scenario: Invalid or revoked token is used

- **WHEN** a request contains a missing, malformed, unknown, expired, or revoked bearer token
- **THEN** the request SHALL fail before session or tool processing
- **AND** the response and logs SHALL NOT reveal whether any mailbox account exists

#### Scenario: Token is rotated

- **WHEN** the user rotates the active MCP token
- **THEN** the replacement SHALL become usable and the prior token SHALL be revoked atomically
- **AND** sessions authenticated by the prior token SHALL be terminated

#### Scenario: Mail account is logged out or replaced

- **WHEN** the active mail account logs out or is replaced
- **THEN** all MCP access tokens and sessions SHALL be revoked
- **AND** no prior MCP credential SHALL gain access to a subsequently configured mailbox

#### Scenario: Server is configured for a non-loopback address

- **WHEN** MCP startup resolves to a non-loopback bind address without a future explicit secure-remote mode
- **THEN** MCP startup SHALL fail closed
- **AND** the normal local API and mailbox SHALL remain usable

### Requirement: Versioned independently allowlisted public registry

The system SHALL expose MCP tools through a versioned public registry that is independent from internal Agent tool registration and that declares each tool's input schema, output schema, risk class, and limits.

#### Scenario: Internal tool is not public

- **WHEN** an internal Agent, Curator, automation, directory, configuration, workspace, or WeCLI tool is registered without an explicit MCP public-registry entry
- **THEN** it SHALL NOT appear in `tools/list`
- **AND** an MCP call using its internal name SHALL be rejected as unknown

#### Scenario: Public tool catalog is listed

- **WHEN** an initialized client calls `tools/list`
- **THEN** the server SHALL return only the approved v1 MCP catalog
- **AND** every entry SHALL have a stable name, description, strict input schema, and output schema

#### Scenario: Tool input includes an unknown property

- **WHEN** a tool call includes a field not allowed by its schema
- **THEN** the call SHALL fail validation before domain or provider work begins

### Requirement: Provider capability discovery

The system SHALL expose non-secret account and provider capabilities so clients can select supported behavior without learning credentials or provider tokens.

#### Scenario: Current account is listed

- **WHEN** `list_mail_accounts` runs with an authenticated local session
- **THEN** it SHALL return the account id, provider kind, address/display metadata, and versioned capabilities
- **AND** it SHALL omit IMAP/SMTP endpoints when sensitive, passwords, OAuth tokens, cookies, and provider session data

#### Scenario: Provider lacks a capability

- **WHEN** a client calls a tool whose required provider capability is false or unavailable
- **THEN** the tool SHALL return `capability_not_supported`
- **AND** it SHALL NOT emulate the operation with a semantically different unsafe behavior

#### Scenario: Folder model is listed

- **WHEN** `list_mail_folders` runs for an owned account
- **THEN** it SHALL return stable provider folder/label ids, names, roles, and selectability metadata
- **AND** it SHALL distinguish provider folders or labels from WeMail-only virtual views

#### Scenario: Continuing sync status is read

- **WHEN** `get_mail_sync_status` is called with a sync operation id returned by `sync_mail_account`
- **THEN** it SHALL return bounded coordinator phase, progress, checkpoint, error category, and terminal-state metadata
- **AND** it SHALL not return mail bodies or provider credentials

### Requirement: Bounded account-isolated pagination

The system SHALL paginate message, search, draft, thread, and todo collections with opaque cursors bound to account, normalized query, ordering, and expiration.

#### Scenario: First page is requested without a cursor

- **WHEN** a collection tool is called without a cursor
- **THEN** it SHALL apply its documented default page size and hard maximum
- **AND** it SHALL return an opaque next cursor only when more results exist

#### Scenario: Cursor is reused for another query or account

- **WHEN** a cursor is supplied with a different account, tool, filters, search query, or sort order
- **THEN** the tool SHALL return `invalid_cursor`
- **AND** it SHALL expose no results from either scope

#### Scenario: Large mailbox is paged

- **WHEN** the matching collection is larger than one page
- **THEN** producing a page SHALL keep provider, repository, and response memory bounded by configured page limits
- **AND** it SHALL NOT materialize every matching message solely to create the page

### Requirement: Envelope-only list and search results

The system SHALL return body-free envelope records from `list_mail_messages` and `search_mail`.

#### Scenario: Messages are listed

- **WHEN** `list_mail_messages` returns one or more messages
- **THEN** each item SHALL contain account/message identifiers, folder, sender, subject, snippet, date, message flags, and whether attachments exist
- **AND** it MAY contain a thread id when available
- **AND** it SHALL NOT contain body text, body HTML, raw headers, attachment bytes, or complete tracking URLs extracted from the body

#### Scenario: Provider search runs

- **WHEN** `search_mail` is called and the account advertises server search
- **THEN** it SHALL preserve provider query semantics and return envelope-only results
- **AND** it SHALL paginate results without hydrating complete bodies

#### Scenario: Local fallback search is used

- **WHEN** provider search is unavailable but the documented local search mode can satisfy the request
- **THEN** the result SHALL identify the search mode used
- **AND** it SHALL still return envelope-only records

### Requirement: Targeted bounded message and thread reads

The system SHALL return mail bodies only through a targeted `get_mail_message` or `get_mail_thread` call with explicit limits and untrusted-content metadata.

#### Scenario: Message is read with defaults

- **WHEN** `get_mail_message` is called for an owned message without body options
- **THEN** it SHALL return plain text up to 6,000 characters by default
- **AND** it SHALL omit body HTML and report whether content was truncated

#### Scenario: Larger body limit is requested

- **WHEN** a client requests a valid body limit above the default
- **THEN** the server SHALL enforce the v1 per-message maximum of 20,000 characters
- **AND** the response SHALL report truncation and omitted content metadata

#### Scenario: Thread exceeds one response

- **WHEN** a targeted thread contains more messages or body content than the thread response limit
- **THEN** `get_mail_thread` SHALL return a bounded page and next cursor
- **AND** limits SHALL apply independently to each included message and to the total response

#### Scenario: Message body contains instructions

- **WHEN** provider content includes text that resembles system instructions, tool requests, credentials requests, or confirmation language
- **THEN** the server SHALL return it only as untrusted message content
- **AND** message content SHALL NOT change tool authorization, risk classification, or confirmation state

### Requirement: Embedded attachment resources

The system SHALL deliver targeted attachment bytes as MCP embedded resources after validating account/message ownership, attachment identity, MIME type, and size.

#### Scenario: Supported attachment is fetched

- **WHEN** `get_mail_attachment` is called for an owned attachment within provider and WeMail size limits
- **THEN** it SHALL return an embedded resource with a session-bound `wemail-attachment://` URI, MIME type, filename metadata, and bytes
- **AND** attachment bytes SHALL NOT be embedded in a JSON text field or written to logs

#### Scenario: Attachment is too large or mismatched

- **WHEN** the attachment exceeds the lower of provider and WeMail limits or detected content conflicts with its declared type
- **THEN** the tool SHALL fail with a stable typed error
- **AND** it SHALL NOT return partial bytes as if the attachment were complete

#### Scenario: Resource URI is reused outside its session

- **WHEN** a client attempts to dereference a session-bound attachment URI from another or expired session
- **THEN** access SHALL be denied

### Requirement: Session-scoped outbound attachment staging

The system SHALL accept outbound attachment bytes only through a bounded `upload_mail_attachment` step and SHALL pass opaque references, rather than inline Base64, to draft and send tools.

#### Scenario: Attachment is staged

- **WHEN** a client uploads one canonical Base64 attachment whose decoded size matches its declaration and stays within the per-item limit
- **THEN** the system SHALL return an opaque reference and byte-free metadata
- **AND** the reference SHALL be bound to the authenticated MCP session and account and expire after 15 minutes

#### Scenario: Draft or send resolves attachments

- **WHEN** draft creation, draft update, or send preparation receives attachment references
- **THEN** a new attachment SHALL use a live upload reference from the current session and account
- **AND** an existing attachment id SHALL be accepted only when it belongs to the referenced draft
- **AND** the final ordered set SHALL contain at most 20 attachments and at most 25 MiB decoded in aggregate

#### Scenario: Attachment list is omitted

- **WHEN** an existing draft operation omits `attachments`
- **THEN** the current attachment set SHALL be retained

#### Scenario: Attachment list is cleared

- **WHEN** an existing draft operation supplies an empty `attachments` array
- **THEN** all attachments SHALL be removed

#### Scenario: Attachment list is replaced

- **WHEN** an existing draft operation supplies a non-empty `attachments` array
- **THEN** that array SHALL define the complete final attachment order

#### Scenario: Upload lifecycle ends

- **WHEN** an upload expires, its MCP session terminates, or the MCP composition shuts down
- **THEN** its temporary bytes SHALL be removed from memory
- **AND** another account or session SHALL receive the same not-found result as an unknown reference

### Requirement: Draft operations never send

The system SHALL expose account-scoped provider or local draft list, read, create, and update tools that cannot dispatch mail.

#### Scenario: Draft is created or updated

- **WHEN** `create_mail_draft` or `update_mail_draft` validates recipients, subject, bodies, attachments, and optional source message
- **THEN** it SHALL persist or update an unsent draft and return bounded draft metadata
- **AND** it SHALL make no call to provider send or SMTP dispatch

#### Scenario: Draft list is returned

- **WHEN** `list_mail_drafts` runs
- **THEN** it SHALL return paginated metadata and bounded body excerpts
- **AND** complete bodies SHALL require `get_mail_draft`

#### Scenario: Draft deletion is requested

- **WHEN** an MCP client requests deletion of a saved draft
- **THEN** it SHALL use `prepare_delete_entity`
- **AND** no draft SHALL be deleted before WeMail approval and committed execution

### Requirement: Centralized semantic risk policy

The system SHALL classify MCP operations through one semantic risk policy shared with pending-action validation and execution.

#### Scenario: Reversible single-message state changes

- **WHEN** `set_mail_state` explicitly requests read, unread, star, or unstar for one owned message
- **THEN** the operation MAY execute directly
- **AND** the response SHALL identify the resulting state

#### Scenario: High-risk mailbox action is requested

- **WHEN** an MCP client requests archive, move, trash, restore-from-trash, spam, unspam, permanent delete, or any batch mutation
- **THEN** it SHALL be represented by `prepare_mail_actions`
- **AND** no provider or repository mutation SHALL occur during preparation

#### Scenario: Alternate tool shape attempts to bypass policy

- **WHEN** semantically equivalent high-risk parameters arrive through another public tool or malformed operation type
- **THEN** centralized policy SHALL still require confirmation or reject the call

### Requirement: WeMail-approved prepared operations

The system SHALL require exact-parameter WeMail approval before a prepared MCP send, mailbox action, draft deletion, or todo deletion can commit.

#### Scenario: Send is prepared

- **WHEN** `prepare_mail_send` validates a complete new, reply, reply-all, or forward payload
- **THEN** it SHALL create a durable pending operation with preview, canonical payload hash, risk, expiry, and `executed: false`
- **AND** it SHALL NOT return an execution-authorizing token to the MCP client

#### Scenario: User approves exact operation in WeMail

- **WHEN** the user approves the displayed operation inside WeMail before expiry
- **THEN** approval SHALL bind account id, operation id, canonical payload hash, and expiry
- **AND** changes to recipients, body, attachments, messages, action, or destination SHALL invalidate that approval

#### Scenario: Client attempts commit before approval

- **WHEN** `commit_mail_operation` is called for a pending, rejected, cancelled, expired, or payload-mismatched operation
- **THEN** it SHALL not execute and SHALL return the corresponding stable state error

#### Scenario: Operation is cancelled before commit

- **WHEN** `cancel_mail_operation` is called before a commit reservation exists
- **THEN** the operation SHALL become cancelled and ineligible for later commit

### Requirement: Durable idempotent operation commit

The system SHALL durably reserve an approved operation and caller idempotency key before provider dispatch and SHALL never dispatch the same retained reservation twice.

#### Scenario: Approved operation is committed

- **WHEN** `commit_mail_operation` receives an approved, unexpired operation and a new valid idempotency key
- **THEN** the server SHALL persist the reservation before dispatch
- **AND** it SHALL persist and return the terminal or continuing operation status

#### Scenario: Identical commit is repeated

- **WHEN** the same operation and idempotency key are submitted again
- **THEN** the server SHALL return the retained status or result
- **AND** it SHALL NOT repeat provider dispatch

#### Scenario: Idempotency key is reused for another payload

- **WHEN** a retained key is presented for a different operation or payload hash in the same account scope
- **THEN** the server SHALL return `idempotency_conflict`
- **AND** no dispatch SHALL occur

#### Scenario: Process stops during provider dispatch

- **WHEN** dispatch began but acknowledgement cannot be proven after restart
- **THEN** the operation SHALL become `outcome_unknown`
- **AND** automatic retry SHALL remain forbidden

### Requirement: Mail-linked todo lifecycle

The system SHALL expose paginated account-scoped todo list/read/create/update/complete/restore tools without exposing source mail bodies, and SHALL require prepared deletion.

#### Scenario: Todos are listed with filters

- **WHEN** `list_todos` is called with status, priority, due-range, or mail-reference filters
- **THEN** it SHALL return bounded todo fields and mail envelope references
- **AND** it SHALL not return source message bodies

#### Scenario: Todo is created or updated

- **WHEN** a valid local todo create or update is requested for the authenticated account
- **THEN** the repository SHALL persist the change and provenance
- **AND** it SHALL reject cross-account mail references

#### Scenario: Todo is completed or restored

- **WHEN** `complete_todo` or `restore_todo` targets an owned todo
- **THEN** the reversible lifecycle transition SHALL execute directly and return the updated record

#### Scenario: Todo deletion is requested

- **WHEN** deletion is requested through `prepare_delete_entity`
- **THEN** the preview SHALL disclose whether deletion also records AI-suggestion suppression
- **AND** deletion SHALL occur only after approval and idempotent commit

### Requirement: Structured results and stable safe errors

The system SHALL return schema-conformant `structuredContent` for every successful public tool and stable sanitized codes for expected failures.

#### Scenario: Modern MCP host receives a result

- **WHEN** a tool succeeds
- **THEN** its `structuredContent` SHALL validate against the declared output schema
- **AND** any text fallback SHALL be concise and SHALL not contain fields or content absent from structured content

#### Scenario: Provider returns a sensitive failure

- **WHEN** a provider, parser, repository, or transport error contains credentials, authorization headers, server paths, or raw remote payloads
- **THEN** the MCP response SHALL map it to a stable safe error code and message
- **AND** sensitive details SHALL not be returned to the client or normal logs

### Requirement: Resource limits and metadata-only audit

The system SHALL enforce per-token and per-session request, concurrency, body, response, attachment, synchronization, and prepared-operation limits before expensive work whenever possible, and SHALL record metadata-only audit events.

#### Scenario: Client exceeds a configured limit

- **WHEN** a token or session exceeds a request, concurrency, response, attachment, sync, or prepared-operation limit
- **THEN** the request SHALL return `rate_limited` or the corresponding size error
- **AND** the rejected request SHALL not begin provider dispatch or body hydration

#### Scenario: Tool call is audited

- **WHEN** a public tool settles
- **THEN** the audit record MAY contain token fingerprint, session hash, tool, account, risk class, argument shapes/counts, duration, outcome, byte count, operation id, and idempotency-key hash
- **AND** it SHALL exclude authorization values, raw arguments/results, subjects, snippets, recipients, bodies, attachment names/bytes, and confirmation material

### Requirement: Live MCP connection management UI

The system SHALL replace the static MCP panel inventory with live enablement, credential, protocol, tool, session, and pending-operation state from the local server.

#### Scenario: User enables and configures MCP

- **WHEN** the user enables MCP and creates a token
- **THEN** the panel SHALL present a copyable connection configuration containing the current local endpoint and one-time token
- **AND** it SHALL clearly state that the token grants mailbox access and should be kept secret

#### Scenario: User revisits the panel

- **WHEN** the panel is reopened after token creation
- **THEN** it SHALL show only the token fingerprint and lifecycle metadata
- **AND** it SHALL not attempt to recover plaintext token material

#### Scenario: Tool catalog changes

- **WHEN** server public-tool availability or provider capability changes
- **THEN** the panel SHALL render live server metadata rather than a hard-coded legacy list

#### Scenario: User revokes access

- **WHEN** the user disables MCP, revokes a token, or terminates a session
- **THEN** the panel SHALL reflect the new state promptly
- **AND** affected clients SHALL no longer be able to call tools
