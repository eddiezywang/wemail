## Why

WeMail currently exposes its local MCP credential as a manually created, one-time API token that users must deliberately save. That model fits a remote developer API, but it creates unnecessary setup and recovery friction for a loopback-only desktop integration whose expected workflow is simply enabling MCP and copying a ready-to-use client configuration.

## What Changes

- Treat the MCP bearer credential as an internal local-app implementation detail while preserving authenticated loopback access.
- Automatically provision a managed MCP credential when MCP is enabled or when a connection configuration is first requested.
- Store the managed credential with OS-backed encryption so WeMail can repeatedly produce a complete configuration without displaying or asking the user to save a raw token.
- Replace the primary create/rotate/revoke-token workflow with an always-available `Copy MCP configuration` action.
- Generate supported host configuration shapes from the same endpoint and managed credential, keeping host-specific JSON formatting separate from credential lifecycle.
- Move credential reset, fingerprint, session termination, diagnostics, and port controls into secondary or advanced UI.
- Preserve explicit credential reset, logout/replacement revocation, loopback-only binding, request authentication, session termination, logging redaction, and WeMail-owned confirmation for high-risk operations.
- Migrate existing manually created credentials without silently granting access to a different mailbox or exposing their plaintext.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `secure-mail-mcp`: Change MCP onboarding from explicit one-time token creation to automatic managed credentials and repeatable one-click configuration copy.
- `account-secretstore`: Require recoverable MCP connection credentials to use OS-backed encryption while remaining isolated from mailbox credentials and non-secret persistence.

## Impact

- Electron main-process secret storage and IPC for privileged configuration-copy operations.
- MCP credential service, listener lifecycle, settings API, migration behavior, and session invalidation.
- Shared MCP configuration contracts and supported-host formatters.
- Settings MCP section, connection status, advanced credential controls, and clipboard feedback.
- Existing MCP authentication, security, renderer, migration, restart, and external-host acceptance tests.
- User documentation describing a local connection configuration rather than an API-key lifecycle.
