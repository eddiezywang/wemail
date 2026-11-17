## Why

Summary is phase one's most stable intelligence feature and the reference integration for the LLM layer. This package introduces the `LlmClient` abstraction (OpenAI-compatible + Anthropic Messages adapters), the single fixed summary prompt, and the `SummaryProcessor` that Package C's queue runner dispatches to — producing structured summary JSON per message and exposing it via the intelligence API.

## What Changes

- Add `server/wemail/ai/LlmClient.ts` — unified `generate(input) => StructuredResult` interface.
- Add `server/wemail/ai/OpenAiCompatibleClient.ts` — adapter for OpenAI-compatible endpoints.
- Add `server/wemail/ai/AnthropicMessagesClient.ts` — adapter for Anthropic Messages API.
- Add `server/wemail/ai/prompts/summaryPrompt.ts` — one fixed phase-one summary prompt.
- Add `server/wemail/intelligence/processors/SummaryProcessor.ts` — reads mail body via `DB Service mail API`, calls `LlmClient`, writes structured JSON into `mail_ai_artifacts`, with retry ≤ 2.
- Modify `server/wemail/intelligence/MailIntelligenceBus.ts` to register `SummaryProcessor` on startup (or to receive it via composition root).
- Modify `server/api/routes/intelligenceRoutes.ts` so `GET /api/intelligence/messages/:id` returns the persisted summary.

## Capabilities

### New Capabilities
- `llm-summary-processor`: the LLM client abstraction, the fixed summary prompt, and the queue-driven summary processor.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **Package C** (`wemail-pkg-c-mail-queue-wiring`) — provides the processor interface and the dispatch path.
- Transitively depends on Packages A and B.
- Downstream: Packages F (tag) and G (reply draft) reuse `LlmClient`; Package J (PI agent) calls `get_summary`.

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- **LLM: OpenAI-compatible + Anthropic Messages** (this package defines the shape).
- Built-in agent is PI (not Claude Code).
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited.
- Logout MUST NOT wipe local DB.
- New mail → durable queue; **summary retry ≤ 2** (enforced here).
- **One fixed summary prompt** (no dynamic prompt construction).
- Agent may draft but never auto-send.
- No mail body in logs (LLM request/response diagnostics MUST NOT include body).
- Windows-only phase one, but logic stays cross-platform.

## Impact

- Code: `server/wemail/ai/*`, `server/wemail/intelligence/processors/SummaryProcessor.ts`, `server/wemail/intelligence/MailIntelligenceBus.ts`, `server/api/routes/intelligenceRoutes.ts`.
- DB: writes into existing `mail_ai_artifacts` table.
- API: `GET /api/intelligence/messages/:id` now returns the summary payload.
- Dependencies: HTTP client of choice (native `fetch` preferred); no SDKs required.
