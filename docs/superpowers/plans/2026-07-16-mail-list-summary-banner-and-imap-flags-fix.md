# Mail List Summary Banner and IMAP Flags Fix Plan

## Objective

Remove summary banners from every mail-list surface, remove the aggregate unread badge from the `All Mail` parent, and make unread counts reflect provider IMAP flags for both new and existing synchronized messages.

## Tasks

1. Update `MessageListView` so it no longer imports, queries for, or renders `MailDigestBanner`; remove route-level opt-out plumbing and update renderer tests.
2. Remove `allMailUnreadCount` calculation and component input; keep unread badges for inbox and secondary entries and update sidebar tests.
3. Extend `RawFetchLike` and `RawImapMessage` with message flags, request flags in metadata and body fetches, and map standard system flags in `normalizeMail`.
4. Make synchronized flags provider-authoritative during upsert so the next normal metadata pass repairs stale local defaults; preserve non-provider local-only fields separately if needed.
5. Add focused provider, normalizer, repository, route, and renderer tests for the corrected behavior.
6. Run typecheck, focused Vitest and Node tests, production client build, and the deterministic Windows desktop rebuild/startup workflow.
7. Commit the implementation, merge into `main`, push, and verify `origin/main` matches.

## Acceptance Criteria

- No mail list can render the yellow summary banner.
- `All Mail` has no numeric badge.
- Secondary unread badges remain visible and hide zero.
- Provider `\\Seen`, `\\Flagged`, `\\Answered`, and `\\Draft` flags are persisted correctly.
- A normal resynchronization corrects rows previously stored with false default flags.
- Summary Center and background recovery remain operational.
