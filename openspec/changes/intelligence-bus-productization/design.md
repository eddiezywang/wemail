# Intelligence Bus Productization — Design

## Context

Packages A–L are complete. The intelligence pipeline runs: `Mail Core sync worker` → `MailIntelligenceBus` → `QueueRunner` → `SummaryProcessor`/`TagProcessor`/`ReplyDraftProcessor` → `IntelligenceResultRepository`. The skeleton works but is architecturally rigid and lacks product-level polish.

Current coupling problems:
- Adding a new job type requires changes in 6+ files: shared types, `JobRepository.enqueueForMessage`, `MailIntelligenceBus` registration, `AppComposition`, API routes, and the processor itself
- `JobRepository.enqueueForMessage` hardcodes the three-way fan-out
- `QueueRunner` has no lane isolation — a slow draft job blocks summary jobs
- `IntelligenceResultRepository.findByEmailId` only returns succeeded results — the frontend can't distinguish "pending" from "failed" from "skipped"

## Architecture

### New Component Topology

```
Mail Core sync worker
       │
       │  new-mail event
       ▼
┌──────────────────────────────┐
│   IntelligenceOrchestrator   │  ← replaces MailIntelligenceBus
│                              │
│  1. LocalPrescreener.check() │  ← new, rule-based, no LLM
│  2. Fan-out strategy         │  ← per-mail capability plan
│  3. Conditional enqueue      │  ← replyDecision → replyDraft
└──────────┬───────────────────┘
           │
           │  enqueues IntelligenceJob[]
           ▼
┌──────────────────────────────┐
│       QueueRunner            │  ← evolved, lane-aware
│                              │
│  Per-lane config:            │
│    summary: timeout=30s      │
│    tags: timeout=25s         │
│    replyDecision: timeout=20s│
│    replyDraft: timeout=45s   │
└──────────┬───────────────────┘
           │
           │  dispatches by job.type
           ▼
┌──────────────────────────────┐
│     Capability Processors    │
│                              │
│  SummaryProcessor            │
│  TagProcessor                │  ← confidence tiers
│  ReplyDecisionProcessor      │  ← new
│  ReplyDraftProcessor         │  ← simplified
│  LocalPrescreener            │  ← new, no LLM
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  IntelligenceResultStore     │  ← evolved
│                              │
│  Stores result + status for  │
│  every terminal state:       │
│  succeeded / failed / skipped│
└──────────────────────────────┘
```

### Intelligence Service Layer (Agent-First Architecture)

WeMail is an AI-driven email client. Every intelligence capability must be callable from three entry points:

1. **System orchestration** — new-mail event triggers the automatic pipeline
2. **PI agent** — on-demand invocation via agent tools (read, trigger, operate)
3. **User action** — frontend buttons (retry summary, confirm tag, use draft)

All three paths MUST go through the same `IntelligenceService` layer. No capability is implemented directly in a route handler or agent tool — the service layer is the single source of truth for business logic.

