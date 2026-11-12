## Context

The accepted realtime synchronization design assigns one provider to foreground
IDLE and one provider to all background transfer work. That connection budget is
appropriate for the production enterprise mailbox, but the current background
adapter serializes individual method calls instead of complete IMAP mailbox
transactions.

IMAP sessions are stateful. One connection has one selected mailbox at a time.
ImapFlow recommends `getMailboxLock()` around mailbox operations, and its fetch
iterator must not be interleaved with unrelated IMAP commands. MailKit documents
the same single-open-folder constraint. OfflineIMAP and EmailEngine obtain
parallelism through bounded independent sessions rather than concurrent use of
one selected-mailbox state.

The concrete failure has two contributors:

1. `BackgroundTransferMailProvider.pages()` schedules only `iterator.next()`.
   The wrapped iterator can retain mailbox state across a yield, while an
   interactive body operation changes the selected mailbox before the next
   call.
2. `MailBodySyncWorker` calls `provider.disconnect()` after every non-credential
   fetch failure, including `mail-body-missing`, which tears down the same
   session used by historical metadata.

## Goals

- Preserve exactly two persistent IMAP sessions per active account.
- Make every background operation safe under mailbox switching.
- Preserve interactive body and attachment priority between bounded historical
  pages.
- Resume history from committed checkpoints after a genuine connection loss.
- Prevent one missing remote message from damaging account-level sync health.
- Keep ImapFlow as the only IMAP protocol engine.

## Non-Goals

- Adding a permanent third content-download session.
- Implementing an IMAP parser, custom IDLE engine, or Redis-backed worker.
- Fetching all bodies during metadata synchronization.
- Changing the existing local message identity model.
- Hiding persistent historical failures from diagnostics.

## Options Considered

### Option A: Add a third body connection

This gives the cleanest physical isolation, but contradicts the accepted
two-session production constraint and may exceed enterprise server connection
limits. Rejected as the default architecture.

### Option B: Hold one mailbox lock for the entire historical window

This preserves selected-mailbox state but can block user-requested bodies and
attachments for minutes. It also turns a resumable page design into a
long-running critical section. Rejected.

### Option C: Atomic page transactions on one owned background session

Each page independently acquires the background session, selects and locks its
folder, validates cursor identity, fetches a bounded page, commits messages and
checkpoint, then releases ownership. Interactive transfers run between pages.
This preserves two connections and responsiveness. Selected.

## Architecture

### Background session owner

`BackgroundTransferMailProvider` becomes the connection actor for the raw
background provider. Only this owner may connect, disconnect, or invalidate the
background session. Consumers submit typed operations with priority and failure
classification; they do not manipulate connection lifecycle directly.

The owner tracks a monotonically increasing session generation. A successful
connect creates a new generation. An operation admitted under an obsolete
generation fails fast and is retried from its durable boundary rather than
continuing against stale state.

The public behavior is conceptually:

```ts
withBackgroundSession({
  priority: "interactive" | "background",
  mailbox?: string,
  operation: async (provider, session) => result,
});
```

The implementation may remain behind the existing `MailProvider` boundary, but
the lifecycle and transaction invariants must be explicit and testable.

### Atomic metadata pages

The scheduling boundary must not expose an async iterator that assumes a
selected mailbox survives between yields. Metadata paging becomes a sequence of
independent page transactions. Each transaction:

1. acquires the background queue slot;
2. ensures a connected session generation;
3. selects and locks the target folder through ImapFlow;
4. validates `UIDVALIDITY` and the persisted page checkpoint;
5. fetches at most the configured page size;
6. returns messages plus the next durable checkpoint;
7. commits messages and checkpoint atomically through `DB Service mail API`;
8. releases the mailbox lock and queue slot.

The next page repeats selection and validation. It never relies on mailbox state
left by the previous page. A user-requested body or attachment can therefore run
after step 8 without corrupting the next page.

