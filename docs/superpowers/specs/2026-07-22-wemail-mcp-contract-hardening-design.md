# WeMail MCP contract hardening design

Date: 2026-07-22

## Goal

Harden the existing public MCP v1 contract so a generic local MCP client can inspect a complete message or draft, discover and fetch attachments, classify tool risk, and interact with the Streamable HTTP endpoint without unbounded request bodies or unvalidated browser origins.

This is a corrective change to the newly introduced v1 contract. It does not add a parallel v2 surface or preserve the defective behavior as a compatibility mode.

## Scope

The change covers:

- complete message and thread metadata;
- attachment identifier discovery;
- complete, byte-free draft review;
- tool annotations;
- aggregate outbound attachment limits and Base64 validation;
- bounded HTTP request parsing;
- Origin validation;
- consistent thread pagination and response budgeting;
- focused contract, transport, domain, compatibility, and documentation tests.

The change does not expose attachment filesystem paths, return outbound attachment Base64 from draft reads, add browser CORS support, add new public tool names, or alter the prepared-operation approval model.

## Public data contract

### Shared output shapes

`McpToolCatalog.ts` will define reusable strict schemas for:

- an address: optional display name plus required email address;
- attachment metadata: `id`, `filename`, `mimeType`, `size`, and optional `contentId` and `disposition`;
- targeted message detail;
- targeted draft detail.

All object schemas remain strict with `additionalProperties: false`.

### Message detail

`get_mail_message` will continue returning the bounded untrusted body fields and add:

- `threadId`;
- `folder`;
- `from`;
- `to`;
- `cc`;
- `bcc`;
- `receivedAt`;
- `attachments` as metadata only.

The new properties are additive and optional in the v1 output schema so older recorded responses remain valid. The current handler will emit every field for which the repository has data.

`get_mail_thread.messages` will expose the corresponding per-message envelope and attachment metadata in addition to each bounded body. This lets a client distinguish senders and chronology and discover attachment identifiers without a separate lookup tool.

Attachment metadata uses the public `mimeType` spelling even though the repository model uses `mimetype`.

### Attachment retrieval

`get_mail_attachment` keeps its existing arguments and session-bound embedded-resource response. The attachment `id` exposed by message or thread detail is the opaque value callers pass as `attachmentId`.

No provider path, mailbox credential, cache key, or filesystem location is exposed.

### Draft detail

`get_mail_draft` will add:

- `sourceMessageId` when the draft derives from another message;
- `to`;
- `cc`;
- `bcc`;
- `attachments` as metadata only;
- `createdAt`.

The response will never echo `dataBase64`. Existing subject, body, mode, and update timestamp behavior remains.

## Attachment input limits

The public per-attachment limit remains 25 MiB and the maximum count remains 20. A new configurable `maxTotalAttachmentBytes` composition limit defaults to 25 MiB and applies to the final attachment list accepted by:

- `create_mail_draft`;
- `update_mail_draft` when attachments are supplied;
- `prepare_mail_send` when attachments are supplied.

A shared validator will:

1. require non-empty canonical padded Base64 with no whitespace, preserving the current rejection of zero-byte attachment payloads;
2. calculate decoded length without retaining a second decoded copy;
3. require the decoded length to equal the declared `size`;
4. require each item to stay within the per-item limit;
5. require the sum of decoded lengths to stay within 25 MiB.

Malformed Base64 or a declared-size mismatch returns the existing `invalid_arguments` tool error. A per-item or aggregate size violation returns `attachment_too_large`.

Omitted attachments on draft update retain the existing draft attachment list. Newly supplied lists must pass all validation before any repository write or prepared operation is created.

## HTTP request boundary

`McpHttpTransport` will accept a configurable `maxRequestBytes` limit with a default of 40 MiB. This accommodates a 25 MiB decoded attachment set after Base64 expansion plus the currently permitted message bodies and normal JSON overhead. Pathological bodies whose JSON escaping pushes the wire representation beyond 40 MiB are intentionally rejected at the transport boundary.

The transport will:

1. reject a numeric `Content-Length` above the limit before body consumption;
2. read streaming or chunked bodies incrementally and stop when the byte count exceeds the limit;
3. parse JSON only after the bounded read succeeds;
4. return HTTP 413 with a stable `request_too_large` response when the boundary is exceeded.

Bearer authentication remains before expensive body parsing. Origin validation runs before authentication so an invalid browser origin is consistently rejected without consuming or parsing its body.

## Origin policy

Requests without an `Origin` header remain supported because native desktop MCP clients normally omit it.

When `Origin` is present, it must parse as an HTTP or HTTPS origin whose hostname is exactly one of:

- `localhost`;
- `127.0.0.1`;
- `::1`.

The comparison uses parsed hostname values rather than suffix or substring matching. `Origin: null`, credentials in the origin, malformed values, and non-loopback hostnames are rejected with HTTP 403 and a stable `origin_forbidden` response.

