## 1. Workbench presentation

- [x] 1.1 Remove the active background synchronization banner from the
  workbench.
- [x] 1.2 Remove the settled synchronization summary and its dismissal state.
- [x] 1.3 Preserve refresh-button-local busy and error feedback.
- [x] 1.4 Preserve credential recovery and foreground mailbox-health warnings.

## 2. Tests

- [x] 2.1 Update workbench tests so running, paused, historical failure, and
  settled startup states render no synchronization banner or summary.
- [x] 2.2 Verify manual refresh and credential recovery behavior remains
  unchanged.
- [x] 2.3 Confirm API and MCP status tests continue exposing diagnostic progress.

## 3. Verification

- [x] 3.1 Run focused renderer tests and full TypeScript typecheck.
- [x] 3.2 Run the production renderer build.
- [x] 3.3 Rebuild and launch the desktop app for visual acceptance.
