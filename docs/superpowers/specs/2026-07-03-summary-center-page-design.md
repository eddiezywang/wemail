# Summary Center Page Design

## Purpose

Replace the current right-side digest drawer with a dedicated Summary Center page that sits at the same navigation level as Action Center. The page should make summary generation observable and controllable: users can scroll through large failure sets, filter by state and reason, retry in bulk or per item, inspect diagnostics, and still read generated digest history.

The existing drawer fails this workflow because it compresses operational controls, task rows, and digest reading into a narrow 520px modal. The data capabilities already exist, but the container and information architecture do not support high-volume recovery cases such as 1026 failed summary jobs.

## Current Context

- Primary navigation is defined in `app/components/Sidebar.tsx`.
- Action Center is a first-level route at `/actions`, implemented as a thin route over `WorkbenchShell`.
- `ActionCenterFeed` uses `PageFrame` for a formal page surface inside the workbench list slot.
- The current digest UI lives in `app/components/wemail/MailDigestCenter.tsx` as a Radix dialog drawer.
- Summary health data already supports totals, query, state filtering, retryable item lists, item diagnostics, and per-item job metadata through `useSummaryHealth`.
- Retry operations already exist through `useRetryAllSummaries`, including selected `emailIds`.
- Digest history already exists through `useDigestList`, `useLatestDigest`, and `useGenerateDigest`.

## Goals

- Add a first-level Summary Center entry beside Action Center.
- Make summary tasks scrollable and filterable at large volume.
- Separate three mental models:
  - operational generation task recovery,
  - digest history reading,
  - digest rules/settings.
- Preserve fast entry from inbox banners, but route users to the Summary Center instead of opening a drawer.
- Allow source mail inspection in the existing right detail pane.
- Keep implementation scoped to existing digest and summary-health APIs where possible.

## Non-Goals

- Redesign the entire Action Center.
- Merge Summary Center into Action Center.
- Add a new backend queue system.
- Add cross-account digest management.
- Replace per-email `EmailIntelligenceCard` summary display.
- Build advanced analytics beyond the task health and history required for recovery.

## Navigation

Add a new primary nav item in `Sidebar`:

- Label: `摘要中心`
- Route: `/digests`
- Icon: article/document style, matching current Phosphor icon usage.
- Optional count badge: current retryable count from summary health if cheaply available; otherwise omit for the first implementation.

The route should be a peer of:

- `/actions` Action Center,
- `/todos` Todos,
- `/workspace` Workspace.

Inbox banners and email-level summary error CTAs should navigate to `/digests`, optionally with query params that preselect filters:

- `/digests?tab=tasks&state=failed`
- `/digests?tab=tasks&emailId=<id>`
- `/digests?tab=history&kind=daily`

## Route Structure

Add `app/routes/digests.tsx`.

Use the same shell pattern as Action Center:

```tsx
export default function DigestsRoute() {
  return (
    <WorkbenchShell
      list={<SummaryCenterPage />}
      detail={<MessageDetailView />}
    />
  );
}
```

The `detail` slot remains the standard mail detail pane. Clicking a task row's `打开邮件` action should select that email through the existing UI store/navigation behavior, so source content can be inspected without leaving the center.

## Page Layout

`SummaryCenterPage` should use `PageFrame` as the outer formal page shell.

Header:

- Title: `摘要中心`
- Subtitle: `管理单封邮件摘要生成任务，查看汇总摘要历史，并集中处理失败、未生成和空内容。`
- Actions:
  - `刷新状态`
  - `全量重试` when retryable count > 0
  - optional `暂停队列` only if a real pause control exists; otherwise do not render it.

Header metrics:

- Total emails in scope.
- Succeeded.
- Failed.
- Missing.
- Invalid or empty.
- Pending + running.
- Retryable.

Tabs:

- `生成任务`
- `汇总摘要`
- `规则与设置`
- `运行日志` only if useful data exists; otherwise defer.

The page root should be `h-full overflow-hidden`. Each major pane owns its scroll:

- Filter rail: vertical scroll.
- Task table: vertical and horizontal scroll, sticky table header.
- Task inspector: vertical scroll.
- Digest history tab: vertical scroll.

## Generate Tasks Tab

This is the default tab when summary health has retryable work.

### Information Architecture

Use a three-pane layout inside the page content:

- Left filter rail.
- Center task table.
- Right task inspector.

