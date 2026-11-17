# All Mail Time Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the All Mail virtual-folder query apply the active directory filters, including the existing “older than N days” time filter.

**Architecture:** Keep the current directory-scoped filter state and the existing `allMail: "1"` virtual-folder query. Extend the filter object passed from `FolderRoute` through `useVirtualEmails` and `useAllMailQuery`, so `useEmails` receives the same serialized filter parameters as a normal folder query. The existing React Query key already includes the complete query-parameter object, so changing `olderThan` will naturally select a separate cache entry.

**Tech Stack:** React, React Router, TanStack Query, TypeScript, Vitest, Testing Library.

## Global Constraints

- Preserve the existing directory filter isolation behavior.
- Preserve the existing time-filter meaning: `7d`, `30d`, and `180d` mean messages older than 7, 30, and 180 days respectively.
- Keep `allMail: "1"` on All Mail requests; do not replace the All Mail query with a folder-scoped query.
- Do not change the backend SQLite time predicate or its `received_at_ms < cutoff` direction.
- Do not modify the filter labels, add a custom date picker, or alter unrelated virtual-folder behavior.
- Do not change the installed data, mailbox configuration, or generated output.

---

## File Structure

### Modified files

- `app/queries/virtualFolders.ts`
  - Accept the serialized mail-list filter parameters in `useVirtualEmails`.
  - Forward supported filters through `useAllMailQuery` into `useEmails` while retaining `allMail: "1"`.
- `app/routes/folder.tsx`
  - Pass the current directory’s `filterParams` to `useVirtualEmails`.
- `app/queries/virtualFolders.test.tsx`
  - Verify All Mail forwards time and boolean filters to `api.listEmails`.
- `app/queries/emails.test.tsx`
  - Verify the existing email-list query key distinguishes different `olderThan` values.

### Unchanged files

- `app/components/wemail/MailFilterPopover.tsx`
- `app/hooks/useMailFilters.ts`
- `app/queries/keys.ts`
- `server/wemail/database/MailDatabaseQueryRepository.ts`

`app/queries/keys.ts` already constructs list keys as `["emails", mailboxId, params]`; the complete `params` object already includes `olderThan` after the forwarding fix.

## Task 1: Add All Mail Filter Regression Tests

**Files:**

- Modify: `app/queries/virtualFolders.test.tsx`
- Modify: `app/queries/emails.test.tsx`

**Interfaces:**

- Consumes: `useVirtualEmails(mailboxId, VirtualFolders.ALL_MAIL, filters)`.
- Produces: regression coverage proving the all-mail request contains `allMail`, `olderThan`, and the other supported filters.

- [ ] **Step 1: Add a failing All Mail time-filter test**

Extend the existing All Mail test in `app/queries/virtualFolders.test.tsx` with a serialized filter object:

```tsx
const { result } = renderHook(
  () =>
    useVirtualEmails("acct-1", VirtualFolders.ALL_MAIL, {
      olderThan: "30d",
    }),
  { wrapper },
);
```

After the query succeeds, assert that the request contains both values:

```tsx
expect(listSpy).toHaveBeenCalledWith(
  "acct-1",
  expect.objectContaining({
    allMail: "1",
    olderThan: "30d",
  }),
);
```

The test must fail before implementation because the current `useVirtualEmails` signature does not accept a third filter argument and `useAllMailQuery` drops `olderThan`.

- [ ] **Step 2: Add a combined-filter forwarding assertion**

Add a second test that calls All Mail with:

```tsx
{
  unread: "1",
  toMe: "1",
  ccMe: "1",
  hasAttachment: "1",
  olderThan: "180d",
  category: "important",
  tag: "finance",
}
```

Assert that the `api.listEmails` call contains all of these fields plus `allMail: "1"`. This prevents the fix from forwarding only the time field while silently dropping the other directory filters.

- [ ] **Step 3: Add a query-key distinction test**

In `app/queries/emails.test.tsx`, import `queryKeys` if it is not already imported and add:

```tsx
it("separates All Mail caches by olderThan", () => {
  const sevenDays = queryKeys.emails.list("acct-1", {
    limit: "50",
    allMail: "1",
    olderThan: "7d",
  });
  const thirtyDays = queryKeys.emails.list("acct-1", {
    limit: "50",
    allMail: "1",
    olderThan: "30d",
  });

  expect(sevenDays).not.toEqual(thirtyDays);
});
```

This confirms the existing key factory does not need a code change and guards against a future regression that omits filter values from list keys.

- [ ] **Step 4: Run the focused tests and confirm the new forwarding test fails for the current implementation**

Run:

```powershell
npm run test:renderer -- app/queries/virtualFolders.test.tsx app/queries/emails.test.tsx
```

Expected before implementation: the existing tests pass, while the new All Mail forwarding test fails because `olderThan` is not present in the API call. If the repository’s Vitest script does not accept file arguments, run the equivalent direct Vitest command configured by `package.json` with the two test paths.

## Task 2: Forward Active Filters Through the All Mail Query

**Files:**

- Modify: `app/queries/virtualFolders.ts:52-65,74-82`
- Modify: `app/routes/folder.tsx:48-69`

**Interfaces:**