```typescript
// server/wemail/intelligence/IntelligenceService.ts

export interface IntelligenceService {
  // ── Query (read-only, no side effects) ──

  /** Get the full intelligence state for an email (for frontend + agent) */
  getState(emailId: string): Promise<EmailIntelligenceState>;

  /** Get summary result only */
  getSummary(emailId: string): Promise<SummaryResult | null>;

  /** Get tag result only */
  getTags(emailId: string): Promise<TagResult | null>;

  /** Get reply decision result only */
  getReplyDecision(emailId: string): Promise<ReplyDecisionResult | null>;

  /** Get reply draft result only */
  getReplyDraft(emailId: string): Promise<ReplyDraftResult | null>;

  // ── Trigger (enqueue or execute a capability) ──

  /** Trigger summary generation for an email. Returns job ID. */
  triggerSummary(emailId: string, caller: CallerContext): Promise<string>;

  /** Trigger tag generation for an email. Returns job ID. */
  triggerTags(emailId: string, caller: CallerContext): Promise<string>;

  /** Trigger reply decision for an email. Returns job ID. */
  triggerReplyDecision(emailId: string, caller: CallerContext): Promise<string>;

  /** Trigger reply draft generation for an email. Returns job ID. */
  triggerReplyDraft(emailId: string, caller: CallerContext): Promise<string>;

  /** Retry a failed capability. Returns job ID. */
  retry(emailId: string, type: IntelligenceJobType, caller: CallerContext): Promise<string>;

  // ── Operate (mutate state with audit trail) ──

  /** Confirm a suggested tag (promote to auto-tier) */
  confirmTag(emailId: string, tagName: string, caller: CallerContext): Promise<void>;

  /** Reject a tag (create feedback rule, remove from email) */
  rejectTag(emailId: string, tagName: string, caller: CallerContext): Promise<void>;

  /** Accept a draft (mark as accepted in feedback log) */
  acceptDraft(emailId: string, caller: CallerContext): Promise<void>;

  /** Mark draft as edited-and-sent */
  editAndSendDraft(emailId: string, caller: CallerContext): Promise<void>;

  /** Delete a draft */
  deleteDraft(emailId: string, caller: CallerContext): Promise<void>;

  // ── System ──

  /** Check if LLM is configured */
  getLlmStatus(): { configured: boolean; provider?: string; model?: string };
}

export interface CallerContext {
  /** Who initiated this action */
  source: "system" | "agent" | "user";
  /** For agent calls: the agent session ID */
  sessionId?: string;
  /** For user calls: user identifier (phase one: always "default") */
  userId?: string;
  /** Additional metadata for audit logging */
  meta?: Record<string, string>;
}
```

Every method on `IntelligenceService` must:

1. Perform the business logic (enqueue job, update result, create feedback rule, etc.)
2. Write an audit log entry via `AuditLogService` with the `CallerContext`

The `CallerContext.source` field drives audit log filtering and future permission checks:
- `"system"` — automatic pipeline (new-mail triggered)
- `"agent"` — PI agent tool call
- `"user"` — frontend button click

### Agent Tool Surface

The PI agent's tools are thin wrappers over `IntelligenceService`. Each tool:

1. Receives agent input
2. Calls `IntelligenceService` with `source: "agent"`
3. Returns the result to the agent

Updated tool inventory:

| Tool | Maps To | Read/Write |
|------|---------|-----------|
| `list_mail` | `DB Service mail API.listMessages` | Read |
| `read_mail` | `DB Service mail API.getMessageById` | Read |
| `search_mail` | `DB Service mail API.listMessages` + filter | Read |
| `get_summary` | `IntelligenceService.getSummary` | Read |
| `get_tags` | `IntelligenceService.getTags` | Read |
| `get_reply_decision` | `IntelligenceService.getReplyDecision` | Read |
| `get_reply_draft` | `IntelligenceService.getReplyDraft` | Read |
| `get_intelligence_state` | `IntelligenceService.getState` | Read |
| `trigger_summary` | `IntelligenceService.triggerSummary` | Write (enqueue) |
| `trigger_tags` | `IntelligenceService.triggerTags` | Write (enqueue) |
| `trigger_reply_decision` | `IntelligenceService.triggerReplyDecision` | Write (enqueue) |
| `trigger_reply_draft` | `IntelligenceService.triggerReplyDraft` | Write (enqueue) |
| `retry_intelligence` | `IntelligenceService.retry` | Write (enqueue) |
| `confirm_tag` | `IntelligenceService.confirmTag` | Write (mutate) |
| `reject_tag` | `IntelligenceService.rejectTag` | Write (mutate) |

Key differences from current agent tools:
- **Trigger tools are new** — agent can now *initiate* intelligence generation, not just read existing results
- **`get_summary` returns state-aware results** — includes `status` field so agent knows if summary is pending/failed/skipped
- **No `send_mail` tool** — still forbidden. Draft acceptance goes through user-reviewed path
- **All writes are audited** — every trigger/confirm/reject records the agent session ID

### Audit Log for Intelligence Operations

New table: `intelligence_audit_log`

```sql
CREATE TABLE IF NOT EXISTS intelligence_audit_log (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- 'trigger-summary', 'trigger-tags', 'retry', 'confirm-tag', 'reject-tag', 'accept-draft', 'delete-draft', etc.
  processor TEXT,                -- which capability (null for non-processor actions)
  source TEXT NOT NULL,          -- 'system' | 'agent' | 'user'
  session_id TEXT,               -- agent session if source=agent
  user_id TEXT,                  -- user id if source=user
  result_json TEXT,              -- lightweight result snapshot (no mail body)
  created_at TEXT NOT NULL
);

CREATE INDEX idx_intelligence_audit_email ON intelligence_audit_log(email_id, created_at DESC);
CREATE INDEX idx_intelligence_audit_source ON intelligence_audit_log(source, created_at DESC);
```