On narrower widths, collapse the inspector below the selected row or hide it behind a details drawer. Do not return to the old right-edge global drawer.

### Filter Rail

Filters should map to existing `SummaryHealthFilters` first.

Initial implementation:

- Search query.
- State filter:
  - all,
  - failed,
  - missing,
  - invalid,
  - pending,
  - running,
  - succeeded,
  - skipped.

Recommended next extension:

- Failure source/reason, derived from `diagnostic.errorCode` or `error`.
- Scope:
  - current folder,
  - all inbox scope if backend supports it,
  - current view.
- Date range if backend supports it.

Keep unsupported filters visually absent, not disabled placeholders.

### Toolbar

The table toolbar contains:

- Search input.
- State select or segmented status control.
- Sort select:
  - updated time desc,
  - received time desc,
  - attempts desc,
  - state priority.
- `导出诊断` only if implemented; otherwise defer.

Search updates should use debounced state before calling `useSummaryHealth` to avoid request churn while typing.

### Task Table

Columns:

- Checkbox.
- Mail subject and sender.
- State.
- Attempts.
- Error code or reason.
- Updated time.
- Actions.

Row behavior:

- Click row selects it and updates the inspector.
- Checkbox selects for batch retry.
- `重试` retries one retryable item by calling `onRetrySelectedSummaries([emailId])`.
- `打开邮件` selects/navigates to source mail for the right detail pane.

For large result sets, the table needs pagination or capped server results. If `useSummaryHealth` currently returns only a bounded `items` list, expose a clear count label such as `显示前 100 条，共 1026 条需处理`. If it can return all 1026, table virtualization should be considered before rendering every row.

### Bulk Action Bar

The bulk action bar is sticky at the bottom of the task pane and appears only when selected count > 0.

Actions:

- Clear selection.
- Retry selected.
- Retry selected failed only, if mixed states are selected.

Selection state should survive filter changes only for visible same-scope items. If account or scope changes, clear selection.

### Task Inspector

The inspector shows selected task details:

- Mail subject.
- Sender.
- Email ID.
- Received time.
- State.
- Error source.
- Error code.
- Error message.
- Job ID.
- Job status.
- Attempts and max attempts.
- Created, started, finished, updated timestamps when present.
- Per-item retry action.
- Open source mail action.

The inspector should show a neutral empty state when no row is selected.

## Digest History Tab

This tab replaces the digest-reading part of the current drawer.

Sections:

- Daily digests, recent 7 by default.
- Manual digest for current scope.
- Inactivity digest.

Controls:

- Kind filter: all/daily/manual/inactivity.
- Scope label.
- Generate current scope manual digest.
- Regenerate manual digest when a manual digest exists.

Reuse `DigestDetails`, `DailyDigestList`, and digest formatting logic from `MailDigestCenter`, but move them into smaller reusable components rather than keeping them nested in the drawer component.

Recommended extraction:

- `DigestDetails.tsx`
- `DigestHistoryList.tsx`
- `DigestEmptyState.tsx`

## Rules And Settings Tab

This tab should not duplicate all of `AiSummarySection` initially.

First implementation:

- Show current summary settings read-only:
  - manual enabled,
  - manual window hours,
  - inactivity prompt enabled and threshold,
  - daily enabled and time,
  - daily window mode.
- Provide `打开 AI 摘要设置`, which opens Settings Dialog at `ai-summary`.

Later implementation may inline settings editing if users expect this center to be the primary place to manage summary behavior.

## Existing Drawer Migration

`MailDigestCenter` should stop being the primary experience.

Recommended migration:

1. Extract reusable digest history components from `MailDigestCenter`.
2. Create `SummaryCenterPage` for the new route.
3. Replace inbox banner's `摘要中心` action with navigation to `/digests`.
4. Keep `MailDigestCenter` temporarily only if tests or narrow entry points still require it.
5. Remove the drawer once the new route covers history and task management.

The banner should remain compact:

- Failure state: show inline failed/missing/invalid counts and a `摘要中心` navigation CTA.
- Ready state: show generated count and `摘要中心` navigation CTA.
- Available state: keep `生成摘要` action.

## Data Flow

Task health:

- `useSummaryHealth(accountId, scope, enabled, { query, state })`
- Refetch every 5 seconds only when `pending + running > 0`.
- Manual refresh invalidates the summary-health key.

Retry:

- All retry: `useRetryAllSummaries(accountId, scope).mutate()`
- Selected retry: `mutate({ emailIds })`
- Single retry: same selected retry path with one ID.

