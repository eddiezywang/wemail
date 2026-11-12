# IMAP Connection Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent installed WeMail from crashing when an IMAP connection is aborted, closed, reset, or unavailable during background sync.

**Architecture:** Treat IMAP connection loss as a recoverable provider state transition instead of a fatal main-process exception. Add connection-error classification and stale-client cleanup in `ImapSmtpMailProvider`, make sync and watcher code reset the provider before retrying, and install a narrow Electron main-process error logger so unexpected async failures are recorded without showing the generic JavaScript crash dialog when recovery is possible.

**Tech Stack:** TypeScript, Electron, Node `EventEmitter`, `imapflow`, `node:test`, Vitest, electron-builder.

## Global Constraints

- Do not change mailbox credentials, provider presets, or user data migration behavior in this plan.
- Do not swallow all errors silently; every recovered connection error must be logged with account id, phase, and message.
- Preserve the existing background watcher behavior: IMAP IDLE first, polling fallback after repeated watch failures.
- Keep implementation compatible with packaged Electron paths such as `D:\WeMail\resources\app.asar`.
- The target enterprise IMAP/SMTP host must still be verified operationally; code resilience does not make an invalid DNS name valid.

---

## File Structure

### New files

- `electron/main/process-errors.ts`
  Exports a small `installProcessErrorHandlers()` helper used by Electron main.
- `electron/main/process-errors.test.ts`
  Tests that the process-error helper writes structured boot logs and classifies recoverable IMAP/network errors.

### Modified files

- `server/wemail/mail/ImapSmtpMailProvider.ts`
  Owns IMAP connection lifecycle, command wrapping, connection-error classification, and stale-client cleanup.
- `server/wemail/mail/ImapSmtpMailProvider.test.ts`
  Adds provider tests for `error`, `close`, `end`, `ECONNABORTED`, and stale-client reconnect behavior.
- `server/wemail/mail/Mail Core sync worker.ts`
  Resets the provider when sync commands fail because the connection is no longer usable.
- `server/wemail/mail/Mail Core sync worker.test.ts`
  Adds sync-service tests that verify disconnect-on-connection-error behavior.
- `server/wemail/mail/BackgroundMailWatcher.ts`
  Resets stale connections before retry/polling fallback after IDLE failures.
- `server/wemail/mail/BackgroundMailWatcher.test.ts`
  Adds watcher tests that verify IDLE failures do not escape as unhandled errors and polling starts from a clean provider state.
- `electron/main/app.ts`
  Installs process-level error handlers early and routes unexpected errors through the existing `bootLog()` path.

### Operational validation

- Verify the target production IMAP/SMTP host, port, TLS mode, and DNS requirements before treating remaining login failures as app defects.
- If `mail.example.com` only resolves on enterprise DNS or VPN, document that requirement near the account setup flow separately from this resilience fix.

---

### Task 1: Add IMAP Connection Error Classification And Provider Reset

**Files:**
- Modify: `server/wemail/mail/ImapSmtpMailProvider.ts`
- Modify: `server/wemail/mail/ImapSmtpMailProvider.test.ts`

**Interfaces:**
- Produces: `isRecoverableImapConnectionError(error: unknown): boolean`
- Produces: provider-internal `resetImapClient(client?: ImapLikeClient): void`
- Produces: provider-internal `markImapDisconnected(client: ImapLikeClient, reason: string, error?: unknown): void`
- Consumes: existing `MailProviderCommandError` with `phase` and `cause`

- [ ] **Step 1: Write failing tests for client event cleanup**

Add these tests to `server/wemail/mail/ImapSmtpMailProvider.test.ts`. Extend the local fake client so it can emit events:

