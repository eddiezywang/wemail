## Context

WeMail already uses ImapFlow and constructs two account-scoped provider instances: one is shared by `Mail Core sync worker` and `BackgroundMailWatcher`, while the other is owned by `MailBodySyncWorker`. The current startup coordinator completes the historical metadata phase before starting the watcher, and all metadata synchronization is serialized through one queue. The workbench exposes that implementation as lightweight and 30-day deep sync choices.

The target enterprise mail service supports IMAP IDLE, so realtime receipt is the normal path. Operational evidence also shows that the target enterprise mail service can present non-standard UID rollback without changing UIDVALIDITY. The design must preserve bounded paging and checkpoints from `optimize-initial-sync-performance`, remain local-first, and avoid introducing Redis, a hosted mail service, or another IMAP protocol implementation.

Mailspring-Sync validates the architectural separation of a foreground IDLE worker and a background synchronization worker, but its GPLv3 code cannot be copied into this Apache-2.0 project. EmailEngine validates the production use of ImapFlow but is commercially licensed and requires Redis. These projects are references, not dependencies.

## Goals / Non-Goals

**Goals:**

- Make automatic IDLE receipt the primary enterprise mail experience.
- Provide one manual refresh intent without exposing synchronization algorithms.
- Prevent historical metadata, body hydration, and recovery from delaying the realtime connection.
- Reuse ImapFlow for protocol behavior and the two provider instances already created by WeMail.
- Preserve resumable, bounded, idempotent persistence and distinct live/historical notification semantics.
- Detect and recover from bounded enterprise cursor anomalies without making the user select a time window.

**Non-Goals:**

- Building a generic replacement for ImapFlow, EmailEngine, Mailspring-Sync, or Thunderbird.
- Adding Redis, a sidecar synchronization process, or a third persistent IMAP connection.
- Guaranteeing realtime receipt while the WeMail process is fully terminated.
- Downloading all bodies or attachments on the live arrival path.
- Introducing a local sync generation unless real enterprise acceptance proves UID reuse under unchanged UIDVALIDITY.
- Redesigning SMTP send behavior, mail composition, or intelligence quality.

## Decisions

### 1. ImapFlow remains the protocol boundary

WeMail will use ImapFlow automatic IDLE, renewal, STATUS fallback, mailbox status fields, locking, streaming fetch, and advertised CONDSTORE/QRESYNC support where the enterprise mail server confirms it. WeMail owns account lifecycle, reconnect supervision, durable checkpoints, event policy, and provider-specific recovery only.

Alternative considered: copy synchronization code from EmailEngine or Mailspring-Sync. Rejected because EmailEngine requires commercial licensing and Redis, while Mailspring-Sync is GPLv3 and uses a C++/MailCore2 runtime that does not fit the existing Node/Electron package.

### 2. Existing providers become foreground and background roles

The provider currently shared by the watcher and `Mail Core sync worker` becomes the foreground provider. It owns:

- connection and capability discovery;
- IDLE waiting and reconnect catch-up;
- bounded recent/bootstrap reconciliation;
- manual refresh;
- lightweight periodic health and flag reconciliation.

The existing `bodyProvider` becomes the background transfer provider. It owns:

- historical metadata pages;
- credential/cursor recovery windows;
- background body hydration;
- user-requested bodies and attachments, with interactive transfer ahead of background work.

Both roles write through the same repository and idempotent short transactions. Historical page checkpoints remain durable. This isolates realtime latency without adding a third connection or a general preemptive scheduler.

Alternative considered: one metadata connection with a global priority queue that preempts historical pages. Rejected because the existing second provider permits simpler connection-level isolation and matches a mature foreground/background mail-client pattern.

### 3. Realtime watching starts after recent cursor readiness

Startup renders cached mail immediately, fetches a bounded recent slice when required, establishes a usable Inbox cursor, and starts the foreground watcher. Historical metadata is then admitted on the background provider. A historical failure or pause never stops a healthy foreground watcher.

If the recent slice cannot complete because of a transient network failure, the workbench remains usable from cache and the foreground supervisor reconnects. Credential-invalid failures enter the existing credential recovery flow.

