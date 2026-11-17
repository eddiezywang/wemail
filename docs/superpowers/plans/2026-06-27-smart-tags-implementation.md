# Smart Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make smart tags behave as first-class AI-backed tag views: visible in the sidebar, clickable as filtered lists, manageable, removable, and usable from mail detail as move-in/move-out actions.

**Architecture:** Reuse the existing `user_tags`, tag apply/remove endpoints, and mail route `category` filtering for the first implementation. Add a `/smart-tags/:id` route that resolves the user tag by id and queries mail with `category=<tag.name>`. Add UI management controls in the sidebar and tag picker, and strengthen delete cleanup in `IntelligenceResultRepository`.

**Tech Stack:** React Router 7, React Query, TypeScript renderer, Hono-style server routes, node:test, Vitest.

## Global Constraints

- User-facing product name remains `智能标签`; do not rename it to `智能分类`.
- Creation flow only asks for tag name and description; prompt is only shown in management.
- Deleting a smart tag removes that tag from all mail results but does not delete mail.
- Action center history and prompt revision history are preserved after deleting a smart tag.
- Existing `user-tags` APIs stay compatible.
- Existing onboarding changes in the working tree must not be reverted or mixed into smart-tag commits.

---

## File Structure

- `app/routes.ts`: add `/smart-tags/:id`.
- `app/routes/smart-tags.tsx`: new workbench route for a selected smart tag.
- `app/components/Sidebar.tsx`: render the Smart Tags section from `useUserTags`, navigate after create, expose edit/delete menu.
- `app/components/wemail/CreateSmartTagDialog.tsx`: return the created tag object to parents.
- `app/components/wemail/SmartTagManageDialog.tsx`: new focused management dialog for name, description, prompt, and delete.
- `app/components/wemail/SmartTagPickerPopover.tsx`: update copy to move-in/move-out smart tag language and invalidate list caches.
- `app/queries/userTags.ts`: add stronger invalidation and expose shared type for create callback.
- `app/queries/tagLibrary.ts`: invalidate mail lists after apply/remove.
- `server/wemail/intelligence/IntelligenceResultRepository.ts`: add `removeTagFromAccount(accountId, tagName)`.
- `server/api/routes/intelligenceRoutes.ts`: call `removeTagFromAccount` when deleting a user tag.
- Tests: add focused backend and renderer tests around delete cleanup, sidebar display, and route filtering where practical.

## Tasks

### Task 1: Backend delete cleanup

**Files:**
- Modify: `server/wemail/intelligence/IntelligenceResultRepository.ts`
- Modify: `server/api/routes/intelligenceRoutes.ts`
- Test: `server/api/routes/intelligenceRoutes.test.ts`

**Interfaces:**
- Produces: `IntelligenceResultRepository.removeTagFromAccount(accountId: string, tagName: string): number`
- Consumes: `UserTagRepository.getById(id)` and `UserTagRepository.deleteById(id)`

- [ ] Add a failing route test: create a user tag, add it to two messages, delete the tag, assert message results no longer contain the tag and the tag row is deleted.
- [ ] Run `node --import tsx --test server/api/routes/intelligenceRoutes.test.ts`.
- [ ] Implement `removeTagFromAccount` by scanning succeeded `tags` results joined to `mail_messages` for the account and rewriting result JSON with the tag removed.
- [ ] Update `DELETE /user-tags/:id` to fetch the tag first, remove tag relations, then delete the tag.
- [ ] Re-run the focused server test.

### Task 2: Sidebar smart tag navigation and management shell

**Files:**
- Modify: `app/components/Sidebar.tsx`
- Modify: `app/components/wemail/CreateSmartTagDialog.tsx`
- Create: `app/components/wemail/SmartTagManageDialog.tsx`
- Test: `app/components/Sidebar.test.tsx` if a local sidebar test exists; otherwise add coverage through route/workbench tests later.

**Interfaces:**
- Consumes: `useUserTags(accountId)`, `useUpdateUserTag(accountId)`, `useDeleteUserTag(accountId)`
- Produces: sidebar links to `/smart-tags/:id`, management dialog with edit/delete controls

- [ ] Render a Smart Tags section below primary shortcuts and above Mailbox.
- [ ] Change create callback to receive the created `UserTag`; after create navigate to `/smart-tags/${tag.id}`.
- [ ] Add a per-tag management button/menu that opens `SmartTagManageDialog`.
- [ ] In the management dialog, support editing name, description, prompt, and deleting with confirmation.
- [ ] On delete success, close the dialog and navigate away if currently on that tag.

### Task 3: Smart tag route and real list filtering

**Files:**
- Modify: `app/routes.ts`
- Create: `app/routes/smart-tags.tsx`
- Modify: `app/routes/_workbench.tsx`
- Test: `app/routes/_workbench.test.tsx` or a new route test

**Interfaces:**
- Consumes: `useUserTags(accountId)` and `useEmails(mailboxId, { category: tag.name })`
- Produces: route `/smart-tags/:id`

- [ ] Add route `route("smart-tags/:id", "routes/smart-tags.tsx")`.
- [ ] Implement `SmartTagRoute` that resolves the tag by id, queries `useEmails` with `{ category: tag.name, page: "1" }`, and renders `WorkbenchShell`.
- [ ] Pass a view label into `MessageListView` so the list can show `发票` instead of folder-like text when needed.
- [ ] If the tag does not exist, render a friendly empty/not-found state in the list slot.

### Task 4: Mail detail move-in/move-out copy and invalidation

**Files:**
- Modify: `app/components/wemail/SmartTagPickerPopover.tsx`
- Modify: `app/components/wemail/EmailIntelligenceCard.tsx`
- Modify: `app/queries/tagLibrary.ts`

**Interfaces:**
- Consumes: existing `api.applyMessageTag` and `api.removeMessageTag`
- Produces: user-facing move-in/move-out smart tag wording and list invalidation

- [ ] Change picker title/copy from generic tag wording to `智能标签`.
- [ ] Button rows should communicate move state: checked means already in tag; toggling prompts “为什么要移出…”, unchecked prompts “为什么要移入…”.
- [ ] After apply/remove, invalidate `["emails"]`, `["list-categories"]`, `["user-tags"]` where applicable, plus message intelligence detail.
- [ ] Keep optional reason behavior.

### Task 5: Verification

**Files:**
- No source files unless failures require focused fixes.

**Commands:**
- `node --import tsx --test server/api/routes/intelligenceRoutes.test.ts server/wemail/intelligence/SmartTagPromptLearningService.test.ts`
- `npm exec vitest -- run app/routes/_workbench.test.tsx app/routes/onboarding.test.tsx`
- `npm run typecheck`
- `git diff --check`

- [ ] Run all commands.
- [ ] Fix failures without reverting unrelated onboarding edits.
- [ ] Report remaining risk and whether the app needs rebuild/restart.

## Self-Review

- Spec coverage: sidebar, create visibility, route filtering, delete cleanup, mail detail move-in/out, management shell, and tests are covered.
- Placeholder scan: no TODO/TBD placeholders are used.
- Type consistency: route uses `tag.id`, filtering uses existing `category` param with `tag.name`, delete cleanup uses `accountId + tagName`.
