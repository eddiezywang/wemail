## 1. Contract Freeze and Baseline

- [x] 1.1 Record the current agent UI, SSE, persistence, pending-action, and desktop acceptance baselines with focused regression tests.
- [x] 1.2 Define `WeMail AgentEvent v1` discriminated unions with schema version, run identity, message identity, sequence, timestamp, reasoning, text, tool, retry, queue, confirmation, attachment, citation, error, and settled events.
- [x] 1.3 Define persisted conversation, message-part, run, tool-execution, follow-up, citation, attachment-reference, behavior-event, and preference contracts.
- [x] 1.4 Define the Pi-to-WeMail adapter interface so no Pi types escape the runtime module.
- [x] 1.5 Add protocol fixtures and contract tests covering normal completion, tools, failure, retry, stop, pending confirmation, and interrupted runs.
- [x] 1.6 Add a development-only command that clears Agent-specific data without deleting accounts, mail, drafts, or mailbox state.

## 2. Stage One Conversation State and Compatibility Adapter

- [x] 2.1 Implement the canonical `ConversationState` and pure reducer for messages, reasoning, Markdown text, tool executions, citations, confirmations, queue items, and run state.
- [x] 2.2 Implement the temporary legacy-SSE-to-ConversationState adapter.
- [x] 2.3 Add sequence-aware duplicate protection and deterministic ordering in the reducer.
- [x] 2.4 Make persisted message loading enter the same reducer/component model as live SSE updates.
- [x] 2.5 Add reducer tests for interleaved reasoning, text, tools, partial results, errors, stop, and settled-state ordering.
- [x] 2.6 Add the temporary old/new Agent UI feature flag with the old renderer as an immediate fallback.

## 3. Stage One Componentized Agent UI

- [x] 3.1 Extract `AgentHeader`, `ConversationThread`, `UserMessage`, `AssistantMessage`, `RunStatus`, and `Composer` from the current `AgentPanel` responsibilities.
- [x] 3.2 Implement `ReasoningDisclosure` so active reasoning is visible and settled, stopped, or failed reasoning collapses while remaining inspectable.
- [x] 3.3 Implement one safe Streamdown-based Markdown renderer for both streaming and completed answers, with raw HTML and remote images disabled, external links routed through safe system-browser opening, and copy-only code-block controls.
- [x] 3.4 Implement the tool-renderer registry and `GenericToolCard` fallback without a user-facing global expand-all control.
- [x] 3.5 Implement in-place tool card updates for argument, running, partial-result, success, and failure states.
- [x] 3.6 Add initial mail search, mail read, draft, confirmation, automation/WeCLI, attachment, and allowance-invoice tool renderers.
- [x] 3.7 Implement structured inline citations, source popovers, mail navigation, attachment navigation, and unavailable-source states.
- [x] 3.8 Implement the active composer, visible follow-up queue, queue editing, queue removal, queue reordering, and paused-queue states without mid-run steering.
- [x] 3.9 Preserve smart auto-scroll and provide a jump-to-latest control without forcing users away from content they are reading.
- [x] 3.10 Implement the lightweight pending-operation count and navigation back to originating confirmation cards.
- [x] 3.11 Add renderer tests for reasoning collapse, Markdown safety, tool progressive disclosure, queue interaction, citations, and pending-card history states.
- [x] 3.12 Persist unsent composer text as a separate local draft per conversation without creating executable queue items.
- [x] 3.13 Add renderer tests for system-browser external links, code copying, absence of global tool expansion, queue reordering, and per-conversation composer draft restoration.
- [x] 3.14 Replace per-part reasoning presentation with one run-level process disclosure that stays expanded while active, auto-collapses on terminal states, shows server-timestamp elapsed time, and keeps final answers outside the disclosure.

## 4. Stage One Desktop Acceptance