The `source` field enables future analytics: "how many summaries were triggered by the agent vs system vs user?"

### New Component Topology

```
    ┌─────────────────────────────────────────────────────────┐
    │                    Callers                              │
    │                                                         │
    │  Mail Core sync worker     PI Agent          Frontend         │
    │  (new-mail event)   (tool calls)      (button clicks)  │
    └────────┬───────────────┬──────────────────┬────────────┘
             │               │                  │
             │               │                  │
             ▼               ▼                  ▼
    ┌─────────────────────────────────────────────────────────┐
    │              IntelligenceService                        │
    │                                                         │
    │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │
    │  │   Query     │  │   Trigger    │  │   Operate    │  │
    │  │  (read)     │  │  (enqueue)   │  │  (mutate)    │  │
    │  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘  │
    │         │                │                  │           │
    │         │    ┌───────────┴──────────┐       │           │
    │         │    │ IntelligenceOrchestr. │       │           │
    │         │    │  + FanOutStrategy     │       │           │
    │         │    │  + LocalPrescreener   │       │           │
    │         │    └───────────┬──────────┘       │           │
    │         │                │                  │           │
    │         ▼                ▼                  ▼           │
    │  ┌─────────────────────────────────────────────────┐   │
    │  │         JobRepository + ResultStore             │   │
    │  └────────────────────────┬────────────────────────┘   │
    │                           │                             │
    │                           ▼                             │
    │  ┌─────────────────────────────────────────────────┐   │
    │  │              QueueRunner                        │   │
    │  └────────────────────────┬────────────────────────┘   │
    │                           │                             │
    │                           ▼                             │
    │  ┌─────────────────────────────────────────────────┐   │
    │  │         Capability Processors                   │   │
    │  │  Summary / Tags / ReplyDecision / ReplyDraft    │   │
    │  └────────────────────────┬────────────────────────┘   │
    │                           │                             │
    │                           ▼                             │
    │  ┌─────────────────────────────────────────────────┐   │
    │  │         IntelligenceResultStore                 │   │
    │  └────────────────────────┬────────────────────────┘   │
    │                           │                             │
    │                           ▼                             │
    │  ┌─────────────────────────────────────────────────┐   │
    │  │         AuditLogService                         │   │
    │  │  (records every operation with CallerContext)    │   │
    │  └─────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────┘
```

The orchestrator is now *inside* the service layer. The system path (new-mail event) calls `IntelligenceService.triggerSummary/tags/replyDecision` which internally goes through the orchestrator. The agent path calls the same methods. The user path calls the same methods via API routes.

### Capability Registry Pattern

The key extensibility mechanism: each capability self-describes.

```typescript
// server/wemail/intelligence/CapabilityDescriptor.ts

export interface CapabilityDescriptor {
  /** Unique capability identifier */
  type: IntelligenceJobType;

  /** Factory for the processor instance */
  createProcessor(deps: ProcessorDeps): MailIntelligenceProcessor;

  /** Default lane configuration */
  lane: {
    maxAttempts: number;
    timeoutMs: number;
  };

  /** Whether this capability requires LLM */
  requiresLlm: boolean;

  /** Whether this capability can be pre-screened locally */
  prescreenable: boolean;
}
```

The orchestrator reads from a `CapabilityRegistry` (simple `Map<string, CapabilityDescriptor>`). Adding a new capability means:

1. Create one file implementing `CapabilityDescriptor` + `MailIntelligenceProcessor`
2. Register it in `AppComposition` with one line: `registry.register(myCapability)`

No shared type changes, no `JobRepository` modifications, no fan-out hardcoding.

### Fan-Out Strategy

Replace `JobRepository.enqueueForMessage` with a strategy object:

