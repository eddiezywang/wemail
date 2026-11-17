## 1. Contracts and Persistence

- [x] 1.1 Add focused baseline tests for current MCP token creation, verification, listener enable/disable, renderer management state, and legacy one-time configuration behavior.
- [x] 1.2 Extend shared MCP management contracts with managed/legacy credential metadata, credential readiness errors, copy targets, and secret-free copy results.
- [x] 1.3 Add a database migration that classifies existing MCP token rows as legacy and supports one active managed credential alongside still-valid legacy credentials.
- [x] 1.4 Add migration and repository tests proving existing active credentials remain valid, new rows have deterministic kinds, and no bearer plaintext enters SQLite.

## 2. OS-Protected Managed Credential Vault

- [x] 2.1 Implement a versioned Electron-main `McpCredentialVault` that atomically stores account-bound encrypted blobs using `safeStorage`.
- [x] 2.2 Implement vault read, delete, corruption quarantine, encryption-unavailable, and account-mismatch behavior without logging secret material.
- [x] 2.3 Add unit tests with an injected encryption adapter proving restart recovery, overwrite safety, deletion, fail-closed behavior, and absence of plaintext on disk.
- [x] 2.4 Keep the existing verifier pepper behind `SecretStore` while preventing the production desktop from using `FileSecretStore` for recoverable managed bearer values.

## 3. Managed Credential Lifecycle

- [x] 3.1 Define an injectable managed-credential vault contract at the Electron/local-API composition boundary without exposing it through renderer HTTP routes.
- [x] 3.2 Implement candidate provisioning in `McpAccessTokenService` so a generated credential becomes active only after the injected vault confirms encrypted persistence.
- [x] 3.3 Implement idempotent recovery for interrupted provisioning, including cleanup of orphaned candidates and encrypted blobs.
- [x] 3.4 Add service tests for one managed credential per account, repeatable reuse, legacy coexistence, reset revocation, account logout/replacement, and session termination.
- [x] 3.5 Update MCP enablement so it automatically ensures a managed credential before listener readiness, while disable stops sessions and retains the encrypted managed credential.
- [x] 3.6 Surface safe credential-unavailable and credential-corrupt management states without exposing account existence or secret values.

## 4. Privileged Configuration Copy

- [x] 4.1 Add deterministic shared formatters and golden tests for the generic/Codex server-entry JSON and Claude `mcpServers` JSON using the same endpoint and credential.
- [x] 4.2 Add a narrow preload/main IPC operation that validates the requested target, retrieves the current endpoint, decrypts the managed credential, and writes JSON directly to the system clipboard.
- [x] 4.3 Ensure the copy operation returns only success and safe error metadata to the renderer and never enters query caches, renderer persistence, telemetry, or normal logs.
- [x] 4.4 Add Electron main, preload bridge, and mail-core integration tests for successful copy, repeat copy without rotation, restart copy, unsupported target, unavailable encryption, corrupt blob, and disabled listener.

## 5. MCP Settings Experience

- [x] 5.1 Replace the renderer's create/rotate/one-time-save token workflow with automatic readiness and one primary `Copy MCP configuration` action.
- [x] 5.2 Add a masked configuration preview and a secondary supported-host format selector that does not create or rotate credentials.
- [x] 5.3 Move fingerprint, legacy credential metadata, reset, active sessions, session termination, diagnostics, and port controls into an advanced section.
- [x] 5.4 Add clear UI states for provisioning, listening, port conflict, OS encryption unavailable, corrupt credential, copy success, and copy failure.
- [x] 5.5 Update component and query tests to prove raw bearer values never render and revisiting the panel keeps copy available.

## 6. Security, Migration, and Acceptance

- [x] 6.1 Add secret-scanning tests covering encrypted vault files, SQLite, logs, diagnostics, renderer messages, query state, and crash-safe error paths.
- [x] 6.2 Add upgrade acceptance coverage proving a legacy client remains authenticated while a new managed configuration can be copied and used concurrently.
- [x] 6.3 Add reset/logout acceptance coverage proving all prior credentials and sessions become unusable and a replacement account cannot inherit access.
- [x] 6.4 Run external-host smoke tests against copied Codex/generic and Claude configurations and verify repeat copy does not change the bearer fingerprint.
- [x] 6.5 Update MCP setup, security, reset, troubleshooting, and migration documentation to describe a local connection configuration rather than API-key management.
- [x] 6.6 Run the focused MCP, Electron bridge, renderer, migration, and secret-store tests, then run `npm test`, `npm run typecheck`, and `npm run build:desktop`.
- [x] 6.7 Launch the packaged or production-mode Windows desktop app and verify enable, copy, paste into a supported MCP host, restart, disable/re-enable, reset, port-conflict recovery, and no renderer style/startup regression.
