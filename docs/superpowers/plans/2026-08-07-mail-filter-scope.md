# Scoped Mail Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure mail filters are isolated to the current directory view and never make the global “all mail” list inherit filters from another directory.

**Architecture:** Add a pathname-backed filter scope to the UI store and expose a hook that returns the current view’s filters, returning defaults until the scope is synchronized. All mail routes, the toolbar, the local list filter, and route query builders consume that hook, so changing directory clears the prior scope while reusing the existing filter controls and API parameters.

**Tech Stack:** React, React Router, Zustand, TypeScript, Vitest, Testing Library.

## Global Constraints

- Keep the Electron runtime and existing route structure unchanged.
- Preserve current filter query parameter names and server behavior.
- Do not add application tests to the rapid interactive debugging loop; run the focused Vitest tests at the acceptance checkpoint.
- Preserve unrelated working-tree changes in `.codegraph/daemon.pid` and `.tmp-package-lock.json`.

### Task 1: Add the scoped filter state hook and failing regression tests

**Files:**
- Create: `app/hooks/useMailFilters.ts`
- Create: `app/hooks/useMailFilters.test.tsx`
- Modify: `app/hooks/useUIStore.ts`

**Interfaces:**
- `useMailFilters()` returns the effective `MailFilters` for the current `location.pathname`.
- `useUIStore` stores `mailFilterScope: string | null` and exposes `setMailFilterScope(scope: string)`.

- [ ] **Step 1: Write the failing hook test**

Create a MemoryRouter test that seeds an inbox filter, renders `useMailFilters`, navigates to `/folder/all-mail`, and asserts the returned filters are defaults and the store has cleared the old filter scope. Add a second assertion that after setting a filter while on `/folder/all-mail`, rerendering returns that filter for the same path.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run app/hooks/useMailFilters.test.tsx`

Expected: FAIL because `useMailFilters` and the scoped store state do not exist yet.

- [ ] **Step 3: Add the minimal store scope and hook**

Add `mailFilterScope`, `setMailFilterScope`, and a `useMailFilters` hook. The hook must use `useLayoutEffect` to synchronize the current pathname, return a fresh default filter object when the stored scope differs, and otherwise return `state.mailFilters`. `setMailFilterScope` must clear `mailFilters` whenever the scope changes.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run app/hooks/useMailFilters.test.tsx`

Expected: PASS.

### Task 2: Route all filter consumers through the current view scope

**Files:**
- Modify: `app/routes/inbox.tsx`
- Modify: `app/routes/folder.tsx`
- Modify: `app/routes/message.tsx`
- Modify: `app/routes/smart-tags.tsx`
- Modify: `app/routes/_workbench.tsx`
- Modify: `app/components/wemail/MailFilterPopover.tsx`

**Interfaces:**
- Every consumer uses `useMailFilters()` instead of reading `useUIStore((state) => state.mailFilters)` directly.
- Existing `buildMailFilterParams` output remains unchanged.

- [ ] **Step 1: Replace direct store reads**

Use `const mailFilters = useMailFilters()` in each route and in `MessageListView`, `FilterActiveDot`, and `MailFilterPopover`. Keep `setMailFilter` and `clearMailFilters` actions from `useUIStore` unchanged.

- [ ] **Step 2: Add the list-level regression assertion**

Extend `app/routes/_workbench.test.tsx` with a case that renders `MessageListView` at `/folder/all-mail` while the store contains an inbox-scoped filter. Assert the matching email remains visible, then set the all-mail scope and filter and assert the same local filtering behavior applies only after the new view owns the filter.

- [ ] **Step 3: Run the focused renderer tests**

Run: `npx vitest run app/hooks/useMailFilters.test.tsx app/routes/_workbench.test.tsx app/routes/inbox.test.tsx`

Expected: PASS with the existing inbox query-parameter assertions unchanged.

### Task 3: Validate the changed renderer behavior

**Files:**
- Review only the files changed in Tasks 1–2.

- [ ] **Step 1: Run the renderer typecheck**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 2: Run the focused regression suite again**

Run: `npx vitest run app/hooks/useMailFilters.test.tsx app/routes/_workbench.test.tsx app/routes/inbox.test.tsx`

Expected: all selected tests pass.

- [ ] **Step 3: Inspect the final diff and working tree**

Run: `git diff --check; git status --short`

Expected: no whitespace errors; only the intended source/tests/docs changes plus the pre-existing local runtime files remain.
