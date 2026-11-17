## 1. Contract Freeze and Baseline

- [x] 1.1 Record the current local API lifecycle, `MCPPanel`, Agent tool registries, pending-action execution, mail sync, draft, attachment, and todo baselines with focused tests.
- [x] 1.2 Define versioned shared MCP contracts for server identity, protocol versions, public tool metadata, account capabilities, folders, envelopes, message details, threads, attachments, drafts, todos, cursors, structured errors, and operation states.
- [x] 1.3 Freeze the v1 public tool-name catalog from `design.md` in one exported constant and add a golden test that fails on accidental additions, removals, or renames.
- [x] 1.4 Define strict input and output JSON Schemas for every v1 tool, including `additionalProperties: false`, documented defaults, hard limits, and stable error codes.
- [x] 1.5 Define and test the centralized MCP semantic risk matrix for direct operations versus prepared operations.
- [x] 1.6 Add recorded MCP protocol fixtures for initialize, initialized notification, tools list, structured success, tool error, unknown method, authentication failure, session delete, and unsupported capability calls.
- [x] 1.7 Add dependency and license review for the selected MCP SDK/transport implementation, or document the minimal internal implementation if no SDK is adopted.

## 2. Credential, Persistence, and Migration Foundation

- [x] 2.1 Add migrations for MCP token metadata, prepared operations, idempotency reservations, and metadata-only audit events with account and state indexes.
- [x] 2.2 Implement `McpAccessTokenService` using `SecretStore` for secret material and salted verifier/fingerprint metadata in SQLite.
- [x] 2.3 Implement cryptographically random token creation with one-time plaintext return and no plaintext recovery API.
- [x] 2.4 Implement atomic rotation, revocation, last-used updates, revocation-driven session termination, and automatic token/session revocation on mail account logout or replacement.
- [x] 2.5 Implement `McpPreparedOperationRepository` with canonical payload, payload hash, preview, risk, state, expiry, approval metadata, provenance, and sanitized result summary.
- [x] 2.6 Implement `McpIdempotencyRepository` with atomic pre-dispatch reservation and retained result/status lookup.
- [x] 2.7 Implement `McpAuditRepository` with metadata-only fields and retention hooks.
- [x] 2.8 Add migration, rollback, restart, concurrent reservation, token rotation, and SecretStore isolation tests.
- [x] 2.9 Add a development-only MCP reset command that deletes MCP tokens, sessions, prepared operations, and MCP audit data without deleting accounts, mailbox credentials, mail, drafts, todos, Agent data, or intelligence results.

## 3. Streamable HTTP Transport and Session Lifecycle

- [x] 3.1 Implement the `/mcp` Streamable HTTP transport on a stable configurable loopback listener in the existing Electron/local API process, with supported protocol-version negotiation and accurate capability advertisement.
- [x] 3.2 Implement bearer authentication before JSON-RPC/session processing with constant-time verifier comparison and sanitized failures.
- [x] 3.3 Implement stateful session creation, bearer binding, initialization state, idle expiry, in-flight call tracking, cancellation handles, and cryptographically random session ids.
- [x] 3.4 Implement `notifications/initialized`, `tools/list`, `tools/call`, and session DELETE handling.
- [x] 3.5 Return protocol-correct errors for malformed JSON-RPC, invalid request ids, unknown methods, uninitialized sessions, unsupported protocol versions, and unadvertised Resources/Prompts/Tasks/Sampling methods.
- [x] 3.6 Reject non-loopback MCP binding unless a future explicit secure-remote mode exists; surface port conflicts safely and prove normal renderer API startup survives MCP bind-policy or port failures.
- [x] 3.7 Start the MCP-only listener against a full shared composition only while MCP is enabled; keep the renderer API's ephemeral listener and skeleton API tests independent.
- [x] 3.8 Wire session cleanup into local API/composition shutdown and token revocation.
- [x] 3.9 Add protocol conformance tests for HTTP status, content types, session headers, SSE/JSON response handling, notification behavior, cleanup, concurrent sessions, stable endpoint across restart, and occupied-port behavior.

## 4. Public Registry and Domain Adapters

