# Mail Search Clear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a visible, accessible search-clear control that exits the URL-backed mail search state and refreshes the normal mailbox view.

**Architecture:** `MessageListView` already owns the URL-backed search input and `submitSearch`. Add a small `clearSearch` callback next to it, and make `onChange`, Escape, and the explicit button reuse that callback. Removing `q` lets `InboxRoute` select its existing `useEmails` query rather than `useSearchEmails`.

**Tech Stack:** React 19, React Router, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- Do not invoke `api.syncMail` when clearing a search.
- Preserve the current folder pathname and non-search query parameters.
- Use an accessible icon button named `清除搜索`.

---

### Task 1: Prove and implement the visible clear-search transition

**Files:**
- Modify: `app/routes/_workbench.test.tsx`
- Modify: `app/routes/_workbench.tsx`

**Interfaces:**
- Consumes: `submitSearch(raw: string)` in `MessageListView`.
- Produces: an `aria-label="清除搜索"` button that removes `q` from the current route.

- [ ] **Step 1: Write the failing test**

```tsx
it("clears the keyword with the visible clear button and restores the inbox route", async () => {
  const user = userEvent.setup();
  renderMessageList([makeEmail("msg-1")], "/?q=invoice");

  await user.click(screen.getByRole("button", { name: "清除搜索" }));

  await waitFor(() =>
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/"),
  );
  expect(api.syncMail).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:renderer -- app/routes/_workbench.test.tsx`

Expected: FAIL because no button has the accessible name `清除搜索`.

- [ ] **Step 3: Write minimal implementation**

```tsx
const clearSearch = () => {
  setSearchInput("");
  submitSearch("");
};

onChange={(event) => {
  const next = event.target.value;
  setSearchInput(next);
  if (!next && urlQuery) clearSearch();
}}

{urlQuery ? (
  <button type="button" aria-label="清除搜索" onClick={clearSearch}>…</button>
) : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:renderer -- app/routes/_workbench.test.tsx`

Expected: PASS with the new clear-search case and existing Workbench tests.

- [ ] **Step 5: Run project verification and commit**

Run: `npm run typecheck && npm run test:renderer -- app/routes/_workbench.test.tsx`

Expected: both commands exit 0. Commit with `git commit -m "fix: clear mail search back to inbox"`.