### 4. Manual refresh is an intent, not a synchronization mode

The renderer calls one account-scoped refresh operation without `mode`, `days`, or `deep`. The operation joins an equivalent foreground reconciliation already caused by IDLE, reconnect, or another manual request. The API returns accepted/joined identity and bounded status rather than blocking on historical repair.

The existing `/api/mail/sync` route may remain temporarily for internal tests and compatibility, but the workbench will not select its strategy. A semantic `/api/mail/refresh` route or equivalent typed service method becomes the user-facing contract.

### 5. Cursor recovery is layered and bounded

The fast path compares the persisted cursor with ImapFlow mailbox status including UIDVALIDITY and UIDNEXT. A UIDVALIDITY change is immediately invalid. A suspicious UIDNEXT regression records safe metadata and triggers a bounded overlap confirmation on the background provider rather than treating an empty UID range as proof of rollback.

Confirmed gaps restore the latest recent slice first, replace the affected cursor explicitly, re-arm foreground IDLE, and continue the wider recovery window in background pages. Routine checks never perform a 30-day scan on the foreground connection.

If acceptance proves that the enterprise mail server reuses the same UID under unchanged UIDVALIDITY for different messages, a follow-up migration will separate local message identity from the remote locator by adding a local synchronization generation. That migration is not assumed without evidence.

### 6. Discovery and presentation policies are separate

Every first-time inserted message produces a durable discovery result. Downstream policy independently decides:

- renderer and unread-count refresh;
- automation eligibility;
- intelligence/body scheduling;
- desktop notification eligibility.

Live IDLE/reconnect discoveries may notify. Manual refresh discoveries update the mailbox and remain automation-eligible but do not issue a redundant desktop notification. Historical imports do not notify and do not run receive-mail automation unless a rule opts into backfill.

### 7. User-visible state remains minimal

The refresh icon reflects only the user-requested refresh operation. Normal React Query fetching, historical repair, body hydration, and intelligence work do not spin it. Normal watching is silent; only sustained reconnect, stale data, credential-required state, or an explicit diagnostics view exposes synchronization health.

## Risks / Trade-offs

- [Enterprise mail limits simultaneous IMAP sessions] → Reuse the two sessions already created today, verify the limit in real acceptance, and fall back to serialized background transfer if the server rejects the second connection.
- [Both providers can write concurrently] → Route all writes through idempotent repository methods and bounded SQLite transactions; never advance a checkpoint beyond committed messages.
- [Background metadata can delay a requested body] → Use the existing background transfer admission point to prioritize user-requested body/attachment work between bounded historical pages.
- [UIDNEXT is absent or unreliable] → Treat it as a health signal rather than the sole cursor authority and confirm anomalies through a bounded time overlap.
- [Manual discoveries could duplicate downstream work] → Persist first-discovery identity and make automation/intelligence enqueueing idempotent.
- [Overlap with `optimize-initial-sync-performance`] → Reuse its paging, checkpoint, governor, and performance contracts; this change changes provider ownership and product semantics only.

## Migration Plan

1. Add status, refresh-intent, provider-role, and discovery-policy contracts with regression tests while preserving existing routes.
2. Route historical metadata through the existing background provider and prove bounded transactional writes from both roles.
3. Start the foreground watcher after recent cursor readiness and validate IDLE latency during historical backfill.
4. Add coalesced manual refresh and layered enterprise cursor health/recovery.
5. Separate discovery from automation and desktop-notification policy.
6. Replace the split toolbar control with one manual refresh action.
7. Run deterministic tests and real enterprise acceptance before removing obsolete workbench sync modes.

Rollback keeps the compatibility sync route and can restore historical metadata to the foreground provider without deleting mail or checkpoints. No rollback step may remove locally synchronized messages.

## Open Questions

- Which of CONDSTORE, QRESYNC, UIDNEXT, and HIGHESTMODSEQ are consistently advertised by the production enterprise mail server?
- Does the production enterprise mail server ever reuse a UID for different mail while UIDVALIDITY is unchanged, or has only a highest-UID regression been observed?
- What sustained reconnect duration should surface a workbench warning rather than remaining silent?