- [x] 4.1 Introduce a public MCP registry that owns public names, descriptions, schemas, risk class, response limits, and audit behavior independently of internal Agent tools.
- [x] 4.2 Introduce bounded domain adapter interfaces for account, folder, message, attachment, draft, operation, sync, and todo handlers.
- [x] 4.3 Reuse existing domain services and safe handler logic without importing Pi event, renderer, conversation, or MCP protocol types into domain repositories.
- [x] 4.4 Implement strict schema validation before handler execution and output validation before response delivery.
- [x] 4.5 Return `structuredContent` for every tool and generate only a concise, schema-equivalent text fallback.
- [x] 4.6 Map provider, repository, validation, capability, ownership, cursor, limit, and operation errors into stable sanitized MCP error codes.
- [x] 4.7 Add tests proving internal-only Agent, Curator, WeCLI, directory, automation, intelligence, workspace, and configuration tools cannot be discovered or invoked through MCP.
- [x] 4.8 Add tests proving public registry changes do not alter the Pi/renderer protocol and internal tool registration does not alter the MCP golden catalog.

## 5. Account, Folder, Capability, and Synchronization Tools

- [x] 5.1 Implement `list_mail_accounts` with zero-or-one current account results and versioned provider capability metadata.
- [x] 5.2 Add provider capability derivation for folder model, threading, search, drafts, send-as, attachments, sync mode, realtime mode, attachment limit, and recipient limit.
- [x] 5.3 Implement `list_mail_folders` with provider folder/label ids, names, roles, selectability, and separation from WeMail virtual views.
- [x] 5.4 Implement `sync_mail_account` as an adapter over the existing account-scoped startup/sync coordinator, checkpoints, resource governor, and single-flight path.
- [x] 5.5 Support optional folder-scoped sync only where the provider capability is available, returning `capability_not_supported` otherwise.
- [x] 5.6 Return accepted/shared/completed sync status, phase, counters, checkpoint metadata, and a pollable operation id when work outlives the tool latency budget.
- [x] 5.7 Implement `get_mail_sync_status` for bounded progress, checkpoint, safe error category, and terminal status without exposing mail content or credentials.
- [x] 5.8 Preserve bootstrap/historical notification and automation-suppression semantics for MCP-triggered sync.
- [x] 5.9 Add capability, no-account, provider-unsupported, equivalent-sync sharing, status polling, folder isolation, checkpoint, resource-admission, and historical-origin tests.

## 6. Message Listing, Search, Targeted Reads, and Cursors

- [x] 6.1 Implement a reusable opaque cursor codec bound to account, tool, normalized filters/query, sort order, and expiry without embedding credentials.
- [x] 6.2 Implement `list_mail_messages` with small default pages, hard maximum page size, stable ordering, and envelope-only results.
- [x] 6.3 Implement `search_mail` with provider-search mode when available and an explicitly identified bounded local fallback where supported.
- [x] 6.4 Ensure list/search results omit body text, body HTML, raw headers, attachment bytes, full tracking URLs, provider tokens, and intelligence traces.
- [x] 6.5 Implement `get_mail_message` with a 6,000-character plain-text default, 20,000-character hard maximum, optional bounded HTML, and explicit truncation metadata.
- [x] 6.6 Implement `get_mail_thread` with per-message and total response limits, bounded message pages, and opaque continuation cursors.
- [x] 6.7 Mark provider body content as untrusted data in tool metadata/results and ensure it cannot affect server authorization, policy, confirmation, or tool availability.
- [x] 6.8 Enforce response byte limits after serialization and return a typed size error rather than silently dropping schema fields.
- [x] 6.9 Add tests using adversarial HTML/text emails that attempt prompt injection, tool invocation, token exfiltration, fake approval, and cross-account references.
- [x] 6.10 Add large-mailbox tests proving list/search pagination does not hydrate complete bodies or materialize all matches in memory.
- [x] 6.11 Add cursor tamper, expiration, query mismatch, cross-account, sort mismatch, and restart-behavior tests.

## 7. Attachment Embedded Resources

- [x] 7.1 Define session-bound `wemail-attachment://` resource identifiers that contain no filesystem path or reusable provider credential.
- [x] 7.2 Implement `get_mail_attachment` ownership checks against account, message, and attachment metadata before cache/provider fetch.
- [x] 7.3 Reuse `MailAttachmentCache` and provider fetch capability without logging or persisting attachment bytes in MCP-specific storage.
- [x] 7.4 Validate declared/detected MIME type, provider limit, WeMail 25 MB maximum, actual byte count, and completion before returning a resource.
- [x] 7.5 Return attachment bytes as an MCP embedded resource with filename and MIME metadata, never as JSON text/base64 inside `structuredContent`.
- [x] 7.6 Reject expired-session resource reuse, cross-session references, mismatched attachment ids, unsupported providers, oversized files, and partial fetches.
- [x] 7.7 Add binary, text, MIME mismatch, maximum-size, cross-account, session expiry, cache reuse, provider failure, and memory-bound tests.

