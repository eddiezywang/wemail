# Mail Body Recovery Implementation Plan

## 1. Durable Queue Semantics

- Add an enqueue terminal policy to Mail Core durable jobs.
- Preserve existing revive behavior by default for maintenance jobs.
- Make passive body ensure reuse terminal work without resetting attempts.
- Add explicit body retry that resets only retryable terminal work.
- Test passive ensure, explicit retry, pending deduplication, and restart state.

## 2. Body State Projection

- Extend the Mail Core snapshot contract with `fetching` and `failed`.
- Project body error, attempts, retry deadline, and retryability from the
  persisted mail row and durable body job.
- Keep HTTP and direct Mail Core paths behaviorally consistent.
- Clear failure metadata after successful body persistence.

## 3. Renderer Loading and Retry

- Trigger passive ensure once when a message first enters `missing`.
- Poll snapshots without enqueueing additional work.
- Stop polling on `ready` or `failed`.
- Replace local-only reload with an awaited explicit retry command.
- Display safe failed/fetching state and prevent duplicate retry clicks.

## 4. Recovery Classification

- For connection failures, invalidate the background session once and apply
  the shared retry deadline.
- For `mail-body-missing`, attempt remote locator recovery before declaring the
  item terminal.
- Prevent application startup from reviving terminal body jobs.

## 5. Intelligence Guard

- Defer body-dependent summary work while body state is not ready.
- Ensure body hydration can recover deferred summary work.
- Preserve existing fingerprint/recovery behavior from concurrent summary
  changes.

## 6. Verification

- Run focused Mail Core queue/runtime/RPC tests.
- Run renderer email and EmailPanel tests.
- Run server, renderer, and desktop type checks.
- Build the production renderer and Electron output.
- Launch via the WeMail desktop build workflow.
- Validate the known failed message: passive open does not increase attempts,
  one explicit retry creates one controlled cycle, and the UI exposes the
  resulting state.
