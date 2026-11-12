## Context

The current MCP implementation deliberately models credentials as conventional API keys: users explicitly create a token, plaintext is returned once, SQLite retains only verifier metadata, and later visits show only a fingerprint. This protects against accidental secret recovery but makes the common local-desktop workflow brittle: copying a complete configuration is possible only during token creation, and losing that moment requires rotation and invalidates an existing client.

MCP remains a real local trust boundary. A loopback listener can be reached by other processes running as the user, so removing authentication is not acceptable. The change must instead make authentication invisible in the normal UI while preserving revocation, audit, account isolation, and approval gates.

The desktop architecture also matters: the MCP listener and token verifier are composed by `electron/main/local-api.ts` in the privileged Electron main process. Electron `safeStorage`, the MCP controller, and the system clipboard can therefore cooperate in-process without exposing the raw managed credential to the renderer.

## Goals / Non-Goals

**Goals:**

- Make enabling MCP and copying a complete configuration the only normal setup actions.
- Allow the same managed configuration to be copied again after navigation or restart.
- Protect the recoverable credential with the current OS user's encryption boundary.
- Keep bearer authentication, loopback-only binding, revocation, session invalidation, and high-risk confirmation semantics.
- Generate deterministic supported-host JSON without coupling host formatting to token creation.
- Migrate existing one-time credentials without silently invalidating working clients.

**Non-Goals:**

- Removing MCP authentication because the listener uses loopback.
- Adding remote-network MCP access.
- Giving MCP clients direct mailbox/provider credentials.
- Automatically editing third-party client configuration files.
- Replacing the public MCP tool registry, protocol transport, risk policy, or approval model.
- Solving OS-backed storage for every existing WeMail secret in the same change.

## Decisions

### 1. Use one account-bound managed device credential

WeMail will maintain one managed MCP credential for the current account. Enabling MCP ensures that the credential exists; copying configuration reads the same credential rather than rotating it. Resetting the connection credential atomically replaces it and terminates sessions authenticated by the old credential.

This matches the mental model of one local WeMail installation rather than a collection of user-managed API keys. Per-client credentials were considered, but they require client naming, a credential list, and revocation choices that recreate the management burden this change is intended to remove. They can be added later without changing the one-click primary flow.

### 2. Preserve bearer authentication but hide raw-token lifecycle

Generated JSON will continue to contain an `Authorization: Bearer ...` header because loopback is not an authorization boundary. The settings UI will not expose standalone create, save, or rotate-token steps. It will show connection readiness, a copy action, and advanced reset/session controls.

Removing authentication was rejected because unrelated local processes could initialize an MCP session and access mailbox tools.

### 3. Keep recoverable credential custody in Electron main

Electron main will own a small `McpCredentialVault` backed by `safeStorage`. The encrypted blob will be stored under the app's user-data directory with an account-bound key and format version. SQLite will continue to hold token identity, verifier/fingerprint, status, and lifecycle metadata, never the raw token.

The vault will be injected into the MCP controller by the Electron composition boundary. The controller generates and verifies credentials, while a narrow desktop IPC handler decrypts the active managed credential, combines it with non-secret endpoint state, serializes the selected host format, and writes it directly to the system clipboard. The renderer receives success/error metadata, not the bearer value.

Moving the MCP lifecycle into the mail-core utility process or making the general `SecretStore` asynchronous was rejected because the current MCP composition already lives in Electron main. Persisting recoverable plaintext in the current `FileSecretStore` was rejected because that implementation is explicitly obfuscation rather than cryptographic protection.

### 4. Make provisioning transactional from the user's perspective

Enabling MCP follows this observable sequence:

1. Ensure a current mail account exists and OS encryption is available.
2. Reuse a decryptable managed credential, or generate a new candidate in mail core.
3. Encrypt and durably store the candidate through the injected main-process vault.
4. Commit its active verifier metadata and start the loopback listener.
5. Return a ready/error state without returning plaintext to the renderer.

If encrypted persistence fails, the candidate is revoked or never activated and MCP remains unavailable with an actionable local-credential error. Listener startup failure does not delete a valid managed credential; resolving the port conflict can reuse it.

### 5. Copy through a privileged bridge, with explicit formatters

The preload bridge will expose a narrow operation such as `copyMcpConfiguration(target)`. Supported targets initially include the current generic/Codex server-entry shape and the Claude `mcpServers` wrapper. A shared formatter will produce deterministic JSON from server name, endpoint, and bearer credential.

The panel keeps one primary `Copy configuration` action using the last-selected or product-default target. Alternate formats live in an adjacent secondary menu. The copied JSON contains the full secret, while the visible preview masks the authorization value.

Returning configuration JSON from an ordinary renderer HTTP API was rejected because it unnecessarily exposes the recoverable credential to renderer state, developer tools, query caches, and browser storage.

### 6. Preserve legacy credentials during migration

Existing one-time credentials are not recoverable and cannot become managed credentials. A migration will classify existing active rows as legacy. The first managed provisioning creates a separate managed credential without revoking the legacy credential, so already configured clients continue to work.

Legacy credentials remain visible only as redacted advanced metadata and may be revoked by `Reset connection credential`, account logout/replacement, or an explicit advanced cleanup action. New normal flows create at most one active managed credential. This avoids a silent breaking change while allowing users to converge on the new configuration.

### 7. Keep disable and reset semantics distinct

Disabling MCP stops the listener and terminates sessions but retains the encrypted managed credential, allowing a later re-enable to restore the same configuration. `Reset connection credential` revokes all current account MCP credentials, terminates sessions, deletes the encrypted managed secret, provisions a replacement when MCP remains enabled, and copies nothing automatically.

This distinction makes the toggle reversible without forcing every client to be reconfigured, while still providing an explicit way to invalidate copied configurations.

## Risks / Trade-offs

- [A copied JSON contains a reusable mailbox-access credential] → Keep the preview masked, copy only on direct user action, write no secret to renderer/logs, and retain reset/session controls.
- [OS encryption can be unavailable or locked] → Fail closed for managed provisioning and copying, surface an actionable state, and do not fall back to the obfuscated file store in production.
- [Credential persistence can fail after verifier creation] → Use candidate/commit/abort service methods with idempotent recovery and delete orphaned encrypted blobs or verifier rows during reconciliation.
- [Legacy credentials can remain valid longer than users expect] → Label them in advanced diagnostics and revoke all credentials on reset, logout, account replacement, or data clear.
- [Multiple host schemas make “one universal JSON” impossible] → Keep one primary copy button while implementing small, tested formatters over the same endpoint and credential.
- [Clipboard managers may retain copied JSON] → Explain that copied configuration grants local mailbox access and make reset a single explicit action.

## Migration Plan

1. Add credential-kind/version metadata and classify existing active rows as `legacy`.
2. Add the Electron main encrypted vault and inject it into the local MCP controller.
3. Add managed credential ensure/reset behavior without changing verification of legacy tokens.
4. Add privileged configuration-copy IPC and host formatters.
5. Replace the normal renderer token workflow with ready/copy/reset controls.
6. Preserve legacy authentication until explicit reset/logout and verify restart behavior.
7. After acceptance, remove normal UI/API dependencies on one-time plaintext token results while retaining any development-only test seams.

Rollback keeps legacy token verification and existing listener settings intact. A rolled-back build will not understand the managed encrypted blob, so migration must not delete legacy credentials automatically; users can still create a conventional token after rollback if no legacy credential exists.

## Open Questions

- Whether the default copy target should be the generic/Codex entry or be selected once during first use.
- Whether legacy credentials should remain indefinitely until reset or receive a future user-visible retirement policy.
