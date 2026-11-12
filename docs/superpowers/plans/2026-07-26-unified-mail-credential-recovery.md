# Unified Mail Credential Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route NetEase 163 `LOGIN user in black list` failures through the same password-update and recovery-sync flow as invalid or expired passwords on a corporate mail service.

**Architecture:** Extend the existing server-side credential classifier so it returns a normalized, safe issue instead of only a boolean. Propagate that issue through startup status and existing mail-auth-required events, then let the workbench dispatch the existing credential-update event and reuse `MailCredentialDialog`. Recognized credential failures stop automatic retries until verified credentials are saved.

**Tech Stack:** TypeScript, Node `node:test`, React, TanStack Query, Vitest, Electron IPC/SSE.

## Global Constraints

- Corporate mail services and 163 use one shared credential-update interaction.
- Never send raw IMAP commands, usernames, or secrets to the renderer.
- `LOGIN user in black list` must remain visible in the safe 163 explanation.
- Unknown network/provider errors keep the generic recoverable-failure path.
- New credentials must be verified before they are saved.
- Successful replacement immediately triggers the existing 30-day recovery sync.

---

### Task 1: Normalize Recognized Credential Failures

**Files:**
- Modify: `server/wemail/mail/MailCredentialError.ts`
- Test: `server/wemail/mail/MailCredentialError.test.ts`

**Interfaces:**
- Produces: `classifyMailCredentialError(error: unknown): MailCredentialIssue | null`
- Produces: `MailCredentialIssue = { code: "MAIL_CREDENTIAL_INVALID"; message: string }`
- Preserves: `isMailCredentialInvalidError(error: unknown): boolean`

- [ ] **Step 1: Write failing classifier tests**

Add literal expectations that distinguish the two supported provider responses:

```ts
test("classifies the 163 black-list login response as credential invalid", () => {
  const issue = classifyMailCredentialError(commandError({
    responseStatus: "NO",
    responseText: "LOGIN user in black list",
  }));
  assert.deepEqual(issue, {
    code: "MAIL_CREDENTIAL_INVALID",
    message:
      "163 邮箱服务器拒绝登录（LOGIN user in black list），请更新邮箱密码或 IMAP 授权码。",
  });
});

test("keeps the corporate-mail password-invalid response in the shared flow", () => {
  const issue = classifyMailCredentialError(commandError({
    responseStatus: "NO",
    responseText: "LOGIN Login error or password error",
  }));
  assert.equal(issue?.code, "MAIL_CREDENTIAL_INVALID");
  assert.match(issue?.message ?? "", /密码.*过期|无效/);
});
```

