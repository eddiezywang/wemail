# Intelligence Orchestrator & Capability System

## Capability

- `type`: The unique identifier for an intelligence capability (e.g. `"summary"`, `"tags"`, `"replyDecision"`, `"replyDraft"`).
- `lane`: Per-capability queue configuration: `maxAttempts`, `timeoutMs`.
- `requiresLlm`: Whether the capability needs an LLM client. If `true` and LLM is not configured, the job is immediately skipped with reason `"llm-not-configured"`.
- `prescreenable`: Whether local pre-screening can suppress this capability for certain mail.
- `createProcessor(deps)`: Factory that constructs a `MailIntelligenceProcessor` given shared dependencies.

## IntelligenceService

The unified service layer that ALL callers (system, PI agent, frontend) use. No intelligence operation bypasses this layer.

**Query methods** (read-only, no side effects):
- `getState(emailId)` → `EmailIntelligenceState`
- `getSummary(emailId)` → `SummaryResult | null`
- `getTags(emailId)` → `TagResult | null`
- `getReplyDecision(emailId)` → `ReplyDecisionResult | null`
- `getReplyDraft(emailId)` → `ReplyDraftResult | null`
- `getLlmStatus()` → `{ configured, provider?, model? }`

**Trigger methods** (enqueue a job, return job ID):
- `triggerSummary(emailId, caller)` → `string` (job ID)
- `triggerTags(emailId, caller)` → `string` (job ID)
- `triggerReplyDecision(emailId, caller)` → `string` (job ID)
- `triggerReplyDraft(emailId, caller)` → `string` (job ID)
- `retry(emailId, type, caller)` → `string` (job ID)

**Operate methods** (mutate state, write audit log):
- `confirmTag(emailId, tagName, caller)` → void
- `rejectTag(emailId, tagName, caller)` → void
- `acceptDraft(emailId, caller)` → void
- `editAndSendDraft(emailId, caller)` → void
- `deleteDraft(emailId, caller)` → void

Every method writes an audit log entry via `AuditLogService.log()` with the `CallerContext`.

## CallerContext

```typescript
interface CallerContext {
  source: "system" | "agent" | "user";
  sessionId?: string;   // agent session ID when source="agent"
  userId?: string;       // user ID when source="user" (phase one: always "default")
  meta?: Record<string, string>;  // additional metadata
}
```

This context is:
- Passed to `AuditLogService.log()` for every operation
- Available to `IntelligenceOrchestrator` for potential source-specific logic
- Stored in `intelligence_audit_log` for analytics

## Orchestrator

The `IntelligenceOrchestrator` lives inside the `IntelligenceService`. It:

1. Subscribes to `Mail Core sync worker` `"new-mail"` events (system path).
2. Runs `LocalPrescreener.check()` on each new mail.
3. Calls `FanOutStrategy.plan(mail, prescreenResult)` to determine which jobs to enqueue.
4. Inserts jobs via `JobRepository.enqueueJobs(jobs)`.
5. For jobs that require LLM but LLM is not configured: immediately marks them as `skipped`.
6. Exposes `registerCapability(descriptor)` for composition root wiring.
7. Exposes `dispatch(job)` for `QueueRunner` to call.

The orchestrator is also called by `IntelligenceService.trigger*()` methods for agent and user-initiated capabilities.

## Fan-Out Strategy

The `DefaultFanOutStrategy` produces this plan per mail:

| Prescreen Result | Jobs Enqueued |
|-----------------|---------------|
| Normal mail | summary(2), tags(3), replyDecision(3) |
| Pre-screened (skip reply) | summary(2), tags(3), replyDecision(1, will skip) |
| LLM not configured | (all LLM jobs immediately skipped) |

`replyDraft` is never pre-enqueued. `ReplyDecisionProcessor` enqueues it conditionally when `shouldReply=true`.

For agent-initiated triggers, the fan-out strategy is bypassed — the agent explicitly specifies which capability to trigger.

## Agent Tool Mapping

PI agent tools are thin wrappers over `IntelligenceService`:

