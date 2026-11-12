## Why

Historical metadata synchronization, body hydration, resource throttling, and
automatic recovery are background maintenance. The workbench currently renders
a persistent progress banner and a completion summary for these internal
operations. This exposes implementation detail, consumes user attention, and
can make a healthy realtime mailbox look broken when only historical repair is
delayed.

## What Changes

- Remove background synchronization progress, pause, recoverable-history
  failure, and completion-summary banners from the workbench.
- Keep user-requested refresh feedback local to the refresh control.
- Continue surfacing credential recovery and sustained realtime-receive
  unavailability because those conditions require user awareness or action.
- Preserve full synchronization state in the local API, MCP tools, logs, and
  diagnostics.
- Replace the previous product requirement for one visible historical progress
  state and one final summary with a silent-maintenance policy.

## Impact

- Affected capabilities: `mail-refresh-ux`, `application-message-center`.
- Primary renderer path: `app/routes/_workbench.tsx` and its tests.
- No synchronization scheduling, database, IMAP, notification, or diagnostic
  API behavior changes.