- [x] 4.1 Run typecheck and focused server/renderer tests for the compatibility stage.
- [x] 4.2 Run browser acceptance for live streaming, history reload, stop, conversation switching, panel collapse, and tool-card rendering.
- [x] 4.3 Rebuild and launch the Windows desktop app using the repository desktop build workflow and verify renderer health with no white screen.
- [x] 4.4 Capture acceptance screenshots for reasoning, Markdown, tool cards, queued follow-ups, citations, confirmations, and error states.
- [x] 4.5 Switch the new Agent UI to default after stage-one acceptance while retaining the temporary fallback flag.

## 5. Pi Upgrade and WeMail Runtime Protocol

- [x] 5.1 Pin the approved Pi 0.80.6 package set and document package/API differences from the current 0.70.2 integration.
- [x] 5.2 Update `PiAgentRuntime` behind the adapter without exposing Pi SDK, RPC, TUI, or AgentHarness types to shared or renderer code.
- [x] 5.3 Map Pi message, reasoning, tool, retry, abort, and settled lifecycle into `WeMail AgentEvent v1`.
- [x] 5.4 Add adapter tests based on Pi 0.80.6 event-order and tool-lifecycle scenarios.
- [x] 5.5 Replace legacy SSE emission with versioned WeMail events and monotonic per-run sequences.
- [x] 5.6 Reject or safely diagnose unknown Pi events without forwarding them directly to the renderer.

## 6. Structured Persistence and Run Orchestration

- [x] 6.1 Add or replace internal Agent database tables for structured messages, runs, tool executions, follow-up queue items, citations, attachments, attachment references, user behavior events, and preferences.
- [x] 6.2 Persist Markdown source and structured parts without storing rendered HTML or raw token-delta history.
- [x] 6.3 Implement at-most-once-per-second assistant snapshots and immediate persistence at semantic boundaries.
- [x] 6.4 Implement startup reconciliation that marks unfinished runs interrupted and pauses queued follow-ups without restarting tools.
- [x] 6.5 Implement one active run per conversation and a global maximum of two active runs.
- [x] 6.6 Implement visible waiting state for runs blocked by global concurrency.
- [x] 6.7 Persist sent follow-ups and automatically execute them in order after normal settlement.
- [x] 6.8 Pause follow-ups after user stop or application restart and require explicit resume confirmation.
- [x] 6.9 Implement safe stop propagation to model generation and cancellable read tools while awaiting final status from non-cancellable operations.
- [x] 6.10 Implement cancellable exponential-backoff retry with a maximum of two attempts for transient model failures and approved idempotent reads.
- [x] 6.11 Add crash, duplicate-event, queue-order, concurrency, stop, retry, and settled-state integration tests.

## 7. Tool Safety, Confirmations, and Citations

- [x] 7.1 Encode the approved direct-execution and confirmation-required operation matrix in a centralized policy module.
- [x] 7.2 Require exact displayed parameters and an idempotency key for every confirmed write operation.
- [x] 7.3 Ensure send, delete, move, archive, spam, unsubscribe, inferred mutations, batch mutations, automation, WeCLI, and allowance-invoice mutations cannot bypass confirmation.
- [x] 7.4 Allow reads, analysis, unsent drafts, and explicitly requested low-risk single-item operations through the direct path.
- [x] 7.5 Keep pending operations in the operational repository and remove their aggregation from Action Center semantics.
- [x] 7.6 Add `expiresAt` to pending operations, reject expired execution, and render expired cards as read-only states requiring regeneration.
- [x] 7.7 Persist resolved confirmation cards as read-only history states with execution outcomes.
- [x] 7.8 Generate structured citation references from mail, attachment, and business-record tool results instead of model-authored Markdown links.
- [x] 7.9 Add mutation idempotency, parameter-change, expiry, batch-scope, cross-account, and citation-navigation tests.

## 8. Deterministic Attachment Store

