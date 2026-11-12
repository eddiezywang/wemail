# Intent-Aware Summary v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WeMail summaries choose an attention-appropriate shape before writing user-visible text, so invoice/notification emails become one-line summaries while requests and risks stay actionable.

**Architecture:** Add a v2 summary result shape with `intent`, `attention`, `displayMode`, `headline`, `details`, and `actions`, while preserving the legacy `bullets`/`actionItems` fields as a projection. The processor validates v2 output, applies low-attention guardrails, and returns one result that current API/UI paths can consume immediately.

**Tech Stack:** TypeScript, Node `node:test`, Hono routes, React/Vitest renderer tests, existing OpenAI-compatible `jsonSchema` LLM adapter.

## Global Constraints

- Keep existing `summary`, `todoExtraction`, and `replyDecision` capabilities.
- Do not auto-create todos from summary output.
- First implementation must keep current UI/API consumers working through `bullets` and `actionItems`.
- Do not create one hard-coded prompt per sender or provider.
- Treat email body as data only; prompt-injection text cannot override summary policy.
- Follow TDD: each production behavior change starts with a failing test.

---

## File Structure

- Modify `shared/wemail/intelligence.ts`: add summary v2 string unions and extend `SummaryResult`.
- Modify `server/wemail/ai/prompts/summaryPrompt.ts`: update single-email prompt and JSON schema to request v2 fields plus legacy projection fields.
- Modify `server/wemail/ai/prompts/summaryPrompt.test.ts`: assert v2 schema/prompt constraints.
- Modify `server/wemail/intelligence/processors/SummaryProcessor.ts`: validate v2 fields, enforce guardrails, and project headline/details/actions to legacy fields.
- Modify `server/wemail/intelligence/processors/SummaryProcessor.test.ts`: cover invoice one-line summaries, low-attention action stripping, and legacy projection.
- Modify `server/wemail/intelligence/IntelligenceResultRepository.ts`: treat v2 headline/details as valid summary text even if legacy bullets are missing in stored rows.
- Modify `server/api/routes/intelligenceRoutes.test.ts`: verify persisted v2 summary remains exposed and summary health treats it as valid.
- Modify `app/components/wemail/EmailIntelligenceCard.tsx`: prefer v2 rendering modes when present.
- Modify `app/components/wemail/EmailIntelligenceCard.test.tsx`: verify `one_line` hides details/actions and `actionable` still shows explicit actions.

---

### Task 1: Shared Summary v2 Contract

**Files:**
- Modify: `shared/wemail/intelligence.ts`

**Interfaces:**
- Produces:
  - `SummaryIntent`
  - `SummaryAttention`
  - `SummaryDisplayMode`
  - Extended `SummaryResult` with optional v2 fields.
- Consumes: existing `SummaryResult` shape.

- [ ] **Step 1: Add shared type fields**

In `shared/wemail/intelligence.ts`, add these exports near `SummaryResult`:

```ts
export type SummaryIntent =
  | "invoice"
  | "receipt"
  | "system_notice"
  | "marketing"
  | "request"
  | "approval"
  | "meeting"
  | "risk"
  | "thread"
  | "other";

export type SummaryAttention =
  | "ignore"
  | "know"
  | "verify"
  | "reply"
  | "act"
  | "follow_up";

export type SummaryDisplayMode =
  | "one_line"
  | "brief"
  | "actionable"
  | "thread";
```

Extend `SummaryResult`:

```ts
export interface SummaryResult {
  type: "summary";
  schemaVersion?: 1 | 2;
  intent?: SummaryIntent;
  attention?: SummaryAttention;
  displayMode?: SummaryDisplayMode;
  headline?: string;
  details?: string[];
  actions?: string[];
  bullets: string[];
  actionItems: string[];
  urgency: "low" | "medium" | "high";
  _metadata?: AiResultMetadata;
}
```

- [ ] **Step 2: Run typecheck for shared/server consumers**

Run: `npm run typecheck:server`

Expected: any failures should be unrelated to the new optional fields. If TypeScript reports missing exports or incompatible summary shapes, fix the shared types before continuing.

---

### Task 2: Prompt and Schema Require Intent-Aware Output

**Files:**
- Modify: `server/wemail/ai/prompts/summaryPrompt.test.ts`
- Modify: `server/wemail/ai/prompts/summaryPrompt.ts`