Digest history:

- Daily list: `useDigestList(accountId, scope, "daily", 7)`
- Manual latest: `useLatestDigest(accountId, scope, "manual")`
- Inactivity latest: `useLatestDigest(accountId, scope, "inactivity")`
- Generate manual: `useGenerateDigest(accountId, scope).mutate({ kind: "manual" })`

Settings:

- `useDigestSettings()`
- Existing settings dialog opened through `useUIStore().openSettings("ai-summary")`.

## Component Plan

New components:

- `app/components/digests/SummaryCenterPage.tsx`
- `app/components/digests/SummaryHealthMetrics.tsx`
- `app/components/digests/SummaryTaskFilters.tsx`
- `app/components/digests/SummaryTaskTable.tsx`
- `app/components/digests/SummaryBulkActionBar.tsx`
- `app/components/digests/SummaryTaskInspector.tsx`
- `app/components/digests/DigestHistoryTab.tsx`
- `app/components/digests/SummarySettingsTab.tsx`

Refactored/reused components:

- Extract digest display helpers from `MailDigestCenter`.
- Reuse `PageFrame`.
- Reuse `EmptyState`.
- Reuse existing UI `Button`, `Tabs`, and form controls.

Avoid one giant component. The current `MailDigestCenter` mixes shell, health management, task rows, diagnostics, digest history, and formatting helpers. The new page should keep each pane independently testable.

## Error Handling

- No account: `WorkbenchShell` already redirects to onboarding.
- Summary health loading: show a table skeleton and disabled metrics.
- Summary health error: show a recoverable `EmptyState` with retry.
- Retry mutation failure: toast error and keep current selection.
- Retry mutation success: toast queued/reset count and invalidate health/status/intelligence keys.
- No matching task rows: show an empty state inside table area, not a blank panel.
- No selected task: inspector shows "选择一封邮件查看摘要任务详情".
- Digest history empty: show per-kind empty states and manual generation CTA where valid.

## Accessibility

- Tabs must use the existing accessible `Tabs` component.
- Task table checkboxes need labels containing the subject.
- Row selection should not rely only on color.
- Bulk retry buttons must include selected count in the accessible name.
- Inspector headings should be semantic.
- Filter controls need visible labels or `aria-label`.

## Testing

Frontend tests:

- `/digests` route renders Summary Center in `WorkbenchShell`.
- Sidebar contains Summary Center nav and marks it active on `/digests`.
- Task metrics render summary health counts.
- Query input and state filter update `useSummaryHealth` filters.
- Task table renders failed, missing, invalid, pending, running, and succeeded labels.
- Selecting rows enables bulk retry and calls retry mutation with selected IDs.
- Per-row retry calls retry mutation with one ID.
- Selecting a row shows inspector diagnostics.
- `打开邮件` selects/navigates to the source email.
- Digest history tab renders recent daily digests and manual regenerate CTA.
- Settings tab opens Settings Dialog at `ai-summary`.
- Inbox banner navigates to `/digests` instead of opening the drawer.

Backend tests:

- No new backend tests are required for the first implementation if existing endpoints remain unchanged.
- Add backend tests only if new summary-health filters, pagination, or diagnostic export endpoints are introduced.

Visual/e2e tests:

- A browser test should verify that a large task list scrolls inside the page without moving the entire workbench shell.
- Verify sticky table header and bottom bulk action bar remain visible during scroll.
- Verify filtering from failed to missing updates rows without losing page structure.

## Rollout

Phase 1:

- Add route, sidebar nav, Summary Center task tab, digest history tab, and banner navigation.
- Reuse existing health and digest APIs.
- Keep drawer component in place but no longer use it from the main banner.

Phase 2:

- Add richer filters if backend supports them.
- Add pagination or virtualization if real health item counts exceed a safe render threshold.
- Consider inlining summary settings edits after usage feedback.

Phase 3:

- Remove obsolete drawer and tests once all entry points use the page.

## Open Questions

- Should `/digests` default to current folder scope, account-wide inbox scope, or remember the last selected scope?
- Does `summaryHealth.items` return a bounded list today? If so, the UI must disclose the visible limit.
- Should Summary Center nav show retryable count, or should counts remain inside the page to avoid sidebar query fan-out?
- Is there an existing source-mail selection helper that works outside `MessageListView`, or do we need a small shared helper for `打开邮件`?

