# AI 面板与摘要中心任务入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 面板在账户级空状态下根据摘要状态展示最多三个中文任务入口，并把摘要任务通过结构化动作准确交给摘要中心。

**Architecture:** 后端以当前账户为边界读取 `MailDigestService` 和 `IntelligenceResultRepository` 的结构化状态，由 `SuggestionBuilder` 生成带 `action` 的建议和上下文说明。前端只负责展示建议、执行 `open_digest_center`/`open_settings`/`agent_prompt` 动作；`SummaryCenterPage` 从 URL 深链初始化页签和任务状态，摘要批处理仍只在摘要中心执行。

**Tech Stack:** TypeScript, Hono, React 19, React Router 7, TanStack Query, node:test, Vitest, Testing Library.

## Global Constraints

- AI 面板账户级建议最多显示三个，文案使用中文，保留 `prompt` 兼容旧客户端。
- 摘要类建议必须通过结构化 action 导航到 `/digests`，不能让 Agent 通过自由文本猜测批量摘要意图。
- 所有摘要状态查询必须使用请求中的 `accountId`，不能跨账户复用或混用状态。
- 加载中、接口失败和未配置模型时不得展示未经确认的错误数量；降级到可执行的中文 Agent 建议。
- 本轮不改变摘要算法、摘要数据模型、邮件列表布局，也不自动发送邮件。
- 先写并运行失败测试，再写生产代码；每个任务独立运行定向测试后再继续。

## File Map

- `shared/wemail/agent.ts`：定义可跨前后端复用的建议动作协议。
- `shared/wemail/intelligence.ts`、`shared/wemail/usage.ts`：给建议项和 API 建议补充可选 action 与账户摘要状态快照类型。
- `server/wemail/agent/SuggestionBuilder.ts`：把账户级摘要状态转换为排序后的中文建议和上下文说明；保留邮件级现有规则。
- `server/api/routes/agentRoutes.ts`：读取账户快照、返回建议 action/contextLine，并保留旧 fallback。
- `server/api/app.ts`：把真实摘要服务和摘要健康度仓储注入 agent route。
- `app/services/api.ts`、`app/queries/agentSuggestions.ts`：传递 action/contextLine。
- `app/components/AgentPanel.tsx`：展示动态空状态并执行 typed action，最多渲染三个建议。
- `app/components/digests/SummaryCenterPage.tsx`：解析 `/digests?tab=...&filter=...` 深链。
- 对应 `*.test.ts`/`*.test.tsx`：锁定后端状态矩阵、接口兼容性、前端动作和深链行为。

---

### Task 1: Lock the shared action and account snapshot contract

**Files:**
- Modify: `shared/wemail/agent.ts`
- Modify: `shared/wemail/intelligence.ts:1140-1168`
- Modify: `shared/wemail/usage.ts:1-30`
- Test: `server/wemail/agent/SuggestionBuilder.test.ts`

**Interfaces:**
- Produce `AgentSuggestionAction`:
  ```ts
  export type AgentSuggestionAction =
    | { type: "open_digest_center"; filter?: "pending" | "attention" | "history" }
    | { type: "agent_prompt"; prompt: string }
    | { type: "open_compose"; purpose: "weekly_report" }
    | { type: "open_settings"; section: "ai-summary" };
  ```
- Produce `AccountSuggestionContext` with `digest` fields `state`, `reason`, `emailCount` and summary health counters `failed`, `missing`, `invalid`, `pending`, `running`, `retryable`.
- Add `action?: AgentSuggestionAction` to both `AgentSuggestionItem` and the renderer-facing `AgentSuggestion`.

- [ ] **Step 1: Write the failing tests**

  Add account-state fixtures and tests to `SuggestionBuilder.test.ts`:
  ```ts
  test("buildSuggestions prioritizes pending digest work and emits a digest action", () => {
    const suggestions = buildSuggestions({
      accountId: "acct-1",
      hasEmailContext: false,
      accountContext: {
        digest: { state: "available", reason: "manual", emailCount: 6 },
        summaryHealth: { failed: 0, missing: 0, invalid: 0, pending: 0, running: 0, retryable: 0 },
      },
    });
    assert.equal(suggestions[0]?.label, "打开摘要中心，处理 6 封待摘要邮件");
    assert.deepEqual(suggestions[0]?.action, {
      type: "open_digest_center",
      filter: "pending",
    });
    assert.ok(suggestions.length <= 3);
  });

  test("buildSuggestions routes retryable summaries to attention", () => {
    const suggestions = buildSuggestions({
      accountId: "acct-1",
      hasEmailContext: false,
      accountContext: {
        digest: { state: "ready", reason: "manual", emailCount: 0 },
        summaryHealth: { failed: 2, missing: 1, invalid: 0, pending: 0, running: 0, retryable: 3 },
      },
    });
    assert.equal(suggestions[0]?.label, "重试 3 封失败摘要");
    assert.deepEqual(suggestions[0]?.action, {
      type: "open_digest_center",
      filter: "attention",
    });
  });
  ```