The preferred provider contract is a single-page operation such as
`syncMetadataPage(options, checkpoint)`. If compatibility requires retaining
`syncMetadataPages`, the wrapper must recreate or drive the underlying work so
that each yielded page is a complete mailbox-lock transaction and no iterator
retains selected-mailbox assumptions outside the scheduled callback.

### Connection invalidation

Workers report typed failures. They never call `disconnect()` as generic error
cleanup.

| Failure class | Examples | Action |
| --- | --- | --- |
| Item | missing body, vanished UID, unsupported body part | Record item failure; keep session |
| Mailbox | UIDVALIDITY change, folder removed | Reset or stop only that folder cursor |
| Connection | `NoConnection`, socket close, TLS interruption | Invalidate generation; reconnect with backoff; retry durable transaction |
| Credential | authentication rejected, authorization code expired | Enter credential-required state; stop automatic reconnect |
| Throttling | server busy, rate limit, temporary resource limit | Preserve session when valid; retry with bounded backoff |
| Protocol/data | malformed response or invariant violation | Fail the operation, log bounded diagnostics, avoid blind disconnect unless the session is unusable |

`mail-body-missing` is an item failure. It increments the message-level failure
state and applies the existing retry/terminal policy, but it must not disconnect
the background session.

### Retry ownership

Connection reconnection belongs to the background session owner. Historical
retry belongs to historical synchronization. Body retry belongs to the body
queue. A successful foreground live poll must not restart the entire startup
pipeline merely to repair history.

Historical metadata uses checkpointed exponential retry with jitter. Suggested
delays are 5 seconds, 30 seconds, 2 minutes, and 10 minutes, capped at 30
minutes. App restart resumes from the same committed checkpoint.

Startup readiness and foreground watching remain successful when history is
retrying. Intelligence readiness may proceed for locally available messages and
must not require the whole historical window to settle.

### Health model

The account exposes independent bounded state:

- `realtime`: connecting, healthy, stale, credential-required;
- `historicalMetadata`: idle, running, retrying, settled, failed;
- `bodyHydration`: idle, running, retrying, credential-required;
- background session generation and next retry time in diagnostics only.

The normal workbench may state that new mail remains available while historical
content is being repaired. A historical failure must not be represented as total
mailbox unavailability when foreground IDLE is healthy.

## Data Integrity

- Remote identity continues using folder, UID, and UIDVALIDITY under the current
  repository contract.
- Page checkpoints advance only in the same successful persistence boundary as
  their messages.
- Replaying a page after reconnection is idempotent and does not duplicate mail,
  automation, intelligence, or notifications.
- A UIDVALIDITY mismatch invalidates only the affected folder checkpoint.
- Message-level body failure state remains independent from metadata success.

## Testing

Focused tests must prove:

- a body fetch between two historical pages changes the selected mailbox, yet
  the next metadata page reselects its intended folder and succeeds;
- `mail-body-missing` records a body failure without disconnecting;
- a real `NoConnection` invalidates one session generation, reconnects, and
  resumes from the last committed page;
- stale operations from the previous generation cannot continue;
- interactive body and attachment work runs before the next background page;
- repeated connection failures back off without a full-startup retry loop;
- foreground IDLE remains healthy while background history retries;
- UIDVALIDITY changes reset only the affected folder;
- the composition root still creates exactly two persistent account providers.

Real enterprise acceptance must verify live delivery, requested body latency during
history, background continuation after a forced disconnect, and stable operation
with exactly two sessions.

## Rollout

1. Add failure classification and stop body workers from disconnecting on item
   failures.
2. Add background session ownership and generation tracking.
3. Convert metadata paging to independent mailbox transactions.
4. Move historical retry out of full startup recovery.
5. Expose split diagnostic health and update user-facing failure copy.
6. Run deterministic tests, then real enterprise acceptance.

Rollback may restore the previous scheduling adapter, but must retain durable
checkpoints and must never delete synchronized mail. The item-error disconnect
fix is safe to retain independently.

