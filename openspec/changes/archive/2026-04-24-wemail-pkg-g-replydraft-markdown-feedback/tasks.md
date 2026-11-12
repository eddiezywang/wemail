## 1. Prompt module

- [x] 1.1 Write failing test asserting `replyDraftPrompt.ts` exports stable constants including schema with `shouldReply` boolean and optional `draft`.
- [x] 1.2 Create `server/wemail/ai/prompts/replyDraftPrompt.ts`.

## 2. DraftFeedbackLog

- [x] 2.1 Write failing unit test: `DraftFeedbackLog.append(event)` produces a Markdown entry with correct event metadata and no body text.
- [x] 2.2 Write failing unit test: concurrent `append` calls are serialized and produce a well-formed file.
- [x] 2.3 Create `server/wemail/telemetry/DraftFeedbackLog.ts`.

## 3. ReplyDraftProcessor

- [x] 3.1 Write failing unit test: notification mail classified `shouldReply = false`; no draft generated.
- [x] 3.2 Write failing unit test: question mail classified `shouldReply = true`; draft persisted into `mail_ai_artifacts`.
- [x] 3.3 Write failing unit test: mass mail defaults conservative unless high confidence signals exist.
- [x] 3.4 Write failing unit test: processor never calls `MailProvider.sendDraft`.
- [x] 3.5 Create `server/wemail/intelligence/processors/ReplyDraftProcessor.ts` reusing `LlmClient` and `DB Service mail API`.
- [x] 3.6 Register the processor in the bus composition root.

## 4. API wiring

- [x] 4.1 Write failing integration test: `GET /api/intelligence/messages/:id` includes `shouldReply` and (when present) draft payload.
- [x] 4.2 Write failing integration test for `POST /api/mail/messages/:id/draft/accept`, `.../draft/edit_and_sent`, `.../draft/delete`; each triggers the correct `DraftFeedbackLog` entry.
- [x] 4.3 Modify `server/api/routes/mailRoutes.ts` and `server/api/routes/intelligenceRoutes.ts`.
- [x] 4.4 Run tests until green.

## 5. Safety

- [x] 5.1 Write test asserting the Markdown log never contains the incoming mail body.
- [x] 5.2 Write test asserting the AppLogger is not called with draft or body content.

## 6. Verification

- [x] 6.1 Run `npm run test:server` — must pass.
- [x] 6.2 Run `npm run typecheck:server` — must pass.
- [x] 6.3 Run `npm run typecheck:desktop` — must pass.
- [x] 6.4 Run `npm run build:desktop` — must pass.
- [x] 6.5 Confirm new code has unit / integration tests for processor, feedback log, and routes.
- [x] 6.6 Confirm no violations of Handoff §6 hard rules (no auto-send, no body in logs/markdown, queue not bypassed).
- [x] 6.7 Commit with the exact Handoff §5.G message: `git commit -m "feat(ai): add reply draft processor and feedback log"`.
