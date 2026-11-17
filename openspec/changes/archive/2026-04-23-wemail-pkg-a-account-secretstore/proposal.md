## Why

WeMail phase one is an Electron desktop app limited to a single IMAP/SMTP account, but the current skeleton has no way to persist account credentials or configuration. Without an AccountService and a SecretStore, downstream packages (IMAP/SMTP sync, queue, intelligence, agent) have nothing to authenticate against and no safe place to keep the password. This package establishes that foundation.

## What Changes

- Add `server/wemail/account/AccountService.ts` to save, read, and update the single WeMail account.
- Add `server/wemail/account/AccountTypes.ts` for local account DTOs.
- Add `server/wemail/security/SecretStore.ts` with a stable `saveSecret / getSecret / deleteSecret` API (phase-one implementation MAY use Electron `safeStorage` or a file-level placeholder behind the interface).
- Modify `server/api/routes/accountRoutes.ts` to expose `GET /api/account/current`, `POST /api/account/login`, `POST /api/account/logout`.
- Modify `shared/wemail/account.ts` to keep shared DTOs aligned with the new service.
- Logout MUST only delete the session/secret; it MUST NOT wipe the local mail cache.
- Passwords/secrets MUST NOT be stored in plaintext inside the `accounts` table.

## Capabilities

### New Capabilities
- `account-secretstore`: single-account configuration, IMAP/SMTP credential persistence, and the secret-store abstraction used by the rest of WeMail.

### Modified Capabilities
- (none — no existing specs)

## Dependencies

- Upstream OpenSpec changes: **none** (this is the foundation package).
- Runtime prerequisite: the existing Electron + local API + SQLite skeleton from baseline commit `c4462bc`.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron desktop only, single account, single mailbox, IMAP/SMTP protocol.
- LLM surface supports OpenAI-compatible and Anthropic Messages (not consumed here but shape must remain compatible).
- Built-in agent is PI (not Claude Code).
- WeCLI auto-approves `ls/list` only; everything else requires confirmation; all calls audited.
- **Logout MUST NOT wipe the local DB.**
- New mail → durable queue; summary retry ≤ 2.
- One fixed summary prompt.
- Agent may draft but never auto-send.
- No mail body in logs.
- Phase one is Windows-only, but shared logic MUST stay cross-platform.

## Impact

- Code: `server/wemail/account/*`, `server/wemail/security/SecretStore.ts`, `server/api/routes/accountRoutes.ts`, `shared/wemail/account.ts`.
- API: introduces `GET /api/account/current`, `POST /api/account/login`, `POST /api/account/logout`.
- DB: uses existing `accounts` table — secrets kept out of it.
- Dependencies: Electron `safeStorage` (optional), no new npm dependencies required.
