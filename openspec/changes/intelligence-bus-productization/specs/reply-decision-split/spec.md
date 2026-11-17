# Reply Decision Split

## Capability

Split the current `ReplyDraftProcessor` into two distinct capabilities:

1. **ReplyDecisionProcessor** — Determines whether a mail warrants a reply. Fast, cheap (~200 output tokens).
2. **ReplyDraftProcessor** — Generates a reply draft for mails that need one. Slower, more expensive (~800 output tokens). Only runs when `ReplyDecisionProcessor` returns `shouldReply=true`.

## ReplyDecisionProcessor

**Input:**
- Mail subject, sender, body text (budgeted to 6000 chars)
- If summary result is available and status is `succeeded`, include summary text as additional context
- No summary dependency — if summary isn't ready, proceed with body only

**LLM Prompt:** Fixed system prompt instructing the model to classify the mail as needing or not needing a reply. Returns JSON: `{ shouldReply: boolean, reason: string, confidence: number }`.

**Output:** `ReplyDecisionResult` stored in `mail_ai_artifacts`:
```typescript
interface ReplyDecisionResult {
  type: "replyDecision";
  shouldReply: boolean;
  reason: string;      // e.g. "对方提出问题等待确认" or "通知类邮件无需回复"
  confidence: number;  // 0-1
}
```

**Side effect:** When `shouldReply=true`, enqueues a `replyDraft` job for the same email via `JobRepository.enqueueJob()`.

**Pre-screened path:** When the mail was pre-screened (prescreen result `skipReply=true`), the orchestrator sets `maxAttempts=1` on the `replyDecision` job. The processor detects this via a job metadata flag and writes a skipped result immediately without calling LLM: `{ shouldReply: false, reason: prescreenResult.skipReason, confidence: 1.0 }`.

## ReplyDraftProcessor (Simplified)

**Input:**
- Mail subject, sender, body text
- `ReplyDecisionResult` from the same email (fetched from `IntelligenceResultRepository`)
- The decision result provides context: why a reply is needed, what the user should address

**LLM Prompt:** Fixed system prompt for drafting a reply. Returns JSON: `{ draftMarkdown: string }`. No `shouldReply` field — the decision is already made.

**Output:** `ReplyDraftResult` stored in `mail_ai_artifacts`:
```typescript
interface ReplyDraftResult {
  type: "replyDraft";
  draftMarkdown: string;
}
```

**Fallback:** If `ReplyDecisionResult` is not yet available (race condition), the processor falls back to generating a draft based on the mail body alone, but logs a warning.

## Shared Types Changes

`IntelligenceProcessorName` becomes: `"summary" | "tags" | "replyDecision" | "replyDraft"`

`IntelligenceJobType` aligns with `IntelligenceProcessorName`.

`ReplyDraftResult` loses the `shouldReply` and `rationale` fields (those move to `ReplyDecisionResult`).

## Existing Data Migration

Existing `replyDraft` results in `mail_ai_artifacts` that contain `shouldReply` are still readable — the JSON is untyped in the DB. The new `ReplyDecisionProcessor` creates a separate `replyDecision` result row for new mail. Old data is not migrated; old `replyDraft` results with `shouldReply=false` are still displayable.

## Frontend Consumption

- `replyDecision` result is queried for display when the user opens a mail
- If `shouldReply=false` and skip reason exists → draft area is hidden
- If `shouldReply=true` and draft is pending → show loading state in draft area
- If `shouldReply=true` and draft succeeded → show draft with "Use this draft" action
- If `shouldReply=true` and draft failed → draft area is hidden (silent failure per product decision)