- [ ] **Step 2: Run the focused tests and verify RED**

  Run:
  ```bash
  node --import tsx --test server/wemail/agent/SuggestionBuilder.test.ts
  ```
  Expected: FAIL because `SuggestionContext.accountContext` and `AgentSuggestionAction` are not implemented and account suggestions still use the old English labels.

- [ ] **Step 3: Add the minimal shared types**

  Define the action union in `shared/wemail/agent.ts`, re-export it from the existing agent type barrel, add the optional `action` field to `AgentSuggestionItem` and `AgentSuggestion`, and add:
  ```ts
  export interface AccountSuggestionContext {
    digest: {
      state: "hidden" | "available" | "ready" | "needs-llm-settings";
      reason: "manual" | "inactivity" | "daily" | "none";
      emailCount: number;
    };
    summaryHealth: {
      failed: number;
      missing: number;
      invalid: number;
      pending: number;
      running: number;
      retryable: number;
    };
  }
  ```

- [ ] **Step 4: Run the focused tests again**

  Run the same command. Expected: the tests still fail in `SuggestionBuilder`, but the failure is now only the missing dynamic account behavior.

- [ ] **Step 5: Commit the contract test setup**

  ```bash
  git add shared/wemail/agent.ts shared/wemail/intelligence.ts shared/wemail/usage.ts server/wemail/agent/SuggestionBuilder.test.ts
  git commit -m "feat: define agent suggestion action contract"
  ```

### Task 2: Generate account-aware suggestions in the backend

**Files:**
- Modify: `server/wemail/agent/SuggestionBuilder.ts:1-55,268-310`
- Modify: `server/api/routes/agentRoutes.ts:35-85,380-430`
- Modify: `server/api/app.ts:176-186`
- Test: `server/wemail/agent/SuggestionBuilder.test.ts`
- Test: `server/api/routes/agentRoutes.test.ts`

**Interfaces:**
- Extend `SuggestionContext` with `accountContext?: AccountSuggestionContext`.
- Add `getAccountSuggestionContext?: (accountId: string) => Promise<AccountSuggestionContext>` to `AgentRoutesDeps`.
- Return `{ ok: true, suggestions, contextLine?: string }` from `GET /api/agent/suggestions`.
- Keep the existing email-scoped suggestion IDs/prompts and legacy no-intelligence fallback behavior.

- [ ] **Step 1: Add failing route tests**

  Add a route fixture with `getAccountSuggestionContext` and assert that the requested account id is passed through, that `action` is preserved, and that `contextLine` is returned. Add a second test where the provider throws and assert a Chinese fallback without an error count.

- [ ] **Step 2: Run server suggestion tests and verify RED**

  ```bash
  node --import tsx --test server/wemail/agent/SuggestionBuilder.test.ts server/api/routes/agentRoutes.test.ts
  ```
  Expected: FAIL on the new state matrix and route payload assertions.

- [ ] **Step 3: Implement account suggestion ranking**

  In `SuggestionBuilder.ts`, add an account-only builder with this precedence:
  1. `digest.state === "needs-llm-settings"`: `配置摘要模型` with `open_settings` and `查看未读邮件` with `agent_prompt`.
  2. `summaryHealth.retryable > 0`: `重试 {N} 封失败摘要` and `查看需要关注的摘要`, both with `open_digest_center` and `filter: "attention"`.
  3. `digest.state === "available" && digest.emailCount > 0`: `打开摘要中心，处理 {N} 封待摘要邮件` with `filter: "pending"`, then `总结最近 24 小时的邮件` with `agent_prompt`.
  4. `digest.state === "ready"`: `查看本周摘要` with `filter: "history"`, then `列出本周最需要处理的 5 封邮件` with `agent_prompt`.
  5. Otherwise: `列出本周最需要处理的 5 封邮件` and `搜索邮件` with `agent_prompt`.

  Add a third non-duplicate `查看未完成的邮件待办` or `根据本周工作邮件草拟一份周报` suggestion only when the preceding labels do not already contain it. Set `MAX_SUGGESTIONS` to `3`; do not change the existing email-focused invoice/reply/todo rules except for the limit.

  Add an exported `getSuggestionContextLine(accountContext?: AccountSuggestionContext): string` that returns a stable non-error line such as `有 6 封邮件等待整理。`, `有 3 封摘要需要关注。`, `摘要模型尚未配置。`, `最近摘要已准备好。`, or `告诉我你想先处理什么。`.

