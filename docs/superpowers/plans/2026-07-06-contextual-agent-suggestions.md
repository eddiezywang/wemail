# Contextual Agent Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WeMail AI suggestion chips prioritize contextual next actions for the focused email, with generic AI actions only as capped fallback suggestions.

**Architecture:** Refactor `server/wemail/agent/SuggestionBuilder.ts` into a small candidate pipeline that collects built-in scenario actions, personalized action candidates, and fallback candidates, then ranks and caps them. Update `server/api/routes/agentRoutes.ts` to pass mail envelope context from `IntelligenceService.getAgentContext()`. Keep the renderer contract unchanged and only adjust the frontend display cap if backend returns four suggestions.

**Tech Stack:** TypeScript, Node `node:test`, Hono route tests, React AgentPanel.

## Global Constraints

- Do not auto-execute high-risk actions; invoice upload must create a pending confirmation action through the existing agent tools.
- Default AI actions (`总结`, `翻译`, `起草回复`, `提取待办`) are fallback suggestions only.
- Show at most four suggestions.
- Built-in scenarios include invoice, meeting, alert/risk, and approval, but the first implementation must ship invoice end-to-end because the tool chain already exists.
- The frontend must preserve backend suggestion order.

---

### Task 1: Suggestion Candidate Pipeline

**Files:**
- Modify: `server/wemail/agent/SuggestionBuilder.ts`
- Test: `server/wemail/agent/SuggestionBuilder.test.ts`

**Interfaces:**
- Consumes: `EmailIntelligenceState` and optional `envelope` data from the route.
- Produces: `buildSuggestions(ctx: SuggestionContext): AgentSuggestionItem[]`, preserving the existing exported function.

- [ ] **Step 1: Write failing tests**

Add tests for:

```ts
test("buildSuggestions puts invoice upload before fallback suggestions", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        schemaVersion: 2,
        intent: "invoice",
        attention: "know",
        displayMode: "one_line",
        headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
        bullets: ["湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。"],
        actionItems: [],
        urgency: "low",
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
    envelope: {
      id: "msg-1",
      subject: "湖北电信电子发票",
      from: "info@hb-189.cn",
      snippet: "您有一张电子发票，请查收附件。",
      folder: "INBOX",
      attachments: [{ id: "att-1", filename: "26427000000526378227.pdf", mimetype: "application/pdf" }],
    },
  });
  assert.equal(suggestions[0]?.id, "upload-allowance-invoice");
  assert.equal(suggestions[0]?.label, "上传发票到发票平台");
  assert.match(suggestions[0]?.prompt ?? "", /只处理当前邮件/);
});
```

```ts
test("buildSuggestions uses fallback suggestions only when no high-priority action exists", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        schemaVersion: 2,
        intent: "system_notice",
        attention: "know",
        displayMode: "one_line",
        headline: "系统通知，无需处理。",
        bullets: ["系统通知，无需处理。"],
        actionItems: [],
        urgency: "low",
      },
    },
    replyDecision: {
      status: "succeeded",
      result: {
        type: "replyDecision",
        shouldReply: false,
        replyRequired: false,
        reason: "No reply required",
        confidence: 0.9,
        priorityScore: 0.1,
        level: "none",
        signals: [],
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.ok(suggestions.length <= 3);
  assert.ok(suggestions.some((s) => s.id === "fallback-summary"));
  assert.ok(!suggestions.some((s) => s.id === "suggest-draft"));
  assert.ok(!suggestions.some((s) => s.id === "suggest-todos"));
});
```

```ts
test("buildSuggestions derives personalized action from summary actions", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        schemaVersion: 2,
        intent: "request",
        attention: "act",
        displayMode: "actionable",
        headline: "客户要求核对合同金额。",
        actions: ["核对合同金额并确认是否可以开票"],
        bullets: ["客户要求核对合同金额。"],
        actionItems: ["核对合同金额并确认是否可以开票"],
        urgency: "medium",
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.equal(suggestions[0]?.id, "personalized-action-1");
  assert.equal(suggestions[0]?.label, "核对合同金额并确认是否可以开票");
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx tsx --test server/wemail/agent/SuggestionBuilder.test.ts`

Expected: the new invoice and personalized tests fail because `envelope`, `upload-allowance-invoice`, and personalized action extraction do not exist yet.

- [ ] **Step 3: Implement candidate pipeline**

Update `SuggestionBuilder.ts` with:

```ts
interface SuggestionEnvelope {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  folder: string;
  language?: string;
  attachments?: Array<{ id?: string; filename?: string; mimetype?: string }>;
}

interface SuggestionCandidate extends AgentSuggestionItem {
  confidence: number;
  source: "built-in" | "personalized" | "fallback";
}
```

Implement helpers for invoice detection, fallback collection, personalized action extraction from `summary.result.actions ?? summary.result.actionItems`, de-duplication, sort, and cap.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx tsx --test server/wemail/agent/SuggestionBuilder.test.ts`

Expected: all `SuggestionBuilder` tests pass.

### Task 2: Route Uses Envelope Context And Removes Fixed Three-Chip Fallback

**Files:**
- Modify: `server/api/routes/agentRoutes.ts`
- Test: `server/api/routes/agentRoutes.test.ts`

**Interfaces:**
- Consumes: `IntelligenceService.getAgentContext(emailId)`.
- Produces: `GET /api/agent/suggestions` response ordered by `buildSuggestions()`.

- [ ] **Step 1: Write failing route tests**

Add or update tests so focused email suggestions do not return the fixed `["summarize-email", "draft-reply", "extract-todos"]` fallback when intelligence is wired, and invoice context returns `upload-allowance-invoice` first.

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx tsx --test server/api/routes/agentRoutes.test.ts`

Expected: the invoice route test fails because the route only passes `getState()` and still owns a fixed fallback list.

- [ ] **Step 3: Update route**

For focused email requests with `deps.intelligenceService`, call `getAgentContext(emailId)`, pass `intelligenceState` and `envelope` to `buildSuggestions()`, map to `{ id, label, prompt }`, and remove the email-scoped fixed three-chip fallback for the intelligence-wired path. Keep the legacy fallback only when `intelligenceService` is absent.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx tsx --test server/api/routes/agentRoutes.test.ts`

Expected: route tests pass.

### Task 3: Frontend Cap Allows Four Suggestions

**Files:**
- Modify: `app/components/AgentPanel.tsx`
- Test: `app/components/AgentPanel.test.tsx`

**Interfaces:**
- Consumes: ordered suggestions from `useAgentSuggestions()`.
- Produces: at most four rendered suggestion chips.

- [ ] **Step 1: Write failing frontend test**

Add a test that mocks four backend suggestions and asserts all four labels render before the first chat message.

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx vitest run app/components/AgentPanel.test.tsx`

Expected: the fourth chip is missing because the current frontend slices to three.

- [ ] **Step 3: Update cap**

Change `return data.slice(0, 3);` to `return data.slice(0, 4);`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run app/components/AgentPanel.test.tsx`

Expected: AgentPanel tests pass.

### Task 4: Final Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: evidence for completion.

- [ ] **Step 1: Run focused server tests**

Run: `npx tsx --test server/wemail/agent/SuggestionBuilder.test.ts server/api/routes/agentRoutes.test.ts`

Expected: exit code 0.

- [ ] **Step 2: Run focused frontend tests**

Run: `npx vitest run app/components/AgentPanel.test.tsx`

Expected: exit code 0.

- [ ] **Step 3: Run typecheck if focused tests pass**

Run: `npm run typecheck:server`

Expected: exit code 0.