Retain negative cases for non-login phases, network failures, and unrelated
`NO` responses.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx tsx --test server/wemail/mail/MailCredentialError.test.ts
```

Expected: FAIL because `classifyMailCredentialError` and the 163 branch do not exist.

- [ ] **Step 3: Implement the normalized classifier**

Require `MailProviderCommandError`, `imap.login`, and response status `NO`.
Match the corporate-mail `login error or password error` response and 163
`user in black list` separately. Return only fixed safe Chinese messages.
Implement the existing boolean helper as:

```ts
export function isMailCredentialInvalidError(error: unknown): boolean {
  return classifyMailCredentialError(error) !== null;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run the Task 1 command. Expected: all credential classifier tests pass.

- [ ] **Step 5: Commit**

```powershell
git add server/wemail/mail/MailCredentialError.ts server/wemail/mail/MailCredentialError.test.ts
git commit -m "fix: recognize 163 credential rejection"
```

### Task 2: Carry the Safe Reason Through Sync Boundaries

**Files:**
- Modify: `server/wemail/mail/MailCredentialError.ts`
- Modify: `server/wemail/mail/Mail Core sync worker.ts`
- Modify: `server/wemail/mail/MailBodySyncWorker.ts`
- Modify: `server/api/routes/mailRoutes.ts`
- Modify: `server/api/routes/mailEventsRoutes.ts`
- Modify: `server/wemail/performance/StartupSyncCoordinator.ts`
- Modify: `shared/wemail/startup.ts`
- Test: `server/wemail/mail/Mail Core sync worker.test.ts`
- Test: `server/api/routes/mailRoutes.test.ts`
- Test: `server/api/routes/mailEventsRoutes.test.ts`
- Test: `server/wemail/performance/StartupSyncCoordinator.test.ts`

**Interfaces:**
- Extends: `MailCredentialInvalidEvent` with `message: string`
- Extends: `StartupSyncStatus` with `errorMessage: string | null`
- Consumes: `classifyMailCredentialError`

- [ ] **Step 1: Write failing propagation tests**

Add tests proving:

```ts
assert.deepEqual(receivedCredentialEvent, {
  accountId: "acct-1",
  code: "MAIL_CREDENTIAL_INVALID",
  stage: "imap.login",
  message:
    "163 邮箱服务器拒绝登录（LOGIN user in black list），请更新邮箱密码或 IMAP 授权码。",
});
```

For startup sync, throw a 163 `MailProviderCommandError` from `syncRecent`
and assert:

```ts
assert.equal(status.status, "failed");
assert.equal(status.errorCode, "MAIL_CREDENTIAL_INVALID");
assert.match(status.errorMessage ?? "", /LOGIN user in black list/);
assert.equal(watcherStarts, 0);
```

For an offline error, assert `errorCode === "offline"` and
`errorMessage === null`.

For HTTP and SSE responses, assert the safe `message` is present and raw
fields such as `executedCommand`, the username, and password are absent.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx tsx --test server/wemail/mail/Mail Core sync worker.test.ts server/wemail/performance/StartupSyncCoordinator.test.ts server/api/routes/mailRoutes.test.ts server/api/routes/mailEventsRoutes.test.ts
```

Expected: FAIL on missing message fields and generic startup error code.

- [ ] **Step 3: Implement event and startup propagation**

At each catch boundary, call `classifyMailCredentialError(error)` once.
When non-null, emit/return the normalized code and message. In
`StartupSyncCoordinator`, store:

```ts
errorCode: issue?.code ?? safeErrorCode(error),
errorMessage: issue?.message ?? null,
```

Initialize `errorMessage` to `null`. Preserve current behavior for unknown
errors. The existing watcher already stops after
`isMailCredentialInvalidError`; the expanded classifier makes 163 use that
same stop condition.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Task 2 command. Expected: all selected server tests pass.

- [ ] **Step 5: Commit**

```powershell
git add shared/wemail/startup.ts server/wemail/mail server/wemail/performance/StartupSyncCoordinator.ts server/api/routes/mailRoutes.ts server/api/routes/mailEventsRoutes.ts server/api/routes/*.test.ts
git commit -m "feat: propagate credential recovery reasons"
```

### Task 3: Reuse the Existing Password-Update Dialog

**Files:**
- Modify: `app/lib/mailCredentialEvents.ts`
- Modify: `app/hooks/useMailEvents.ts`
- Modify: `app/routes/_workbench.tsx`
- Modify: `app/components/MailCredentialDialog.tsx`
- Modify: `app/services/api.ts`
- Modify: `electron/main/mail-events.ts`
- Modify: `electron/preload/index.ts`
- Test: `app/hooks/useMailEvents.test.tsx`
- Test: `app/routes/_workbench.test.tsx`
- Test: `app/components/MailCredentialDialog.test.tsx`
- Test: `electron/main/mail-events.test.ts`

**Interfaces:**
- Extends: `MailAuthRequiredDetail` with `message: string`
- Consumes: `StartupSyncStatus.errorCode` and `errorMessage`
- Reuses: `dispatchMailAuthRequired` and `MailCredentialDialog`

- [ ] **Step 1: Write failing renderer behavior tests**

In the workbench test, return a failed startup status:

```ts
startup: {
  accountId: "acct-1",
  runId: "run-163",
  status: "failed",
  phase: "recoverable-failure",
  errorCode: "MAIL_CREDENTIAL_INVALID",
  errorMessage:
    "163 邮箱服务器拒绝登录（LOGIN user in black list），请更新邮箱密码或 IMAP 授权码。",
  progress: { inserted: 0, updated: 0, processed: 0,
    pendingBodies: 0, pendingIntelligence: 0 },
}
```

Assert that the concrete message appears and one
`wemail:mail-auth-required` event is dispatched for that run. Re-rendering or
polling the same `runId` must not dispatch a second event.

In the dialog test, dispatch the event with the 163 message and assert:

```ts
expect(await screen.findByText(/LOGIN user in black list/)).toBeInTheDocument();
expect(screen.getByText("邮箱密码需要更新")).toBeInTheDocument();
```

Keep the existing verification/save/recovery-sync test unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx vitest run app/routes/_workbench.test.tsx app/components/MailCredentialDialog.test.tsx app/hooks/useMailEvents.test.tsx electron/main/mail-events.test.ts
```

Expected: FAIL because event payloads and startup handling do not carry the message.

- [ ] **Step 3: Implement the shared UI flow**

Pass `message` through SSE, Electron IPC, preload, and renderer event types.
In `MessageListView`, use an effect keyed by `startup.runId` that dispatches
the existing auth-required event only when:

```ts
startup.status === "failed" &&
startup.errorCode === "MAIL_CREDENTIAL_INVALID" &&
startup.errorMessage
```

Track the last dispatched run in a ref. For recognized failures, render
`startup.errorMessage`; for unknown failures, retain the generic cached-mail
message.

Store the event message in `MailCredentialDialog` and show it in the dialog
description or alert above the password field. Keep the existing form,
verification endpoint, secret saving, and 30-day recovery sync.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Task 3 command. Expected: all selected renderer and Electron tests pass.

- [ ] **Step 5: Commit**

```powershell
git add app electron/main/mail-events.ts electron/preload/index.ts
git commit -m "feat: open credential recovery for startup failures"
```

### Task 4: Regression Verification and Desktop Validation

**Files:**
- No production files expected.

**Interfaces:**
- Verifies the complete server-to-renderer credential recovery path.

- [ ] **Step 1: Run focused tests**

Run the Task 1, Task 2, and Task 3 commands together. Expected: all pass.

- [ ] **Step 2: Run type checks**

```powershell
npm run typecheck:server
npm run typecheck:desktop
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 3: Run full regression suites**

```powershell
npm run test:server
npm run test:renderer
```

Expected: both commands exit 0.

- [ ] **Step 4: Build the desktop application**

```powershell
npm run package:desktop:installer
```

Expected: `dist/WeMail Setup 0.1.1.exe` is produced.
