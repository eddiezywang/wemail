# Global Mail Search Deduplication Design

## Objective

Make the top search experience operate on logical, unique mail across the mailbox while keeping IMAP folder records intact. All user-visible variants of `INBOX`, `Inbox`, and `inbox` must display as `收件箱`; protocol values, database folder values, routes, and existing email IDs remain unchanged.

## Search scope

The top search searches all ordinary mail locations:

- 收件箱
- 已发送
- 归档
- ordinary user-created folders

It excludes drafts, trash, junk/spam, and virus-mail folders by default, including their IMAP special-use markers and known localized aliases. A search explicitly scoped to one of those folders may still return its contents.

The UI must label the scope as `搜索所有邮件` so the currently selected navigation folder does not imply that the search is folder-local.

## Logical mail identity

Search results are grouped by a normalized RFC `Message-ID` when one is present. Normalization trims whitespace, treats comparison as case-insensitive, and normalizes surrounding angle brackets. Messages without a usable `Message-ID` retain their local email ID as the identity and are not merged based only on subject, sender, or time.

Physical IMAP records remain in the database. No migration deletes folder copies or changes existing primary keys.

## Representative copy selection

For records belonging to one logical message, select the representative in this order:

1. `body_state=ready`
2. a record with actual body content
3. 收件箱
4. 已发送
5. 归档
6. another ordinary folder
7. `body_state=missing`
8. `body_state=failed`

Ties prefer complete attachment metadata, then the newest update time, then a stable email-ID order. The returned ID must always identify the selected physical record so reply, move, attachment, and body operations remain valid.

## Ordinary search

The server fetches enough physical candidates, applies default folder exclusions, groups by logical identity, selects a representative, sorts by real received time, and only then applies result limits and pagination. `totalCount` represents unique logical messages rather than physical database rows.

An explicit folder query limits candidates to that folder. Global search does not silently broaden such a query.

## Semantic search

Existing semantic index rows may remain physical-copy based. At query time the service must:

1. retrieve more candidates than the requested logical result count;
2. resolve each semantic hit to its mail record;
3. exclude default-special folders;
4. group hits by normalized `Message-ID`;
5. preserve the best semantic score/snippet per logical message;
6. replace the hit email ID with the best representative physical copy;
7. continue fetching candidates as needed to fill the logical result limit.

The semantic API returns complete display metadata: representative email ID, logical identity, real subject, sender, recipient, received time, folder information, score, and a cleaned snippet.

The renderer must remove the synthetic `语义搜索命中` subject, `Wemail AI` sender, copied first-result date, and visible `Subject:` index prefix. Keyword and semantic results are merged by logical identity and appear once.

## Folder display names

A shared display-name function maps protocol/system roles to Chinese UI labels while leaving internal identifiers untouched:

- `INBOX` -> `收件箱`
- sent variants -> `已发送`
- draft variants -> `草稿`
- archive variants -> `归档`
- trash variants -> `回收站`
- junk/spam variants -> `垃圾邮件`

Sidebar items, route titles, search scope labels, filters, and mail-detail folder labels use this function. Unknown user folders retain their provider name.

## Body loading behavior

Body states have explicit UI behavior:

- `ready`: render the body.
- A list-row snapshot may seed the detail surface so the subject, sender, and date render immediately, but it is placeholder data rather than a fresh detail response. It must not inherit the normal 30-second detail `staleTime` or suppress the first detail request.
- Selecting a message immediately requests its full local Mail Core snapshot. A locally cached `ready` body should render without entering the polling path.
- `missing` or `fetching`: queue hydration and use bounded progressive polling as a fallback: immediately fetch once, then poll after 500 ms, 500 ms, and every 1 second thereafter for at most 15 observations.
- `failed`, or a polling timeout: stop automatic polling and show `邮件正文暂时无法加载` with a manual `重新加载` action.

Manual retry starts one new hydration attempt and a fresh bounded polling window. Internal error codes such as `mail-body-missing` are not exposed to the user.

The normal 30-second freshness window remains valid only for complete detail responses. A failed Mail Core snapshot may use the local HTTP recovery path, but the detail query must not apply the application-wide retry schedule on top of Mail Core timeouts and body polling; manual retry remains available after an explicit failure.

Choosing the ready representative during search should prevent most duplicate-copy hydration failures.

## Error handling

- Semantic-only hits whose available copies are all in excluded folders are omitted.
- Missing semantic mail records are skipped rather than rendered as fake emails.
- A semantic search failure still allows keyword results.
- A keyword search failure still allows valid semantic results.
- Missing `Message-ID` values never cause heuristic merging.
- Stable tie-breaking prevents result order from changing between refreshes.

## Implementation boundaries

- `shared/`: folder-role/display helpers, special-folder rules, Message-ID normalization, and representative ranking primitives where cross-layer reuse is needed.
- `server/wemail/mail/`: logical-mail grouping and ordinary search result selection.
- `server/wemail/search/`: semantic hit hydration, filtering, grouping, and representative selection.
- `server/api/routes/`: normalized search response contracts.
- `app/services/` and `app/queries/`: consume complete semantic results and bounded body states.
- `app/routes/_workbench.tsx`: remove synthetic semantic mail objects and merge by logical identity.
- `app/components/EmailPanel.tsx`: render bounded loading, failure, and retry states.

The unrelated existing change in `server/wemail/bootstrap/composition/agent.ts` is outside this work and must remain untouched.

## Tests

Automated coverage must verify:

- all user-visible inbox variants render as `收件箱` while internal IDs remain unchanged;
- eight folder copies with one `Message-ID` produce one search result;
- a ready 收件箱 copy wins over missing or failed copies;
- missing `Message-ID` records are not incorrectly merged;
- default-special folders are excluded, while explicit folder searches still work;
- deduplication occurs before limits and unique `totalCount` calculation;
- semantic duplicate candidates fill the requested number of distinct messages;
- keyword and semantic results merge into one row;
- semantic results carry real subject, sender, and received time;
- `语义搜索命中`, fake dates, and visible `Subject:` prefixes are absent;
- selecting a list-only snapshot immediately requests full detail even while the global detail `staleTime` is 30 seconds;
- a locally ready body does not wait for a polling interval;
- only `missing` or `fetching` detail responses enter bounded progressive polling;
- failed bodies stop polling and fetching bodies time out into a retry state.

Verification commands:

- `npm run typecheck`
- `npm run typecheck:server`
- `npm run test:server`
- `npm run test:renderer`
- `npm run build:desktop`
- relevant Electron startup validation for mail search and detail rendering

## Acceptance criteria

Searching `绩效` returns the July 6 performance mail once, with its real title and time, and opens the ready physical copy. The result list contains unique ordinary mail from all included folders, excludes special folders by default, never shows `语义搜索命中` or a synthetic date, stops failed body hydration, and displays `收件箱` everywhere visible to the user. Opening a locally ready historical message issues an immediate detail request and renders its cached body without waiting for the polling interval.
