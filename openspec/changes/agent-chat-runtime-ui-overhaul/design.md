## Context

The current agent experience has already gained structured reasoning and Markdown rendering, but `AgentPanel.tsx` still owns transport handling, stream reduction, persistence mapping, pending-action display, scrolling, composer state, and most visual rendering. The server persists overlapping `events`, `parts`, and `text` representations, and the renderer consumes WeMail types that still reflect the current Pi delivery shape.

Pi 0.80.6 does not provide a reusable browser UI. Its useful contribution is the separation between runtime, session lifecycle, host protocol, and presentation components. WeMail needs the same separation while retaining its mail-specific confirmation, citation, attachment, privacy, and Harness behavior.

The product is internal. Existing agent conversations and run state can be cleared, so the design optimizes for a clean target architecture rather than permanent compatibility. The implementation still uses a temporary old/new UI flag during acceptance to keep the desktop client recoverable.

## Goals / Non-Goals

**Goals:**

- Establish a versioned, Pi-independent WeMail protocol for live events and persisted conversation state.
- Make live streaming, crash recovery, and history reconstruction use the same reducer and renderer contracts.
- Replace the monolithic chat panel with isolated React components and a tool-renderer registry.
- Support durable runs, follow-up queues, bounded concurrency, safe retry, stop, and settled-state semantics.
- Support message-scoped local and mail attachments through a deterministic account-isolated store.
- Preserve mail safety through explicit confirmation boundaries and idempotent write execution.
- Turn the Action Center into a Harness-oriented user behavior ledger rather than a UI-card store.
- Remove the old UI, adapter, protocol, and old internal agent state after two-stage acceptance.

**Non-Goals:**

- Reusing Pi TUI components or the removed Pi web UI as a direct dependency.
- Replacing the current Pi runtime with AgentHarness in this change.
- Model selection, conversation branching, mid-run steering, cloud-drive input, URL ingestion, OCR, complex Office preview, Artifact execution, Mermaid, or LaTeX.
- Compatibility with pre-release agent conversation data.
- Automatic resumption of interrupted tool execution after a process restart.

## Decisions

### 1. WeMail owns the delivery protocol

Pi events terminate at a server-side adapter. The adapter emits `WeMail AgentEvent v1` with `schemaVersion`, `conversationId`, `runId`, optional `messageId`, monotonic `sequence`, and `timestamp`. SSE and persistence use WeMail contracts only.

The approved 0.80.6 package set uses the successor `@earendil-works/*` scope;
the exact dependency and API migration record is maintained in
`pi-0.80.6-migration.md`.

Alternative considered: forward raw Pi events to the renderer. Rejected because Pi upgrades would then change renderer and database behavior simultaneously.

### 2. Persist structured state, not rendered output or token logs

The server stores structured messages, runs, tool executions, queue items, citations, and attachment references. Markdown source is persisted; rendered HTML is not. During streaming, message state is checkpointed at most once per second and immediately at semantic boundaries. Raw token deltas are not retained as conversation history.

Alternative considered: append every event forever and replay for each history load. Rejected because it increases SQLite write volume, complicates schema evolution, and makes history rendering dependent on transport details.

### 3. One reducer and renderer serve live and persisted conversations

The frontend maps both SSE events and loaded message snapshots into one `ConversationState`. Message, reasoning, tool, confirmation, citation, and error components render that state. Tool cards are keyed by stable `toolCallId` and update in place.

Each assistant run owns one process disclosure that groups its user-visible reasoning, progress, tools, confirmations, and recoverable errors in event order while keeping the final answer and artifacts outside the disclosure. The disclosure is expanded while the run is queued, running, retrying, or stopping so the user can follow work as it happens. It collapses automatically when the run settles, stops, fails, or is interrupted, and its summary uses server-owned run timestamps to show the terminal state and elapsed time. Historical conversations therefore load with completed process disclosures collapsed but fully inspectable.

Active tool groups are expanded while their tools update. Successful read-only tools remain individually collapsed at the deepest detail level, while failures and confirmations remain prominent. The user-facing experience does not provide a global "expand every tool" control because that would turn ordinary mail assistance into a developer trace viewer.

### 4. Deliver in two stages with a disposable compatibility adapter

Stage one introduces the new state model and UI behind a feature flag while adapting the existing SSE stream. Stage two replaces the backend protocol and persistence, implements all runtime and attachment capabilities, then deletes the old UI and adapter. The adapter is migration scaffolding, not a permanent abstraction.

### 5. Runs are durable but execution recovery is conservative

One active run is allowed per conversation, with at most two active runs across conversations. Follow-up messages are persisted and normally run automatically in order. Stop or restart pauses the queue. An interrupted run preserves its last snapshot and becomes `interrupted`; it never automatically restarts tools.

