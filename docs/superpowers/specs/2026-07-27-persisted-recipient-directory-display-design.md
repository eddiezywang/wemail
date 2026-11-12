# Persisted Recipient Directory Display Design

## Summary

Improve the mail detail header so recipient information behaves like a traditional desktop mail client. The compact header remains one line, can be expanded to show all To, CC, and BCC addresses, and displays the enterprise-directory name when one has been matched to an address.

Directory association is persisted with the stored mail address data. Opening a mail detail must not trigger a directory API request or repeat address matching.

## Goals

- Keep the recipient header compact by default and allow users to expand it.
- Show To, CC, and BCC as separate rows in the expanded state.
- Display the complete directory name, for example `evanxu(徐自然) <evanxu@example.com>`.
- Preserve the original name supplied by the mail message.
- Resolve directory names during ingestion or background reconciliation, not during detail rendering.
- Give single-message and thread-message views the same behavior.

## Non-goals

- Changing compose recipient behavior.
- Guessing a directory contact when an email address does not match exactly.
- Fetching contacts from a remote directory while rendering a message.
- Revealing BCC addresses that are not present in the stored message.
- Redesigning the complete message header or message action toolbar.

## User Experience

### Collapsed state

The header displays one truncated line beginning with `发送给：`. It uses the available width and applies an ellipsis when the recipient text overflows.

An adjacent downward caret expands the address details. The control remains available even when the text fits on one line so users have a consistent way to inspect CC and BCC.

### Expanded state

The expanded area renders the available address groups on separate rows:

- `收件人：` for To
- `抄送：` for CC
- `密送：` for BCC

Empty groups are omitted. Addresses wrap naturally across lines, with no artificial recipient-count limit. An upward caret collapses the area.

The recipient expansion state is independent of the thread message's own collapsed or expanded state. Each visible message owns its own recipient-detail state.

### Address formatting

Address labels use the following priority:

1. Persisted directory name and email: `directoryName <email>`
2. Original message name and email: `name <email>`
3. Email only

The directory name is used exactly as stored by the directory, including mixed account-name and Chinese-name forms such as `evanxu(徐自然)`.

## Data Model

Extend `WemailAddress` with an optional persisted directory display name:

```ts
export interface WemailAddress {
  name?: string;
  email: string;
  directoryName?: string;
}
```

`name` remains the value parsed from the original mail header. `directoryName` is an exact-email match obtained from the enterprise directory.

Mail addresses are already stored as JSON in `sender_json`, `recipients_json`, `cc_json`, and `bcc_json`. Adding an optional JSON property does not require a database schema migration. This feature enriches To, CC, and BCC only; sender enrichment is outside the requested scope.

## Directory Association

### Ingestion-time enrichment

Before a newly synchronized message is persisted, collect and normalize the email addresses in To, CC, and BCC. Match them against the locally persisted directory using case-insensitive exact email lookup.

For each exact match, copy the directory contact's complete `name` into `directoryName`. Preserve address order, duplicates, original `name`, and all other message data.

The enrichment path must be local and synchronous with the repository write. It must not initiate a remote directory search or delay mail synchronization on network availability.

### Directory-not-ready behavior

Mail synchronization can complete before the first directory snapshot is available. In that case, messages are stored with their original address data and no `directoryName`.

After a successful directory snapshot update, a background reconciliation pass processes stored To, CC, and BCC addresses that either:

- do not yet have `directoryName`; or
- have a persisted directory name whose matching contact changed in the new snapshot.

The reconciliation performs exact email matches against the new local snapshot and writes changed address JSON back in bounded batches. It must not block the directory refresh response or the UI.

### Subsequent mail updates

Mail metadata refreshes can upsert an existing message with fresh provider data that does not contain `directoryName`. Every mail upsert runs the same local enrichment boundary before serialization. If the directory snapshot is temporarily unavailable, the persistence layer preserves the previously stored `directoryName` when the normalized email still matches. A routine metadata, flag, or body refresh must not erase an existing directory association.

### Directory changes and removals