**Interfaces:**
- Consumes: shared v2 field names from Task 1.
- Produces: updated `SUMMARY_SYSTEM_PROMPT` and `SUMMARY_JSON_SCHEMA` for single-email summaries.

- [ ] **Step 1: Write failing prompt/schema test**

Add a test to `server/wemail/ai/prompts/summaryPrompt.test.ts`:

```ts
test("SUMMARY_JSON_SCHEMA requires intent-aware v2 summary fields", () => {
  const schema = SUMMARY_JSON_SCHEMA as {
    required: string[];
    properties: Record<string, any>;
  };
  assert.ok(schema.required.includes("schemaVersion"));
  assert.ok(schema.required.includes("intent"));
  assert.ok(schema.required.includes("attention"));
  assert.ok(schema.required.includes("displayMode"));
  assert.ok(schema.required.includes("headline"));
  assert.ok(schema.required.includes("details"));
  assert.ok(schema.required.includes("actions"));
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.deepEqual(schema.properties.displayMode.enum.sort(), [
    "actionable",
    "brief",
    "one_line",
    "thread",
  ]);
});
```

Add a second test:

```ts
test("SUMMARY_SYSTEM_PROMPT includes low-attention summary policy", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /attention/i);
  assert.match(SUMMARY_SYSTEM_PROMPT, /one_line/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /invoice/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /receipt/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /system_notice/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /can download/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /not actions/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/wemail/ai/prompts/summaryPrompt.test.ts`

Expected: FAIL because schema/prompt do not include v2 fields.

- [ ] **Step 3: Update prompt and schema**

In `SUMMARY_SYSTEM_PROMPT`, replace the current bullet/action wording with policy text that says:

```ts
"First classify the email before summarizing: intent, attention, and displayMode.",
"intent: one of invoice, receipt, system_notice, marketing, request, approval, meeting, risk, thread, other.",
"attention: ignore, know, verify, reply, act, or follow_up.",
"displayMode: one_line for low-attention notifications; brief for useful context; actionable for explicit requests; thread for multi-message state.",
"headline: the single most useful user-facing sentence.",
"details: zero to 3 short supporting facts; empty for ordinary invoice, receipt, system_notice, and marketing emails unless one detail materially helps the user.",
"actions: zero to 3 explicit recipient obligations; phrases such as 'can download', 'may view', 'for reference', or 'if not received, check spam' are details, not actions.",
"For invoice, receipt, system_notice, and marketing messages, default to attention='know' or 'ignore', displayMode='one_line', urgency='low', and actions=[].",
"For one_line summaries, keep headline under 90 Chinese characters or 180 Latin characters.",
"Also provide legacy bullets and actionItems as a projection: bullets must equal [headline, ...details] after guardrails; actionItems must equal actions.",
```

Update `SUMMARY_JSON_SCHEMA` so required fields include:

```ts
[
  "type",
  "schemaVersion",
  "intent",
  "attention",
  "displayMode",
  "headline",
  "details",
  "actions",
  "bullets",
  "actionItems",
  "urgency",
]
```

Add properties:

```ts
type: { type: "string", const: "summary" },
schemaVersion: { type: "number", const: 2 },
intent: { type: "string", enum: ["invoice", "receipt", "system_notice", "marketing", "request", "approval", "meeting", "risk", "thread", "other"] },
attention: { type: "string", enum: ["ignore", "know", "verify", "reply", "act", "follow_up"] },
displayMode: { type: "string", enum: ["one_line", "brief", "actionable", "thread"] },
headline: { type: "string", minLength: 1 },
details: { type: "array", maxItems: 3, items: { type: "string", minLength: 1 } },
actions: { type: "array", maxItems: 3, items: { type: "string", minLength: 1 } },
```

Keep legacy `bullets`, `actionItems`, and `urgency` properties.

- [ ] **Step 4: Run prompt/schema tests**

Run: `node --import tsx --test server/wemail/ai/prompts/summaryPrompt.test.ts`

Expected: PASS.

---

### Task 3: Processor Validation, Guardrails, and Legacy Projection

**Files:**
- Modify: `server/wemail/intelligence/processors/SummaryProcessor.test.ts`
- Modify: `server/wemail/intelligence/processors/SummaryProcessor.ts`