```ts
class EventedFakeImap extends EventEmitter implements ImapLikeClient {
  connectCalls = 0;
  logoutCalls = 0;
  openedFolders: string[] = [];
  searches = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
  }

  async mailboxOpen(path: string): Promise<{ uidValidity: number }> {
    this.openedFolders.push(path);
    return { uidValidity: 17 };
  }

  async search(): Promise<number[]> {
    this.searches += 1;
    return [];
  }

  async *fetch(): AsyncIterable<RawFetchLike> {}
}

test("ImapSmtpMailProvider clears cached client when the IMAP client emits close", async () => {
  const { secrets, accountService } = setupAccount();
  const clients = [new EventedFakeImap(), new EventedFakeImap()];
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => clients.shift()!,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  await provider.connect();
  const first = clients.length;

  (provider as unknown as { imap: EventedFakeImap }).imap.emit("close");

  await provider.syncRecent(1);

  assert.equal(first, 1);
  assert.equal(clients.length, 0);
});
```

Add equivalent tests for `error` and `end` events. For `error`, emit an error with `code = "ECONNABORTED"`.

- [ ] **Step 2: Run provider tests and verify they fail**

Run:

```bash
npm run test:server -- ImapSmtpMailProvider
```

Expected: the new cleanup tests fail because the provider currently keeps using the cached `this.imap` client after `close`, `end`, or connection errors.

- [ ] **Step 3: Implement recoverable IMAP error classification**

In `server/wemail/mail/ImapSmtpMailProvider.ts`, export a classifier near `MailProviderCommandError`:

```ts
const RECOVERABLE_IMAP_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "NoConnection",
]);

export function isRecoverableImapConnectionError(error: unknown): boolean {
  const current = error instanceof MailProviderCommandError ? error.cause : error;
  if (!(current instanceof Error)) return false;

  const code = (current as Error & { code?: unknown }).code;
  if (typeof code === "string" && RECOVERABLE_IMAP_ERROR_CODES.has(code)) return true;

  return /connection not available|socket closed|socket hang up|write ECONNABORTED|write EPIPE/i.test(
    current.message,
  );
}
```

- [ ] **Step 4: Implement stale client cleanup**

Add provider-private cleanup helpers:

```ts
private resetImapClient(client?: ImapLikeClient): void {
  if (client && this.imap !== client) return;
  this.imap = null;
  this.uidValidity = null;
}

private markImapDisconnected(client: ImapLikeClient, reason: string, error?: unknown): void {
  this.log?.(
    "warn",
    `imap disconnected account=${this.accountId ?? "unknown"} reason=${reason} error=${String(
      error instanceof Error ? error.message : error ?? "",
    )}`,
  );
  this.resetImapClient(client);
}
```

If `accountId` or `log` is not currently stored on the provider, use the existing logger pattern in this file and include the account id after account config is loaded in `connect()`.

- [ ] **Step 5: Bind client lifecycle events during connect**

After creating the IMAP client and before assigning it to `this.imap`, bind lifecycle listeners if the client supports `on`:

```ts
const eventedClient = client as ImapLikeClient & {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

eventedClient.on?.("error", (error) => {
  this.markImapDisconnected(client, "error", error);
});
eventedClient.on?.("close", () => {
  this.markImapDisconnected(client, "close");
});
eventedClient.on?.("end", () => {
  this.markImapDisconnected(client, "end");
});
```

- [ ] **Step 6: Reset client on recoverable command failures**

Where `MailProviderCommandError` is thrown for IMAP commands, reset the client first when the cause is recoverable:

```ts
catch (error) {
  const wrapped = new MailProviderCommandError({ phase: "imap.search", cause: error });
  if (isRecoverableImapConnectionError(wrapped)) {
    this.resetImapClient(client);
  }
  throw wrapped;
}
```

Apply the same pattern for `imap.fetch`, `imap.select`, and other IMAP command catch blocks in this provider.

- [ ] **Step 7: Run provider tests and typecheck**

Run:

```bash
npm run test:server -- ImapSmtpMailProvider
npm run typecheck:server
```

Expected: provider tests pass and server TypeScript reports no errors.

- [ ] **Step 8: Commit**

