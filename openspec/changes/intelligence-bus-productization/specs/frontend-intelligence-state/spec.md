# Frontend Intelligence State

## Capability

Provide the frontend with a unified, real-time view of all intelligence states for a given email, supporting loading indicators, error states, retry affordances, and the LLM configuration banner.

## EmailIntelligenceState

```typescript
interface EmailIntelligenceState {
  emailId: string;
  summary: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    result?: SummaryResult;
    canRetry?: boolean;  // true when status is "failed" and attempts < maxAttempts
  };
  tags: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    result?: TagResult;
  };
  replyDecision: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    result?: ReplyDecisionResult;
    skipReason?: string;
  };
  replyDraft: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "not-needed";
    result?: ReplyDraftResult;
    canRetry?: boolean;  // always false per product decision (silent failure)
  };
}
```

## Status Derivation

The API endpoint `GET /api/intelligence/messages/:id` derives status from two sources:

1. **`mail_ai_artifacts`** — If a result row exists, use its `status` field (`succeeded`, `failed`, `skipped`).
2. **`mail_jobs`** — If no result row exists, check the job row:
   - `status='pending'` → `"pending"`
   - `status='running'` → `"running"`
   - No job row → capability not applicable (e.g. `replyDraft` not enqueued yet)

For `replyDraft`, the `"not-needed"` status is derived: if `replyDecision` result exists with `shouldReply=false`, then `replyDraft.status = "not-needed"` regardless of whether a draft job exists.

## Summary Card

Location: bottom of email detail view, collapsible.

| State | Render |
|-------|--------|
| pending/running | Skeleton loader, "AI 摘要生成中" |
| succeeded | Summary text, key points, action items |
| failed | "摘要生成失败" + retry button |
| skipped | Hidden (no summary area) |

Retry button calls `POST /api/intelligence/messages/:id/summary/retry`.

## Smart Tags

Location: email header area.

| State | Render |
|-------|--------|
| pending/running | Skeleton tag chips |
| succeeded | Auto-tier tags as normal chips, suggested-tier with confirm/dismiss |
| failed/skipped | Hidden (no tags area) |

## Smart Draft

Location: below email body.

| State | Render |
|-------|--------|
| not-needed | Hidden (no draft area) |
| pending/running | Skeleton loader |
| succeeded | Draft preview + "使用此草稿" button |
| failed/skipped | Hidden (silent failure) |

## LLM Configuration Banner

Global banner shown when `GET /api/system/llm-status` returns `{ configured: false }`.

Banner text: "AI 功能需要配置语言模型。前往设置 → AI 配置。"

Banner includes a "前往设置" link that navigates to the LLM settings page.

Banner is dismissible per session (stored in React state, not localStorage). Reappears on next app launch.

## Polling Strategy

When a user opens an email with `pending` or `running` intelligence:
- Poll `GET /api/intelligence/messages/:id` every 2 seconds
- Stop polling when all capabilities reach a terminal state
- Use React Query's `refetchInterval` with a condition

## React Query Integration

```typescript
// app/queries/intelligence.ts
export function useEmailIntelligence(emailId: string) {
  return useQuery({
    queryKey: ["intelligence", emailId],
    queryFn: () => fetch(`/api/intelligence/messages/${emailId}`).then(r => r.json()),
    refetchInterval: (query) => {
      const state = query.state.data as EmailIntelligenceState | undefined;
      if (!state) return false;
      const hasActive = ["pending", "running"].some(s =>
        [state.summary.status, state.tags.status, state.replyDecision.status, state.replyDraft.status].includes(s as any)
      );
      return hasActive ? 2000 : false;
    },
  });
}
```
