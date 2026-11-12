# Contextual Agent Suggestions Design

## Problem

The right-side WeMail AI panel currently presents suggestion chips as generic AI
capabilities. For a focused email, that is the wrong product contract. The chips
should answer: "What is the most likely next action the user wants to take on
this email?"

In the invoice example, the system already has tools for allowance invoice
upload, but the panel falls back to "总结 / 起草回复 / 提取待办". That makes the
surface feel hard-coded and misses the user's actual workflow.

## Goal

Generate at most three to four focused suggestions for the current email:

1. Prefer high-priority, email-specific business actions.
2. Use default AI capabilities only as fallback when no strong action is found.
3. Keep built-in workflows for known scenarios, while allowing personalized
   action extraction from the email content and user preferences.

## Non-Goals

- Do not auto-execute high-risk actions. Actions such as invoice upload still
  create pending confirmation cards.
- Do not replace the agent runtime or tool inventory.
- Do not build a full user-authored rules UI in the first implementation.
- Do not show more than four suggestions.

## Product Model

Suggestion generation has two layers.

### Layer 1: Built-In Scenario Actions

Built-in actions are deterministic or near-deterministic mappings from known
email scenarios to existing product workflows. They have the highest priority
because they represent concrete user jobs, not generic AI operations.

Initial scenarios:

| Scenario | Signals | Suggested action | Execution path |
| --- | --- | --- | --- |
| Invoice / reimbursement | summary intent `invoice` or invoice-like subject/snippet/attachment | 上传发票到发票平台 | agent prompt calls `find_invoice_attachments`, then `propose_allowance_invoice_upload` |
| Meeting | summary intent `meeting`, calendar/schedule language | 整理会议事项 | agent prompt extracts agenda, decisions, attendees, time, and follow-up items from the focused mail |
| Alert / incident | summary intent `risk`, alert keywords, severity language | 分析告警影响 / 查询历史告警频率 | agent prompt analyzes the focused mail and searches available mailbox context; it must not claim code-system access unless a code tool is registered |
| Approval | summary intent `approval`, approve/review/sign language | 处理审批 / 提取审批要点 | agent prompt summarizes decision, risks, and required confirmation |

The first implementation must ship invoice because the end-to-end tool chain
already exists. Other scenarios should be represented by clear candidate
builders and tests where current tools can support the action without pretending
to complete unavailable integrations.

### Layer 2: Personalized Action Extraction

When no built-in action confidently applies, or when the email contains a
specific non-built-in request, the system derives action suggestions from:

- summary v2 fields: `intent`, `attention`, `actions`, `actionItems`, `urgency`;
- todo extraction results and reply decision results;
- mail envelope and attachment metadata;
- AI profile custom instructions and learned preferences when available.

The extracted action is not a raw todo label. It must be phrased as something
the AI panel can start, for example:

- "核对这张账单金额"
- "整理客户提出的三个问题"
- "分析这次告警是否重复出现"
- "把会议决议整理成待办"

Each personalized action must carry a confidence score and a reason. Low
confidence actions are discarded before fallback suggestions are added.

## Fallback Suggestions

Fallback suggestions are only shown when no high-priority business action is
available. They are capped and context-aware.

Candidate fallback set:

- 总结
- 翻译
- 起草回复
- 提取待办

Rules:

- Maximum visible suggestions: 4.
- Preferred default count: 3.
- If one or more high-priority actions exist, fill remaining slots with fallback
  suggestions only when useful.
- Do not show "起草回复" when reply decision says no reply is needed.
- Do not show "提取待办" when todo extraction already produced todos or summary
  has no action items.
- Do not show "翻译" when translation is already complete or not needed.
- "总结" is the last fallback and should not displace a stronger action.

## Ranking

Suggestions are sorted by priority, then confidence:

1. Built-in executable workflow actions.
2. Personalized actions extracted from the email's concrete requests.
3. Context-aware fallback capabilities.

The renderer should receive only the final capped list. The frontend should not
re-rank suggestions beyond preserving API order.

## Backend Shape

Extend the existing `SuggestionBuilder` into a candidate pipeline:

```ts
interface SuggestionCandidate {
  id: string;
  label: string;
  prompt: string;
  reason: string;
  priority: number;
  confidence: number;
  source: "built-in" | "personalized" | "fallback";
}
```

`buildSuggestions()` should:

1. collect built-in scenario candidates;
2. collect personalized action candidates from intelligence state and envelope;
3. collect fallback candidates only as needed;
4. de-duplicate by normalized label/prompt intent;
5. sort by `priority` and `confidence`;
6. return at most four suggestions.

## API Behavior

`GET /api/agent/suggestions?accountId=&emailId=` remains the renderer contract.

For focused email requests, the route should use the richer agent context
instead of only `getState(emailId)` so the builder can inspect envelope and
attachment metadata. The response may remain backward-compatible:

```ts
{ id: string; label: string; prompt: string }[]
```

The internal builder can keep reason/source/confidence for tests and later UI
explanations.

## Invoice Behavior

For a focused invoice email with an invoice-like attachment, the first chip
should be:

```json
{
  "id": "upload-allowance-invoice",
  "label": "上传发票到发票平台",
  "prompt": "查找当前邮件 <emailId> 的发票附件，并创建上传到发票平台的确认操作。只处理当前邮件，等待我确认后再执行。"
}
```

The agent prompt must explicitly keep scope to the current focused email unless
the user asks for a wider mailbox range.

## Testing Strategy

Add backend tests for `SuggestionBuilder` and agent suggestions route:

- invoice email with attachment returns upload action first;
- invoice email does not fall back to only "总结 / 起草回复 / 提取待办";
- no high-priority action returns at most three context-aware fallback chips;
- reply fallback is suppressed when reply is not needed;
- todo fallback is suppressed when no action items exist;
- translation fallback is suppressed when translation is complete;
- personalized summary action is created from concrete action text when no
  built-in scenario applies;
- route preserves ordering and caps the response at four suggestions.

Frontend changes should be minimal because `AgentPanel` already renders backend
suggestions in API order and caps to three. If backend decides to allow four,
update the frontend cap and tests together.

## Rollout

1. Refactor `SuggestionBuilder` into candidate collection, ranking, and fallback
   selection.
2. Add invoice built-in scenario and tests.
3. Add generic personalized action extraction from summary/todo/reply state.
4. Update `GET /api/agent/suggestions` to pass envelope context.
5. Adjust frontend cap to the agreed visible maximum.
6. Run backend route tests and focused frontend agent panel tests.