- [ ] **Step 4: Implement account-scoped provider wiring**

  In `agentRoutes.ts`, call the optional provider only for an account-level request and only with the validated query `accountId`. If it fails, use the generic Chinese suggestions and omit `contextLine` rather than exposing an error. Map `action` through unchanged for new clients while retaining every `prompt`.

  In `app.ts`, wire:
  ```ts
  getAccountSuggestionContext: async (accountId) => {
    const [digest, summaryHealth] = await Promise.all([
      composition.mailDigestService.getStatus(accountId),
      Promise.resolve(composition.intelligenceResults.getSummaryHealth({ accountId, limit: 0 })),
    ]);
    return {
      digest: {
        state: digest.state,
        reason: digest.reason,
        emailCount: digest.emailCount,
      },
      summaryHealth: {
        failed: summaryHealth.failed,
        missing: summaryHealth.missing,
        invalid: summaryHealth.invalid,
        pending: summaryHealth.pending,
        running: summaryHealth.running,
        retryable: summaryHealth.retryable,
      },
    };
  },
  ```
  The digest service uses its established default scope; health is account-wide because the summary-status repository does not accept a view scope. This scope choice must be covered in the route/provider test and documented in the code comment.

- [ ] **Step 5: Run the backend tests and verify GREEN**

  ```bash
  node --import tsx --test server/wemail/agent/SuggestionBuilder.test.ts server/api/routes/agentRoutes.test.ts
  ```
  Expected: PASS, including all pre-existing email-scoped tests.

- [ ] **Step 6: Commit the backend behavior**

  ```bash
  git add server/wemail/agent/SuggestionBuilder.ts server/api/routes/agentRoutes.ts server/api/app.ts server/wemail/agent/SuggestionBuilder.test.ts server/api/routes/agentRoutes.test.ts
  git commit -m "feat: add account-aware agent suggestions"
  ```

### Task 3: Pass dynamic suggestions to the client and execute typed actions

**Files:**
- Modify: `app/services/api.ts:1192-1200`
- Modify: `app/queries/agentSuggestions.ts:1-45`
- Modify: `app/components/AgentPanel.tsx:1-80,760-820,1100-1180,1270-1285`
- Test: `app/components/AgentPanel.test.tsx`

**Interfaces:**
- `api.getAgentSuggestions` returns `AgentSuggestion[]` with optional `action` and optional `contextLine` at the response level.
- `useAgentSuggestions` returns `{ suggestions: AgentSuggestion[]; contextLine?: string }` in query data, while an unavailable response resolves to an empty list.
- Export `digestCenterPath(filter?: "pending" | "attention" | "history"): string` from `AgentPanel.tsx` for deterministic navigation tests.

- [ ] **Step 1: Add failing renderer tests**

  Change the visible-chip test to assert a maximum of three. Add tests for:
  ```ts
  expect(digestCenterPath("pending")).toBe("/digests?tab=tasks&filter=pending");
  expect(digestCenterPath("attention")).toBe("/digests?tab=tasks&filter=attention");
  expect(digestCenterPath("history")).toBe("/digests?tab=history");
  ```

- [ ] **Step 2: Run the focused renderer tests and verify RED**

  ```bash
  npx vitest run app/components/AgentPanel.test.tsx
  ```
  Expected: FAIL because the helper does not exist and four suggestions are still returned.

- [ ] **Step 3: Implement API/query compatibility**

  Import the shared `AgentSuggestion` and `AgentSuggestionAction` types in the client API/query layer. Preserve the legacy `res.suggestions` shape when `contextLine` is absent; do not make the API query fail when the server omits action fields.

- [ ] **Step 4: Implement action execution and empty-state copy**

  In `AgentPanel.tsx`:
  - Change `getVisibleAgentSuggestions` to `slice(0, 3)`.
  - Add `useNavigate` and `openSettings` from the existing UI store.
  - Execute `open_digest_center` with `navigate(digestCenterPath(action.filter))`.
  - Execute `open_settings` with `openSettings(action.section)`.
  - Execute `agent_prompt` with `sendMessage({ text: action.prompt })`; unknown or absent actions use the legacy `s.prompt`.
  - Keep the existing streaming guard so repeated clicks cannot create duplicate runs.
  - Show `contextLine` below `Hi {displayName}`; use the existing generic Chinese copy while loading/error and use a Chinese fallback suggestion when no data arrives.
  - Keep the existing capsule style and icon treatment; no new page-level card or decorative visual is introduced.