- Consumes: `buildMailFilterParams(mailFilters)` from `FolderRoute`.
- Produces: `useVirtualEmails(mailboxId, view, filters?)`, where `filters` contains serialized list parameters and All Mail always adds `allMail: "1"` internally.

- [ ] **Step 1: Define the narrow serialized filter type**

In `app/queries/virtualFolders.ts`, define a local type next to `EmailListResponse`:

```ts
interface VirtualMailFilters {
  unread?: string;
  toMe?: string;
  ccMe?: string;
  hasAttachment?: string;
  olderThan?: string;
  category?: string;
  tag?: string;
}
```

Use a serialized-string type because `buildMailFilterParams` returns URL/API parameters, not the boolean-valued UI store state.

- [ ] **Step 2: Extend `useAllMailQuery` and explicitly forward supported filters**

Change the helper signature to accept `filters?: VirtualMailFilters`, then construct the `useEmails` parameters as:

```ts
{
  page: "1",
  allMail: "1",
  ...(filters?.unread ? { unread: filters.unread } : {}),
  ...(filters?.toMe ? { toMe: filters.toMe } : {}),
  ...(filters?.ccMe ? { ccMe: filters.ccMe } : {}),
  ...(filters?.hasAttachment
    ? { hasAttachment: filters.hasAttachment }
    : {}),
  ...(filters?.olderThan ? { olderThan: filters.olderThan } : {}),
  ...(filters?.category ? { category: filters.category } : {}),
  ...(filters?.tag ? { tag: filters.tag } : {}),
}
```

Do not spread an unknown object wholesale. Explicit forwarding keeps the virtual-folder boundary limited to fields supported by `api.listDesktopEmails`.

- [ ] **Step 3: Extend `useVirtualEmails` and pass filters to the all-mail branch**

Change the signature to:

```ts
export function useVirtualEmails(
  mailboxId: string | undefined,
  view: VirtualFolderId,
  filters?: VirtualMailFilters,
)
```

Pass `filters` to `useAllMailQuery`:

```ts
const { allQuery } = useAllMailQuery(
  isAllMail ? mailboxId : undefined,
  filters,
);
```

Keep the non-All-Mail virtual-folder behavior unchanged. The filters are intentionally consumed by the All Mail query only; ordinary folders already receive them through their direct `useEmails` call.

- [ ] **Step 4: Pass `filterParams` from `FolderRoute`**

Update the `useVirtualEmails` call in `app/routes/folder.tsx` to merge the current directory filters with the existing URL scopes:

```tsx
const virtualQuery = useVirtualEmails(
  virtualFolder ? mailboxId : undefined,
  virtualFolder ?? "all-mail",
  {
    ...filterParams,
    ...(searchParams.get("category")
      ? { category: searchParams.get("category")! }
      : {}),
    ...(searchParams.get("tag") ? { tag: searchParams.get("tag")! } : {}),
  },
);
```

The URL category/tag values remain available, and the directory-scoped filter state now reaches All Mail. `allMail: "1"` remains owned by `useAllMailQuery`.

- [ ] **Step 5: Run the focused tests and confirm they pass**

Run:

```powershell
npm run test:renderer -- app/queries/virtualFolders.test.tsx app/queries/emails.test.tsx
```

Expected: all focused tests pass, including the All Mail `olderThan` forwarding assertion and the query-key distinction assertion.

## Task 3: Review the Diff and Verify Scope

**Files:**

- Review only: `app/queries/virtualFolders.ts`
- Review only: `app/routes/folder.tsx`
- Review only: `app/queries/virtualFolders.test.tsx`
- Review only: `app/queries/emails.test.tsx`

- [ ] **Step 1: Inspect the diff for unrelated changes**

Run:

```powershell
git diff -- app/queries/virtualFolders.ts app/routes/folder.tsx app/queries/virtualFolders.test.tsx app/queries/emails.test.tsx
```

Expected: the diff contains only filter-type propagation, All Mail request construction, and focused regression tests. No backend, filter-state, label, or time-direction changes should appear.

- [ ] **Step 2: Check the required semantic assertions**

Confirm in the diff and tests that:

- `allMail: "1"` is still present.
- `olderThan: "7d"`, `"30d"`, and `"180d"` are passed as strings without client-side timestamp conversion.
- No condition changes from “older than” to “newer than”.
- Clearing a filter removes the corresponding optional parameter through `buildMailFilterParams`.
- The query key includes the complete parameter object.

- [ ] **Step 3: Run the repository’s changed-renderer verification when explicitly authorized**

Run only after the user explicitly requests verification:

```powershell
npm run verify:changed
```

Expected: the changed-path renderer checks and related tests pass. If the repository reports an unrelated pre-existing failure, record the exact failing command and error without modifying unrelated work.

## Expected Result

After implementation, selecting “一个月前” in All Mail produces a request equivalent to:

```ts
{
  limit: "50",
  allMail: "1",
  olderThan: "30d",
}
```

The existing backend applies:

```sql
received_at_ms < 当前时间 - 30 * 86400000
```

Thus All Mail shows messages earlier than 30 days before the current time, while 收件箱 behavior, directory filter isolation, and filter-clearing behavior remain unchanged.