## 8. Draft and Todo Tools

- [x] 8.1 Implement paginated `list_mail_drafts` with metadata and bounded excerpts plus targeted `get_mail_draft` for full bounded content.
- [x] 8.2 Implement `create_mail_draft` and `update_mail_draft` over existing draft persistence/provider capability with strict recipient, body, attachment, source-message, and account validation.
- [x] 8.3 Prove draft create/update cannot call provider send or SMTP and cannot mutate a draft owned by another account.
- [x] 8.4 Implement `list_todos` with status, priority, due-range, and mail-reference filters plus opaque pagination.
- [x] 8.5 Implement `get_todo`, `create_todo`, `update_todo`, `complete_todo`, and `restore_todo` with account and linked-message ownership checks.
- [x] 8.6 Keep source mail bodies out of todo results while returning bounded envelope references and provenance.
- [x] 8.7 Implement `prepare_delete_entity` for saved drafts and todos, including AI-suggestion suppression disclosure for todo deletion.
- [x] 8.8 Add draft no-send, provider capability, body limit, attachment, todo lifecycle, suppression, cursor, missing entity, and cross-account tests.

## 9. Direct State Changes and Prepared Mail Actions

- [x] 9.1 Implement `set_mail_state` only for explicit single-message read, unread, star, and unstar operations.
- [x] 9.2 Implement `prepare_mail_actions` for archive, move, trash, restore-from-trash, spam, unspam, permanent delete, and every batch mutation.
- [x] 9.3 Normalize message ids, destination, provider semantics, account ownership, and action scope before computing preview and payload hash.
- [x] 9.4 Ensure preparation creates no provider or repository mailbox mutation and returns `executed: false`.
- [x] 9.5 Add policy tests proving aliases, malformed operation names, single-versus-batch reshaping, and alternate tool inputs cannot downgrade high-risk actions.
- [x] 9.6 Add tests for reversible direct state changes, prepared previews, batch counts, destination validation, cross-account ids, permanent-delete warnings, and zero side effects before approval.

## 10. Send Preparation, Approval, Commit, and Recovery

- [x] 10.1 Implement `prepare_mail_send` for new, reply, reply-all, and forward modes using existing address, source-message, draft, attachment, and provider validation.
- [x] 10.2 Canonicalize every prepared payload deterministically and persist its hash, exact parameters, redacted preview, risk, provenance, creation time, and expiry.
- [x] 10.3 Integrate MCP prepared operations into the existing WeMail confirmation UI/repository without returning execution authority during preparation.
- [x] 10.4 Bind approval to account, operation id, payload hash, approver event, and unexpired state; reject approval of changed or expired operations.
- [x] 10.5 Implement `commit_mail_operation` with an atomic durable idempotency reservation before any provider dispatch.
- [x] 10.6 Route approved send, mailbox action, draft deletion, and todo deletion through the existing safe action executor or an equivalently centralized executor.
- [x] 10.7 Implement `get_mail_operation_status` and `cancel_mail_operation` for all prepared operation types.
- [x] 10.8 Persist and return `prepared`, `awaiting_confirmation`, `approved`, `committing`, `succeeded`, `failed_retryable`, `cancelled`, `expired`, and `outcome_unknown` states.
- [x] 10.9 Reconcile startup state so a pre-dispatch reservation can continue safely while an uncertain post-dispatch interruption becomes non-retryable `outcome_unknown`.
- [x] 10.10 Ensure an identical operation/key returns its retained outcome and a key reused for another payload returns `idempotency_conflict`.
- [x] 10.11 Add tests for prepare-without-send, self-commit attempt, rejection, expiry, cancellation, payload change, duplicate commit, concurrent commit, key conflict, provider failure, process interruption, and uncertain outcome.
- [x] 10.12 Add end-to-end tests proving no model/MCP-only sequence can execute a high-risk operation without a separate WeMail approval event.

## 11. Limits, Audit, Retention, and Privacy

