## 1. Failure semantics

- [x] 1.1 Add shared IMAP failure classification for item, mailbox, connection,
  credential, throttling, and protocol/data failures.
- [x] 1.2 Stop `MailBodySyncWorker` from disconnecting the provider for
  `mail-body-missing` and other item-level failures.
- [x] 1.3 Add focused body-worker tests for item failure, connection failure, and
  credential failure.

## 2. Background session ownership

- [x] 2.1 Make the background transfer provider the sole connection lifecycle
  owner and add session-generation tracking.
- [x] 2.2 Replace direct consumer disconnect calls with typed invalidation.
- [x] 2.3 Add tests proving stale-generation work cannot continue after a
  reconnect.

## 3. Atomic metadata paging

- [x] 3.1 Introduce an independently restartable metadata-page provider
  operation or equivalent transaction boundary.
- [x] 3.2 Ensure every page reselects and locks its folder and validates
  UIDVALIDITY/checkpoint state.
- [x] 3.3 Preserve interactive transfer priority between committed pages.
- [x] 3.4 Add a regression test that interleaves a body fetch between metadata
  pages and verifies the second page reads the correct folder.

## 4. Recovery state machines

- [x] 4.1 Move checkpointed historical retry out of the full startup restart
  path and add exponential backoff with jitter.
- [x] 4.2 Keep foreground watcher health independent from historical and body
  retry state.
- [x] 4.3 Add tests preventing repeated live-success events from starting
  duplicate historical recovery runs.

## 5. Diagnostics and UX

- [ ] 5.1 Expose separate realtime, historical-metadata, and body-hydration
  states with bounded error codes and retry timing.
- [ ] 5.2 Update failure copy so healthy live receipt is not presented as total
  synchronization failure.

## 6. Verification

- [ ] 6.1 Run focused server mail tests and the full test suite.
- [x] 6.2 Run TypeScript typecheck and production client build.
- [x] 6.3 Verify composition still creates exactly two persistent providers.
- [ ] 6.4 Run real enterprise acceptance with forced background disconnect and body
  requests during historical paging.
