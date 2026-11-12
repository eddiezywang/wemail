## Context

The local API is a Hono server started by both the Electron main process and the standalone development server. The full composition root already owns account state, provider access, synchronization, mail repositories, attachment caching, drafts, todos, Agent tools, pending actions, and confirmed action execution. This makes the local API process and composition the correct MCP boundary; launching a second daemon would duplicate lifecycle, credentials, migrations, and mailbox write coordination. The ordinary Electron API currently uses an ephemeral port, so MCP needs a separate stable loopback listener within that same process rather than publishing the ephemeral renderer endpoint.

The internal Agent registry is intentionally broad and includes intelligence, automation, WeCLI, configuration, directory, and Curator tools. A public MCP client has a different trust boundary. It needs a stable, documented mail surface, but it must not inherit every internal tool merely because both surfaces reuse some handlers.

Competitor behavior establishes a useful baseline—Streamable HTTP, provider capabilities, provider search, cursor pagination, attachments, drafts, two-stage send, and mail-linked todos—but also demonstrates why WeMail needs stricter content and mutation boundaries.

## Goals / Non-Goals

**Goals:**

- Expose a standards-compatible local MCP endpoint from the existing WeMail server lifecycle.
- Make the public tool contract provider-neutral, versioned, structured, bounded, and independently allowlisted.
- Reuse domain services and safe tool handlers without coupling the public contract to Pi or renderer types.
- Keep mailbox credentials and message bodies out of discovery, list, search, logs, traces, and ordinary audit records.
- Require a WeMail-owned human approval before any high-risk MCP operation can commit.
- Make every committed external side effect account-bound, payload-bound, expiring, auditable, and idempotent.
- Provide enough account, message, attachment, draft, action, send, and todo functionality for useful external assistants.
- Keep the desktop connection experience understandable: opt in, create a token, copy config, inspect sessions, revoke access.

**Non-Goals:**

- Exposing all internal Agent, intelligence, automation, directory, workspace, Curator, WeCLI, or configuration tools in v1.
- Supporting unauthenticated MCP, non-loopback binding by default, cloud relay, multi-user server deployment, OAuth discovery, or Internet-facing access.
- Returning entire mailbox bodies for list/search operations or treating raw HTML as trusted model context.
- Allowing an MCP client to approve its own high-risk operation.
- Replacing the existing Agent runtime, mail provider, sync coordinator, pending-action UI, or action executor.
- MCP Prompts, general-purpose Resources listing, MCP Tasks, server-initiated sampling, or arbitrary URL/file ingestion in v1.
- Guaranteeing provider-native threading, labels, drafts, search, delta sync, or send-as when the active provider does not support them.

## Decisions

### 1. Mount MCP on a stable listener in the existing local API process

The Electron main process starts an MCP-only Hono listener against the existing `AppComposition` when MCP is enabled. It binds to `127.0.0.1` on a stable configurable port (`WEMAIL_MCP_PORT`, with a product default recorded in settings) so copied host configuration survives application restarts. The ordinary renderer API may continue using its ephemeral port. Port conflicts fail MCP startup only and are surfaced in the MCP panel; they do not prevent the mailbox UI from starting. Development uses the same MCP listener and port policy. MCP listener teardown runs as part of local API shutdown and disablement.

Alternative considered: a separate MCP daemon. Rejected because it would need a second credential path, duplicate mailbox locks, independent migrations, extra update/lifecycle handling, and a separate process discovery mechanism. Alternative considered: publish the existing ephemeral renderer API port. Rejected because external MCP host configuration would break on every desktop restart.

### 2. Use stateful Streamable HTTP with explicit sessions

