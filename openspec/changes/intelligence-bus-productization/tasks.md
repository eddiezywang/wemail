# Intelligence Bus Productization — Tasks

## Phase A: Backwards-Compatible Foundation

### Task 1: Add `skipped` to `JobStatus` and result storage

- [ ] Add `"skipped"` to `JobStatus` union in `shared/wemail/intelligence.ts`
- [ ] Add `CallerContext` type to `shared/wemail/intelligence.ts`: `{ source: "system" | "agent" | "user", sessionId?, userId?, meta? }`
- [ ] Add `markJobSkipped(id: string, reason: string)` to `JobRepository`
- [ ] Add `saveSkipped(emailId, processor, reason, matchedRule?)` to `IntelligenceResultRepository`
- [ ] Update `IntelligenceResultRepository.findByEmailId` to return all statuses (not just `succeeded`)
- [ ] Add migration: update any existing `mail_ai_artifacts` rows without status to `status='succeeded'` (data fix)
- [ ] Verify typecheck passes

### Task 2: Add `replyDecision` job type to shared contracts

- [ ] Add `"replyDecision"` to `IntelligenceProcessorName` and `IntelligenceJobType` in `shared/wemail/intelligence.ts`
- [ ] Define `ReplyDecisionResult` type: `{ type: "replyDecision", shouldReply: boolean, reason: string, confidence: number }`
- [ ] Update `ReplyDraftResult`: remove `shouldReply` and `rationale` fields, keep only `draftMarkdown`
- [ ] Update `IntelligenceResult` discriminated union to include `replyDecision`
- [ ] Define `EmailIntelligenceState` type for frontend + agent consumption
- [ ] Verify typecheck passes (expect some errors in existing ReplyDraftProcessor — acceptable)

### Task 3: Add `headers` field to `MailMessage`

- [ ] Add `headers?: Record<string, string>` to `MailMessage` in `shared/wemail/mail.ts`
- [ ] Update `ImapSmtpMailProvider` to populate `precedence`, `list-id`, `x-auto-response-suppress` headers during sync
- [ ] Update `normalizeMail.ts` to extract relevant headers from IMAP envelope
- [ ] Verify typecheck passes

### Task 4: Implement `LocalPrescreener`

- [ ] Create `server/wemail/intelligence/LocalPrescreener.ts`
- [ ] Implement `PrescreenResult` interface and `check()` method
- [ ] Implement sender pattern rule (noreply@, no-reply@, etc.)
- [ ] Implement notification domain rule (configurable set with defaults)
- [ ] Implement bulk header rule (Precedence: bulk, List-Id)
- [ ] Write unit tests for each rule (use `node --import tsx --test`)
- [ ] Verify all tests pass

### Task 5: Implement `CapabilityDescriptor` and `CapabilityRegistry`

- [ ] Create `server/wemail/intelligence/CapabilityDescriptor.ts` with `CapabilityDescriptor` interface
- [ ] Create `server/wemail/intelligence/CapabilityRegistry.ts` with register/get/getAll methods
- [ ] Define `ProcessorDeps` interface: `{ llmClient?, mailRepo, resultRepo, jobRepo, feedbackRepo?, logger }`
- [ ] Verify typecheck passes

### Task 6: Implement `FanOutStrategy`

- [ ] Create `server/wemail/intelligence/FanOutStrategy.ts` with `FanOutStrategy` interface and `IntelligenceJobPlan` type
- [ ] Create `server/wemail/intelligence/DefaultFanOutStrategy.ts`
- [ ] Implement `plan()` method: summary(2) + tags(3) + replyDecision(3 or 1 if prescreened)
- [ ] replyDraft is never in the plan — it's conditionally enqueued by ReplyDecisionProcessor
- [ ] Write unit tests for DefaultFanOutStrategy
- [ ] Verify all tests pass

### Task 7: Implement `IntelligenceOrchestrator`

- [ ] Create `server/wemail/intelligence/IntelligenceOrchestrator.ts`
- [ ] Constructor takes: `CapabilityRegistry`, `JobRepository`, `LocalPrescreener`, `FanOutStrategy`, `Mail Core sync worker?`, `logger`
- [ ] Implement `onNewMail(message)`: prescreen → plan → enqueue → handle LLM-not-configured
- [ ] Implement `dispatch(job)`: look up processor from registry, call handle, return outcome
- [ ] Implement `start()` / `stop()`: subscribe/unsubscribe from sync events
- [ ] Handle LLM-not-configured: check `capability.requiresLlm` and skip immediately if no LLM client
- [ ] Write unit tests with mock sync service
- [ ] Verify all tests pass

### Task 8: Implement `AuditLogService` and `intelligence_audit_log` table

