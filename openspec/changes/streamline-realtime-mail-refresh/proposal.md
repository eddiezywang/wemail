## Why

WeMail targets enterprise mailboxes that support IMAP IDLE, yet the workbench exposes “lightweight” and “deep” synchronization choices and can let historical metadata work delay the realtime receive path. The product should behave like a normal mail client: new mail arrives automatically, one manual refresh action checks immediately, and recovery remains an internal responsibility.

## What Changes

- Replace the split lightweight/deep synchronization control with one account-scoped manual refresh action.
- Make the realtime receive connection responsible only for IDLE, immediate reconciliation, manual refresh, reconnect catch-up, and lightweight health checks.
- Reuse the existing second provider connection for historical metadata, body hydration, attachments, and recovery work so background transfer cannot block realtime IDLE.
- Continue delegating IMAP protocol behavior, automatic IDLE, mailbox status, locking, streaming fetch, and advertised extension handling to ImapFlow rather than implementing another IMAP engine.
- Start realtime watching as soon as the bounded recent slice establishes a usable cursor, before historical metadata completes.
- Coalesce compatible IDLE, reconnect, and manual refresh requests and keep historical/recovery work resumable through bounded SQLite checkpoints.
- Separate first-time mail discovery, automation eligibility, renderer refresh, and desktop-notification policy so manual refresh updates the mailbox without producing duplicate desktop notifications.
- Add provider-aware cursor health checks using provider status information and bounded overlap recovery without exposing UID, cursor, or time-window choices in the workbench.
- Retain historical repair as an internal or diagnostics-only operation.

## Capabilities

### New Capabilities

- `mail-refresh-ux`: Defines the single manual-refresh interaction, user-visible states, and removal of synchronization strategy choices from the workbench.

### Modified Capabilities

- `mail-sync`: Changes realtime/background connection responsibilities, watcher startup ordering, refresh coalescing, discovery/notification semantics, and enterprise cursor recovery requirements.

## Impact

- Renderer workbench toolbar, refresh state, query invalidation, and credential-recovery interaction.
- Mail API refresh/status contracts and compatibility handling for the existing sync route.
- Account mail composition, ImapFlow provider roles, watcher lifecycle, synchronization coordination, body worker, repository checkpoints, and event delivery.
- Shared synchronization status and event contracts.
- Focused provider/service/route/renderer tests plus real enterprise IDLE, reconnect, historical-backfill, and UID-anomaly acceptance.
- The active `optimize-initial-sync-performance` change remains the source for bounded paging, resource governance, and startup performance budgets; this change narrows the product interaction and prevents its historical work from owning the realtime connection.
