## 1. Types and classifier

- [x] 1.1 Write failing unit test for `WecliCommandClassifier.classify`: `ls` and `list` → `auto`; everything else → `requires-confirmation`; empty args → `requires-confirmation`.
- [x] 1.2 Create `server/wemail/skills/WecliTypes.ts` and `server/wemail/skills/WecliCommandClassifier.ts`.

## 2. AuditLogRepository

- [x] 2.1 Write failing unit test: `append(row)` inserts a well-formed row; rows are append-only (no update method).
- [x] 2.2 Write failing unit test asserting no mail body / attachment fields are acceptable inputs.
- [x] 2.3 Create `server/wemail/telemetry/AuditLogRepository.ts`.

## 3. WecliSkillRuntime

- [x] 3.1 Write failing unit test: `ls` path auto-executes, parses `-f json`, returns parsed result, and writes an `auto`-classified audit row.
- [x] 3.2 Write failing unit test: mutation path without prior confirm returns an error, writes a `refused` audit row, spawns no process.
- [x] 3.3 Write failing unit test: mutation path with valid confirm token executes, writes a `confirmed` audit row, returns parsed result.
- [x] 3.4 Write failing unit test: JSON parse failure falls back to raw text with a warning but still writes the audit row.
- [x] 3.5 Create `server/wemail/skills/WecliSkillRuntime.ts`; spawn `wecli` via array-form args (no shell).

## 4. Route wiring

- [x] 4.1 Write failing integration test for `classify` and `run` endpoints in `skillRoutes` (phase-one simplification: no separate `confirm` endpoint — `run` returns 412 with the classification payload when `approvedBy` is missing).
- [x] 4.2 Modify `server/api/routes/skillRoutes.ts` to wire the runtime.
- [x] 4.3 Ensure renderer `AgentActionConfirmDialog` (from Package D) is the UI entry for `requires-confirmation` path; document the contract in a code comment.

## 5. Safety

- [x] 5.1 Write test that audit rows never contain body-like fields.
- [x] 5.2 Write test that args are passed as an array (no shell interpolation).

## 6. Verification

- [x] 6.1 Run `npm run test:server` — must pass.
- [x] 6.2 Run `npm run typecheck:server` — must pass.
- [x] 6.3 Run `npm run typecheck:desktop` — must pass.
- [x] 6.4 Run `npm run build:desktop` — must pass.
- [x] 6.5 Confirm new code has unit / integration tests for classifier, repository, runtime, and routes.
- [x] 6.6 Confirm no violations of Handoff §6 hard rules (confirmation never bypassed, every call audited, no body in logs).
- [x] 6.7 Commit with the exact Handoff §5.I message: `git commit -m "feat(skills): add wecli runtime and audit logging"`.