- [x] 8.1 Implement intake entry points for both local files and existing mail attachments, define their account-scoped source keys, and map them to one deterministic relative canonical path.
- [x] 8.2 Implement single-flight or locking so concurrent intake of the same account/source cannot create duplicate canonical files.
- [x] 8.3 Implement `.part` writes, size/hash validation, atomic rename, metadata commit, and incomplete-write recovery.
- [x] 8.4 Store attachment metadata and message references in the database without storing file blobs.
- [x] 8.5 Implement readable-before-ready and send-time revalidation.
- [x] 8.6 Implement parsers for supported images, plain text, Markdown, PDF, and DOCX.
- [x] 8.7 Enforce 10 files, 25 MB per file, 50 MB total, 200 PDF pages, 200,000 characters per file, and 400,000 characters per message without silent truncation.
- [x] 8.8 Reject URL, cloud-drive, XLSX, PPTX, ZIP, encrypted/damaged files, OCR-only scans, and unsupported content-signature mismatches.
- [x] 8.9 Bind attachments to one user message and implement explicit reuse without implicit carry-over.
- [x] 8.10 Implement reference removal, seven-day orphan grace period, 24-hour stale `.part` cleanup, and immediate clear-all-Agent-data cleanup.
- [x] 8.11 Add tests for deterministic reuse, account isolation, concurrent intake, crash recovery, parser failures, limits, references, and retention.

## 9. Harness User Learning Ledger

- [x] 9.1 Replace Action Center card aggregation with a schema for meaningful user input, decisions, edits, confirmations, and real mail operations.
- [x] 9.2 Exclude assistant output, reasoning, tool traces, card snapshots, scroll, and expansion interactions from learning evidence.
- [x] 9.3 Add secret filtering for passwords, verification codes, tokens, cookies, and authorization values before behavior persistence.
- [x] 9.4 Implement 180-day raw behavior retention.
- [x] 9.5 Implement derived preferences with provenance, confidence, last-confirmed time, contradiction handling, and decay.
- [x] 9.6 Provide user-visible preference inspection, correction, and per-preference deletion.
- [x] 9.7 Provide a dedicated clear-learning action independent from conversation deletion.
- [x] 9.8 Add tests proving chat deletion and learning deletion remain independent and that forbidden presentation events are not recorded.

## 10. Notifications, Privacy, and Diagnostics

- [x] 10.1 Implement in-app background run, failure, paused-queue, and confirmation indicators.
- [x] 10.2 Implement privacy-safe Windows notifications for failures and confirmation requests when WeMail is not focused or the conversation is not visible.
- [x] 10.3 Make notification selection restore WeMail and navigate to the exact conversation, run, or confirmation card.
- [x] 10.4 Add notification disablement and short-window aggregation without hiding in-app state.
- [x] 10.5 Enforce metadata-only normal logs that reject prompts, mail bodies, attachment text, assistant output, raw tool payloads, credentials, and absolute paths.
- [x] 10.6 Implement explicit local diagnostic mode with a 24-hour activation limit and credential filtering.
- [x] 10.7 Implement local diagnostic package export and seven-day automatic cleanup without automatic upload.
- [x] 10.8 Add privacy, redaction, expiry, notification-focus, and deep-link tests.

## 11. Final Cutover and Removal

- [ ] 11.1 Run full server, renderer, browser, and desktop acceptance against the new Pi runtime and WeMail protocol.
- [x] 11.2 Verify live/history parity for reasoning, Markdown, tools, confirmations, citations, attachments, errors, retry, stop, queue, and interrupted runs.
- [x] 11.3 Verify the write confirmation matrix and idempotency under duplicate requests and uncertain outcomes.
- [x] 11.4 Verify attachment cleanup and user-learning retention with controlled clock-based tests.
- [x] 11.5 Clear incompatible internal Agent data in the development rollout and confirm mail/account/draft data remains intact.
- [x] 11.6 Remove the legacy Agent renderer and associated tests that no longer describe supported behavior.
- [x] 11.7 Remove the legacy SSE compatibility adapter and raw Pi event persistence.
- [x] 11.8 Remove obsolete Agent message fields and old internal schema paths.
- [x] 11.9 Remove the old/new UI feature flag and make the new experience unconditional.
- [x] 11.10 Rebuild and launch the Windows desktop application, complete white-screen diagnostics, and capture final acceptance evidence.
- [ ] 11.11 Update OpenSpec acceptance evidence, mark every completed task, and archive the change only after all removal gates pass.