The policy applies to every method reaching `/mcp`, including POST and DELETE. It does not add CORS response headers. The server continues enforcing loopback-only binding and Bearer authentication.

## Tool annotations

Every tool returned by `tools/list` will include all four MCP behavior hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.

Annotations are declared per tool in the catalog rather than inferred solely from the existing coarse risk class.

| Tools | readOnly | destructive | idempotent | openWorld |
| --- | --- | --- | --- | --- |
| `list_mail_accounts`, `get_mail_sync_status`, `list_mail_messages`, `search_mail`, `get_mail_message`, `get_mail_thread`, `list_mail_drafts`, `get_mail_draft`, `get_mail_operation_status`, `list_todos`, `get_todo` | true | false | true | false |
| `list_mail_folders`, `get_mail_attachment` | true | false | true | true |
| `sync_mail_account` | false | true | false | true |
| `create_mail_draft`, `create_todo` | false | false | false | false |
| `update_mail_draft`, `update_todo`, `complete_todo`, `restore_todo`, `cancel_mail_operation` | false | true | false | false |
| `set_mail_state` | false | true | true | true |
| `prepare_mail_actions`, `prepare_mail_send`, `prepare_delete_entity` | false | false | false | false |
| `commit_mail_operation` | false | true | true | true |

`commit_mail_operation` uses worst-case destructive and open-world hints because one static annotation set covers send, move, spam, and permanent deletion. Its durable idempotency key justifies `idempotentHint: true`.

Annotations remain hints; they do not replace WeMail's internal risk policy, ownership checks, approval gates, or client confirmation.

## Pagination and response budgets

The shared pagination helper will accept a configurable maximum. `get_mail_thread.pageSize` will advertise and enforce a maximum of 50; other existing paged tools keep their current maximum of 100.

Thread assembly will apply an internal serialized-byte budget below the public 1 MB response limit. Messages are appended in order until either the requested item count or the byte budget is reached. When rows remain, `nextCursor` advances by the number actually returned, preventing both skipped messages and terminal `response_too_large` errors for valid body-size/page-size combinations.

At least one individually valid bounded message must be returned per non-empty page. The per-message body cap already ensures one item can fit within the thread response budget.

The draft-detail response budget will be raised from 1 MB to 16 MiB. This covers the existing schema's two one-million-character body fields even when JSON escaping expands their wire representation, plus recipient and attachment metadata. It aligns the response budget with inputs already accepted and drafts already storable, rather than silently truncating draft content as part of this hardening change.

## Error handling

The change reuses existing MCP tool errors where possible:

- `invalid_arguments` for malformed Base64 and size mismatches;
- `attachment_too_large` for item or aggregate attachment limits;
- `response_too_large` as a final invariant guard, not normal pagination control.

Transport-level errors are returned before JSON-RPC dispatch when no reliable request id is available:

- HTTP 403, `origin_forbidden`;
- HTTP 413, `request_too_large`.

No raw Origin, authorization value, Base64 content, attachment name, or message content is added to audit records or error messages.

## Implementation boundaries

- `McpToolCatalog.ts`: shared output schemas, annotations, thread page-size contract, response budgets.
- `McpComposition.ts`: output mapping, attachment validation, adaptive thread assembly.
- `McpHttpTransport.ts`: Origin validation, bounded request reading, annotation emission.
- MCP tests: catalog, message, attachment, draft/state, transport, runtime guards, and external-host acceptance.
- MCP architecture, user, release, and acceptance documentation: updated limits and discoverability behavior.

No new repository, provider, transport framework, public tool name, or approval path is introduced.

## Verification

Focused tests will prove:

1. a message detail exposes sender, recipients, time, and attachment id;
2. that attachment id successfully calls `get_mail_attachment`;
3. thread items expose the same metadata and paginate without skipping under a byte budget;
4. a draft round-trip exposes recipients and attachment metadata without Base64;
5. the configured aggregate attachment limit is accepted exactly and any excess is rejected; tests use a small injected limit while a separate assertion freezes the 25 MiB production default;
6. malformed Base64 and declared-size mismatch are rejected before writes;
7. all tools expose complete, semantically appropriate annotations;
8. missing and loopback Origin values are accepted while untrusted, null, and malformed origins receive 403;
9. declared and streaming request bodies above the configured limit receive 413;
10. `get_mail_thread.pageSize` rejects values above 50;
11. existing account isolation, approval, audit redaction, session, attachment-cache, and external-host acceptance behavior remains intact.

Verification commands will include the MCP test suite, repository type checking, and the relevant broader backend test command defined by the workspace.

## Compatibility

The public tool-name allowlist and protocol versions remain unchanged. Output additions are optional in the v1 schemas. Tightening thread `pageSize` and request/attachment limits intentionally rejects inputs that were previously accepted but silently clamped or unsafe. This is treated as a security and correctness repair to the newly introduced v1 surface.