- [x] 11.1 Implement configurable per-token and per-session request-rate, concurrent-call, sync, body-read, response-byte, attachment-byte, and pending-operation limits.
- [x] 11.2 Apply authentication, ownership, schema, capability, and limit checks before body hydration, attachment fetch, sync admission, or provider dispatch whenever possible.
- [x] 11.3 Add MCP-specific log redaction for authorization headers, token plaintext/verifiers, session ids, idempotency keys, confirmation material, raw arguments/results, and provider errors.
- [x] 11.4 Emit metadata-only audits with token fingerprint, session hash, tool, account, risk class, argument shapes/counts, duration, outcome, byte count, operation id, and idempotency-key hash.
- [x] 11.5 Prove audit and diagnostics exclude subjects, snippets, recipients, bodies, raw headers, attachment names/bytes, filesystem paths, and credentials.
- [x] 11.6 Add retention and cleanup for expired sessions, expired/cancelled prepared operations, token metadata, idempotency reservations, and MCP audit events without deleting retained operation outcomes too early for reconciliation.
- [x] 11.7 Add load and abuse tests for request floods, concurrent body reads, sync spam, oversized responses, attachment limits, prepared-operation accumulation, and repeated invalid authentication.
- [x] 11.8 Add secret-scanning assertions over logs, audit rows, error responses, renderer state, and diagnostic exports.

## 12. MCP Connection and Confirmation UI

- [x] 12.1 Replace the hard-coded `MCPPanel` tool array with typed queries for enablement, endpoint, protocol, public registry metadata, token metadata, sessions, and MCP pending operations.
- [x] 12.2 Add explicit MCP enable/disable controls with local-only security explanation and no implicit token creation.
- [x] 12.3 Add one-time token create/rotate dialogs, fingerprint-only revisit state, copyable host configuration, and secret-handling warnings.
- [x] 12.4 Add token revocation, active-session listing, per-session termination, last-used metadata, and immediate query invalidation.
- [x] 12.5 Render tools grouped by discovery, read, attachment, drafts, operations, and todos from live server metadata, including provider-unavailable states.
- [x] 12.6 Add MCP-origin badges and deep links for pending confirmation cards without changing the existing exact-parameter approval semantics.
- [x] 12.7 Render operation expiry, rejection, cancellation, committed, failed, and outcome-unknown states with safe user guidance.
- [x] 12.8 Add renderer tests for one-time secret display, clipboard configuration, no plaintext recovery, revoke/rotate, live catalog, sessions, pending-operation navigation, and disabled state.

## 13. External Host, Browser, and Desktop Acceptance

- [x] 13.1 Build a hermetic MCP test client that exercises initialize, tools list, structured calls, cursors, resources, session termination, auth rotation, and protocol errors against the real local server.
- [x] 13.2 Add smoke tests from at least two supported external MCP hosts or SDK clients using generated local connection configuration.
- [x] 13.3 Verify an external host can discover accounts/folders, list/search envelopes, read one bounded message/thread, retrieve an attachment, manage a draft, and manage a todo.
- [x] 13.4 Verify send and mailbox mutations stop at pending confirmation, appear in WeMail, require exact user approval, and commit once with a durable idempotency key.
- [x] 13.5 Verify token revoke/rotation terminates access and no reconnect succeeds with the old token.
- [x] 13.6 Run server typecheck/tests, renderer typecheck/tests, browser tests, and full repository verification required by touched paths.
- [x] 13.7 Rebuild and launch the Windows desktop application, verify the stable MCP loopback endpoint alongside the ephemeral renderer API, MCP panel behavior, restart cleanup, occupied-port isolation, and no white screen.
- [x] 13.8 Capture acceptance evidence for connection setup, live catalog, bounded message results, attachment resource, pending send, approval, committed status, token revocation, and privacy-safe logs.

## 14. Rollout, Documentation, and Cleanup

- [x] 14.1 Add user documentation for enabling MCP, configuring supported hosts, protecting/rotating/revoking tokens, confirmation behavior, body limits, and troubleshooting.
- [x] 14.2 Add developer documentation for public registry changes, schema/version policy, risk classification, operation state machine, audit rules, and protocol compatibility tests.
- [x] 14.3 Add release notes that MCP is local, opt-in, account-scoped, and confirmation-gated for external side effects.
- [x] 14.4 Roll out behind an emergency disable switch and verify disabling terminates sessions, revokes or suspends access according to product policy, and leaves mailbox data untouched.
- [x] 14.5 Remove the static legacy MCP tool inventory and any dead placeholder-only code after the live panel and endpoint pass acceptance.
- [x] 14.6 Confirm every public tool has implementation, input/output schema, unit tests, account-isolation tests, limit tests, audit classification, and user documentation.
- [x] 14.7 Update OpenSpec acceptance evidence, mark completed tasks, and archive only after protocol, security, external-host, and Windows desktop gates pass.
