# Summary Center Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-level `/digests` Summary Center page that replaces the current right-side digest drawer as the primary place for summary task recovery, digest history, and summary settings entry.

**Architecture:** Add a new route that mirrors Action Center: `WorkbenchShell` hosts a formal `SummaryCenterPage` in the list slot and the standard `MessageDetailView` in the detail slot. The page is split into focused digest components: health metrics, filters, task table, bulk action bar, inspector, history tab, and settings tab. Existing digest and summary-health React Query hooks remain the data boundary; backend changes are deferred unless pagination or richer filters become necessary.

**Tech Stack:** React 19, React Router route config in `app/routes.ts`, TanStack Query, Zustand `useUIStore`, Vitest + Testing Library, Phosphor icons, existing WeMail UI primitives and Tailwind utility classes.

---

## Preconditions

- Work in a clean dedicated worktree before implementation. The current main working tree has unrelated staged edits and unresolved merge files, so do not implement this plan directly there.
- Read the design spec first: `docs/superpowers/specs/2026-07-03-summary-center-page-design.md`.
- Follow repo style: TypeScript/TSX, 2-space indentation, double quotes, semicolons.
- Use TDD for each task: write the failing test, run it, implement the smallest code, rerun.

## File Structure

Create:

- `app/routes/digests.tsx`: thin route shell, same pattern as `app/routes/actions.tsx`.
- `app/components/digests/SummaryCenterPage.tsx`: top-level page composition and tab state.
- `app/components/digests/SummaryHealthMetrics.tsx`: metric strip for health counts.
- `app/components/digests/SummaryTaskFilters.tsx`: search and state filters.
- `app/components/digests/SummaryTaskTable.tsx`: scrollable task table and row selection.
- `app/components/digests/SummaryBulkActionBar.tsx`: sticky selected-row actions.
- `app/components/digests/SummaryTaskInspector.tsx`: selected task diagnostics and open-mail action.
- `app/components/digests/DigestDetails.tsx`: extracted digest detail rendering from `MailDigestCenter`.
- `app/components/digests/DigestHistoryTab.tsx`: digest history and manual generation controls.
- `app/components/digests/SummarySettingsTab.tsx`: read-only summary settings and Settings shortcut.
- `app/components/digests/SummaryCenterPage.test.tsx`: component tests for the new page.
- `app/routes/digests.test.tsx`: route shell smoke test if needed.
- `app/components/Sidebar.test.tsx`: primary navigation test coverage.

Modify:

- `app/routes.ts`: register `route("digests", "routes/digests.tsx")`.
- `app/components/Sidebar.tsx`: add Summary Center nav item.
- `app/components/wemail/MailDigestBanner.tsx`: keep prop name but call a navigation handler supplied by workbench.
- `app/routes/_workbench.tsx`: replace drawer opening with navigation to `/digests`; remove `MailDigestCenter` usage from the inbox list path when the new page covers it.
- `app/components/wemail/MailDigestCenter.tsx`: leave in place initially, but extract shared digest rendering helpers into `app/components/digests/DigestDetails.tsx`.
- Existing tests for `MailDigestBanner`, `_workbench`, and `MailDigestCenter`: update expectations around “摘要中心” opening route/page instead of drawer where applicable.

Avoid backend files in Phase 1.

## Task 1: Add `/digests` Route And Sidebar Entry

**Files:**

- Create: `app/routes/digests.tsx`
- Modify: `app/routes.ts`
- Modify: `app/components/Sidebar.tsx`
- Create: `app/components/Sidebar.test.tsx`

- [ ] **Step 1: Write failing Sidebar test**

Add `app/components/Sidebar.test.tsx` with mocks for mailbox/folder queries and UI store actions. Test that `/digests` renders a primary nav link labeled `摘要中心` and marks it active.

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

vi.mock("~/queries/currentAccount", () => ({
  useCurrentAccount: () => ({ data: { account: { id: "acct-1" } } }),
}));
vi.mock("~/queries/folders", () => ({
  useFolders: () => ({ data: [{ id: "INBOX", name: "Inbox", unreadCount: 0 }] }),
}));
vi.mock("~/queries/mailboxes", () => ({
  useMailbox: () => ({ data: { name: "Eddie", email: "eddie@example.test", settings: {} } }),
}));
vi.mock("~/queries/snooze", () => ({ useSnoozedMessages: () => ({ data: { messages: [] } }) }));
vi.mock("~/queries/scheduledDrafts", () => ({ useScheduledDrafts: () => ({ data: { scheduled: [] } }) }));
vi.mock("~/queries/userTags", () => ({ useUserTags: () => ({ data: [] }) }));