```typescript
// server/wemail/intelligence/FanOutStrategy.ts

export interface FanOutStrategy {
  /** Given a new mail message, return the list of jobs to enqueue */
  plan(mail: MailMessage, prescreenResult: PrescreenResult): IntelligenceJobPlan[];
}

export interface IntelligenceJobPlan {
  type: IntelligenceJobType;
  maxAttempts: number;
  /** If set, only enqueue after this job succeeds */
  dependsOn?: IntelligenceJobType;
}
```

Default strategy for phase one:

```typescript
class DefaultFanOutStrategy implements FanOutStrategy {
  plan(mail, prescreen): IntelligenceJobPlan[] {
    const jobs: IntelligenceJobPlan[] = [
      { type: "summary", maxAttempts: 2 },
      { type: "tags", maxAttempts: 3 },
    ];

    if (prescreen.skipReply) {
      // Still enqueue replyDecision so we record the skip reason
      // But it will be handled by LocalPrescreener, not LLM
      jobs.push({ type: "replyDecision", maxAttempts: 1 });
    } else {
      jobs.push({ type: "replyDecision", maxAttempts: 3 });
    }

    // replyDraft is NOT pre-enqueued
    // It gets enqueued by ReplyDecisionProcessor when shouldReply=true
    return jobs;
  }
}
```

### LocalPrescreener

```typescript
// server/wemail/intelligence/LocalPrescreener.ts

export interface PrescreenResult {
  skipReply: boolean;
  skipReason?: string;
  matchedRule?: string;
}

export class LocalPrescreener {
  private readonly noreplyPatterns: RegExp;
  private readonly notificationDomains: Set<string>;

  constructor(config?: PrescreenerConfig) {
    this.noreplyPatterns = /^(noreply|no-reply|notification|donotreply|donot-reply|mailer-daemon|postmaster)@/i;
    this.notificationDomains = new Set([
      "github.com", "stripe.com", "aws.amazon.com",
      "notifications.google.com", "mailer.linkedin.com",
    ]);
  }

  check(mail: { from: { email: string }; headers?: Record<string, string> }): PrescreenResult {
    // Rule 1: noreply sender pattern
    if (this.noreplyPatterns.test(mail.from.email)) {
      return { skipReply: true, skipReason: "noreply-sender", matchedRule: "sender-pattern" };
    }

    // Rule 2: known notification domain
    const domain = mail.from.email.split("@")[1]?.toLowerCase();
    if (domain && this.notificationDomains.has(domain)) {
      return { skipReply: true, skipReason: "notification-domain", matchedRule: "domain-list" };
    }

    // Rule 3: bulk/list headers
    if (mail.headers?.["precedence"] === "bulk" || mail.headers?.["list-id"]) {
      return { skipReply: true, skipReason: "bulk-mailing-list", matchedRule: "header-check" };
    }

    return { skipReply: false };
  }
}
```

### ReplyDecision Split

**ReplyDecisionProcessor** (new):

```typescript
// Input: mail body + optional summary (if available)
// Output: { shouldReply, reason, confidence }
// If shouldReply=true → enqueues a replyDraft job for the same email
```

This processor is lightweight: smaller prompt, fewer tokens, faster response. It's the gate that prevents unnecessary draft generation.

**ReplyDraftProcessor** (simplified):

```typescript
// Input: mail body + replyDecision result (reason + context)
// Output: { draftMarkdown }
// No longer decides shouldReply — that's ReplyDecisionProcessor's job
```

### Skipped State Implementation

1. **Add `"skipped"` to `JobStatus`** in `shared/wemail/intelligence.ts`
2. **Add `markJobSkipped(id, reason)` to `JobRepository`**
3. **`IntelligenceResultRepository.saveSkipped(emailId, processor, reason)`** — stores a result row with `status='skipped'` and `result_json` containing the skip reason
4. **`QueueRunner`** handles skipped outcome from dispatch (bus returns `{ kind: "skipped", reason }`)
5. **`IntelligenceResultRepository.findByEmailId`** returns all statuses, not just succeeded

### Tag Confidence Tiers

```typescript
// In TagProcessor output
interface TagSuggestion {
  name: string;
  confidence: number;     // 0-1
  source: "system" | "ai";
  tier: "auto" | "suggested";  // derived from confidence
}

// Derivation rule:
// confidence >= 0.85 → tier = "auto" (applied automatically)
// confidence < 0.85  → tier = "suggested" (shown as suggestion)
// BUILTIN_TAGS that match → bumped to "auto" tier
```

