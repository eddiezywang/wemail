# Mail Category and Detail Interaction Performance Implementation Plan

## Constraints

- Electron remains the only desktop runtime.
- DB Writer remains the only production writer.
- The migration is additive and restart-safe.
- Existing user changes in `workspace/reports` and the untracked performance
  collector remain untouched.
- Each stage receives focused tests before full validation.

## Stage 1: Indexed Category Read Model

1. Add a migration for `mail_system_classifications`.
2. Backfill important, action-required, and invoice membership from successful
   tag results and user overrides.
3. Add triggers for tag-result, override, folder, received-time, read-state,
   and deletion changes.
4. Add the category-list and thread composite indexes.
5. Add migration tests for backfill and ongoing synchronization.

## Stage 2: Category Queries

1. Replace JSON category membership predicates with the normalized table.
2. Aggregate category counts in SQL from the normalized table.
3. Keep bounded list pagination and exact count compatibility.
4. Add query-plan and sparse-category performance regression tests.
5. Re-run a read-only benchmark on the configured mailbox.

## Stage 3: Stable Detail Layout

1. Keep one desktop Workbench panel topology across detail open/close.
2. Collapse or hide the detail panel without remounting navigation and list.
3. Remove whole-grid width animation from the first detail paint.
4. Add component-identity and selection regression tests.

## Stage 4: Precise Read Updates

1. Patch the selected detail and containing list caches optimistically.
2. Patch known folder/category unread counts.
3. Avoid successful broad list invalidation for a read-only flag change.
4. Scope mail-event invalidation by event fields when available.
5. Add success, rollback, and event-scope tests.

## Stage 5: Secondary Detail Work

1. Use the new thread index and preserve ordered thread results.
2. Defer thread and intelligence work until metadata has painted.
3. Delay automatic todo/link/reply-decision triggers and cancel stale
   selection work.
4. Add scheduling and rapid-selection tests.

## Stage 6: Verification

1. Run focused migration, repository, query, and renderer tests.
2. Run TypeScript checks and server/renderer suites.
3. Rebuild and launch with `wemail-desktop-build`.
4. Verify a visible window and startup health markers.
5. Run category and detail interaction sampling on the real mailbox.
6. Compare category first-row, detail metadata, body, query duration,
   invalidation count, heartbeat timeout, and Worker restart results against
   the approved design.
