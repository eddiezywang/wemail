## Why

WeMail already has a mature internal mail-agent tool surface, provider abstractions, pending-action confirmation, idempotent action execution, drafts, attachments, synchronization, and mail-linked todos. The renderer even advertises an MCP endpoint, but the repository does not currently mount a production MCP transport and the displayed legacy tool list is disconnected from the actual Agent registry.

Competitor reconnaissance confirms that a local Streamable HTTP MCP is a useful product boundary for allowing Codex, Claude, and other MCP hosts to work with a user's mailbox. It also exposes failure modes WeMail should avoid: list calls returning complete HTML bodies, JSON encoded as text instead of structured results, direct permanent deletion mixed with reversible actions, and send confirmation tokens that are available to the same model that prepared the send.

WeMail should expose its existing capabilities through a secure, context-efficient MCP server whose public contract is deliberately smaller than the internal Agent surface and whose external side effects remain subject to WeMail-owned confirmation, account isolation, audit, and idempotency.

## What Changes

- Mount a standards-compatible Streamable HTTP MCP endpoint on a stable loopback listener in the existing local API process and share its composition and lifecycle with the desktop server.
- Add local MCP access-token creation, rotation, revocation, storage, and redacted connection metadata without exposing mailbox or provider credentials.
- Introduce a versioned public MCP tool registry with an explicit allowlist, stable JSON Schemas, structured output, output schemas, error codes, and capability metadata.
- Publish provider-neutral account and folder discovery, bounded synchronization, envelope-only message listing and search, targeted message/thread reads, attachment resources, provider-backed drafts, prepared mail operations, safe state changes, and mail-linked todo tools.
- Keep list and search results body-free. Full body retrieval is allowed only for a targeted message or thread, defaults to plain text and a bounded character limit, and reports truncation.
- Route every send, archive, move, trash, spam, permanent delete, batch mutation, draft deletion, and todo deletion through a durable prepared-operation record. Preparation does not grant execution authority; the exact operation must be approved in WeMail before an MCP commit can execute it.
- Require payload-hash binding, expiration, account ownership, idempotency keys, durable status, and uncertain-outcome handling for committed operations.
- Expose attachment bytes as MCP embedded resources with size and MIME validation rather than embedding base64 payloads in ordinary JSON results.
- Replace the renderer's hard-coded legacy MCP tool list with live server capability and connection-state data.
- Add metadata-only audit, rate limits, concurrency limits, response-size limits, session cleanup, privacy-safe diagnostics, and explicit remote-binding safeguards.
- Deliver the feature behind an opt-in local setting, then make it generally available only after protocol, security, desktop, and external-host acceptance gates pass.

## Capabilities

### New Capabilities

- `secure-mail-mcp`: Local Streamable HTTP transport, authentication, public tool registry, structured mail/todo contracts, content minimization, prepared operations, embedded attachment resources, audit, limits, lifecycle, and connection UI.

### Modified Capabilities

- `pi-agent-runtime`: Reuse WeMail-owned tool handlers through separate internal-Agent and public-MCP registries without allowing MCP clients to reach internal-only tools or bypass semantic risk policy.
- `mail-sync`: Admit MCP-requested synchronization through the existing account-scoped single-flight coordinator and expose bounded, resumable progress rather than starting an independent sync pipeline.
- `account-secretstore`: Store MCP bearer-token material through `SecretStore`, expose only token fingerprints after creation, and support rotation and revocation without changing mailbox credentials.

## Impact

- Server API: new `/mcp` transport, MCP session/auth middleware, protocol handlers, tool/result adapters, attachment resource delivery, operation status tools, and capability/settings endpoints.
- Composition root: MCP registry, session manager, token service, prepared-operation service, rate limiter, lifecycle teardown, and adapters over existing mail, sync, draft, todo, pending-action, and action-executor services.
- Shared contracts: public MCP tool names, versioned account capabilities, envelope/detail/thread/draft/todo results, structured errors, pagination cursors, prepared-operation states, and audit metadata.
- Persistence: additive MCP token metadata, sessions where needed, prepared-operation payload hashes/status/idempotency reservations, and metadata-only audit records. Mail, account, draft, todo, and Agent data remain compatible.
- Renderer: replace the static `MCPPanel` inventory with enable/disable, token creation/rotation/revocation, copyable connection configuration, live capabilities, session visibility, and pending-operation navigation.
- Security: bearer tokens remain local secrets; normal logs exclude tokens, authorization headers, mail bodies, attachment bytes, raw tool payloads, confirmation proofs, and provider credentials.
- Tests: protocol conformance, authentication, account isolation, schemas, pagination, body minimization, prompt-injection containment, prepared-operation confirmation/idempotency, attachment resources, rate limits, restart recovery, external MCP-host smoke tests, and Windows desktop acceptance.