**Interfaces:**
- Consumes: v2 prompt/schema from Task 2.
- Produces: guarded `SummaryResult` where legacy fields mirror v2 fields.

- [ ] **Step 1: Write failing invoice summary test**

Add this test to `SummaryProcessor.test.ts` in the email-mode section:

```ts
test("SummaryProcessor keeps invoice notifications one-line with no actions", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        type: "summary",
        schemaVersion: 2,
        intent: "invoice",
        attention: "know",
        displayMode: "one_line",
        headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
        details: ["电子发票可下载或打印使用。"],
        actions: ["下载并保存附件中的电子发票"],
        bullets: ["模型不应保留这条旧摘要"],
        actionItems: ["模型不应保留这条旧行动"],
        urgency: "medium",
      }),
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 8 },
    })),
  });

  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      subject: "湖北电信电子发票",
      from: { email: "info@hb-189.cn", name: "湖北电信" },
      bodyText: "附件是电子发票，可自行下载打印。如未收到请查垃圾箱。",
      hasAttachments: true,
    })),
  ) as SummaryResult;

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.intent, "invoice");
  assert.equal(result.attention, "know");
  assert.equal(result.displayMode, "one_line");
  assert.equal(result.urgency, "low");
  assert.deepEqual(result.details, []);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.bullets, [result.headline]);
  assert.deepEqual(result.actionItems, []);
});
```

- [ ] **Step 2: Write failing actionable request projection test**

Add:

```ts
test("SummaryProcessor preserves explicit actions for actionable requests", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        type: "summary",
        schemaVersion: 2,
        intent: "request",
        attention: "act",
        displayMode: "actionable",
        headline: "客户要求周五前确认合同条款。",
        details: ["合同第 3 条和第 5 条需要复核。"],
        actions: ["周五前回复客户合同确认意见"],
        bullets: [],
        actionItems: [],
        urgency: "medium",
      }),
      finishReason: "stop",
    })),
  });

  const result = await processor.handle(makeJob(), makeCtx(makeMessage({
    subject: "合同确认",
    bodyText: "请你周五前确认合同第 3 条和第 5 条，并回复我。",
  }))) as SummaryResult;

  assert.deepEqual(result.bullets, [
    "客户要求周五前确认合同条款。",
    "合同第 3 条和第 5 条需要复核。",
  ]);
  assert.deepEqual(result.actionItems, ["周五前回复客户合同确认意见"]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import tsx --test server/wemail/intelligence/processors/SummaryProcessor.test.ts`

Expected: FAIL because v2 validation and guardrails are not implemented.

- [ ] **Step 4: Implement v2 validation helpers**

In `SummaryProcessor.ts`, add constants:

```ts
const SUMMARY_INTENTS = new Set(["invoice", "receipt", "system_notice", "marketing", "request", "approval", "meeting", "risk", "thread", "other"]);
const SUMMARY_ATTENTIONS = new Set(["ignore", "know", "verify", "reply", "act", "follow_up"]);
const SUMMARY_DISPLAY_MODES = new Set(["one_line", "brief", "actionable", "thread"]);
const LOW_ATTENTION_INTENTS = new Set(["invoice", "receipt", "system_notice", "marketing"]);
```

Add helper functions:

```ts
function sanitizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

function isExplicitActionContext(intent: string, attention: string): boolean {
  return attention === "reply" ||
    attention === "act" ||
    attention === "verify" ||
    intent === "request" ||
    intent === "approval" ||
    intent === "meeting" ||
    intent === "risk";
}
```

Add a `guardSummaryV2(obj)` helper that:

```ts
const intent = SUMMARY_INTENTS.has(obj.intent as string) ? obj.intent as SummaryIntent : "other";
const attention = SUMMARY_ATTENTIONS.has(obj.attention as string) ? obj.attention as SummaryAttention : "know";
const displayMode = SUMMARY_DISPLAY_MODES.has(obj.displayMode as string) ? obj.displayMode as SummaryDisplayMode : "brief";
const headline = typeof obj.headline === "string" && obj.headline.trim()
  ? trimToChars(obj.headline, 90)
  : compactedBullets[0] ?? "";
let details = sanitizeStringArray(obj.details, 3);
let actions = sanitizeStringArray(obj.actions, 3);
let urgency = obj.urgency === "high" || obj.urgency === "medium" ? obj.urgency : "low";

if (displayMode === "one_line" || LOW_ATTENTION_INTENTS.has(intent)) {
  details = displayMode === "one_line" ? [] : details.slice(0, 1);
  if (!isExplicitActionContext(intent, attention)) actions = [];
  if (LOW_ATTENTION_INTENTS.has(intent)) urgency = "low";
}

return {
  type: "summary",
  schemaVersion: 2,
  intent,
  attention,
  displayMode,
  headline,
  details,
  actions,
  bullets: compactSummaryBullets([headline, ...details]),
  actionItems: actions,
  urgency,
};
```