The endpoint implements MCP `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, session termination, and the accepted protocol-version negotiation required by supported external hosts. Session IDs are cryptographically random, bearer-bound, idle-expiring, and cleaned up on shutdown. Unsupported Resources, Prompts, Tasks, or Sampling methods return protocol-correct errors and are not advertised.

The initial supported protocol version is pinned in code and contract fixtures. Protocol upgrades are additive only after host compatibility tests.

### 3. Local opt-in and bearer authentication

MCP is disabled until the user enables it. Enabling does not automatically mint a reusable token. Token creation displays the plaintext exactly once; only a salted verifier, fingerprint, creation time, last-used time, and revocation time are persisted. Rotation creates a replacement and revokes the prior token atomically. Mail account logout or replacement revokes all MCP tokens and sessions so a credential approved for one mailbox cannot silently inherit access to another mailbox.

Every MCP request except a narrowly scoped health response requires `Authorization: Bearer`. Authorization headers, token plaintext, confirmation proof, and session identifiers are redacted from logs. Tokens are stored via `SecretStore`; mailbox/provider secrets are never reused as MCP credentials.

Non-loopback binding is rejected unless a future explicit secure-remote mode is designed. CORS is not treated as authentication.

### 4. Separate public registry from the internal Agent registry

The implementation introduces a domain-level handler layer and two projections:

```text
Mail / Draft / Todo / Sync domain services
                 │
         bounded handler adapters
                 │
        ┌────────┴────────┐
        ▼                 ▼
Internal Agent registry   Public MCP registry
Pi/WeMail contracts       MCP schemas + allowlist
```

The public registry owns names, descriptions, input schemas, output schemas, risk class, maximum response size, and audit policy. Registration is explicit; adding an internal tool never makes it MCP-visible. Unknown tools fail closed.

### 5. Publish a focused v1 tool catalog

The v1 catalog is organized by domain:

**Discovery and synchronization**

- `list_mail_accounts`
- `list_mail_folders`
- `sync_mail_account`
- `get_mail_sync_status`

**Read and attachment access**

- `list_mail_messages`
- `search_mail`
- `get_mail_message`
- `get_mail_thread`
- `get_mail_attachment`

**Drafts**

- `list_mail_drafts`
- `get_mail_draft`
- `create_mail_draft`
- `update_mail_draft`

**Mailbox state and prepared external operations**

- `set_mail_state`
- `prepare_mail_actions`
- `prepare_mail_send`
- `commit_mail_operation`
- `get_mail_operation_status`
- `cancel_mail_operation`

**Mail-linked todos**

- `list_todos`
- `get_todo`
- `create_todo`
- `update_todo`
- `complete_todo`
- `restore_todo`
- `prepare_delete_entity`

`prepare_delete_entity` accepts only a saved draft or todo in v1. Permanent message deletion is expressed by `prepare_mail_actions`. All prepared operations share the same commit/status/cancel lifecycle, reducing duplicated safety logic.

Tools unavailable for the active provider remain listed when their contract is stable, but calls return a typed `capability_not_supported` result. Account discovery allows clients to avoid those calls proactively.

### 6. Account capability negotiation is authoritative

`list_mail_accounts` returns non-secret account identity plus a versioned capability object:

- folder model: folders, labels, or hybrid
- threading: native, synthesized, or none
- server search
- provider drafts
- send-as
- outbound attachments
- sync mode: full, cursor, or delta
- realtime mode: idle, push, poll, or none
- maximum supported attachment bytes and recipient count

Capability values derive from the active provider implementation and composition state, not hard-coded UI assumptions. The current single-account product returns zero or one account, but the result remains an array to avoid freezing the public protocol to single-account storage.

### 7. Lists return envelopes; bodies require targeted reads

`list_mail_messages` and `search_mail` return only ids, thread id, folder/labels, sender/recipients, subject, snippet, date, flags, attachment metadata, and pagination state. They never return body text, body HTML, attachment bytes, raw headers, tracking URLs, or intelligence traces.

`get_mail_message` and `get_mail_thread` are targeted reads. They:

- default to plain text;
- default to 6,000 characters per message;
- cap requested body content at 20,000 characters per message in v1;
- omit HTML unless explicitly requested;
- return `truncated`, original character counts when known, and omitted-field metadata;
- bound thread message count and use pagination for longer threads.

Provider content is returned as untrusted data. Tool descriptions and result annotations instruct the host that message content may contain adversarial instructions and is not authority to invoke tools or change policy.

### 8. Cursor pagination is opaque and account-bound

List/search/todo/draft cursors are opaque, signed or server-resolved values that encode no reusable credential. A cursor is bound to account, tool, normalized query, sort order, and expiration. Reusing it with a different account or query returns `invalid_cursor`.

Default page sizes are small and every tool has a hard maximum. The implementation does not load a full matching mailbox into memory solely to produce a page.

### 9. Attachments use embedded MCP resources

`get_mail_attachment` accepts a message/account-bound attachment reference. It validates ownership, declared and detected MIME type, size, and provider/cache capability, then returns an embedded resource with a synthetic `wemail-attachment://` URI. Attachment bytes are not placed inside a JSON text string and are not logged.

