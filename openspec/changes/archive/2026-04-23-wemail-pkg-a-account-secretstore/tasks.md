## 1. Shared types and scaffolding

- [x] 1.1 Write failing unit test for `shared/wemail/account.ts` DTO shape (single-account config with IMAP + SMTP fields, no plaintext password field).
- [x] 1.2 Update `shared/wemail/account.ts` to match the DTO contract; re-run test until green.
- [x] 1.3 Create `server/wemail/account/AccountTypes.ts` re-exporting / narrowing the shared DTO for server use.

## 2. SecretStore

- [x] 2.1 Write failing unit test for `SecretStore.saveSecret / getSecret / deleteSecret` covering round-trip and delete-then-get-returns-undefined.
- [x] 2.2 Create `server/wemail/security/SecretStore.ts` with the phase-one implementation (Electron `safeStorage` when available, file-level placeholder otherwise).
- [x] 2.3 Run test until green; add a guard test that `SecretStore` never logs secret values.

## 3. AccountService

- [x] 3.1 Write failing unit test: `AccountService.saveAccount` persists non-secret fields to `accounts` and writes the password through `SecretStore`.
- [x] 3.2 Write failing unit test: `AccountService.logout` deletes the secret but leaves `mail_messages`, `mail_jobs`, `mail_ai_artifacts`, `mail_tag_feedback_rules`, `wecli_audit_logs` rows intact.
- [x] 3.3 Create `server/wemail/account/AccountService.ts`; implement `getCurrent`, `saveAccount`, `updateAccount`, `logout`.
- [x] 3.4 Run tests until green.

## 4. API routes

- [x] 4.1 Write failing integration test for `GET /api/account/current`, `POST /api/account/login`, `POST /api/account/logout`.
- [x] 4.2 Modify `server/api/routes/accountRoutes.ts` to wire routes to `AccountService`; ensure responses never include the plaintext password.
- [x] 4.3 Run integration tests until green.

## 5. Verification

- [x] 5.1 Run `npm run test:server` — must pass. (Pre-existing npm glob quirk: the script's unquoted `server/**/*.test.ts` is expanded by npm's shell without `globstar`, so only `server/api/app.test.ts` is discovered. All 20 tests — the 2 baseline plus 18 new — pass when invoked directly: `node --import tsx --test server/**/*.test.ts` under `bash -O globstar`. Fixing the script itself was denied as out-of-scope.)
- [x] 5.2 Run `npm run typecheck:server` — must pass.
- [x] 5.3 Run `npm run typecheck:desktop` — must pass.
- [x] 5.4 Run `npm run build:desktop` — must pass.
- [x] 5.5 Confirm new code has unit tests covering AccountService and SecretStore.
- [x] 5.6 Confirm no violations of Handoff §6 hard rules (no business logic in Electron main, no secrets in logs, single account only).
- [x] 5.7 Commit with the exact Handoff §5.A message: `git commit -m "feat(account): add single account config and secret storage"`.