Update `validateSummary(parsed)` to detect `schemaVersion === 2` or `headline` and return guarded v2. Keep legacy validation path for old responses used by existing tests.

- [ ] **Step 5: Run processor tests**

Run: `node --import tsx --test server/wemail/intelligence/processors/SummaryProcessor.test.ts`

Expected: PASS.

---

### Task 4: Repository, API, and UI Compatibility

**Files:**
- Modify: `server/api/routes/intelligenceRoutes.test.ts`
- Modify: `server/wemail/intelligence/IntelligenceResultRepository.ts`
- Modify: `server/wemail/intelligence/IntelligenceService.ts`
- Modify: `app/components/wemail/EmailIntelligenceCard.test.tsx`
- Modify: `app/components/wemail/EmailIntelligenceCard.tsx`

**Interfaces:**
- Consumes: `SummaryResult` optional v2 fields from Task 1.
- Produces: v2 summaries persist as valid rows and render with attention-appropriate density.

- [ ] **Step 1: Write failing persisted v2 API test**

In `server/api/routes/intelligenceRoutes.test.ts`, add:

```ts
test("v2 one-line summary results are stored and exposed as valid summaries", async () => {
  const { app, results } = makeHarness();
  results.saveResult("email-v2-summary", {
    type: "summary",
    schemaVersion: 2,
    intent: "invoice",
    attention: "know",
    displayMode: "one_line",
    headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
    details: [],
    actions: [],
    bullets: [],
    actionItems: [],
    urgency: "low",
  }, "test-model");

  const res = await app.request("/api/intelligence/messages/email-v2-summary");
  assert.equal(res.status, 200);
  const body = await res.json() as {
    summary: {
      schemaVersion?: number;
      headline?: string;
      bullets: string[];
      actionItems: string[];
    } | null;
  };
  assert.ok(body.summary);
  assert.equal(body.summary.schemaVersion, 2);
  assert.equal(body.summary.headline, "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。");
});
```

- [ ] **Step 2: Run API test to verify it fails**

Run: `node --import tsx --test server/api/routes/intelligenceRoutes.test.ts`

Expected: FAIL because repository validation only checks `bullets`.

- [ ] **Step 3: Update repository and service validity checks**

In `IntelligenceResultRepository.ts`, change `SummaryLikeResult`:

```ts
interface SummaryLikeResult {
  type: "summary";
  bullets?: string[];
  actionItems?: string[];
  headline?: string;
  details?: string[];
  actions?: string[];
}
```

Change `isValidSummaryResult`:

```ts
function isValidSummaryResult(result: SummaryLikeResult): boolean {
  return (
    (result.bullets ?? []).some(hasText) ||
    (result.actionItems ?? []).some(hasText) ||
    hasText(result.headline) ||
    (result.details ?? []).some(hasText) ||
    (result.actions ?? []).some(hasText)
  );
}
```

In `IntelligenceService.ts`, update the private `isValidSummaryResult` helper similarly:

```ts
const summary = result as SummaryResult;
return (
  hasSummaryText(summary.bullets) ||
  hasSummaryText(summary.actionItems) ||
  hasSummaryText(summary.headline ? [summary.headline] : []) ||
  hasSummaryText(summary.details) ||
  hasSummaryText(summary.actions)
);
```

- [ ] **Step 4: Write failing UI one-line render test**

In `app/components/wemail/EmailIntelligenceCard.test.tsx`, add:

```tsx
it("renders one-line v2 summaries without detail or action rows", () => {
  render(
    <EmailIntelligenceCard
      emailId="email-1"
      summaryStatus="succeeded"
      summary={{
        type: "summary",
        schemaVersion: 2,
        intent: "invoice",
        attention: "know",
        displayMode: "one_line",
        headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
        details: ["电子发票可下载或打印。"],
        actions: ["下载并保存电子发票"],
        bullets: ["不应显示旧 bullets"],
        actionItems: ["不应显示旧 actionItems"],
        urgency: "low",
      } as any}
      tagsStatus="skipped"
      tags={null}
    />,
  );

  expect(screen.getByText("湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。")).toBeInTheDocument();
  expect(screen.queryByText("电子发票可下载或打印。")).toBeNull();
  expect(screen.queryByText("下载并保存电子发票")).toBeNull();
  expect(screen.queryByText("不应显示旧 bullets")).toBeNull();
});
```

Add an actionable test:

```tsx
it("renders actionable v2 summaries with explicit actions", () => {
  render(
    <EmailIntelligenceCard
      emailId="email-1"
      summaryStatus="succeeded"
      summary={{
        type: "summary",
        schemaVersion: 2,
        intent: "request",
        attention: "act",
        displayMode: "actionable",
        headline: "客户要求周五前确认合同条款。",
        details: ["合同第 3 条和第 5 条需要复核。"],
        actions: ["周五前回复客户合同确认意见"],
        bullets: [],
        actionItems: [],
        urgency: "medium",
      } as any}
      tagsStatus="skipped"
      tags={null}
    />,
  );

  expect(screen.getByText("客户要求周五前确认合同条款。")).toBeInTheDocument();
  expect(screen.getByText("合同第 3 条和第 5 条需要复核。")).toBeInTheDocument();
  expect(screen.getByText("周五前回复客户合同确认意见")).toBeInTheDocument();
});
```

- [ ] **Step 5: Run UI tests to verify they fail**

Run: `npx vitest run app/components/wemail/EmailIntelligenceCard.test.tsx`

Expected: FAIL because UI still renders legacy arrays first.

- [ ] **Step 6: Update UI summary item selection**

In `EmailIntelligenceCard.tsx`, add helpers near `getRenderableItems`:

```ts
function getSummaryBullets(summary: SummaryResult | null | undefined) {
  if (!summary) return [];
  if ((summary as any).schemaVersion === 2 && typeof (summary as any).headline === "string") {
    const headline = (summary as any).headline.trim();
    const details = Array.isArray((summary as any).details)
      ? (summary as any).details.filter((item: unknown): item is string =>
          typeof item === "string" && item.trim().length > 0,
        )
      : [];
    if ((summary as any).displayMode === "one_line") return headline ? [headline] : [];
    return [headline, ...details].filter((item) => item.trim().length > 0);
  }
  return getRenderableItems(summary.bullets);
}

function getSummaryActionItems(summary: SummaryResult | null | undefined) {
  if (!summary) return [];
  if ((summary as any).schemaVersion === 2 && Array.isArray((summary as any).actions)) {
    if ((summary as any).displayMode === "one_line") return [];
    return getRenderableItems((summary as any).actions);
  }
  return getRenderableItems(summary.actionItems);
}
```

Replace:

```ts
const renderableBullets = getRenderableItems(props.summary?.bullets);
const renderableActionItems = getRenderableItems(props.summary?.actionItems);
```

with:

```ts
const renderableBullets = getSummaryBullets(props.summary);
const renderableActionItems = getSummaryActionItems(props.summary);
```

Update `hasRenderableSummary` to use the same helpers.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
node --import tsx --test server/api/routes/intelligenceRoutes.test.ts
npx vitest run app/components/wemail/EmailIntelligenceCard.test.tsx
```

Expected: PASS.

---

### Task 5: Full Verification

**Files:**
- No new source files.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified implementation.

- [ ] **Step 1: Run focused server summary tests**

Run:

```bash
node --import tsx --test server/wemail/ai/prompts/summaryPrompt.test.ts server/wemail/intelligence/processors/SummaryProcessor.test.ts server/api/routes/intelligenceRoutes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run server typecheck**

Run: `npm run typecheck:server`

Expected: PASS.

- [ ] **Step 3: Run renderer summary card test**

Run: `npx vitest run app/components/wemail/EmailIntelligenceCard.test.tsx`

Expected: PASS.

- [ ] **Step 4: Check git diff**

Run: `git status --short` and `git diff --stat`

Expected: only planned files are modified.