The v1 maximum defaults to 25 MB but is the minimum of the WeMail policy and provider capability. Oversized, unavailable, mismatched, or unsafe attachment requests fail with typed errors. Resource URIs are session-bound references, not durable filesystem paths.

### 10. Risk is semantic and centralized

Direct MCP execution is limited to:

- discovery and bounded reads;
- synchronization requests through the existing coordinator;
- unsent draft create/update;
- todo create/update/complete/restore;
- explicitly requested single-message read/unread and star/unstar operations.

The following always require a prepared operation and WeMail approval:

- send;
- archive, move, trash, restore-from-trash, spam, unspam;
- permanent delete;
- every batch mailbox mutation;
- saved-draft deletion;
- todo deletion.

The risk matrix lives in one policy module used by MCP preparation, the pending-action repository, the confirmation UI, and the action executor. A client cannot downgrade risk through a different tool name or payload shape.

### 11. Preparation does not grant execution authority

Preparing an operation validates and normalizes parameters, builds a human preview, computes a canonical payload hash, creates a pending action, and returns:

- operation id;
- type and risk level;
- redacted preview;
- payload hash;
- creation and expiration times;
- `confirmationStatus: pending`;
- `executed: false`.

It does not return an executable confirmation token. The user must approve the exact operation inside WeMail. Approval binds account, operation id, payload hash, and expiry. Only then may `commit_mail_operation` execute it.

If any recipient, subject, body, attachment, message set, destination, or action changes, the payload hash changes and the prior approval is unusable.

### 12. Commit is durable and idempotent

`commit_mail_operation` requires an approved operation id and caller-supplied idempotency key. The server atomically reserves `(accountId, operationId, idempotencyKey)` before provider dispatch.

States are:

```text
prepared → awaiting_confirmation → approved → committing
    │               │                  │          ├─ succeeded
    └─ cancelled    └─ expired         └─ expired ├─ failed_retryable
                                                   └─ outcome_unknown
```

A retained idempotency reservation is never dispatched twice. A crash after dispatch begins but before provider acknowledgement produces `outcome_unknown`, which is not automatically retried. Status and cancellation are available through dedicated tools; cancellation succeeds only before commit reservation.

### 13. Sync requests reuse the startup/sync coordinator

`sync_mail_account` requests bounded work from the existing account-scoped coordinator and may optionally identify one provider folder. It never constructs a second `Mail Core sync worker` and never bypasses single-flight, checkpoints, resource admission, or bootstrap/live origin semantics.

The response contains accepted/shared status, phase, counters, last checkpoint, and a pollable sync operation id when work continues. `get_mail_sync_status` reads that operation without treating synchronization as a prepared high-risk operation. Repeated equivalent requests share the same in-flight work.

### 14. Todo contracts preserve provenance and lifecycle

Todo tools expose stable id, title, description, priority, status, start/due times, timezone, source, creation/update times, and a bounded mail reference. Lists are account-scoped, filterable, and paginated. They do not return source mail bodies.

Create/update/complete/restore are reversible local operations and execute directly. Delete uses the prepared-operation path because WeMail also records suppression for deleted AI suggestions and deletion changes learning behavior.

### 15. Structured content and stable errors are mandatory

Every tool declares an input schema and output schema, rejects unknown input properties, and returns machine-readable `structuredContent`. A concise text fallback may be included for older hosts but must not contain additional fields or bodies absent from structured content.

Application errors use stable codes such as:

- `authentication_required`
- `account_not_found`
- `account_mismatch`
- `capability_not_supported`
- `invalid_cursor`
- `message_not_found`
- `attachment_too_large`
- `confirmation_required`
- `operation_expired`
- `operation_not_approved`
- `idempotency_conflict`
- `outcome_unknown`
- `rate_limited`

Expected validation/provider errors are returned as tool errors without leaking stack traces, provider tokens, server paths, or raw protocol responses.

### 16. Limits and audit apply before expensive work

