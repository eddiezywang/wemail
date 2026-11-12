# MCP Direct Operation Design

## Summary

When local MCP is enabled, every authenticated MCP operation may proceed without a separate WeMail confirmation card. This includes sending mail, moving or deleting messages, permanent deletion, batch mailbox actions, and deleting drafts or Todos.

The existing `prepare_mail_actions`, `prepare_mail_send`, `prepare_delete_entity`, and `commit_mail_operation` protocol remains intact. Preparation validates and persists the exact payload, but the new operation is immediately approved. The MCP client still commits the operation with an idempotency key before any provider mutation occurs.

## Goals

- Remove the WeMail popup and Action Center authorization step for MCP operations.
- Allow every bearer-authenticated local MCP client to perform all public MCP mutations.
- Preserve account isolation, strict schemas, provider capability checks, operation expiry, audit metadata, and idempotent commit behavior.
- Preserve the existing public MCP tool names and request/response shapes.

## Non-goals

- Do not remove confirmation requirements from the built-in Agent, WeCLI, automation, or ordinary renderer workflows.
- Do not add an additional trusted-mode switch or per-operation allowlist.
- Do not collapse preparation and commit into one provider call.
- Do not weaken MCP bearer-token authentication, loopback binding, session ownership, or credential storage.

## Operation flow

The current high-risk flow is:

```text
prepare -> awaiting_confirmation -> approved -> commit -> succeeded
```

The new flow is:

```text
prepare -> approved -> commit -> succeeded
```

Preparation continues to canonicalize and hash the exact payload, verify the active account, validate referenced entities and attachments, create an expiring durable operation, and return its operation id. It no longer inserts an `AgentPendingAction` row.

Commit continues to require an owned, unexpired operation and an idempotency key. It reserves the operation before provider dispatch and retains the existing `failed_retryable` and `outcome_unknown` handling. This is especially important for sends, where automatically retrying after an uncertain provider result could create duplicate mail.

## Server changes

`McpOperationService` will create prepared operations with the initial state `approved`. The approval timestamp and event identifier are not required because no human approval event occurs. Commit authorization will derive from the operation state, as it does today.

`McpPreparedOperationRepository` will allow `approved` as an explicit initial state. Its manual `approve` method remains available for compatibility with existing persisted operations and internal routes, but new MCP requests will not depend on it.

`McpRiskPolicy` will describe authenticated MCP prepare and commit calls as not requiring WeMail confirmation. Semantic risk classifications and tool annotations remain high-risk/destructive where applicable so audit records and MCP hosts still receive accurate metadata.

No new endpoint or database column is required. Existing `awaiting_confirmation` operations created by an older application version remain manually approvable or expire normally; the change applies to newly prepared operations.

## Renderer changes

MCP settings copy will state that an enabled MCP connection can directly perform mailbox operations, including destructive actions. Text claiming that high-risk operations still require in-app confirmation will be removed.

New MCP requests will not appear as pending Action Center cards. Existing cards from operations created before the upgrade remain visible until resolved or expired; no destructive migration will delete them.

The MCP operation history remains visible in Settings so users can inspect prepared, committing, successful, failed, expired, and unknown-outcome operations.

## Security model

Enabling MCP and possessing its managed bearer credential grants full access to the public MCP tool surface for the active mailbox. Anyone who obtains that credential can send or permanently delete mail without another WeMail prompt.

The following controls remain mandatory:

- listener binding only to loopback addresses;
- bearer authentication before request parsing and dispatch;
- token revocation and credential reset;
- account and session ownership validation;
- strict input schemas and bounded payloads;
- provider capability checks;
- durable idempotency reservations;
- privacy-preserving MCP audit records.

Documentation and Settings must make the expanded credential authority explicit.

## Error handling

- Invalid, unauthorized, cross-account, expired, or unsupported operations continue to fail before provider dispatch.
- Commit of an old operation still awaiting confirmation continues to return `operation_not_approved` until it is approved or expires.
- Pre-dispatch failures remain retryable where currently supported.
- Uncertain send outcomes remain `outcome_unknown` and must not be automatically retried.
- Failure to create the durable operation prevents execution; there is no in-memory fallback.

## Testing

Focused tests will verify that:

- every prepared mailbox action begins in `approved` state;
- preparation creates no MCP-origin pending action;
- send, permanent deletion, batch actions, and entity deletion commit without an approval route call;
- commit still rejects missing, cross-account, expired, cancelled, or otherwise invalid operations;
- duplicate idempotency keys do not dispatch twice;
- uncertain sends preserve `outcome_unknown` behavior;
- risk-policy decisions no longer require WeMail confirmation while retaining high-risk classifications;
- MCP Settings and documentation describe direct authority and no longer promise confirmation prompts;
- non-MCP Agent confirmation behavior remains unchanged.

The relevant MCP server tests, server typecheck, renderer tests, and desktop build should pass before delivery.

## Acceptance criteria

With local MCP enabled and a valid managed credential, an MCP client can prepare and commit any public MCP write operation without opening WeMail or interacting with an authorization popup. No Action Center confirmation card is created for the request, and idempotency, audit, account isolation, and provider-error protections remain operational.