```bash
git add server/wemail/mail/ImapSmtpMailProvider.ts server/wemail/mail/ImapSmtpMailProvider.test.ts
git commit -m "fix: reset stale imap connections"
```

---

### Task 2: Make IMAP IDLE Watch Failures Recoverable

**Files:**
- Modify: `server/wemail/mail/ImapSmtpMailProvider.ts`
- Modify: `server/wemail/mail/ImapSmtpMailProvider.test.ts`

**Interfaces:**
- Consumes: `isRecoverableImapConnectionError(error: unknown): boolean`
- Consumes: provider-internal `resetImapClient(client?: ImapLikeClient): void`
- Produces: `waitForMailboxChange(signal?: AbortSignal): Promise<void>` that rejects through provider-controlled errors only

- [ ] **Step 1: Write failing tests for `waitForMailboxChange` socket events**

Add a fake client with `idle()` and event support:

```ts
class IdleFakeImap extends EventEmitter implements ImapLikeClient {
  async connect(): Promise<void> {}
  async logout(): Promise<void> {}
  async mailboxOpen(): Promise<{ uidValidity: number }> {
    return { uidValidity: 17 };
  }
  async search(): Promise<number[]> {
    return [];
  }
  async *fetch(): AsyncIterable<RawFetchLike> {}
  async idle(): Promise<void> {
    await new Promise(() => {});
  }
}

test("waitForMailboxChange rejects and clears the client when IDLE emits ECONNABORTED", async () => {
  const { secrets, accountService } = setupAccount();
  const fake = new IdleFakeImap();
  const provider = new ImapSmtpMailProvider({
    accountService,
    secrets,
    imapFactory: () => fake,
    smtpFactory: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  });

  const wait = provider.waitForMailboxChange();
  const error = Object.assign(new Error("write ECONNABORTED"), { code: "ECONNABORTED" });
  fake.emit("error", error);

  await assert.rejects(wait, /ECONNABORTED|connection/i);
  assert.equal((provider as unknown as { imap: unknown }).imap, null);
});
```

- [ ] **Step 2: Run the focused provider test**

Run:

```bash
npm run test:server -- ImapSmtpMailProvider
```

Expected: the new IDLE failure test fails because `waitForMailboxChange()` currently does not settle on client `error`, `close`, or `end` events.

- [ ] **Step 3: Update `waitForMailboxChange` to listen to connection lifecycle events**

Inside the existing promise, register and unregister handlers for `exists`, `error`, `close`, `end`, and abort:

```ts
const failFromConnection = (error: unknown) => {
  const wrapped = new MailProviderCommandError({
    phase: "imap.idle",
    cause: error instanceof Error ? error : new Error(String(error)),
  });
  this.resetImapClient(client);
  reject(wrapped);
};

const onClose = () => failFromConnection(new Error("imap connection closed"));
const onEnd = () => failFromConnection(new Error("imap connection ended"));
const onError = (error: unknown) => failFromConnection(error);

client.on?.("error", onError);
client.on?.("close", onClose);
client.on?.("end", onEnd);
```

Use the existing cleanup function to remove listeners if the client exposes `off` or `removeListener`.

- [ ] **Step 4: Keep abort as normal cancellation**

Preserve the existing `AbortSignal` behavior. Abort should reject with the existing watch-aborted error message and should not be classified as a network connection failure.

```ts
const onAbort = () => {
  cleanup();
  reject(new Error("mail watch aborted"));
};
```

- [ ] **Step 5: Run provider tests**

Run:

```bash
npm run test:server -- ImapSmtpMailProvider
npm run typecheck:server
```

