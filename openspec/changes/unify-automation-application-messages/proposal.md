## Why

WeMail's automation engine already models triggers, mail matching, delayed execution, actions, audit runs, and Agent-confirmed rule configuration, but its execution contract remains centered on applying actions to one email at a time. This prevents users from expressing automations such as “每天上午 10 点汇总过去 24 小时的邮件并在应用内通知我” as one durable, inspectable rule, and the duplicated UI, REST, and Agent schemas have already drifted apart.

## What Changes

- Preserve the existing automation trigger, structured-condition, natural-language-condition, delayed-execution, idempotency, and audit foundations while adding calendar schedules and explicit collection scopes for time-window and filtered mailbox work.
- Add collection processors that can consume the complete matched set once per rule run, initially including mail digest and invoice-readiness analysis.
- Add a persistent application message center with unread state, history, safe rich-content rendering, source/run references, and typed follow-up actions.
- Add an automation action that publishes processor output as one application message and may optionally raise a privacy-safe Windows notification that deep-links to the persisted message.
- Make automation configuration capability-identical across the form, REST API, and built-in AI Agent by deriving schemas, validation, descriptions, risk metadata, previews, and confirmation presentation from canonical capability definitions.
- Require Agent rule changes to use a normalized preview snapshot and explicit pending-action confirmation; the confirmed snapshot becomes the exact persisted rule and authorizes its future executions within that scope.
- Repair existing preview and presentation drift so condition rules, natural-language conditions, temporal expressions, and newly added collection behavior are evaluated and shown consistently.

## Capabilities

### New Capabilities

- `automation-rule-orchestration`: Canonical trigger, condition, collection scope, processor, action, validation, preview, execution, idempotency, and audit behavior for both per-message and collection rules.
- `application-message-center`: Persistent application messages, unread/history UX, safe rich-content rendering, source references, typed interactions, and optional desktop notification delivery.
- `agent-automation-configuration`: Natural-language inspection, drafting, previewing, confirmation, mutation, explanation, and run-history workflows with capability parity between the Agent and UI.

### Modified Capabilities

- `pi-agent-runtime`: Expand the built-in Agent contract to expose the canonical automation configuration workflow while preserving confirmation, account isolation, and public-MCP separation.

## Impact

- Shared contracts under `shared/wemail/automation.ts` and new application-message contracts.
- Automation validation, matching, preview, execution, action dispatch, repositories, migrations, scheduling, and audit records under `server/wemail/automation` and the composition root.
- Digest and invoice-analysis services used as collection processors rather than duplicated implementations.
- Agent tool schemas, prompts, pending-action payloads, confirmation execution, and renderer cards under `server/wemail/agent` and `app/components/agent` / `app/components/wemail`.
- Automation settings UI, API routes/queries, sidebar navigation, message-center list/detail UI, desktop notifications, and deep links.
- Focused backend, component, Agent scenario, and end-to-end tests for UI/Agent parity, safe rendering, scheduling, idempotency, and confirmation integrity.
