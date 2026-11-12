# Mail List Summary Banner and IMAP Flags Fix

## Problem

The previous mail-navigation change did not fully satisfy the confirmed product behavior:

- Only the dedicated inbox route disabled `MailDigestBanner`. The aggregate `all-mail` route and other folder, category, and smart-tag mail lists still rendered the summary failure banner.
- The `All Mail` parent displayed an aggregate unread badge next to the independent inbox unread badge, which created an unnecessary reconciliation expectation between two different message sets.
- IMAP metadata synchronization did not request or persist message flags. Newly synchronized messages therefore defaulted to `seen: false`, making historical messages appear unread and inflating folder, category, smart-tag, and aggregate unread counts.

## Confirmed Product Decisions

- No mail list renders a summary banner. Summary status, diagnostics, and retry controls live only in Summary Center.
- Background summary recovery remains enabled and unchanged.
- The `All Mail` parent does not display a numeric badge.
- Inbox, secondary categories, smart tags, and IMAP folders continue displaying their own unread counts, with zero hidden.
- The selected mail view header continues displaying its exact total and unread count.
- Unread counts must reflect provider flags rather than treating every synchronized message as unread.

## UI Changes

`MessageListView` will no longer own or render `MailDigestBanner`. Removing the banner at the shared mail-list component boundary guarantees the behavior for inbox, all mail, categories, smart tags, and IMAP folders instead of relying on each route to pass an opt-out property.

Summary-related hooks and actions used only by the banner will also be removed from `MessageListView`. Digest and summary operations in Summary Center and email detail remain intact.

`MailboxNavigationGroup` will remove the `allMailUnreadCount` input and render no badge on the `All Mail` parent. Secondary navigation badge behavior is unchanged.

## IMAP Flag Synchronization

The metadata fetch query will request IMAP `flags` together with UID, envelope, body structure, and internal date. The provider's raw-message seam and normalizer will carry the flags into canonical `MailFlags`:

- `\\Seen` → `seen`
- `\\Flagged` → `flagged`
- `\\Answered` → `answered`
- `\\Draft` → `draft`

Flag matching is case-insensitive. Missing flags remain false.

Full-body fetches also request and preserve flags so body hydration cannot overwrite correct metadata with false defaults.

## Existing Data Correction

Existing rows already contain incorrect defaults, so fixing new synchronization alone is insufficient. The normal account synchronization path will refresh metadata flags for the bounded synchronized UID window. The existing upsert path will then reconcile provider flags into stored rows.

Read state must follow the provider on metadata refresh. Locally initiated read/unread changes already update the provider before local persistence; therefore retaining a permanent logical OR with an old local `seen` value would prevent a provider-side unread change from being reflected. Star state follows the same provider-authoritative rule once flags are fetched.

The correction is incremental and non-destructive: no database reset, message deletion, or forced reprocessing of summaries and classifications. Counts converge as the normal synchronization pass updates rows.

## Error Handling

- If an IMAP server omits flags, normalization uses false defaults without aborting synchronization.
- A flag-refresh failure follows the existing mail synchronization retry and logging path.
- Count query failures keep existing cached UI data; they must not fall back to loaded page length.
- Removing mail-list banners does not suppress Summary Center failures or configuration diagnostics.

## Testing

### Renderer

- Shared `MessageListView` never renders `MailDigestBanner` for any route or summary state.
- Inbox, all-mail, category, smart-tag, and IMAP folder hosts inherit the no-banner behavior.
- `All Mail` renders no numeric badge.
- Inbox and secondary navigation entries still render non-zero unread badges.
- View headers still render exact total and unread metadata.

### Server

- Metadata fetch requests `flags`.
- Full-body fetch requests `flags`.
- Normalization maps the four supported IMAP flags case-insensitively.
- Resynchronization updates stale read and star state from provider flags.
- Folder and aggregate unread counts reflect corrected stored flags.

### Acceptance

- Launch the Windows desktop app against the existing account.
- Verify no yellow summary banner appears in inbox, all mail, categories, smart tags, or IMAP folders.
- Verify `All Mail` has no right-side number.
- Trigger or wait for mail synchronization and verify the header unread count no longer treats almost every historical message as unread.
- Verify Summary Center still shows failures and retains manual retry operations.

## Out of Scope

- Redesigning Summary Center.
- Removing background summary recovery.
- Changing the meaning of inbox or secondary unread badges.
- Resetting the local mailbox database.
- Adding a new manual unread-count repair control.