Expected: IDLE event tests pass, existing provider tests still pass, and server typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add server/wemail/mail/ImapSmtpMailProvider.ts server/wemail/mail/ImapSmtpMailProvider.test.ts
git commit -m "fix: recover from imap idle disconnects"
```

---

### Task 3: Reset Provider State From Sync Failures

**Files:**
- Modify: `server/wemail/mail/Mail Core sync worker.ts`
- Modify: `server/wemail/mail/Mail Core sync worker.test.ts`

**Interfaces:**
- Consumes: `isRecoverableImapConnectionError(error: unknown): boolean`
- Consumes: existing `MailProvider.disconnect(): Promise<void>`
- Produces: `Mail Core sync worker` behavior that disconnects the provider after recoverable connection failures

- [ ] **Step 1: Write failing sync-service test**

Add this test to `server/wemail/mail/Mail Core sync worker.test.ts`:

```ts
test("Mail Core sync worker disconnects the provider after a recoverable IMAP connection error", async () => {
  const { service, provider } = setup([]);
  const cause = Object.assign(new Error("Connection not available"), { code: "NoConnection" });
  provider.syncSinceError = new MailProviderCommandError({
    phase: "imap.search",
    cause,
  });

  await assert.rejects(() => service.syncWindow(), /Connection not available/);

  assert.equal(provider.disconnectCalls, 1);
});
```

- [ ] **Step 2: Run the focused sync-service test**

Run:

```bash
npm run test:server -- Mail Core sync worker
```

Expected: the test fails because `runSyncWith()` logs and rethrows without resetting the provider.

- [ ] **Step 3: Reset the provider in `runSyncWith()`**

Import the classifier and update the catch block:

```ts
import { isRecoverableImapConnectionError } from "./ImapSmtpMailProvider.js";
```

```ts
catch (error) {
  logMailEvent(
    "error",
    `sync failed account=${this.accountId} folder=${this.folder} error=${String(
      error instanceof Error ? error.message : error,
    )}`,
  );
  if (isRecoverableImapConnectionError(error)) {
    await this.provider.disconnect().catch((disconnectError) => {
      logMailEvent(
        "warn",
        `sync disconnect failed account=${this.accountId} folder=${this.folder} error=${String(
          disconnectError instanceof Error ? disconnectError.message : disconnectError,
        )}`,
      );
    });
  }
  throw error;
}
```

- [ ] **Step 4: Run sync tests and server typecheck**

Run:

```bash
npm run test:server -- Mail Core sync worker
npm run typecheck:server
```

Expected: sync-service tests pass and server TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add server/wemail/mail/Mail Core sync worker.ts server/wemail/mail/Mail Core sync worker.test.ts
git commit -m "fix: reset mail provider after sync disconnects"
```

---

### Task 4: Keep Background Watcher Retry And Polling Paths Clean

**Files:**
- Modify: `server/wemail/mail/BackgroundMailWatcher.ts`
- Modify: `server/wemail/mail/BackgroundMailWatcher.test.ts`

**Interfaces:**
- Consumes: `MailProvider.disconnect(): Promise<void>`
- Produces: watcher behavior that calls `disconnect()` after failed watch iterations before retrying or entering polling

- [ ] **Step 1: Write failing watcher test**

Add this test to `server/wemail/mail/BackgroundMailWatcher.test.ts`:

```ts
test("watcher disconnects stale provider after IDLE failure before polling fallback", async () => {
  let disconnects = 0;
  let syncs = 0;
  const watcher = new BackgroundMailWatcher({
    provider: {
      ...createBaseProvider(),
      supportsPushWatch: () => true,
      disconnect: async () => {
        disconnects += 1;
      },
      waitForMailboxChange: async () => {
        throw Object.assign(new Error("write ECONNABORTED"), { code: "ECONNABORTED" });
      },
    },
    sync: {
      syncWindow: async () => {
        syncs += 1;
        return { inserted: [], updated: [], cursor: null };
      },
    } as Pick<Mail Core sync worker, "syncWindow">,
    accountId: "acct-1",
    idleFailureThreshold: 1,
    pollingIntervalMs: 1,
  });

  await watcher.start();
  await watcher.tickOnceForTest();
  await watcher.stop();

  assert.equal(disconnects, 1);
  assert.equal(syncs, 1);
});
```

- [ ] **Step 2: Run watcher tests and verify failure**

