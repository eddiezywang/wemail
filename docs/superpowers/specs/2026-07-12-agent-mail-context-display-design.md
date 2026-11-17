# Agent Mail Context Display Design

## Goal

Make the WeMail AI panel feel like an application-native mail conversation: when a user asks about the currently selected email, the conversation shows a compact “已关联邮件” context tag with the email subject, while internal identifiers and execution details remain hidden from normal user-facing content.

## Problem

The current AI panel sends the selected email ID correctly as hidden request context, but several user-visible surfaces expose implementation details:

- backend-generated suggestion prompts include the full `emailId`;
- assistant prose can contain `emailId`, `tool`, and `path` citations;
- completed tool parts can expose raw tool names such as `summarize_mail`;
- execution summaries can include commands, binaries, paths, arguments, stdout, and stderr;
- persisted conversation messages do not carry a first-class display model for the email that was attached to a user turn.

The desired behavior is to preserve internal context for Agent tool calls and auditability without leaking it into the conversation UI.

## UX Design

### Attached-mail tag

When a selected email is attached to a user turn, render a compact tag beside the user message:

```text
✉ 已关联邮件 · RE: 回复：F2026053107584829 补光灯067
```

The tag may show the sender and received time when space permits. It must not show `emailId`, `threadId`, tool names, JSON paths, action IDs, or raw request metadata. A close control remains available before sending through the existing composer attachment chip. A historical tag can select the associated email when clicked.

If no email is selected, no attached-mail tag is rendered. If an email has no subject, use `当前邮件` as the visible fallback.

### Tool progress

Tool activity may be shown while a response is streaming, but it uses human-facing labels such as `正在整理邮件…`. Raw tool names are never rendered. Completed tool-progress parts are hidden from the persisted conversation so the assistant response remains the primary content.

### Execution results

Confirmed actions show a concise business result, for example:

```text
已完成：上传 2 个发票附件
- invoice.pdf：已完成
```

The UI does not show command strings, binary names, resolved paths, arguments, stdout, stderr, or raw error codes. Failures retain a concise human-readable cause and next action when available.

## Data Model and Data Flow

Add a shared display type without putting the internal email ID inside the display object:

```ts
interface AgentAttachedMail {
  subject: string;
  sender?: string;
  receivedAt?: string;
}
```

The request keeps the existing hidden `emailId` and `threadId` fields and adds `attachedMail` as display metadata:

```ts
{
  userText: "总结重点和风险",
  emailId: "internal-email-id",
  threadId: "internal-thread-id",
  attachedMail: {
    subject: "RE: 回复：F2026053107584829 补光灯067",
    sender: "SHDR Lost & Found",
    receivedAt: "2026-06-01T07:52:17Z"
  }
}
```

The frontend uses the selected email to create both layers. The backend continues to pass `emailId` and `threadId` to the Agent runtime. Conversation persistence stores `attachedMail` alongside the user turn so historical UI messages can render the same tag. Existing stored `emailId` fields remain internal and are never used as visible text.

Suggestion prompts become natural language without IDs:

```text
总结这封邮件，列出重点和风险。
```

The click handler still sends the selected email ID in the hidden context, so tool behavior is unchanged.

## Redaction Boundary

### Backend

Update the PI system prompt so citations remain internal metadata rather than mandatory prose. Normal assistant output must not contain internal identifiers, tool names, JSON paths, or implementation details.

Before SSE delivery and conversation persistence, sanitize assistant-facing text for known internal citation patterns such as:

```text
emailId: ...
tool: ...
path: ...
```

Structured citation metadata may remain available to internal consumers, but it is not rendered as normal prose.

### Frontend

Keep a second sanitization pass before rendering persisted or streaming assistant text. This protects the UI from legacy conversations and unexpected model output. The sanitizer removes citation-like metadata without removing ordinary business language that happens to mention “工具” or “路径”.

Tool results remain internal event data. The message renderer never prints raw tool-result payloads; it only renders a friendly transient progress state when appropriate.

## Components and Responsibilities

- `shared/wemail/agent.ts`: define `AgentAttachedMail` and extend the chat input contract.
- `server/api/routes/agentRoutes.ts`: remove IDs from suggestion prompts, persist attached-mail metadata, and apply the server-facing text redaction boundary.
- `server/wemail/agent/PiAgentRuntime.ts`: remove the instruction requiring visible citations and explicitly require natural user-facing prose.
- `app/components/AgentPanel.tsx`: attach display metadata to new user turns, restore it for persisted turns, render the attached-mail tag, hide completed tool parts, and use friendly execution summaries.
- `app/lib/agent-display.ts`: provide focused, testable helpers for assistant text redaction, friendly tool labels, and execution-result formatting.
- `app/components/agent/AgentAttachedMailTag.tsx`: render the reusable compact mail-context tag and expose an optional click callback.

## Compatibility and Error Handling

- Existing conversations without `attachedMail` continue to render normally.
- Existing messages that contain internal citation text are cleaned at render time.
- Missing subject falls back to `当前邮件`; missing sender or date simply omits that secondary metadata.
- Missing selected email means no attached-mail metadata is sent.
- Agent tool failures continue to be surfaced, but only through a concise user-facing summary.
- Internal IDs remain available to tool calls, pending actions, audit records, and server-side conversation context.

## Testing Strategy

Add focused tests before implementation:

1. `AgentAttachedMail` metadata is sent with the selected email while the visible user text excludes its ID.
2. Backend suggestions contain natural-language prompts without `emailId`.
3. Persisted user turns restore the attached-mail tag metadata.
4. Assistant text redaction removes `emailId`, `tool`, and `path` citation fragments while preserving normal prose.
5. Friendly tool labels never fall back to raw tool names in rendered output.
6. Execution formatting excludes command, binary, path, args, stdout, and stderr while retaining success/failure summaries.
7. Legacy conversations with citation text remain readable after hydration.

Verification commands:

```text
npm run test:renderer -- app/components/AgentPanel.test.tsx
npm run test:server -- server/api/routes/agentRoutes.test.ts
npm run typecheck
npm run build
```

## Scope Boundaries

This change does not alter Agent tool selection, email retrieval, mailbox scope rules, pending-action authorization, or audit persistence. It changes only the user-facing presentation and the explicit display metadata attached to conversation turns.
