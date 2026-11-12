## Why

WeMail's current agent panel mixes streaming transport, conversation reduction, tool presentation, Markdown rendering, pending actions, and composer state in one UI path. This makes Pi upgrades risky, causes live and persisted conversations to diverge, and leaves attachments, run recovery, and Harness learning without stable contracts.

The product is still internal, so this is the right point to make a clean break: replace the current chat implementation with a Pi-inspired but WeMail-owned delivery architecture, reset incompatible internal agent data, and finish the runtime and UI migration before public release.

## What Changes

- Add a versioned `WeMail AgentEvent` protocol between the Pi runtime adapter, SSE transport, persistence, and React client.
- Replace the monolithic agent panel with a componentized conversation experience for reasoning, final Markdown, tool cards, confirmations, citations, attachments, per-conversation composer drafts, run status, and a persistent reorderable follow-up queue.
- Add durable run lifecycle management with one active run per conversation, bounded cross-conversation concurrency, throttled streaming snapshots, retry, stop, crash recovery, and settled-state semantics.
- Add an account-isolated deterministic attachment store for both local files and existing mail attachments, with atomic writes, source-based deduplication, parsing limits, references, delayed garbage collection, and message-scoped attachment context.
- Separate pending operations from the Action Center. Pending operations remain operational entities linked to their originating conversation; the Action Center becomes a Harness-oriented ledger of meaningful user inputs, decisions, edits, and real actions.
- Add structured citations that navigate to original mail or attachment sources.
- Add privacy-safe diagnostics and background notification rules.
- Deliver in two stages using a temporary old/new UI feature flag, then remove the old UI, compatibility adapter, old stream protocol, and old internal agent data.
- **BREAKING** Reset existing internal agent conversations and runtime state instead of migrating or reading the old message format.
- **BREAKING** Frontend and persistence stop consuming raw Pi event shapes and use only the WeMail-owned protocol.

## Capabilities

### New Capabilities

- `agent-conversation-experience`: React conversation UI, reasoning disclosure, safe Markdown, tool renderers, confirmations, citations, composer, queue, and background status behavior.
- `agent-run-orchestration`: Versioned WeMail events, run lifecycle, persistence snapshots, concurrency, retry, stop, queue execution, and crash recovery.
- `agent-attachment-store`: Message-scoped attachment intake, deterministic account-isolated storage, parsing, source references, limits, and cleanup.
- `agent-learning-ledger`: Harness-oriented user behavior ledger and long-lived derived preferences, explicitly excluding model output and UI snapshots.

### Modified Capabilities

- `pi-agent-runtime`: Replace the phase-one fixed event/tool delivery assumptions with a Pi adapter behind the WeMail protocol while preserving the rule that unconfirmed high-risk actions cannot execute.
- `retention-logger-cleanup`: Add attachment, learning-ledger, preference, and temporary diagnostic retention requirements while strengthening metadata-only default logging.

## Impact

- Renderer: `app/components/AgentPanel.tsx`, agent queries/services, streaming Markdown utilities, new conversation/tool/attachment components, desktop notification integration.
- Shared contracts: `shared/wemail/agent.ts`, `shared/wemail/agentStream.ts`, intelligence and citation contracts, new versioned event and conversation-state types.
- Server: agent routes, Pi adapter/runtime, conversation and pending-action repositories, run scheduler, attachment intake/parsers, retention, telemetry, and Harness workspace feedback.
- Data: new or replaced internal agent tables for runs, structured messages, tool executions, follow-up queue items, attachment records/references, behavior events, and preferences. Existing internal agent data may be cleared during development rollout.
- Verification: server/renderer contract tests, stream reducer regressions, persistence and crash scenarios, attachment concurrency and cleanup tests, browser tests, and Windows desktop build/launch health checks.