Run:

```bash
npm run test:server -- BackgroundMailWatcher
```

Expected: the new test fails because the watcher currently increments failure counters but does not guarantee provider cleanup after IDLE connection loss.

- [ ] **Step 3: Disconnect after failed watch iterations**

In `runWatchIteration()` catch handling, disconnect before retry or polling fallback:

```ts
catch (error) {
  if (isAbortError(error)) return;

  await this.provider.disconnect().catch((disconnectError) => {
    logMailEvent(
      "warn",
      `watcher disconnect failed account=${this.accountId} error=${String(
        disconnectError instanceof Error ? disconnectError.message : disconnectError,
      )}`,
    );
  });

  this.idleFailures += 1;
  if (this.idleFailures >= this.idleFailureThreshold) {
    this.mode = "polling";
    await this.runPollingIteration();
    return;
  }

  await this.sleep(this.backoffMsFor(this.idleFailures));
}
```

If `runPollingIteration()` is private and not structured this way in the current file, apply the same behavior at the existing point where the mode switches to polling.

- [ ] **Step 4: Run watcher tests and server typecheck**

Run:

```bash
npm run test:server -- BackgroundMailWatcher
npm run typecheck:server
```

Expected: watcher tests pass and server TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add server/wemail/mail/BackgroundMailWatcher.ts server/wemail/mail/BackgroundMailWatcher.test.ts
git commit -m "fix: clean stale provider before mail watch retry"
```

---

### Task 5: Add Electron Main Process Error Logging

**Files:**
- Create: `electron/main/process-errors.ts`
- Create: `electron/main/process-errors.test.ts`
- Modify: `electron/main/app.ts`

**Interfaces:**
- Produces: `installProcessErrorHandlers(log: (phase: string, extra?: Record<string, unknown>) => void): void`
- Consumes: existing `bootLog(phase, extra)` function in `electron/main/app.ts`

- [ ] **Step 1: Write process-error helper tests**

Create `electron/main/process-errors.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { classifyProcessError, serializeProcessError } from "./process-errors";

describe("process error helpers", () => {
  it("classifies ECONNABORTED as a recoverable connection error", () => {
    const error = Object.assign(new Error("write ECONNABORTED"), { code: "ECONNABORTED" });

    expect(classifyProcessError(error)).toBe("recoverable-connection");
  });

  it("serializes error name, message, stack, and code", () => {
    const error = Object.assign(new TypeError("bad socket"), { code: "ECONNRESET" });

    expect(serializeProcessError(error)).toMatchObject({
      name: "TypeError",
      message: "bad socket",
      code: "ECONNRESET",
    });
  });
});
```

- [ ] **Step 2: Run renderer/electron tests and verify failure**

Run:

```bash
npm run test:renderer -- electron/main/process-errors.test.ts
```

Expected: the test fails because `electron/main/process-errors.ts` does not exist.

- [ ] **Step 3: Implement process-error helper**

Create `electron/main/process-errors.ts`:

```ts
const RECOVERABLE_PROCESS_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "NoConnection",
]);

export function serializeProcessError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: typeof code === "string" ? code : null,
  };
}

export function classifyProcessError(error: unknown): "recoverable-connection" | "fatal" {
  if (!(error instanceof Error)) return "fatal";
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && RECOVERABLE_PROCESS_ERROR_CODES.has(code)) {
    return "recoverable-connection";
  }
  if (/connection not available|socket closed|socket hang up|write ECONNABORTED|write EPIPE/i.test(error.message)) {
    return "recoverable-connection";
  }
  return "fatal";
}