describe("Sidebar", () => {
  it("renders Summary Center as an active primary nav item", () => {
    render(
      <MemoryRouter initialEntries={["/digests"]}>
        <Sidebar />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: /摘要中心/ });
    expect(link).toHaveAttribute("href", "/digests");
    expect(link).toHaveAttribute("data-folder", "digests");
    expect(link.className).toMatch(/text-coral/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/components/Sidebar.test.tsx
```

Expected: FAIL because `摘要中心` does not exist.

- [ ] **Step 3: Add Sidebar nav item**

In `app/components/Sidebar.tsx`, import `ArticleIcon` or another existing document icon from Phosphor and insert the nav item between Action Center and Workspace:

```tsx
<NavLink
  to="/digests"
  icon={<ArticleIcon size={18} weight="regular" />}
  label="摘要中心"
  onClick={handleNavClick}
  data-folder="digests"
/>
```

- [ ] **Step 4: Add route registration and route file**

In `app/routes.ts`, add:

```ts
route("digests", "routes/digests.tsx"),
```

after the Action Center route.

Create `app/routes/digests.tsx`:

```tsx
import { SummaryCenterPage } from "~/components/digests/SummaryCenterPage";
import { MessageDetailView, WorkbenchShell } from "./_workbench";

export function meta() {
  return [{ title: "摘要中心 / Summary Center" }];
}

export default function DigestsRoute() {
  return (
    <WorkbenchShell list={<SummaryCenterPage />} detail={<MessageDetailView />} />
  );
}
```

Temporarily create `SummaryCenterPage` with a placeholder export if Task 2 is not implemented yet.

- [ ] **Step 5: Run route/sidebar tests**

Run:

```bash
npx vitest run app/components/Sidebar.test.tsx
npm run typecheck
```

Expected: Sidebar test PASS. Typecheck may fail until `SummaryCenterPage` exists; if so, complete the placeholder export before rerunning.

- [ ] **Step 6: Commit**

```bash
git add app/routes.ts app/routes/digests.tsx app/components/Sidebar.tsx app/components/Sidebar.test.tsx app/components/digests/SummaryCenterPage.tsx
git commit -m "feat: add summary center route"
```

## Task 2: Build Summary Center Page Skeleton And Health Metrics

**Files:**

- Create/Modify: `app/components/digests/SummaryCenterPage.tsx`
- Create: `app/components/digests/SummaryHealthMetrics.tsx`
- Create/Modify: `app/components/digests/SummaryCenterPage.test.tsx`

- [ ] **Step 1: Write failing page render test**

Mock account and digest hooks. Verify title, subtitle, tabs, and health metrics render.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SummaryCenterPage } from "./SummaryCenterPage";

vi.mock("~/queries/currentAccount", () => ({
  useCurrentAccount: () => ({ data: { account: { id: "acct-1" } }, isLoading: false }),
}));

vi.mock("~/queries/digests", async () => {
  const actual = await vi.importActual<typeof import("~/queries/digests")>("~/queries/digests");
  return {
    ...actual,
    useSummaryHealth: () => ({
      isLoading: false,
      isError: false,
      data: {
        total: 2842,
        succeeded: 1774,
        failed: 1026,
        missing: 18,
        invalid: 20,
        pending: 18,
        running: 4,
        skipped: 0,
        retryable: 1064,
        items: [],
      },
      refetch: vi.fn(),
    }),
    useRetryAllSummaries: () => ({ mutate: vi.fn(), isPending: false }),
    useDigestList: () => ({ data: [], isLoading: false }),
    useLatestDigest: () => ({ data: null, isLoading: false }),
    useGenerateDigest: () => ({ mutate: vi.fn(), isPending: false }),
    useDigestSettings: () => ({ data: null, isLoading: false }),
  };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SummaryCenterPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SummaryCenterPage", () => {
  it("renders page shell, tabs, and health metrics", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "摘要中心" })).toBeInTheDocument();
    expect(screen.getByText("管理单封邮件摘要生成任务，查看汇总摘要历史，并集中处理失败、未生成和空内容。")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "生成任务" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "汇总摘要" })).toBeInTheDocument();
    expect(screen.getByText("1026")).toBeInTheDocument();
    expect(screen.getByText("1064")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx
```

Expected: FAIL because page/components do not exist.

- [ ] **Step 3: Implement `SummaryHealthMetrics`**

Create `app/components/digests/SummaryHealthMetrics.tsx`:

```tsx
import type { SummaryHealthStatus } from "shared/wemail/intelligence";

interface Metric {
  label: string;
  value: number;
  tone?: "default" | "danger" | "warning" | "success";
}

export function SummaryHealthMetrics({ health }: { health?: SummaryHealthStatus }) {
  const metrics: Metric[] = [
    { label: "总邮件", value: health?.total ?? 0 },
    { label: "已完成", value: health?.succeeded ?? 0, tone: "success" },
    { label: "失败", value: health?.failed ?? 0, tone: "danger" },
    { label: "未生成", value: health?.missing ?? 0, tone: "warning" },
    { label: "空/无效", value: health?.invalid ?? 0, tone: "warning" },
    { label: "可重试", value: health?.retryable ?? 0, tone: "danger" },
  ];

  return (
    <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6" data-testid="summary-health-metrics">
      {metrics.map((metric) => (
        <div key={metric.label} className="rounded-md border border-edge bg-paper px-3 py-2">
          <div className="text-[11px] font-medium text-ink-3">{metric.label}</div>
          <div className={metricValueClass(metric.tone)}>{metric.value}</div>
        </div>
      ))}
    </div>
  );
}

function metricValueClass(tone: Metric["tone"]) {
  const base = "mt-1 text-xl font-semibold leading-none";
  if (tone === "danger") return `${base} text-red`;
  if (tone === "warning") return `${base} text-amber`;
  if (tone === "success") return `${base} text-green`;
  return `${base} text-ink`;
}
```

- [ ] **Step 4: Implement `SummaryCenterPage` shell**

Use `PageFrame`, existing `Tabs`, and `useCurrentAccount`.

```tsx
import { ArticleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import EmptyState from "~/components/wemail/EmptyState";
import PageFrame from "~/components/wemail/PageFrame";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useRetryAllSummaries, useSummaryHealth } from "~/queries/digests";
import { SummaryHealthMetrics } from "./SummaryHealthMetrics";

type SummaryCenterTab = "tasks" | "history" | "settings";

export function SummaryCenterPage() {
  const { data: currentAccount } = useCurrentAccount();
  const accountId = currentAccount?.account?.id;
  const [tab, setTab] = useState<SummaryCenterTab>("tasks");
  const summaryHealth = useSummaryHealth(accountId, undefined, !!accountId, {
    state: "all",
    query: "",
  });
  const retryAll = useRetryAllSummaries(accountId);
  const health = summaryHealth.data;

  return (
    <PageFrame
      title="摘要中心"
      subtitle="管理单封邮件摘要生成任务，查看汇总摘要历史，并集中处理失败、未生成和空内容。"
      testId="summary-center-page"
      contentClassName="overflow-hidden"
      actions={
        <>
          <Button type="button" size="sm" variant="secondary" onClick={() => summaryHealth.refetch()}>
            刷新状态
          </Button>
          {health && health.retryable > 0 ? (
            <Button type="button" size="sm" onClick={() => retryAll.mutate()} disabled={retryAll.isPending}>
              全量重试 {health.retryable}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        <SummaryHealthMetrics health={health} />
        <Tabs value={tab} onValueChange={(value) => setTab(value as SummaryCenterTab)} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="h-10 w-fit">
            <TabsTrigger value="tasks">生成任务</TabsTrigger>
            <TabsTrigger value="history">汇总摘要</TabsTrigger>
            <TabsTrigger value="settings">规则与设置</TabsTrigger>
          </TabsList>
          <TabsContent value="tasks" className="min-h-0 flex-1">
            <EmptyState
              icon={<ArticleIcon size={22} weight="regular" />}
              title="生成任务"
              description="任务表格将在下一步接入。"
            />
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1">
            <EmptyState
              icon={<ArticleIcon size={22} weight="regular" />}
              title="汇总摘要"
              description="摘要历史将在后续任务接入。"
            />
          </TabsContent>
          <TabsContent value="settings" className="min-h-0 flex-1">
            <EmptyState
              icon={<ArticleIcon size={22} weight="regular" />}
              title="规则与设置"
              description="摘要设置入口将在后续任务接入。"
            />
          </TabsContent>
        </Tabs>
      </div>
    </PageFrame>
  );
}

export default SummaryCenterPage;
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/digests/SummaryCenterPage.tsx app/components/digests/SummaryHealthMetrics.tsx app/components/digests/SummaryCenterPage.test.tsx
git commit -m "feat: add summary center shell"
```

## Task 3: Add Task Filters And Query State

**Files:**

- Modify: `app/components/digests/SummaryCenterPage.tsx`
- Create: `app/components/digests/SummaryTaskFilters.tsx`
- Modify: `app/components/digests/SummaryCenterPage.test.tsx`

- [ ] **Step 1: Write failing filter test**

Update the digest hook mock to capture filters and test typing/selecting:

```tsx
const useSummaryHealthMock = vi.fn();

vi.mock("~/queries/digests", async () => {
  const actual = await vi.importActual<typeof import("~/queries/digests")>("~/queries/digests");
  return {
    ...actual,
    useSummaryHealth: (...args: unknown[]) => useSummaryHealthMock(...args),
    // other mocks...
  };
});

it("updates summary health filters from search and state controls", async () => {
  const user = userEvent.setup();
  useSummaryHealthMock.mockReturnValue(makeHealthQuery());
  renderPage();

  await user.type(screen.getByRole("searchbox", { name: "搜索摘要任务" }), "EHR");
  await user.selectOptions(screen.getByRole("combobox", { name: "摘要任务状态" }), "failed");

  expect(useSummaryHealthMock).toHaveBeenLastCalledWith(
    "acct-1",
    undefined,
    true,
    expect.objectContaining({ query: "EHR", state: "failed" }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx -t "updates summary health filters"
```

Expected: FAIL because controls do not exist.

- [ ] **Step 3: Implement `SummaryTaskFilters`**

```tsx
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { SummaryWorkState } from "shared/wemail/intelligence";

export type SummaryStateFilter = SummaryWorkState | "all";

export function SummaryTaskFilters({
  query,
  state,
  onQueryChange,
  onStateChange,
}: {
  query: string;
  state: SummaryStateFilter;
  onQueryChange: (query: string) => void;
  onStateChange: (state: SummaryStateFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-paper-2 px-3 py-3">
      <label className="relative min-w-[220px] flex-1">
        <MagnifyingGlassIcon size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="search"
          aria-label="搜索摘要任务"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="搜索主题、发件人或错误内容"
          className="h-9 w-full rounded-md border border-edge bg-paper pl-8 pr-3 text-sm text-ink outline-none focus:border-coral"
        />
      </label>
      <select
        aria-label="摘要任务状态"
        value={state}
        onChange={(event) => onStateChange(event.currentTarget.value as SummaryStateFilter)}
        className="h-9 rounded-md border border-edge bg-paper px-2 text-sm text-ink outline-none focus:border-coral"
      >
        <option value="all">全部状态</option>
        <option value="failed">失败</option>
        <option value="missing">未生成</option>
        <option value="invalid">无效</option>
        <option value="pending">排队中</option>
        <option value="running">生成中</option>
        <option value="succeeded">已完成</option>
        <option value="skipped">已跳过</option>
      </select>
    </div>
  );
}
```

- [ ] **Step 4: Wire filter state into `SummaryCenterPage`**

Add:

```tsx
const [summaryQuery, setSummaryQuery] = useState("");
const [summaryStateFilter, setSummaryStateFilter] = useState<SummaryStateFilter>("all");
```

Pass:

```tsx
useSummaryHealth(accountId, undefined, !!accountId, {
  query: summaryQuery,
  state: summaryStateFilter,
});
```

Render `SummaryTaskFilters` in the tasks tab.

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/digests/SummaryCenterPage.tsx app/components/digests/SummaryTaskFilters.tsx app/components/digests/SummaryCenterPage.test.tsx
git commit -m "feat: filter summary tasks"
```

## Task 4: Add Task Table, Selection, And Bulk Retry

**Files:**

- Create: `app/components/digests/SummaryTaskTable.tsx`
- Create: `app/components/digests/SummaryBulkActionBar.tsx`
- Modify: `app/components/digests/SummaryCenterPage.tsx`
- Modify: `app/components/digests/SummaryCenterPage.test.tsx`

- [ ] **Step 1: Write failing table and bulk retry tests**

Use mock health items with failed/missing/running states. Test rows render, checkbox selection enables `重试选中 2`, and mutation receives selected IDs.

```tsx
it("selects retryable summary tasks and retries selected ids", async () => {
  const user = userEvent.setup();
  const retryMutate = vi.fn();
  mockDigestHooks({
    health: makeHealth({
      items: [
        makeHealthItem({ emailId: "email-1", subject: "EHR系统验证码", state: "failed" }),
        makeHealthItem({ emailId: "email-2", subject: "绩效管理", state: "missing" }),
      ],
    }),
    retryMutate,
  });

  renderPage();

  await user.click(screen.getByRole("checkbox", { name: "选择 EHR系统验证码" }));
  await user.click(screen.getByRole("checkbox", { name: "选择 绩效管理" }));
  await user.click(screen.getByRole("button", { name: "重试选中 2" }));

  expect(retryMutate).toHaveBeenCalledWith({ emailIds: ["email-1", "email-2"] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx -t "selects retryable"
```

Expected: FAIL because table and bulk action do not exist.

- [ ] **Step 3: Implement state label helpers**

In `SummaryTaskTable.tsx`, include local helpers copied from `MailDigestCenter`:

```tsx
function getSummaryStateLabel(state: SummaryWorkState) {
  switch (state) {
    case "succeeded": return "已完成";
    case "failed": return "失败";
    case "missing": return "未生成";
    case "invalid": return "无效";
    case "pending": return "排队中";
    case "running": return "生成中";
    case "skipped": return "已跳过";
    default: return "未知";
  }
}

function isSummaryItemRetryable(item: SummaryHealthItem) {
  return ["failed", "missing", "invalid", "pending", "running"].includes(item.state);
}
```

- [ ] **Step 4: Implement `SummaryTaskTable`**

Render a `table` with sticky header inside a scroll container:

```tsx
export function SummaryTaskTable({
  items,
  selectedIds,
  activeEmailId,
  onToggleSelected,
  onSelectItem,
  onRetryOne,
}: {
  items: SummaryHealthItem[];
  selectedIds: Set<string>;
  activeEmailId: string | null;
  onToggleSelected: (emailId: string, selected: boolean) => void;
  onSelectItem: (item: SummaryHealthItem) => void;
  onRetryOne: (emailId: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-sm text-ink-3">
        没有匹配的摘要任务
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-16" data-testid="summary-task-table-scroll">
      <table className="w-full min-w-[760px] border-separate border-spacing-y-2 text-sm">
        <thead className="sticky top-0 z-10 bg-paper-2 text-xs text-ink-3">
          <tr>
            <th className="w-10 py-2 text-left">选择</th>
            <th className="py-2 text-left">邮件</th>
            <th className="py-2 text-left">状态</th>
            <th className="py-2 text-left">尝试</th>
            <th className="py-2 text-left">错误</th>
            <th className="py-2 text-left">更新</th>
            <th className="py-2 text-left">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const retryable = isSummaryItemRetryable(item);
            return (
              <tr
                key={item.emailId}
                data-testid="summary-task-row"
                data-state={item.state}
                className={activeEmailId === item.emailId ? "bg-paper ring-2 ring-coral" : "bg-paper"}
                onClick={() => onSelectItem(item)}
              >
                <td className="rounded-l-md border-y border-l border-edge px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${item.subject}`}
                    checked={selectedIds.has(item.emailId)}
                    disabled={!retryable}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onToggleSelected(item.emailId, event.currentTarget.checked)}
                    className="accent-coral"
                  />
                </td>
                <td className="border-y border-edge px-2 py-2">
                  <div className="max-w-[280px] truncate font-semibold text-ink">{item.subject}</div>
                  <div className="max-w-[280px] truncate text-xs text-ink-3">{item.sender}</div>
                </td>
                <td className="border-y border-edge px-2 py-2">{getSummaryStateLabel(item.state)}</td>
                <td className="border-y border-edge px-2 py-2">
                  {item.job ? `${item.job.attempts}/${item.job.maxAttempts}` : "-"}
                </td>
                <td className="border-y border-edge px-2 py-2">
                  <div className="max-w-[220px] truncate text-xs text-ink-3">
                    {item.diagnostic?.errorCode ?? item.error ?? "-"}
                  </div>
                </td>
                <td className="border-y border-edge px-2 py-2 text-xs text-ink-3">
                  {item.job?.updatedAt ? formatDateTime(item.job.updatedAt) : formatDateTime(item.receivedAt)}
                </td>
                <td className="rounded-r-md border-y border-r border-edge px-2 py-2">
                  {retryable ? (
                    <button
                      type="button"
                      aria-label={`重试此摘要：${item.subject}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRetryOne(item.emailId);
                      }}
                      className="text-xs font-semibold text-coral hover:underline"
                    >
                      重试
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Implement `SummaryBulkActionBar`**

```tsx
import { Button } from "~/components/ui/button";

export function SummaryBulkActionBar({
  selectedCount,
  isRetrying,
  onClear,
  onRetry,
}: {
  selectedCount: number;
  isRetrying: boolean;
  onClear: () => void;
  onRetry: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="absolute bottom-0 left-0 right-0 flex h-14 items-center justify-between border-t border-edge bg-paper px-4 shadow-[0_-8px_18px_rgba(0,0,0,0.06)]">
      <div className="text-sm text-ink">
        已选 <strong>{selectedCount}</strong> 封可重试邮件
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          清空选择
        </Button>
        <Button type="button" size="sm" onClick={onRetry} disabled={isRetrying}>
          {`重试选中 ${selectedCount}`}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire table state into page**

In `SummaryCenterPage`, track:

```tsx
const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());
const [selectedTask, setSelectedTask] = useState<SummaryHealthItem | null>(null);
```

Clear selection when `health` changes:

```tsx
useEffect(() => {
  setSelectedTaskIds(new Set());
  setSelectedTask(null);
}, [health]);
```

Call retry mutation:

```tsx
const retrySelected = () => retryAll.mutate({ emailIds: [...selectedTaskIds] });
const retryOne = (emailId: string) => retryAll.mutate({ emailIds: [emailId] });
```

- [ ] **Step 7: Run tests**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/components/digests/SummaryCenterPage.tsx app/components/digests/SummaryTaskTable.tsx app/components/digests/SummaryBulkActionBar.tsx app/components/digests/SummaryCenterPage.test.tsx
git commit -m "feat: manage summary task retries"
```

## Task 5: Add Task Inspector And Open Source Mail

**Files:**

- Create: `app/components/digests/SummaryTaskInspector.tsx`
- Modify: `app/components/digests/SummaryCenterPage.tsx`
- Modify: `app/components/digests/SummaryCenterPage.test.tsx`

- [ ] **Step 1: Write failing inspector test**

Test row click shows diagnostics and `打开邮件` calls `useUIStore().selectEmail`.

```tsx
const selectEmailMock = vi.fn();

vi.mock("~/hooks/useUIStore", () => ({
  useUIStore: () => ({ selectEmail: selectEmailMock, openSettings: vi.fn() }),
}));

it("shows selected task diagnostics and opens source mail", async () => {
  const user = userEvent.setup();
  selectEmailMock.mockClear();
  mockDigestHooks({
    health: makeHealth({
      items: [
        makeHealthItem({
          emailId: "email-1",
          subject: "EHR系统验证码",
          state: "failed",
          diagnostic: {
            source: "job",
            errorCode: "model-credential-cooldown",
            errorMessage: "All credentials are cooling down",
            updatedAt: "2026-07-03T06:57:00.000Z",
          },
        }),
      ],
    }),
  });

  renderPage();

  await user.click(screen.getByText("EHR系统验证码"));
  expect(screen.getByText("model-credential-cooldown")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "打开邮件" }));
  expect(selectEmailMock).toHaveBeenCalledWith("email-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx -t "opens source mail"
```

Expected: FAIL because inspector does not exist.

- [ ] **Step 3: Implement `SummaryTaskInspector`**

Create a focused component:

```tsx
import type { SummaryHealthItem } from "shared/wemail/intelligence";
import { Button } from "~/components/ui/button";

export function SummaryTaskInspector({
  item,
  isRetrying,
  onRetry,
  onOpenEmail,
}: {
  item: SummaryHealthItem | null;
  isRetrying: boolean;
  onRetry: (emailId: string) => void;
  onOpenEmail: (emailId: string) => void;
}) {
  if (!item) {
    return (
      <aside className="hidden w-80 shrink-0 border-l border-edge bg-paper px-5 py-6 xl:block">
        <div className="text-sm font-semibold text-ink">任务详情</div>
        <p className="mt-2 text-sm text-ink-3">选择一封邮件查看摘要任务详情。</p>
      </aside>
    );
  }

  return (
    <aside className="hidden min-h-0 w-80 shrink-0 overflow-y-auto border-l border-edge bg-paper px-5 py-5 xl:block" data-testid="summary-task-inspector">
      <h2 className="text-base font-semibold leading-snug text-ink">{item.subject}</h2>
      <p className="mt-1 text-xs text-ink-3">{item.sender}</p>
      <div className="mt-4 flex gap-2">
        <Button type="button" size="sm" onClick={() => onRetry(item.emailId)} disabled={isRetrying}>
          重试此封
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onOpenEmail(item.emailId)}>
          打开邮件
        </Button>
      </div>
      <DetailBlock title="诊断">
        <DetailRow label="邮件 ID" value={item.emailId} />
        <DetailRow label="状态" value={item.state} />
        <DetailRow label="错误来源" value={item.diagnostic?.source ?? "-"} />
        <DetailRow label="错误代码" value={item.diagnostic?.errorCode ?? item.error ?? "-"} />
        <DetailRow label="错误内容" value={item.diagnostic?.errorMessage ?? item.error ?? "-"} />
      </DetailBlock>
      {item.job ? (
        <DetailBlock title="任务">
          <DetailRow label="任务 ID" value={item.job.id} />
          <DetailRow label="任务状态" value={item.job.status} />
          <DetailRow label="尝试次数" value={`${item.job.attempts}/${item.job.maxAttempts}`} />
          <DetailRow label="更新时间" value={item.job.updatedAt} />
        </DetailBlock>
      ) : null}
    </aside>
  );
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-md border border-edge bg-paper-2 px-3 py-3">
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 border-t border-edge-3 py-1 first:border-t-0">
      <span className="text-xs text-ink-3">{label}</span>
      <span className="min-w-0 break-words text-xs text-ink">{value}</span>
    </div>
  );
}
```

- [ ] **Step 4: Wire inspector into page**

Import `useUIStore`:

```tsx
const { selectEmail } = useUIStore();
```

Render task area as:

```tsx
<div className="relative flex min-h-0 flex-1 overflow-hidden rounded-md border border-edge">
  <div className="relative flex min-w-0 flex-1 flex-col">
    <SummaryTaskFilters ... />
    <SummaryTaskTable ... />
    <SummaryBulkActionBar ... />
  </div>
  <SummaryTaskInspector
    item={selectedTask}
    isRetrying={retryAll.isPending}
    onRetry={retryOne}
    onOpenEmail={selectEmail}
  />
</div>
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/digests/SummaryCenterPage.tsx app/components/digests/SummaryTaskInspector.tsx app/components/digests/SummaryCenterPage.test.tsx
git commit -m "feat: inspect summary task diagnostics"
```

## Task 6: Extract Digest Details And Build History Tab

**Files:**

- Create: `app/components/digests/DigestDetails.tsx`
- Create: `app/components/digests/DigestHistoryTab.tsx`
- Modify: `app/components/digests/SummaryCenterPage.tsx`
- Modify: `app/components/wemail/MailDigestCenter.tsx`
- Modify: `app/components/wemail/MailDigestCenter.test.tsx`
- Modify: `app/components/digests/SummaryCenterPage.test.tsx`

- [ ] **Step 1: Write failing history tab test**

Test that daily digest list and manual generate CTA render from mocks.

```tsx
it("renders digest history and can generate current scope manual digest", async () => {
  const user = userEvent.setup();
  const generateMutate = vi.fn();
  mockDigestHooks({
    dailyDigests: [makeDigest({ id: "daily-1", kind: "daily", overview: ["今天有 8 封邮件需要关注"] })],
    manualDigest: null,
    generateMutate,
  });

  renderPage();
  await user.click(screen.getByRole("tab", { name: "汇总摘要" }));

  expect(screen.getByText("今天有 8 封邮件需要关注")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "生成当前范围摘要" }));
  expect(generateMutate).toHaveBeenCalledWith({ kind: "manual" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx -t "renders digest history"
```

Expected: FAIL because history tab is placeholder.

- [ ] **Step 3: Extract `DigestDetails`**

Move digest formatting/rendering from `MailDigestCenter.tsx` into `app/components/digests/DigestDetails.tsx`.

Exports:

```tsx
export function DigestDetails(...)
export function DailyDigestList(...)
export function EmptyDigest(...)
```

Keep behavior and labels identical to current `MailDigestCenter` tests.

- [ ] **Step 4: Update `MailDigestCenter` to import extracted components**

Remove duplicated nested helpers from `MailDigestCenter.tsx` only after tests pass with extracted imports.

- [ ] **Step 5: Implement `DigestHistoryTab`**

Use:

```tsx
useDigestList(accountId, undefined, "daily", 7)
useLatestDigest(accountId, undefined, "manual")
useLatestDigest(accountId, undefined, "inactivity")
useGenerateDigest(accountId)
```

Render kind tabs or simple sections:

- Recent daily digests.
- Manual digest card or generate CTA.
- Inactivity digest card or empty state.

Button labels:

- `生成当前范围摘要`
- `重新生成当前范围摘要`

- [ ] **Step 6: Run tests**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx app/components/wemail/MailDigestCenter.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/components/digests/DigestDetails.tsx app/components/digests/DigestHistoryTab.tsx app/components/digests/SummaryCenterPage.tsx app/components/wemail/MailDigestCenter.tsx app/components/wemail/MailDigestCenter.test.tsx app/components/digests/SummaryCenterPage.test.tsx
git commit -m "feat: show digest history in summary center"
```

## Task 7: Add Settings Tab

**Files:**

- Create: `app/components/digests/SummarySettingsTab.tsx`
- Modify: `app/components/digests/SummaryCenterPage.tsx`
- Modify: `app/components/digests/SummaryCenterPage.test.tsx`

- [ ] **Step 1: Write failing settings tab test**

Test settings values render and button opens Settings Dialog at `ai-summary`.

```tsx
const openSettingsMock = vi.fn();

function mockUIStore(overrides: { openSettings?: typeof openSettingsMock } = {}) {
  openSettingsMock.mockClear();
  vi.mocked(useUIStore).mockReturnValue({
    selectEmail: vi.fn(),
    openSettings: overrides.openSettings ?? openSettingsMock,
  } as unknown as ReturnType<typeof useUIStore>);
}

it("renders summary settings and opens AI summary settings", async () => {
  const user = userEvent.setup();
  const openSettings = vi.fn();
  mockUIStore({ openSettings });
  mockDigestHooks({
    settings: {
      manualEnabled: true,
      manualWindowHours: 8,
      inactivityEnabled: true,
      inactivityHours: 8,
      dailyEnabled: false,
      dailyTime: "18:00",
      dailyWindowMode: "day-start-to-now",
    },
  });

  renderPage();
  await user.click(screen.getByRole("tab", { name: "规则与设置" }));

  expect(screen.getByText("默认摘要窗口")).toBeInTheDocument();
  expect(screen.getByText("8 小时")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "打开 AI 摘要设置" }));
  expect(openSettings).toHaveBeenCalledWith("ai-summary");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx -t "renders summary settings"
```

Expected: FAIL because settings tab is placeholder.

- [ ] **Step 3: Implement `SummarySettingsTab`**

```tsx
import { ArticleIcon } from "@phosphor-icons/react";
import { Button } from "~/components/ui/button";
import EmptyState from "~/components/wemail/EmptyState";
import type { MailDigestSettings } from "shared/wemail/digests";

export function SummarySettingsTab({
  settings,
  isLoading,
  onOpenSettings,
}: {
  settings?: MailDigestSettings | null;
  isLoading: boolean;
  onOpenSettings: () => void;
}) {
  if (isLoading) return <div className="p-6 text-sm text-ink-3">正在加载摘要设置…</div>;
  if (!settings) {
    return (
      <EmptyState
        icon={<ArticleIcon size={22} weight="regular" />}
        title="摘要设置暂不可用"
        description="可以稍后重试，或从设置面板查看 AI 摘要配置。"
        actions={[{ label: "打开 AI 摘要设置", onClick: onOpenSettings }]}
      />
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <SettingRow label="手动摘要按钮" value={settings.manualEnabled ? "已开启" : "已关闭"} />
      <SettingRow label="默认摘要窗口" value={`${settings.manualWindowHours} 小时`} />
      <SettingRow label="离开后提醒" value={settings.inactivityEnabled ? `${settings.inactivityHours} 小时` : "已关闭"} />
      <SettingRow label="日报摘要" value={settings.dailyEnabled ? settings.dailyTime : "已关闭"} />
      <SettingRow label="日报范围" value={settings.dailyWindowMode === "day-start-to-now" ? "今天 0 点到生成时刻" : "上次日报时间到本次日报时间"} />
      <Button type="button" size="sm" onClick={onOpenSettings}>
        打开 AI 摘要设置
      </Button>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-edge bg-paper px-4 py-3">
      <span className="text-sm text-ink">{label}</span>
      <span className="text-sm font-medium text-ink-2">{value}</span>
    </div>
  );
}
```

- [ ] **Step 4: Wire settings tab into page**

Use:

```tsx
const digestSettings = useDigestSettings();
const { openSettings } = useUIStore();
```

Render:

```tsx
<SummarySettingsTab
  settings={digestSettings.data}
  isLoading={digestSettings.isLoading}
  onOpenSettings={() => openSettings("ai-summary")}
/>
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/digests/SummarySettingsTab.tsx app/components/digests/SummaryCenterPage.tsx app/components/digests/SummaryCenterPage.test.tsx
git commit -m "feat: expose summary settings from summary center"
```

## Task 8: Replace Drawer Entry Points With Route Navigation

**Files:**

- Modify: `app/routes/_workbench.tsx`
- Modify: `app/components/wemail/MailDigestBanner.test.tsx`
- Modify: `app/routes/_workbench.test.tsx`
- Optional Modify: `app/components/wemail/MailDigestCenter.tsx`

- [ ] **Step 1: Write failing navigation behavior test**

In `_workbench` tests or a focused banner integration test, assert clicking `摘要中心` calls `navigate("/digests")` rather than opening `MailDigestCenter`.

If mocking `_workbench` is too heavy, add a small pure handler extraction or test around the component area that owns `onOpenDigestCenter`.

Expected behavior:

```tsx
expect(navigateMock).toHaveBeenCalledWith("/digests");
expect(screen.queryByRole("dialog", { name: /摘要中心/ })).toBeNull();
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run app/routes/_workbench.test.tsx -t "摘要中心"
```

Expected: FAIL because current code uses `setDigestCenterOpen(true)`.

- [ ] **Step 3: Replace drawer open handler**

In `MessageListView` inside `app/routes/_workbench.tsx`, use `useNavigate()` already imported or add it if needed:

```tsx
const navigate = useNavigate();
const openSummaryCenter = () => navigate("/digests");
```

Replace:

```tsx
onClick={() => setDigestCenterOpen(true)}
onOpenDigestCenter={() => setDigestCenterOpen(true)}
```

with:

```tsx
onClick={openSummaryCenter}
onOpenDigestCenter={openSummaryCenter}
```

Remove `MailDigestCenter` render from the list scroll path if no other local usage remains.

- [ ] **Step 4: Keep banner API stable**

Do not rename `onOpenDigestCenter` in this task. The prop can now mean "navigate/open the summary center." This keeps changes small and avoids churn in `MailDigestBanner.test.tsx`.

- [ ] **Step 5: Run affected tests**

Run:

```bash
npx vitest run app/components/wemail/MailDigestBanner.test.tsx app/routes/_workbench.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/routes/_workbench.tsx app/routes/_workbench.test.tsx app/components/wemail/MailDigestBanner.test.tsx
git commit -m "feat: route digest center entrypoints"
```

## Task 9: Full Verification And Cleanup

**Files:**

- Potential cleanup: `app/components/wemail/MailDigestCenter.tsx`
- Potential cleanup: `app/components/wemail/MailDigestCenter.test.tsx`

- [ ] **Step 1: Run focused renderer tests**

Run:

```bash
npx vitest run app/components/digests/SummaryCenterPage.test.tsx app/components/Sidebar.test.tsx app/components/wemail/MailDigestCenter.test.tsx app/components/wemail/MailDigestBanner.test.tsx app/routes/_workbench.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run full renderer tests**

Run:

```bash
npm run test:renderer
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run app manually**

Run:

```bash
npm run dev:renderer
```

Open the app and verify:

- Sidebar shows Summary Center.
- `/digests` renders.
- Task table scrolls independently.
- Sticky header and bulk bar do not overlap table content.
- Search and status controls update rows.
- Row click fills inspector.
- `打开邮件` opens the right detail pane.
- Inbox banner `摘要中心` navigates to `/digests`.

- [ ] **Step 5: Optional browser/e2e test**

If there is time, add a browser test under `tests/browser` or existing route-level test setup to verify scroll containment. Keep it focused; do not add broad fixture setup if existing browser tests cannot support digest state cheaply.

- [ ] **Step 6: Commit cleanup**

Only if cleanup was needed:

```bash
git add <cleanup-files>
git commit -m "chore: clean up digest drawer migration"
```

## Risk Notes

- Existing merge conflicts in the current workspace must be resolved or avoided via a fresh worktree before running this plan.
- `summaryHealth.items` may be bounded or unbounded. If unbounded and real data can exceed a few hundred rows, add virtualization or server pagination before shipping.
- Sidebar retryable count is intentionally omitted in Phase 1 to avoid adding query fan-out to every page.
- `MailDigestCenter` is kept temporarily to reduce blast radius. Remove it only after all entry points use `/digests`.