When a directory contact is renamed, the next successful directory reconciliation replaces the persisted `directoryName` for matching addresses.

When a contact is removed from the directory, reconciliation clears the stale `directoryName`. Display then falls back to the original message name or email.

## Components

### Recipient details component

Create a focused recipient-details component shared by `SingleMessageView` and `ThreadMessage`. Its responsibilities are:

- render the collapsed one-line summary;
- own the local expanded/collapsed state;
- render To, CC, and BCC rows;
- format persisted structured addresses;
- provide accessible expand and collapse controls.

The component must be presentation-only. It receives already enriched address data and performs no API calls.

### Client mail model

The current client `Email` model flattens address arrays into comma-separated strings. Extend the mapped client data with structured To, CC, and BCC arrays while retaining the existing string fields until all unrelated consumers can be migrated safely.

The new component consumes the structured arrays. Existing reply, forward, search, and automation behavior continues to use the current fields unless explicitly migrated as part of implementation.

### Mail synchronization and persistence

Introduce a small address-enrichment boundary that accepts a `WemailAddress[]` and returns a copy with persisted directory names. The mail synchronization path and reconciliation worker reuse this boundary, avoiding directory-specific logic in UI components.

The enrichment boundary receives a local exact-email resolver as a dependency. It does not own directory synchronization and cannot perform network operations. Outbound mail serialization continues to send only the standard address name and email fields; `directoryName` is local display metadata.

## Error Handling

- If the local directory is unavailable, persist and display the original mail address unchanged.
- If a directory match is absent, do not guess by local part, alias, pinyin, or name.
- If reconciliation fails partway through, keep completed batches and allow a later directory refresh or startup recovery to continue.
- Malformed or empty addresses are left unchanged and must not prevent valid addresses from being enriched.
- External addresses continue to display their original name or email without an error indicator.
- Detail rendering must remain functional when older stored JSON lacks `directoryName`.

## Performance

- Opening a mail detail performs no directory request and no directory association write.
- Ingestion uses indexed, case-insensitive exact-email lookups against the local directory.
- Address lists are deduplicated for lookup work while their original order and duplicates are preserved in stored message data.
- Directory reconciliation runs in bounded batches so large mailboxes do not monopolize the event loop or a long database transaction.
- Reconciliation writes only messages whose stored address JSON changes.

## Accessibility

- The expand/collapse control is a real button.
- Its accessible name changes between `展开收件人详情` and `收起收件人详情`.
- The control exposes `aria-expanded`.
- Expanded rows use visible text labels and remain selectable for copying.
- Activating recipient details inside a thread message must stop propagation so it does not toggle the enclosing message.

## Testing

### Client tests

- Collapsed state renders one line with truncation styling.
- The caret expands and collapses the details.
- To, CC, and BCC appear as separate rows; empty groups are absent.
- Formatting prefers `directoryName`, then original `name`, then email.
- Expanding recipient details does not collapse an expanded thread message.
- Single-message and thread-message views both use the shared component.

### Server and repository tests

- Exact email matching is case-insensitive.
- Ingestion persists `directoryName` while preserving the original `name`.
- Unmatched and external addresses remain unchanged.
- Existing directory names survive mail metadata, flag, and body refreshes.
- Directory reconciliation backfills previously unresolved messages.
- Directory renames update persisted names.
- Directory contact removal clears stale persisted names.
- Reconciliation preserves address order and duplicates and updates only changed rows.

### Verification

Run:

```powershell
npm test
npm run typecheck
npm run build:desktop
```

Then launch the desktop application and visually verify compact and expanded headers in both a single message and a multi-message thread, including a large internal recipient list.

## Acceptance Criteria

- Mail details show a one-line, truncating recipient summary by default.
- Users can expand and collapse To, CC, and BCC details.
- Directory-matched internal addresses display the complete persisted directory name.
- Opening the same message repeatedly causes no directory lookup or association request.
- Original mail address names remain available as the fallback.
- Existing messages are backfilled after directory synchronization without requiring users to open them.
- The feature behaves consistently in single-message and thread-message views.