export function installProcessErrorHandlers(
  log: (phase: string, extra?: Record<string, unknown>) => void,
): void {
  process.on("uncaughtException", (error) => {
    log("uncaughtException", {
      classification: classifyProcessError(error),
      error: serializeProcessError(error),
    });
  });

  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection", {
      classification: classifyProcessError(reason),
      error: serializeProcessError(reason),
    });
  });
}
```

- [ ] **Step 4: Install handlers from Electron main**

In `electron/main/app.ts`, import and call the helper immediately after `bootLog()` is defined:

```ts
import { installProcessErrorHandlers } from "./process-errors.js";
```

```ts
installProcessErrorHandlers(bootLog);
```

- [ ] **Step 5: Run desktop typecheck and process-error tests**

Run:

```bash
npm run test:renderer -- electron/main/process-errors.test.ts
npm run typecheck:desktop
```

Expected: tests pass and desktop TypeScript reports no errors.

- [ ] **Step 6: Commit**

```bash
git add electron/main/app.ts electron/main/process-errors.ts electron/main/process-errors.test.ts
git commit -m "fix: log main process connection exceptions"
```

---

### Task 6: Package And Verify Installed App Behavior

**Files:**
- No source files changed in this task.
- Uses: `package.json`
- Uses: `%APPDATA%\wemail\data\logs\app-YYYY-MM-DD.log`
- Uses: `%APPDATA%\wemail\startup.log`

**Interfaces:**
- Consumes: completed Tasks 1 through 5
- Produces: verified packaged app behavior on Windows

- [ ] **Step 1: Run full relevant verification**

Run:

```bash
npm run typecheck:server
npm run typecheck:desktop
npm run test:server
npm run test:renderer
```

Expected: all commands pass.

- [ ] **Step 2: Build packaged Windows installer or directory package**

For a quick installed-directory validation:

```bash
npm run package:desktop:dir
```

For NSIS installer validation:

```bash
npm run package:desktop:installer
```

Expected: packaging completes without TypeScript, renderer build, or electron-builder errors.

- [ ] **Step 3: Install or copy the package to `D:\WeMail`**

Use the existing project packaging process. Keep the install path as:

```text
D:\WeMail
```

Expected: `D:\WeMail\WeMail.exe` exists and launches.

- [ ] **Step 4: Reproduce connection failure safely**

Run the installed app with one controlled failure condition:

```text
Disconnect network, disable VPN, or use an account whose IMAP host cannot resolve.
```

Expected:

- The app does not show `A JavaScript error occurred in the main process`.
- `%APPDATA%\wemail\startup.log` records any unexpected main-process errors.
- `%APPDATA%\wemail\data\logs\app-YYYY-MM-DD.log` records sync/watch failure and retry or polling fallback.

- [ ] **Step 5: Verify recovery**

Restore the correct network or VPN and trigger sync.

Expected:

- Background sync reconnects with a new IMAP client.
- The watcher returns to watching mode or continues polling without process crash.
- Login still reports a user-facing error if the configured enterprise mail host is not resolvable.

- [ ] **Step 6: Commit verification notes**

If the repo keeps verification notes for fixes, add a short note to the relevant PR or issue. Do not add runtime logs with real account data to the repository.

```bash
git status --short
```

Expected: no runtime logs, secrets, `.env`, or installed app artifacts are staged.

---

## Self-Review

### Spec coverage

- Installed app main-process crash on `write ECONNABORTED`: covered by Tasks 1, 2, 5, and 6.
- Stale IMAP client reuse after connection loss: covered by Tasks 1, 3, and 4.
- Background watcher `IDLE` failure and polling fallback: covered by Tasks 2 and 4.
- Enterprise mail DNS/server uncertainty: covered as operational validation, not hidden by code changes.
- No code changes made by this document: this file is a plan only.

### Placeholder scan

- No placeholder markers or unspecified test steps remain.
- Each task includes exact file paths, commands, and expected outcomes.

### Type consistency

- `isRecoverableImapConnectionError(error: unknown): boolean` is defined in Task 1 and consumed by Tasks 3 and 4.
- `installProcessErrorHandlers(log)` is defined in Task 5 and consumed by `electron/main/app.ts`.
- Existing `MailProvider.disconnect()` is used without changing the public provider interface.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-imap-connection-resilience.md`. Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints.
