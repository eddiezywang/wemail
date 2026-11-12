# Secure Mail MCP architecture

The public MCP surface is intentionally independent from Pi/Agent tool registration. `McpToolCatalog.ts` is the versioned source of truth for public names, descriptions, strict input/output JSON Schemas, semantic risk, and response limits. Adding or changing a public tool requires updating the golden catalog test, schemas, account-isolation tests, limit tests, audit classification, this document, and compatibility fixtures. Internal Agent, Curator, WeCLI, automation, intelligence, directory, workspace, and configuration tools must never be registered through `McpPublicRegistry`.

The transport is a minimal internal Streamable HTTP implementation documented in `mcp-sdk-decision.md`. It validates any supplied Origin against loopback hosts, authenticates a bearer token before JSON-RPC parsing, bounds request bodies to 40 MiB, negotiates the supported protocol version, creates bearer-bound stateful sessions, advertises only Tools, and rejects unadvertised Resources/Prompts/Tasks/Sampling methods. Native clients may omit Origin. The Electron local API remains an independent ephemeral renderer listener; MCP uses a stable configurable loopback-only listener.

Every catalog entry publishes explicit MCP `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` annotations. These are client hints only; WeMail's internal risk classification, account ownership, authentication, and idempotency enforcement remain authoritative.

## Risk and operation state

The semantic risk matrix is centralized. Envelope/body reads are read-only; drafts, Todos, and single-message read/star changes are direct local writes. Send, destructive mailbox actions, all batches, and entity deletion remain classified as prepared high-risk operations, but a valid authenticated MCP request no longer requires a separate WeMail approval. Aliases or alternate argument shapes cannot downgrade risk because strict schemas and the frozen catalog run before handlers.

Prepared operation states are:

```text
approved → committing → succeeded
    │            ├────→ failed_retryable
    ├────→ expired
    ├────→ cancelled
    └────────────→ outcome_unknown
```

Canonical JSON is recursively key-sorted before SHA-256 hashing. Preparation binds account, token, session, operation id, payload hash, and expiry, then persists the operation directly as `approved` without creating an Action Center card. Commit atomically reserves `(account, idempotency-key hash, operation, payload hash)` before dispatch. A post-dispatch interruption becomes non-retryable `outcome_unknown`; startup reconciliation restores only pre-dispatch reservations to `approved`. Legacy `awaiting_confirmation` operations remain compatible with the existing approval route until they are resolved or expire.

## Privacy, limits, and audit

Authentication, schema, ownership, capability, declared-size, aggregate-size, and rate checks run before expensive reads/fetches/dispatch whenever possible. List/search SQL projections expose sender and message flags but do not select body or raw-header columns. Targeted message and thread reads expose sender, recipients, time, and attachment metadata so attachment ids are discoverable; inbound bytes remain available only through the session-bound attachment tool. Draft detail exposes recipients and attachment metadata but never echoes Base64. Opaque cursors bind account, tool, normalized filters, ordering, and expiry. Thread pages advertise at most 50 messages and stop earlier when the serialized-byte budget requires another cursor. Attachment URIs bind the current session and contain neither paths nor provider credentials.

Outbound bytes enter through `upload_mail_attachment`, which stages one canonical Base64 item in memory and returns an opaque account- and session-bound reference with a 15-minute lifetime. Temporary storage is bounded to 20 uploads and 25 MiB per session and 64 MiB process-wide, and is purged on expiry or session termination. Draft/send tools accept only staged `uploadRef` values and attachment ids already owned by the referenced draft; their final ordered set remains limited to 20 items and 25 MiB decoded in aggregate. The transport independently rejects declared or streamed request bodies above 40 MiB before JSON parsing.

Audit rows contain token fingerprint, session hash, tool, account, risk, argument shapes/counts, duration, outcome code, response bytes, operation id, and hashed idempotency key. They never contain raw arguments/results, subjects, snippets, addresses, bodies, headers, attachment names/bytes, paths, authorization headers, plaintext tokens, confirmation material, or provider errors. Sessions expire in memory; audits are retained for 30 days; revoked token metadata and terminal operations/idempotency rows are retained for 90 days for reconciliation before cleanup.

Compatibility gates include protocol fixtures, the hermetic real-server client, Codex/Claude configuration smoke tests, renderer tests, occupied-port isolation, and Windows desktop build/launch acceptance.