Queued follow-ups may be edited, removed, and reordered before execution. Text that has not been sent remains a separate per-conversation local composer draft and never becomes an executable queue item until the user explicitly sends it.

### 6. Retry is capability-aware

Model transport failures and explicitly idempotent read tools may retry at most twice with cancellable exponential backoff. Mutations never retry unless the operation has an idempotency key and the server can prove the prior attempt did not complete.

### 7. Attachments use a deterministic account-scoped store

An attachment source produces a stable account-scoped key. Intake writes `content.part`, validates size and hash, atomically renames to `content`, then writes metadata and database references. A completed canonical path prevents duplicate storage for the same source within an account. Messages store relative paths, never binary blobs.

### 8. Attachments are message-scoped

Attachments may originate from local files or attachments already present on a mail message. They belong to the user message that sends them. Later turns do not silently reuse them. The canonical stored file supports history and explicit reuse without depending on the user's original path or repeatedly downloading the same mail attachment.

### 9. Confirmation is determined by semantic risk

Reads, analysis, and unsent draft generation execute directly. Explicit low-risk single-item operations may execute directly. Send, delete, move, archive, spam, unsubscribe, inferred mutations, batch mutations, automation, WeCLI, and allowance-invoice mutations require an exact-parameter confirmation card. Write execution uses idempotency keys.

Every pending operation has an explicit `expiresAt`. Once expired, its card becomes read-only and the operation cannot execute; the user must ask WeMail to create a new operation with freshly validated parameters.

### 9.1 Safe Markdown navigation

External Markdown links use WeMail's existing safe-link handling and open in the system browser rather than navigating the renderer. Code blocks offer copy-only interaction and never execute. Remote Markdown images remain blocked.

### 10. The Action Center records user behavior, not assistant UI

Pending actions remain operational records linked to conversations. The Action Center records meaningful user inputs, choices, edits, and actual mail operations for Harness analysis. Assistant output, reasoning, tool traces, and UI expansion state are excluded.

### 11. Default diagnostics are metadata-only

Normal logs omit prompts, mail bodies, attachment text, assistant output, raw tool payloads, credentials, and absolute local paths. Explicit diagnostic mode is local, credential-filtered, limited to 24 hours, and produces packages that expire after seven days unless the user exports them.

## Data Model Direction

The exact migrations may consolidate tables, but the logical records are:

- `agent_conversations`
- `agent_messages` with structured parts and Markdown source
- `agent_runs`
- `agent_tool_executions`
- `agent_followup_queue`
- `agent_pending_actions`
- `agent_attachments`
- `agent_attachment_refs`
- `agent_user_behavior_events`
- `agent_user_preferences`

Because compatibility is not required, development rollout may clear existing agent-specific tables before applying the new schema. Mail, account, draft, and mailbox data must not be cleared.

## Risks / Trade-offs

- [Cross-cutting change creates a long integration window] → Keep stage one renderer-compatible, use capability-oriented modules, and merge vertical slices with contract tests.
- [Temporary dual UI can become permanent] → Define explicit deletion gates and track removal tasks in the same change.
- [SQLite checkpointing can cause contention] → Throttle text snapshots, persist immediately only at semantic boundaries, and serialize writes per run.
- [A crash can leave a partial attachment] → Use `.part`, hash/size validation, atomic rename, and stale-part cleanup.
- [Parallel runs can race on mailbox mutations] → Enforce write-operation locks and idempotency independently from the two-run read concurrency limit.
- [Reasoning can expose inappropriate internals] → Render only provider-approved reasoning and WeMail-generated execution status.
- [Learning data can outlive a deleted chat] → Keep chat and learning deletion separate, expose a dedicated clear-learning action, filter secrets, and expire raw events after 180 days.
- [Pi upgrade changes event meaning] → Pin the runtime version, test adapter mappings against recorded fixtures, and keep all Pi types inside the adapter.

## Migration Plan

1. Freeze event, conversation-state, tool-renderer, and persistence contracts.
2. Add the new renderer behind an old/new feature flag and adapt the existing stream into it.
3. Complete stage-one visual, reducer, history, stop, and desktop acceptance.
4. Replace internal agent persistence and clear incompatible pre-release agent data.
5. Introduce the new event stream, run scheduler, queue, attachments, citations, learning ledger, notifications, retention, and diagnostics.
6. Make the new renderer the only default and run full server, renderer, browser, and desktop acceptance.
7. Remove the old renderer, compatibility adapter, old protocol, old data fields, and feature flag.

Rollback during stage one switches the feature flag to the old renderer. During stage two, rollback is by code/runtime version only; cleared internal agent history is not restored. Mailbox and account data remain outside the reset boundary.

## Open Questions

None. Product behavior, safety boundaries, attachment limits, retention, and rollout semantics were confirmed during the design review.