- [ ] Create `server/wemail/telemetry/AuditLogService.ts`
- [ ] Define `IntelligenceAuditEntry` type: `{ id, emailId, action, processor?, source, sessionId?, userId?, resultJson?, createdAt }`
- [ ] Add `intelligence_audit_log` table migration with indexes on `(email_id, created_at)` and `(source, created_at)`
- [ ] Implement `log(entry)` method: insert into `intelligence_audit_log`
- [ ] Implement `findByEmailId(emailId, limit?)` for querying audit history
- [ ] Implement `findBySource(source, limit?)` for analytics queries
- [ ] Write unit tests
- [ ] Verify all tests pass

### Task 9: Implement `IntelligenceService`

- [ ] Create `server/wemail/intelligence/IntelligenceService.ts`
- [ ] Constructor takes: `IntelligenceOrchestrator`, `JobRepository`, `IntelligenceResultRepository`, `DB Service mail API`, `TagFeedbackRuleRepository`, `AuditLogService`, `DraftFeedbackLog`, `logger`
- [ ] Implement query methods: `getState`, `getSummary`, `getTags`, `getReplyDecision`, `getReplyDraft`, `getLlmStatus`
- [ ] Implement trigger methods: `triggerSummary`, `triggerTags`, `triggerReplyDecision`, `triggerReplyDraft`, `retry`
  - Each trigger: validate email exists → enqueue job → write audit log with CallerContext
- [ ] Implement operate methods: `confirmTag`, `rejectTag`, `acceptDraft`, `editAndSendDraft`, `deleteDraft`
  - Each operate: perform mutation → write audit log with CallerContext
- [ ] `getState()` derives status from both `mail_ai_artifacts` and `mail_jobs`
- [ ] Write unit tests with mock dependencies
- [ ] Verify all tests pass

### Task 10: Implement `ReplyDecisionProcessor`

- [ ] Create `server/wemail/intelligence/processors/ReplyDecisionProcessor.ts`
- [ ] Create `server/wemail/ai/prompts/replyDecisionPrompt.ts` with system prompt, user template, JSON schema
- [ ] Implement processor: fetch mail → optionally fetch summary → build prompt → call LLM → validate → save result
- [ ] On `shouldReply=true`: enqueue `replyDraft` job via `JobRepository.enqueueJob()`
- [ ] On pre-screened path (detected via job context or metadata): write skipped result without LLM call
- [ ] Write unit tests with mock LLM client
- [ ] Verify all tests pass

### Task 11: Simplify `ReplyDraftProcessor`

- [ ] Remove `shouldReply` and `rationale` from processor output
- [ ] Update prompt: no decision logic, only draft generation
- [ ] Fetch `ReplyDecisionResult` from `IntelligenceResultRepository` to provide context
- [ ] If decision result not available: log warning, proceed with body only
- [ ] Update JSON schema to return `{ draftMarkdown: string }` only
- [ ] Verify existing ReplyDraftProcessor tests still pass (update as needed)

### Task 12: Extract shared processor utilities

- [ ] Create `server/wemail/intelligence/processors/SharedProcessorUtils.ts`
- [ ] Extract `looksFenced()`, `truncateBody()`, `validateJsonStructure()` from SummaryProcessor
- [ ] Refactor SummaryProcessor, TagProcessor, ReplyDraftProcessor to use shared utils
- [ ] Verify all processor tests still pass

## Phase B: Cutover

### Task 13: Update `QueueRunner` for per-lane timeout and skipped handling

- [ ] Add per-job-type timeout lookup: read from `CapabilityRegistry` lane config
- [ ] Add skipped outcome handling: `dispatch()` returns `{ kind: "skipped", reason }` → mark job skipped
- [ ] Remove `no-processor` fallback to pending — make it a skipped outcome instead
- [ ] Verify typecheck passes

### Task 14: Wire `IntelligenceService` and orchestrator in `AppComposition`

- [ ] Create `CapabilityRegistry` and register all four capabilities (summary, tags, replyDecision, replyDraft)
- [ ] Create `LocalPrescreener` with default config
- [ ] Create `DefaultFanOutStrategy`
- [ ] Create `IntelligenceOrchestrator` and wire to `Mail Core sync worker`
- [ ] Create `IntelligenceService` with all dependencies
- [ ] Keep old `MailIntelligenceBus` wired but unsubscribed (not listening to events)
- [ ] Wire `QueueRunner` dispatch to orchestrator instead of old bus
- [ ] Verify typecheck passes
- [ ] Run `npm run dev:desktop` and test: new mail triggers orchestrator path

### Task 15: Update PI agent tools to use `IntelligenceService`

