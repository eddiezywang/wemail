export interface AiProfileSettings {
  userDisplayName?: string;
  assistantPreference?: string;
  summaryLanguage?: string;
  todoLanguage?: string;
  composeLanguage?: string;
  translationLanguage?: string;
  /** Important contacts the user frequently communicates with. */
  importantContacts?: string[];
  /** Default language for AI-generated summaries. */
  defaultSummaryLanguage?: string;
  /** Default tone for reply drafts (e.g. "formal", "casual", "friendly"). */
  defaultReplyTone?: string;
  /** Whether to include a signature in drafted replies. */
  signaturePreference?: string;
  /**
   * Free-form Markdown instructions injected into the system prompt of every
   * AI feature (summary, tags, replyDecision, replyDraft, todoExtraction,
   * linkExtraction, translation, composeMail). Capped at 2000 characters.
   *
   * The text is stored and forwarded as plain text — Markdown is not parsed
   * server-side. upstream-parity surface: a single "tell the AI what you want"
   * textarea that affects every feature uniformly.
   */
  customInstructions?: string;
  /** Editable system instructions used only by the standalone todo job. */
  todoPrompt?: string;
  /**
   * Number of concurrent CanonicalAiWorker instances processing AI
   * intelligence jobs (summary/tags/reply-decision/todo). `undefined`/null
   * means "no user preference" — the runtime falls back to the
   * WEMAIL_AI_WORKER_CONCURRENCY env var, then to the default below.
   * Clamped to [AI_WORKER_CONCURRENCY_MIN, AI_WORKER_CONCURRENCY_MAX].
   */
  workerConcurrency?: number;
  updatedAt: string;
}

/** Maximum allowed length of `customInstructions`, in characters. */
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 2000;

/**
 * AI intelligence worker concurrency bounds. Single-sourced here so the
 * server (settings service + routes), the Electron main process (pool), and
 * the renderer (settings UI) all agree. Default is intentionally modest —
 * raising it increases concurrent LLM calls, whose real ceiling is the
 * provider's concurrency/RPM limit plus the shared circuit breaker.
 */
export const AI_WORKER_CONCURRENCY_MIN = 1;
export const AI_WORKER_CONCURRENCY_MAX = 16;

export const LLM_REASONING_EFFORT_VALUES = [
  "auto",
  "omit",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type LlmReasoningEffort = typeof LLM_REASONING_EFFORT_VALUES[number];
export const AI_WORKER_CONCURRENCY_DEFAULT = 2;

export const TODO_PROMPT_MAX_LENGTH = 8000;

export const DEFAULT_TODO_MANAGEMENT_PROMPT = `# Todo Management Rules

Decide when to create, update, complete, or skip todos.

Todos are persistent reminders for things I may need to do, remember, check, reply to, confirm, or follow up later. They are not an email archive.

## Core Rule

Be proactive, but keep the list clean.

Only create a todo for an action that is currently required or for a concrete
follow-up whose trigger is already in motion. General operating instructions
such as "if your details change", "if you want to change your selection", or
"if you later decide to withdraw" are reference information, not current todos.

Create or update a todo when a future reminder would clearly help me. The email does not need to phrase the task as an explicit command.

Before creating, check whether an existing todo, calendar event, or recent context already covers the same need. Prefer update or complete over duplicate creation.

Create one todo per outcome. When several sentences describe alternate
channels, prerequisites, exceptions, or steps for the same outcome, merge them
into one concise todo instead of copying each sentence into a separate item.

Example: an allocation-list announcement says to watch for a future selection
notice, then explains what to do if personal details change, if a room-type
change is later wanted, or if the recipient later withdraws. Create only the
currently useful reminder to watch for the selection notice. Do not create
separate todos for those conditional reference instructions.

## Create

Create a todo when the email implies a concrete future action, follow-up, responsibility, deadline, or check.

Usually create when:

- I need to reply, review, approve, confirm, submit, sign, pay, schedule, prepare, pick up, decide, send, or provide something.
- I need to respond by a date, RSVP, pay before access is lost, submit a document, renew, cancel, return, check in, or confirm details.
- I should follow up if someone else does not respond or complete something by a reasonable time.
- An offer, application, order, booking, appointment, ticket, invoice, contract, report, shipment, repair, refund, or account issue needs future tracking.
- A meeting, flight, appointment, trip, event, or booking has a separate preparation action, check-in action, document requirement, payment, reply, or confirmation step.
- The email changes an existing responsibility enough that a future reminder remains useful.

If the email was important enough to notify and there is a clear future action or follow-up, lean toward creating or updating a todo unless it is already covered.

## Update

Update an existing todo when the email changes the same responsibility:

- deadline or date
- status
- owner or waiting-on person
- link, order number, application ID, document, or reference
- next step
- risk or blocker

Do not create a second todo for the same responsibility just because a new email arrived.

## Complete

Complete or close a todo when the email clearly says the responsibility is done, accepted, cancelled, delivered, paid, submitted, approved, rejected, expired, or no longer needed.

If completion is likely but not certain, update the todo with the new status instead of completing it.

## Time

Use explicit dates from the email.

- \`end_time\`: deadlines, RSVP dates, payment dates, submission dates, cancellation windows, return windows, expiration dates, pickup deadlines, or follow-up dates.
- \`start_time\`: only when the reminder should appear at a specific time and calendar is not better.
- no time: okay when the follow-up is useful but no reliable date exists.

Do not invent precise dates.

## Skip

Skip todos for verification codes, marketing, newsletters, promotions, cold pitches, FYI-only mail, ordinary receipts, delivery confirmations, successful builds, successful logins, passive activity, hypothetical instructions whose condition has not occurred, things someone else owns without my follow-up, calendar-covered events with no separate action, already completed items with no future reminder, misdirected mail, and vague nice-to-have ideas.

## Quality

Write the todo as a short future action, not an email summary.

Include only what helps me act later: verb, person/project, object, deadline or trigger when useful. Do not copy every detail from the email.

For waiting items, write what I am waiting for or when to follow up.

Write the title in Simplified Chinese. Keep product names, platform names, ticket IDs, and other identifiers unchanged.

Good:
- \`与 Nanaco 确认 TechLedger 面试时间\`
- \`周五前回复 Dana 修改后的合同\`
- \`若房间名单仍未确认，跟进 Northstar\`
- \`5 月 31 日前提交报销收据\`

Bad:
- \`回复\` — too vague
- \`跟进\` — missing target
- \`检查邮件\` — describes the source, not the action
- \`审阅文档\` — missing which document
- \`Reply: confirm TechLedger interview time (Monday 11:00 AM Pacific) or provide alternative windows\` — wrong language and copies too much email detail`.trim();

export interface WritingStyle {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}
