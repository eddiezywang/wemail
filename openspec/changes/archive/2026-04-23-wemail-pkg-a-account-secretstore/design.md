## Context

WeMail's server layer already has a SQLite migration for the `accounts` table and a Fastify-style route skeleton at `server/api/routes/accountRoutes.ts`. Shared DTOs live in `shared/wemail/account.ts`. Nothing today writes or reads account configuration, and nothing stores the IMAP/SMTP password safely. This package plugs that gap so packages B (IMAP/SMTP provider) and C (queue wiring) have a real account to work with.

## Goals / Non-Goals

**Goals:**

- Persist one WeMail account (IMAP host/port/tls, SMTP host/port/tls, username, display name, etc.) in the existing `accounts` table.
- Keep the IMAP/SMTP password out of the `accounts` table — store it through `SecretStore`.
- Provide a small, stable `SecretStore` interface so a phase-two implementation can swap the backing store without touching callers.
- Expose `GET /api/account/current`, `POST /api/account/login`, `POST /api/account/logout`.
- Guarantee that logout only clears session/secret rows, leaving mail cache intact.

**Non-Goals:**

- Multi-account support, OAuth, or IMAP-IDLE tuning.
- UI polish for login (covered in package D).
- Encrypted-at-rest mail bodies.

## Decisions

- **SecretStore interface first, implementation second.** Shape: `saveSecret(key, value) / getSecret(key) / deleteSecret(key)`. Keys are namespaced (`wemail:account:<id>:imap-password`). Phase-one implementation MAY delegate to Electron `safeStorage` when available, otherwise write an obfuscated file under the user-data dir with a header comment warning it is a placeholder. Alternative rejected: encrypting inline in SQLite — too coupled to one backing store.
- **AccountService is a single-account facade.** Methods: `getCurrent()`, `saveAccount(input)`, `updateAccount(patch)`, `logout()`. Internally delegates persistence to the existing account row repository and credential persistence to `SecretStore`. Alternative rejected: a generic account repository — violates the Handoff §2 "no multi-account complexity" rule.
- **Consumed shared types.** `shared/wemail/account.ts` remains the single source of truth for DTOs; server types in `AccountTypes.ts` re-export or narrow those shapes. Downstream packages (B, C, D, J) import only from `shared/wemail/*`.
- **Route shape.** `POST /api/account/login` takes an account config payload, stores it, and returns the redacted current account. `POST /api/account/logout` calls `AccountService.logout()` which deletes secret keys and clears the session but preserves `mail_messages`, `intelligence_*`, `mail_tag_feedback_rules`, and `wecli_audit_logs` tables.

## Risks / Trade-offs

- **[Risk] Phase-one placeholder SecretStore is not truly encrypted when `safeStorage` is unavailable.** → Mitigation: document behavior, gate writes behind an `isEncryptionAvailable()` probe, log a warning (no secret contents) at startup, and keep the interface stable so production uses `safeStorage`.
- **[Risk] Accidental deletion of local mail cache on logout.** → Mitigation: explicit unit test that logout leaves `mail_messages` and `mail_ai_artifacts` rows intact.
- **[Risk] Passwords accidentally captured in logs.** → Mitigation: `AccountService` never passes secrets to the app logger; route handlers redact the payload before any debug log.

## Migration Plan

- No data migration: `accounts` table already exists; `password` column (if any) MUST remain unused by this change.
- Rollback: deleting `server/wemail/account/*` and `server/wemail/security/SecretStore.ts` plus reverting the three route handlers reverts the change cleanly.

## Open Questions

- Final naming for secret keys (`wemail:account:<id>:imap-password` vs `wemail:account:<username>:imap-password`). Resolvable in implementation.