| Agent Tool | Service Method | Type |
|-----------|---------------|------|
| `get_summary` | `getSummary(id)` | Query |
| `get_tags` | `getTags(id)` | Query |
| `get_reply_decision` | `getReplyDecision(id)` | Query |
| `get_reply_draft` | `getReplyDraft(id)` | Query |
| `get_intelligence_state` | `getState(id)` | Query |
| `trigger_summary` | `triggerSummary(id, {source:"agent"})` | Trigger |
| `trigger_tags` | `triggerTags(id, {source:"agent"})` | Trigger |
| `trigger_reply_decision` | `triggerReplyDecision(id, {source:"agent"})` | Trigger |
| `trigger_reply_draft` | `triggerReplyDraft(id, {source:"agent"})` | Trigger |
| `retry_intelligence` | `retry(id, type, {source:"agent"})` | Trigger |
| `confirm_tag` | `confirmTag(id, tag, {source:"agent"})` | Operate |
| `reject_tag` | `rejectTag(id, tag, {source:"agent"})` | Operate |

Agent tools receive `CallerContext` with `source: "agent"` and the current `sessionId`. This is passed through to the service layer and audit log.

Query tools return state-aware results including `status` so the agent can reason about whether a result exists, is pending, failed, or skipped. For example, `get_summary` returns `{ status: "pending", result: null }` if the summary hasn't been generated yet — the agent can then decide to call `trigger_summary`.

## Skipped State

`JobStatus` gains `"skipped"`. Terminal state, not retriable.

Skip reasons:
- `"llm-not-configured"` — no LLM client available
- `"noreply-sender"` — sender matches noreply pattern
- `"notification-domain"` — sender domain is in notification list
- `"bulk-mailing-list"` — mail has Precedence: bulk or List-Id header
- `"processor-unregistered"` — no processor registered for this job type (fallback)

`IntelligenceResultRepository` stores skipped results with `status='skipped'` and `result_json` containing `{ reason, matchedRule? }`.

## Query API

`GET /api/intelligence/messages/:id` returns `EmailIntelligenceState`:

```typescript
interface EmailIntelligenceState {
  emailId: string;
  summary: { status, result?, canRetry? };
  tags: { status, result? };
  replyDecision: { status, result?, skipReason? };
  replyDraft: { status, result?, canRetry? };
}
```

Status values: `"pending" | "running" | "succeeded" | "failed" | "skipped" | "not-needed"`.

`"not-needed"` is a virtual status for `replyDraft` when `replyDecision.shouldReply=false`. Not stored in DB; derived at query time.

`"pending"` and `"running"` are derived from `mail_jobs` for jobs that exist but haven't completed. `"succeeded"`, `"failed"`, `"skipped"` come from `mail_ai_artifacts`.

## Trigger API

These endpoints enqueue jobs via `IntelligenceService.trigger*()`:

- `POST /api/intelligence/messages/:id/summary/retry` — retry failed summary
- `POST /api/intelligence/messages/:id/summary/trigger` — trigger summary (agent can also use)
- `POST /api/intelligence/messages/:id/tags/trigger` — trigger tags
- `POST /api/intelligence/messages/:id/reply-decision/trigger` — trigger reply decision
- `POST /api/intelligence/messages/:id/reply-draft/trigger` — trigger reply draft

All trigger endpoints accept an optional `source` field in the request body (defaults to `"user"`).

## Operate API

- `POST /api/intelligence/messages/:id/tags/:tag/confirm` — confirm suggested tag
- `POST /api/intelligence/messages/:id/tags/:tag/reject` — reject tag (existing endpoint, now goes through IntelligenceService)
- `POST /api/intelligence/messages/:id/draft/accept` — accept draft
- `POST /api/intelligence/messages/:id/draft/delete` — delete draft

## LLM Status API

`GET /api/system/llm-status` returns `{ configured: boolean, provider?: string, model?: string }`. Frontend uses this on app load to show/hide the LLM configuration banner.

## Audit Log

`intelligence_audit_log` table records every operation with:
- `email_id`, `action`, `processor`, `source`, `session_id`, `user_id`, `result_json`, `created_at`

Queryable by email_id (all operations on one email) or by source (all agent-triggered operations).
