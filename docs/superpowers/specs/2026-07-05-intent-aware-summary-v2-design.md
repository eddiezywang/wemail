# Intent-Aware Summary v2 Design

## Problem

The current summary pipeline treats every email as the same task: compress the
body into `bullets` plus optional `actionItems`. That makes simple low-attention
emails look over-processed. Invoice notifications, receipts, login alerts, and
system notices can become longer than the source because the model repeats every
available fallback instruction as if it were an action.

The product problem is not only "too many bullets." The system does not first
decide how much user attention the message deserves.

## Goal

Make summaries answer the user's real triage questions:

1. What is this email?
2. Do I need to do anything?
3. If not, what is the one thing worth knowing?

The summary should adapt its density to the message. A no-reply invoice should
be one line. A customer request should surface the ask and deadline. A long
thread should summarize current state, decision, unresolved questions, and next
step.

## Non-Goals

- Do not rebuild the email detail UI in the first implementation.
- Do not create one hard-coded prompt per sender or provider.
- Do not remove existing `summary`, `todoExtraction`, or `replyDecision`
  capabilities.
- Do not make the summary processor auto-create todos. It can expose actions;
  todo creation remains a separate capability.

## Recommended Approach

Add an intent-aware planning layer inside the summary result. The LLM still runs
once per email, but the schema forces it to classify the email's intent and
attention level before producing user-visible summary text.

The processor asks for:

```ts
interface SummaryV2Result {
  type: "summary";
  schemaVersion: 2;
  intent:
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
  attention: "ignore" | "know" | "verify" | "reply" | "act" | "follow_up";
  displayMode: "one_line" | "brief" | "actionable" | "thread";
  headline: string;
  details: string[];
  actions: string[];
  urgency: "low" | "medium" | "high";
  rationale?: string;
}
```

The existing `SummaryResult` can remain as a compatibility projection:

```ts
bullets = [headline, ...details]
actionItems = actions
```

That keeps the first implementation small and avoids a coordinated UI rewrite.

## Attention Policy

The model should classify the email's attention need, then obey the display
budget implied by that classification.

| Condition | Expected attention | Display mode | Output density |
| --- | --- | --- | --- |
| Invoice, receipt, bill paid, ordinary attachment notification | `know` | `one_line` | One headline, no actions |
| Login alert, delivery notice, account notification with no anomaly | `know` | `one_line` | One headline, no actions |
| Marketing or newsletter | `ignore` or `know` | `one_line` | One headline, no actions |
| Sender explicitly asks recipient to reply | `reply` | `actionable` | Headline plus actions |
| Sender asks recipient to submit, approve, review, pay, sign, or schedule | `act` | `actionable` | Ask, owner/deadline if present, actions |
| Security warning, outage, failed payment, compliance issue | `verify` or `act` | `actionable` | Risk, impact, required check |
| Multi-message thread | `follow_up` or best matching state | `thread` | Current state, decision, unresolved questions, next step |

## Guardrails

Post-processing should enforce the intent policy so the model cannot make low
attention emails noisy.

- `displayMode === "one_line"`:
  - `details` max 1 item.
  - `actions` must be empty unless the source explicitly demands recipient
    action.
  - `headline` max 90 Chinese characters or 180 Latin characters.
- `attention in ("ignore", "know")`:
  - no imperative action unless source contains a real request to the recipient.
  - phrases like "can download", "may view", "for reference", and "if not
    received, check spam" are details, not actions.
- `intent in ("invoice", "receipt", "system_notice", "marketing")`:
  - default to `one_line` and `urgency: "low"`.
  - action extraction requires explicit obligation, deadline, approval, payment,
    or reply.
- Numeric values, dates, invoice numbers, deadlines, and attachment names should
  be preserved when they matter to the user.
- Email body remains data only. Prompt-injection text in the body cannot override
  the summary policy.

## Example

Input:

> Subject: 湖北电信电子发票
> Body: 附件是办理业务的电子发票。电子发票等效纸质发票，可下载打印使用。若未收到可查垃圾箱或登录营业厅查询。

Expected v2 output:

```json
{
  "type": "summary",
  "schemaVersion": 2,
  "intent": "invoice",
  "attention": "know",
  "displayMode": "one_line",
  "headline": "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
  "details": [],
  "actions": [],
  "urgency": "low"
}
```

## Pipeline

1. `SummaryProcessor` builds bounded email context exactly as today.
2. The summary prompt requests the v2 schema with intent, attention,
   displayMode, headline, details, and actions.
3. The processor validates the v2 shape.
4. The processor applies guardrails:
   - trim overlong headline/details.
   - downgrade noisy actions for low-attention intents.
   - force low urgency for ordinary notifications unless risk or deadline is
     explicit.
5. The processor stores v2 result metadata.
6. API responses expose both:
   - native v2 fields for future UI.
   - legacy projection for current UI.

## UI Migration

Phase 1 keeps current UI working by rendering the projected `bullets` and
`actionItems`.

Phase 2 updates `EmailIntelligenceCard` to prefer v2 fields:

- `one_line`: show only the headline.
- `brief`: show headline plus details.
- `actionable`: show headline plus explicit actions.
- `thread`: show headline, current state details, actions/open questions.

The user-facing visual rule is: a summary card should spend screen space in
proportion to the user's required attention.

## Testing Strategy

Add focused processor and prompt tests. The test corpus should include:

- Invoice notification: one headline, no actions.
- Receipt or paid bill: one headline, no actions.
- Login reminder with no anomaly: one headline, no actions.
- Login warning from new device: verify/actionable when risk is explicit.
- Marketing email: low attention, no actions.
- Customer asks a question: reply/actionable.
- Approval request with deadline: actionable with deadline preserved.
- Meeting scheduling: actionable only when scheduling is requested.
- Long thread: thread mode summarizes current state instead of repeating each
  message.
- Prompt injection body: does not change policy or create fake actions.

Regression checks should assert both native v2 fields and legacy projection, so
older UI paths do not regress during migration.

## Rollout

1. Add v2 types and schema while keeping legacy `SummaryResult`.
2. Update prompt and processor validation.
3. Add guardrail post-processing.
4. Add corpus tests and one fixture matching the 湖北电信 invoice case.
5. Project v2 output to legacy fields for the existing UI.
6. Later, update `EmailIntelligenceCard` to render v2 fields directly.

## Open Questions

- Should v2 replace the old row shape immediately, or should stored result JSON
  support both `schemaVersion` 1 and 2 during a migration window?
- Should `rationale` be stored for debugging only, hidden from UI, or omitted to
  reduce output tokens?
- Should thread summaries use the same v2 schema or keep the existing
  evidenceRefs-oriented thread result and add intent/attention fields later?