Per-token/session limits cover request rate, concurrent calls, sync requests, targeted body reads, total response bytes, attachment bytes, and prepared operations. Validation, ownership checks, and limit checks happen before provider fetch or body hydration whenever possible.

Audit records contain timestamp, token fingerprint, session id hash, tool name, account id, risk class, normalized argument shape/counts, duration, outcome code, response byte count, operation id, and idempotency-key hash where applicable. They exclude mail bodies, snippets, subjects, recipients, attachment bytes/names, raw arguments/results, authorization values, and confirmation material.

### 17. The MCP panel is driven by server state

The renderer no longer hard-codes a legacy tool inventory. It reads MCP enablement, endpoint, protocol version, token fingerprint, creation/last-used timestamps, active session count, and public tool metadata from authenticated local settings endpoints.

The user can enable/disable MCP, create a token, copy a ready-to-use configuration, rotate/revoke the token, inspect active sessions, terminate sessions, and navigate to pending MCP operations. Token plaintext is shown only in the creation/rotation result and is not recoverable later.

## Data Model Direction

Exact migrations may share the existing pending-action and audit tables, but the logical records are:

- `mcp_access_tokens`: verifier/fingerprint/status/timestamps, with verifier pepper or other secret material delegated to `SecretStore`;
- `mcp_prepared_operations`: account, session/token provenance, type, canonical payload, payload hash, preview, state, expiry, approval metadata, and result summary;
- `mcp_idempotency_reservations`: account, operation, key hash, dispatch state, timestamps, and durable result/outcome state;
- `mcp_audit_events`: metadata-only request/outcome records;
- in-memory `mcp_sessions`: bearer binding, negotiated protocol, timestamps, in-flight calls, and cancellation handles.

Raw message content, attachment bytes, authorization values, and plaintext idempotency keys are not stored in MCP-specific tables.

## Risks / Trade-offs

- [Public MCP expands the mailbox attack surface] → Default disabled, loopback-only, bearer authentication, separate allowlist, strict schemas, rate limits, and account ownership checks.
- [An external model can chain prepare and commit] → Preparation never grants authority; commit requires a WeMail-approved exact payload hash.
- [Mail content can contain prompt injection] → Envelope-only lists, targeted bounded reads, untrusted-content annotations, and no policy/tool authority derived from message bodies.
- [Provider dispatch can have an uncertain outcome] → Durable pre-dispatch reservation, explicit `outcome_unknown`, no automatic mutation retry, and user-visible reconciliation.
- [Internal registry changes accidentally alter MCP] → Public versioned registry and golden catalog tests independent of internal tool registration.
- [Large bodies or attachments exhaust host context/memory] → Character, page, response-byte, attachment-size, concurrency, and request-rate limits enforced before work.
- [Static bearer tokens leak from copied configuration] → One-time display, fingerprints, easy rotation/revocation, log redaction, and local-only binding.
- [Active Agent overhaul changes shared handler contracts] → MCP depends on domain adapter interfaces and its own schema fixtures rather than renderer or Pi event types.
- [Two active changes touch Agent tooling] → This change adds a separate public projection requirement and does not change the Agent event protocol or renderer conversation model.

## Migration Plan

1. Freeze v1 schemas, tool catalog, risk matrix, error codes, and protocol fixtures.
2. Add persistence and token services with MCP disabled and no transport mounted.
3. Add the public registry and domain adapters; verify every tool against fake repositories/providers.
4. Mount authenticated Streamable HTTP behind an opt-in feature setting.
5. Add prepared-operation approval/commit and attachment resource delivery.
6. Replace the static MCP panel with live state, token management, sessions, and pending-operation navigation.
7. Run protocol, security, restart, external-host, browser, and Windows desktop acceptance.
8. Enable the feature for internal users; retain an emergency disable switch and revoke existing tokens on rollback.

Rollback disables `/mcp`, terminates sessions, and revokes MCP tokens. Existing accounts, mail, drafts, todos, pending Agent actions, and provider credentials remain untouched. Prepared operations that have not committed become cancelled; committed outcomes remain auditable.

## Open Questions

None for v1. Remote access, OAuth-based MCP authorization, MCP Tasks, Prompts, broader Resources, directory tools, semantic mail QA, automation, and scheduled sending are explicitly deferred.