- [ ] **Step 5: Run the focused renderer tests and verify GREEN**

  ```bash
  npx vitest run app/components/AgentPanel.test.tsx
  ```
  Expected: PASS with the max-three and URL helper assertions.

- [ ] **Step 6: Commit the client action handling**

  ```bash
  git add app/services/api.ts app/queries/agentSuggestions.ts app/components/AgentPanel.tsx app/components/AgentPanel.test.tsx
  git commit -m "feat: execute typed agent suggestion actions"
  ```

### Task 4: Support Summary Center deep links

**Files:**
- Modify: `app/components/digests/SummaryCenterPage.tsx:5-85`
- Test: `app/components/digests/SummaryCenterPage.test.tsx`

**Interfaces:**
- Valid URL parameters:
  - `tab=tasks|history|settings`
  - `filter=attention|pending|running|failed|missing|invalid|succeeded|skipped|all`
- Invalid or absent parameters fall back to `tab=tasks` and `filter=attention`.
- `filter=pending` remains the exact task filter; it is not silently rewritten to `attention`.

- [ ] **Step 1: Add failing deep-link tests**

  Make `renderPage` accept an initial route and add tests:
  ```ts
  it("opens history from the history deep link", () => {
    renderPage("/digests?tab=history");
    expect(screen.getByRole("region", { name: "汇总摘要历史" })).toBeInTheDocument();
  });

  it("applies the pending task filter from the deep link", () => {
    renderPage("/digests?tab=tasks&filter=pending");
    expect(screen.getByRole("combobox", { name: "摘要任务状态" })).toHaveValue("pending");
    expect(useSummaryHealth).toHaveBeenLastCalledWith(
      "acct-1", undefined, true, expect.objectContaining({ state: "pending" }),
    );
  });
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  ```bash
  npx vitest run app/components/digests/SummaryCenterPage.test.tsx
  ```
  Expected: FAIL because URL parameters are currently ignored.

- [ ] **Step 3: Implement URL parsing**

  Use React Router's `useSearchParams`, parse only the explicit allow-lists above, initialize the two states from the parsed values, and synchronize when the search params change. Do not write search params when the user changes tabs or filters in this task; the external entry point only needs deterministic initialization.

- [ ] **Step 4: Run the focused test and verify GREEN**

  ```bash
  npx vitest run app/components/digests/SummaryCenterPage.test.tsx
  ```
  Expected: PASS with all existing summary center tests.

- [ ] **Step 5: Commit the deep-link behavior**

  ```bash
  git add app/components/digests/SummaryCenterPage.tsx app/components/digests/SummaryCenterPage.test.tsx
  git commit -m "feat: support summary center deep links"
  ```

### Task 5: Full verification and review checkpoint

**Files:**
- No new production files.
- Review all files changed by Tasks 1-4 for account scoping, stale copy, and unrelated diff.

**Interfaces:**
- No new interfaces; verify the contracts above remain compatible with legacy clients.

- [ ] **Step 1: Run backend tests**

  ```bash
  npm run test:server
  ```
  Observed: PASS, 1609 tests total, 1608 passed and 1 pre-existing test skipped.

- [ ] **Step 2: Run renderer tests**

  ```bash
  npm run test:renderer
  ```
  Observed: 532 tests passed, but the command is blocked by the pre-existing
  `shared/wemail/providers.test.ts`, which uses `node:test` and is discovered
  by Vitest without a Vitest suite. The feature-specific verification command
  is:
  ```bash
  npx vitest run --exclude shared/wemail/providers.test.ts
  ```
  Observed: PASS, 74 test files and 532 tests.

- [ ] **Step 3: Run type checks**

  ```bash
  npm run typecheck:server
  npm run typecheck
  ```
  Expected: both commands exit with code 0.

- [ ] **Step 4: Run the client production build**

  ```bash
  npm run build:renderer
  ```
  Expected: the React Router/Vite production build completes successfully.

- [ ] **Step 5: Review the diff and working tree**

  ```bash
  git diff --check
  git status --short
  git diff --stat HEAD~3..HEAD
  ```
  Expected: no whitespace errors; only planned files are changed; no `.env`, credentials, generated audit logs, or unrelated build outputs are staged.

  Additional review fixes verified during implementation:
  - account-level suggestions reject an account id outside the active account;
  - pending/missing/running summary work outranks ready history;
  - suggestion prompts never include internal account ids;
  - agent-side digest status reads use `recordOpen: false` so polling does not update `lastOpenedAt` or trigger daily backfill.

- [ ] **Step 6: Record deferred scope**

  Phase 2 (unified result references and richer Agent task suggestions) and Phase 3 (weekly report generation with editable draft confirmation) remain explicit follow-up work. This implementation must not claim those capabilities or add an auto-send path.