Frontend renders auto-tier tags normally, suggested-tier tags with a distinct visual treatment and confirm/dismiss actions.

### Frontend Intelligence State

New shared type for frontend consumption:

```typescript
// shared/wemail/intelligence.ts

export interface EmailIntelligenceState {
  emailId: string;
  summary: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    result?: SummaryResult;
    canRetry?: boolean;
  };
  tags: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    result?: TagResult;  // includes tier per tag
  };
  replyDecision: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    result?: ReplyDecisionResult;
    skipReason?: string;
  };
  replyDraft: {
    status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "not-needed";
    result?: ReplyDraftResult;
    canRetry?: boolean;
  };
}
```

The "not-needed" status for replyDraft is virtual — it's not a DB status, it's derived from `replyDecision.shouldReply=false`.

### Model-Not-Configured Handling

When `LlmClient` is undefined in `AppComposition`:
- All LLM-requiring jobs are immediately marked `skipped` with reason `"llm-not-configured"`
- `LocalPrescreener` still runs (no LLM needed)
- A new API endpoint `GET /api/system/llm-status` returns `{ configured: boolean }`
- Frontend polls this on startup; if `false`, shows a global banner: "AI features require LLM configuration. Go to Settings → AI Setup."

## Decisions

1. **Agent-first: IntelligenceService as single entry point** — Every intelligence operation (query, trigger, operate) goes through `IntelligenceService`. This is the core architectural principle. System orchestration, PI agent tools, and frontend API routes all call the same service methods. This ensures consistent business logic, audit logging, and permission enforcement regardless of caller.

2. **CallerContext tracks who initiated every operation** — Every write operation carries a `CallerContext` with `source: "system" | "agent" | "user"`. This is written to the audit log and enables future permission controls (e.g. "agent can trigger summary but not delete drafts").

3. **Orchestrator replaces Bus** — `IntelligenceOrchestrator` is a new class that supersedes `MailIntelligenceBus`. The bus is deprecated but not deleted during transition (both exist until migration is complete).

4. **Capability Descriptor pattern** — Each capability self-describes its requirements, lane config, and processor factory. The orchestrator uses this to build the fan-out plan dynamically. This is the primary extensibility mechanism.

5. **Conditional enqueue, not conditional dispatch** — replyDraft is not pre-enqueued. ReplyDecisionProcessor enqueues it on success. This avoids "ghost jobs" sitting in pending that never run.

6. **Prescreen before enqueue** — LocalPrescreener runs synchronously in the orchestrator before any job is created. For pre-screened mail, `replyDecision` gets maxAttempts=1 and is handled by a special lightweight code path that marks it skipped without touching the LLM.

7. **Result store tracks all terminal states** — `mail_ai_artifacts` now has rows for `succeeded`, `failed`, and `skipped`. The frontend queries this table (not `mail_jobs`) for display state. Jobs are the execution mechanism; results are the display mechanism.

8. **Single QueueRunner, lane-aware** — Rather than multiple queue runners, we add per-type timeout config to the existing runner. Concurrency is still sequential but with per-type timeouts. Phase two can add parallel lane processing.

9. **Summary retry is caller-agnostic** — Any caller (system, agent, user) can trigger a retry via `IntelligenceService.retry()`. The frontend exposes it as a button; the agent gets a `retry_intelligence` tool.

10. **Agent trigger tools are safe** — Trigger tools only enqueue jobs; they don't bypass the queue or execute synchronously. This preserves the existing safety model: no auto-send, no direct mutation, everything goes through the audited pipeline.

11. **New `intelligence_audit_log` table** — Dedicated audit table for intelligence operations, separate from the existing `wecli_audit_logs`. Records every trigger, retry, confirm, reject with caller context. Enables analytics on usage patterns across system/agent/user.

12. **No new DB tables beyond audit log** — The existing `mail_jobs` and `mail_ai_artifacts` tables gain the `skipped` status and a few nullable columns. Only `intelligence_audit_log` is genuinely new. Migrations are additive only.

## File Structure