- [ ] Add `IntelligenceService` to `MailAgentToolDeps`
- [ ] Update existing `summarize_mail` / `get_summary` to return state-aware results (include `status`)
- [ ] Update existing `draft_reply` → rename to `get_reply_draft`, return state-aware results
- [ ] Add new query tools: `get_tags`, `get_reply_decision`, `get_intelligence_state`
- [ ] Add new trigger tools: `trigger_summary`, `trigger_tags`, `trigger_reply_decision`, `trigger_reply_draft`, `retry_intelligence`
- [ ] Add new operate tools: `confirm_tag`, `reject_tag`
- [ ] All new tools pass `CallerContext { source: "agent", sessionId }` to `IntelligenceService`
- [ ] Remove old `summarize_mail` alias (keep `get_summary` as canonical)
- [ ] Verify typecheck passes

### Task 16: Add API routes for `IntelligenceService`

- [ ] Update `intelligenceRoutes.ts`: enhance `GET /api/intelligence/messages/:id` to return `EmailIntelligenceState`
- [ ] Implement status derivation: query `mail_ai_artifacts` + `mail_jobs` for each capability
- [ ] Implement `"not-needed"` virtual status for replyDraft
- [ ] Add `POST /api/intelligence/messages/:id/summary/retry` endpoint
- [ ] Add `POST /api/intelligence/messages/:id/summary/trigger` endpoint
- [ ] Add `POST /api/intelligence/messages/:id/tags/trigger` endpoint
- [ ] Add `POST /api/intelligence/messages/:id/reply-decision/trigger` endpoint
- [ ] Add `POST /api/intelligence/messages/:id/reply-draft/trigger` endpoint
- [ ] Add `POST /api/intelligence/messages/:id/tags/:tag/confirm` endpoint
- [ ] Add `POST /api/intelligence/messages/:id/draft/accept` endpoint
- [ ] Add `POST /api/intelligence/messages/:id/draft/delete` endpoint
- [ ] Add `GET /api/system/llm-status` endpoint
- [ ] All trigger/operate routes pass `CallerContext { source: "user" }` to `IntelligenceService`
- [ ] Verify typecheck passes

### Task 17: Update `TagProcessor` for confidence tiers

- [ ] Add `tier` field to `TagSuggestion` output
- [ ] Implement `deriveTier()` function with 0.85 threshold
- [ ] Apply tier derivation after feedback rules and off-vocabulary filtering
- [ ] Store tier in `result_json` alongside confidence
- [ ] Verify existing tag processor tests pass (update assertions for new field)

### Task 18: Update frontend components

- [ ] Update `EmailSummaryCard.tsx`: add loading skeleton, failed+retry state, collapsible behavior at mail bottom
- [ ] Update `EmailSmartTags.tsx`: add suggested-tier visual treatment, confirm/dismiss actions
- [ ] Update `SmartDraftPanel.tsx`: show only when replyDecision.shouldReply=true, hide on failure
- [ ] Create `LlmConfigBanner.tsx`: global banner when LLM not configured, dismissible per session
- [ ] Add `useEmailIntelligence` React Query hook with polling
- [ ] Add `useLlmStatus` React Query hook
- [ ] Wire components into email detail view
- [ ] Verify `npm run build:renderer` passes

## Phase C: Cleanup

### Task 19: Remove deprecated `MailIntelligenceBus`

- [ ] Remove `server/wemail/intelligence/MailIntelligenceBus.ts`
- [ ] Remove all imports and references
- [ ] Remove hardcoded `JobRepository.enqueueForMessage()` (now replaced by orchestrator's plan-based enqueue)
- [ ] Verify typecheck and all tests pass

### Task 20: Clean up shared types

- [ ] Remove `shared/wemail/queue.ts` legacy compat types (if no longer referenced)
- [ ] Ensure `IntelligenceProcessorName` is the single source of truth for job types
- [ ] Remove any dead code from the old bus/processor integration
- [ ] Verify typecheck and all tests pass

### Task 21: Integration verification

- [ ] Run `npm run typecheck:server` and `npm run typecheck:desktop`
- [ ] Run `npm run test:server`
- [ ] Run `npm run test:renderer`
- [ ] Manual smoke test: new mail → prescreen → orchestrator → processors → results → frontend display
- [ ] Manual smoke test: noreply@ sender → replyDecision skipped → no draft area
- [ ] Manual smoke test: LLM unconfigured → global banner → all jobs skipped
- [ ] Manual smoke test: PI agent calls `trigger_summary` → job enqueued → result generated → `get_summary` returns result
- [ ] Manual smoke test: PI agent calls `confirm_tag` → tag promoted → audit log records source="agent"
- [ ] Manual smoke test: audit log query by email_id shows all operations with correct source
