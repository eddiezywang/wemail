## Context

Package C defines `MailIntelligenceProcessor`. This package provides the first concrete implementation (summary) and the LLM adapter behind it. The shape established here is reused by Packages F and G.

## Goals / Non-Goals

**Goals:**

- `LlmClient` interface that abstracts OpenAI-compatible and Anthropic Messages providers behind one `generate(request) => structured result` method.
- Two concrete adapters: `OpenAiCompatibleClient` and `AnthropicMessagesClient`.
- One fixed phase-one prompt module `summaryPrompt.ts` exporting a constant prompt template and the expected JSON schema for the result.
- A `SummaryProcessor` that reads the message from `DB Service mail API`, calls `LlmClient`, validates the JSON, persists into `mail_ai_artifacts`, and respects `max_attempts = 2`.
- Exposes results via `GET /api/intelligence/messages/:id`.

**Non-Goals:**

- Streaming responses.
- Multiple summary prompts, user-configurable prompts, or per-message templates.
- Tag or draft generation (Packages F and G).

## Decisions

- **Single `generate` signature.** Inputs: `{ system, user, responseSchema }`. Outputs: `{ text, json? }` plus usage info. Adapters translate to provider-specific payloads. Alternative rejected: streaming-first interface — not needed for phase one summary.
- **Provider selection via config.** `LlmClient` is selected at composition root based on a WeMail-level setting (provider type, base URL, model, API key pulled from `SecretStore`). Keys NEVER reach logs.
- **Fixed prompt lives in a module.** `summaryPrompt.ts` exports `SUMMARY_SYSTEM`, `SUMMARY_USER_TEMPLATE`, and `SUMMARY_SCHEMA`. Templates use well-known placeholders (`{{subject}}`, `{{body}}`). Alternative rejected: database-stored prompt — violates "one fixed summary prompt".
- **Retry policy at processor level.** `SummaryProcessor.handle` increments the job row's `attempts`; when `attempts >= 2` after a failure, the job transitions to `failed`. This enforces "retry ≤ 2" centrally.
- **Schema validation.** Response JSON is validated against `SUMMARY_SCHEMA` (small manual validator or `zod` if already depended on). Validation failure counts as a retryable error unless attempts are exhausted.
- **Shared types reused.** `shared/wemail/intelligence.ts` (SummaryResult), `shared/wemail/queue.ts` (Job), `shared/wemail/account.ts`. Upstream interfaces consumed: `MailIntelligenceProcessor` (Package C), `DB Service mail API` (Package B), `SecretStore` (Package A).
- **No body in logs.** Logger in AI path logs only message id, model, token counts, latency, and outcome.

## Risks / Trade-offs

- **[Risk] LLM returns non-JSON despite system prompt.** → Mitigation: small tolerance (strip Markdown code fences), otherwise treat as retryable error.
- **[Risk] Provider rate limits burn retries.** → Mitigation: exponential backoff inside a single job attempt; distinct from the job-level retry counter.
- **[Risk] Accidentally sending body text into error-reporting sinks.** → Mitigation: error paths never include the outgoing prompt in the log; only message id and a short error code.
- **[Risk] Token overflow on long threads.** → Mitigation: upstream truncation heuristic documented; phase-one truncates body to a fixed char budget before templating.

## Migration Plan

- Additive: new files and new routes. No DB migrations beyond what `mail_ai_artifacts` already supports.
- Rollback: delete the new files and unregister the processor; queue jobs remain but transition to "no processor" as per Package C.

## Open Questions

- Final model defaults per provider — decided at implementation time; documented in a constants module.