```
server/wemail/intelligence/
  IntelligenceService.ts         ← NEW (unified service layer for system/agent/user)
  IntelligenceOrchestrator.ts    ← NEW (replaces MailIntelligenceBus)
  CapabilityDescriptor.ts        ← NEW
  CapabilityRegistry.ts          ← NEW
  FanOutStrategy.ts              ← NEW
  DefaultFanOutStrategy.ts       ← NEW
  LocalPrescreener.ts            ← NEW
  MailIntelligenceBus.ts         ← DEPRECATED (keep during transition)
  MailIntelligenceProcessor.ts   ← EVOLVED (add skipped return type)
  processors/
    SummaryProcessor.ts          ← MINOR CHANGES (extract shared validation)
    TagProcessor.ts              ← EVOLVED (confidence tiers)
    ReplyDecisionProcessor.ts    ← NEW
    ReplyDraftProcessor.ts       ← SIMPLIFIED (no decision logic)
    SharedProcessorUtils.ts      ← NEW (shared validation, body budget)

server/wemail/queue/
  QueueRunner.ts                 ← EVOLVED (per-lane timeout, skipped handling)
  JobRepository.ts               ← EVOLVED (skipped state, remove hardcoded fan-out)

server/wemail/feedback/
  TagFeedbackRuleRepository.ts   ← UNCHANGED

server/wemail/telemetry/
  AuditLogService.ts             ← NEW (intelligence operation audit logging)
  AuditLogRepository.ts          ← EVOLVED (add intelligence_audit_log table)

server/wemail/agent/
  MailAgentTools.ts              ← EVOLVED (add trigger/operate tools, use IntelligenceService)

shared/wemail/
  intelligence.ts                ← EVOLVED (add replyDecision types, skipped to JobStatus, EmailIntelligenceState, CallerContext)
  queue.ts                       ← MINOR CLEANUP

app/components/wemail/
  EmailSummaryCard.tsx           ← EVOLVED (loading/failed/retry states)
  EmailSmartTags.tsx             ← EVOLVED (suggested tier UI)
  SmartDraftPanel.tsx            ← EVOLVED (not-needed state removed per decision)
  LlmConfigBanner.tsx            ← NEW (global prompt when LLM not configured)
```

## Risks / Trade-offs

- **[Risk] Two-step reply pipeline adds latency for mails that need drafts.** → Mitigation: replyDecision is a fast prompt (~200 tokens vs ~800 for draft). Net cost savings on non-reply mail more than compensate.

- **[Risk] Capability Descriptor pattern adds abstraction overhead.** → Mitigation: the interface is minimal (4 fields + 1 factory method). The benefit of adding capabilities without touching 6 files outweighs the small indirection cost.

- **[Risk] Conditional enqueue makes debugging harder — replyDraft jobs appear mid-flow.** → Mitigation: `IntelligenceResultRepository.findByEmailId` provides a unified view regardless of when jobs were enqueued. The orchestrator logs the full plan on each new mail.

- **[Risk] Per-lane timeout in a single QueueRunner is still sequential.** → Mitigation: acceptable for phase one volume. The architecture supports adding parallel lane processing later without changing the orchestrator.

- **[Risk] `skipped` state in `mail_ai_artifacts` means more rows to query.** → Mitigation: `findByEmailId` is already scoped to a single email. Index on `(email_id, processor)` exists.

## Migration Plan

Phase A (backwards compatible):
1. Add `skipped` to `JobStatus` and `IntelligenceResultRepository.saveSkipped()`
2. Add `IntelligenceOrchestrator`, `CapabilityDescriptor`, `FanOutStrategy`, `LocalPrescreener`
3. Add `ReplyDecisionProcessor` alongside existing `ReplyDraftProcessor`
4. Wire orchestrator in `AppComposition` alongside old bus

Phase B (cutover):
5. Switch `Mail Core sync worker` event subscription from old bus to orchestrator
6. Update `QueueRunner` for per-lane timeout and skipped handling
7. Add `EmailIntelligenceState` API endpoint
8. Update frontend components

Phase C (cleanup):
9. Remove deprecated `MailIntelligenceBus`
10. Remove hardcoded `JobRepository.enqueueForMessage`
11. Clean up shared type compat shims

Rollback: Each phase is independently revertible. Phase A adds new code without changing existing behavior. Phase B is a single cutover point. Phase C is removal only.
