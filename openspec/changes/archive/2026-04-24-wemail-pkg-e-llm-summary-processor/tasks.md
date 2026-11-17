## 1. LlmClient interface

- [x] 1.1 Write failing unit test for the `LlmClient.generate` contract using a fake adapter.
- [x] 1.2 Create `server/wemail/ai/LlmClient.ts` with the interface and a factory that selects an adapter from configuration.

## 2. OpenAI-compatible adapter

- [x] 2.1 Write failing unit test for `OpenAiCompatibleClient` against an HTTP mock.
- [x] 2.2 Create `server/wemail/ai/OpenAiCompatibleClient.ts`; use `SecretStore` for the API key.
- [x] 2.3 Run tests until green; assert no API key appears in logs.

## 3. Anthropic Messages adapter

- [x] 3.1 Write failing unit test for `AnthropicMessagesClient` against an HTTP mock.
- [x] 3.2 Create `server/wemail/ai/AnthropicMessagesClient.ts`; use `SecretStore` for the API key.
- [x] 3.3 Run tests until green.

## 4. Summary prompt

- [x] 4.1 Write failing test asserting `summaryPrompt.ts` exports stable constants and a schema.
- [x] 4.2 Create `server/wemail/ai/prompts/summaryPrompt.ts`.
- [x] 4.3 Add a test that the prompt module has no dynamic/template override path.

## 5. SummaryProcessor

- [x] 5.1 Write failing unit test: happy-path summary persisted into `mail_ai_artifacts` and job marked `done`.
- [x] 5.2 Write failing unit test: transient failure increments `attempts`; second failure caps retry at 2; third failure marks `failed`.
- [x] 5.3 Write failing unit test: invalid JSON response is treated as retryable error until retries exhausted.
- [x] 5.4 Create `server/wemail/intelligence/processors/SummaryProcessor.ts`; wire to `DB Service mail API` and `LlmClient`.
- [x] 5.5 Modify `server/wemail/intelligence/MailIntelligenceBus.ts` composition root to register `SummaryProcessor`.

## 6. API wiring

- [x] 6.1 Write failing integration test: `GET /api/intelligence/messages/:id` returns persisted summary.
- [x] 6.2 Modify `server/api/routes/intelligenceRoutes.ts`.
- [x] 6.3 Run tests until green.

## 7. Safety

- [x] 7.1 Write test that AI log lines never contain prompt bodies or response bodies.

## 8. Verification

- [x] 8.1 Run `npm run test:server` — must pass.
- [x] 8.2 Run `npm run typecheck:server` — must pass.
- [x] 8.3 Run `npm run typecheck:desktop` — must pass.
- [x] 8.4 Run `npm run build:desktop` — must pass.
- [x] 8.5 Confirm new code has unit tests for client interface, both adapters, and the processor.
- [x] 8.6 Confirm no violations of Handoff §6 hard rules (retry ≤ 2, one fixed prompt, no body in logs, no secret leakage).
- [x] 8.7 Commit with the exact Handoff §5.E message: `git commit -m "feat(ai): add summary processor"`.
