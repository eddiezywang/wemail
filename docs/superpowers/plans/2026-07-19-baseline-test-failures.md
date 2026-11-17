# Baseline Test Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the full renderer and server test suites pass by correcting simulated Windows path handling, replacing an obsolete send-action assertion, and waiting for asynchronous intelligence results rather than only pending jobs.

**Architecture:** Platform-dependent path operations select `path.win32` whenever the injected platform is Windows, so tests and packaged behavior use the same semantics on every host. Server integration tests wait for the observable persisted result, avoiding races with the already-running queue worker. The send-action test is updated to assert the implemented, account-scoped behavior.

**Tech Stack:** Node.js `path`, TypeScript, Vitest, `node:test`, `node:assert/strict`.

---

### Task 1: Correct Injected Windows Path Semantics

**Files:**
- Modify: `electron/main/windows-shortcut.ts`
- Test: `electron/main/windows-shortcut.test.ts`
- Modify: `server/wemail/skills/WecliSkillRuntime.ts`
- Test: `server/wemail/skills/WecliSkillRuntime.test.ts`

- [ ] **Step 1: Verify the existing regression tests fail**

Run:

```bash
npm run test:renderer -- electron/main/windows-shortcut.test.ts
node --import tsx --test --test-name-pattern='resolveWecliBinary (finds|skips)' server/wemail/skills/WecliSkillRuntime.test.ts
```

Expected: three shortcut failures and two wecli resolution failures on non-Windows hosts.

- [ ] **Step 2: Select the path implementation from the injected platform**

Use this pattern in both implementations:

```ts
const platformPath = platform === "win32" ? path.win32 : path;
```

Use `platformPath.join`, `platformPath.dirname`, `platformPath.basename`, and
`platformPath.normalize`. Split a simulated Windows `PATH` with `;` instead of
the host's `path.delimiter`.

- [ ] **Step 3: Run both focused suites**

Expected: all shortcut and wecli binary resolution tests pass.

### Task 2: Align the Send Action Test With Implemented Behavior

**Files:**
- Modify: `server/wemail/agent/MailActionExecutor.test.ts`

- [ ] **Step 1: Replace the obsolete not-implemented test**

Create a provider spy and execute a valid account-scoped send input:

```ts
const sent: WemailDraftInput[] = [];
const provider = {
  ...stubProvider(),
  sendDraft: async (draft: WemailDraftInput) => {
    sent.push(draft);
    return { messageId: "sent-message-id" };
  },
};
const result = await exec.execute(
  row({
    action_type: "send",
    email_id: null,
    input_json: JSON.stringify({
      accountId: "acct-1",
      to: [{ email: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Confirmed subject",
      bodyText: "Confirmed body",
    }),
  }),
  { accountId: "acct-1" },
);
```

Assert that the provider receives the draft and the successful result contains
the provider message ID.

- [ ] **Step 2: Run `MailActionExecutor.test.ts`**

Expected: all tests pass.

### Task 3: Wait for Persisted Intelligence Results

**Files:**
- Modify: `server/wemail/bootstrap/AppComposition.integration.test.ts`

- [ ] **Step 1: Preserve the existing failing integration assertions**

The isolated test currently fails because `drainQueue` returns when a job is
`running` and therefore absent from `listPendingJobs`.

- [ ] **Step 2: Wait on the observable result after nudging the queue**

After `drainQueue(app)`, add:

```ts
await waitFor(() =>
  Boolean(app.intelligenceResults.findByEmailId(mail.id).summary),
);
```

Apply the same condition to manual sync, injected watcher, and real watcher
paths before reading the final result.

- [ ] **Step 3: Run the isolated integration file**

Expected: all 15 tests pass.

### Task 4: Full Verification

- [ ] Run `npm run test:renderer` and expect zero failures.
- [ ] Run `npm run test:server` and expect zero failures.
- [ ] Run `npm run typecheck` and `npm run typecheck:desktop`.
- [ ] Commit the fixes with a focused Conventional Commit message.
