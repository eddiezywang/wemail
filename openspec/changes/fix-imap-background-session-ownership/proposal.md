## Why

WeMail intentionally limits each account to two persistent IMAP sessions: one
foreground realtime session and one background transfer session. The background
session is currently shared by historical metadata paging, body hydration, and
attachments through an operation-priority queue.

Runtime evidence shows that operation-level serialization is insufficient for
IMAP. A metadata async iterator can retain an assumption about the selected
mailbox between yielded pages, while an intervening body fetch selects another
mailbox. In addition, `MailBodySyncWorker` disconnects the shared provider for
message-level failures such as `mail-body-missing`. Either behavior can abort
historical synchronization with `NoConnection` even though foreground IDLE
receipt remains healthy.

## What Changes

- Keep exactly two persistent account IMAP sessions.
- Make the background provider the sole owner of background connection
  lifecycle and selected-mailbox state.
- Replace stateful cross-page metadata iteration at the scheduling boundary
  with independently restartable metadata page transactions.
- Allow interactive body and attachment work between committed metadata pages,
  while requiring every subsequent page to reacquire the intended mailbox.
- Classify item, mailbox, connection, credential, and throttling failures so
  only genuine session failures invalidate the connection.
- Decouple historical retry from the full startup pipeline and expose separate
  realtime, historical, and body-hydration health.

## Impact

- Affected capability: `mail-sync`.
- Primary paths: `server/wemail/mail`,
  `server/wemail/performance/StartupSyncCoordinator.ts`, and mail sync tests.
- No database reset, third persistent IMAP connection, new protocol engine, or
  renderer synchronization mode is introduced.

