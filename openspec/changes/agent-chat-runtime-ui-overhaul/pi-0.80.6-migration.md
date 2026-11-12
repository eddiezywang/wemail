## Pi 0.80.6 package migration

### Approved package set

WeMail pins the public Pi 0.80.6 packages exactly:

- `@earendil-works/pi-agent-core@0.80.6`
- `@earendil-works/pi-ai@0.80.6`

Pi moved from the deprecated `@mariozechner/*` scope before 0.80.6. There is
no public `@mariozechner/pi-agent-core@0.80.6` or
`@mariozechner/pi-ai@0.80.6`; the old integration was pinned to 0.70.2.
Both npm and Bun lockfiles must resolve the new scope and must not retain the
old packages.

### API differences from WeMail's 0.70.2 integration

| Area | 0.70.2 integration | 0.80.6 integration in WeMail |
| --- | --- | --- |
| Package scope | `@mariozechner/pi-*` | `@earendil-works/pi-*` |
| Agent lifecycle | WeMail consumed message and tool events opportunistically | `agent_start`/`agent_end`, message, and tool events are treated as an ordered lifecycle; WeMail settlement remains host-owned |
| Tool progress | Start/end were the only mapped tool phases | `tool_execution_update` is mapped to `tool_execution_updated` |
| Subscriber settlement | Listener completion was not part of the WeMail contract | Pi 0.80.6 awaits subscribers in order; `agent_end` is final and `waitForIdle()` settles after listeners |
| Abort signal | Callers relied mainly on `Agent.abort()` | Subscribers and hooks receive the active `AbortSignal`; WeMail still owns HTTP cancellation and maps cancellation to a terminal run event |
| Model API surface | Global `pi-ai` APIs were the normal entry point | 0.80.6 splits provider/model collections from the temporary `/compat` entry point; WeMail uses the main typed/event surface and does not import `/compat` directly |
| Harness exports | Not part of the integration boundary | The core package exports Harness types, but WeMail does not expose or import them outside the Pi runtime package boundary |
| TypeBox | Older transitive TypeBox release | Pi 0.80.6 resolves TypeBox 1.1.38; WeMail tool schemas remain converted inside `PiAgentRuntime` |

### WeMail boundary response

- `PiAgentRuntime` is the only production module importing Pi packages. A
  focused server-side tool-schema test imports Pi's validator directly; no
  shared or renderer module does.
- `PiV0806ToWemailEventAdapter` accepts `unknown` and emits only
  `WemailAgentEvent` schema version 1.
- Routes, SSE, persistence, shared contracts, and renderer code do not import
  Pi SDK, RPC, TUI, web UI, or AgentHarness types.
- Unknown runtime events become a metadata-only `run_failed` event with code
  `unsupported_pi_event`; their payload is never forwarded or logged.
- SSE and non-streaming chat responses now contain monotonic per-run versioned
  events. Legacy `assistant_text`, `tool_call`, `conclusion`, and `done` events
  no longer cross the HTTP boundary.

### Focused verification

- `npm run typecheck:server`
- `npm run typecheck`
- `npm run test:server -- --path server/wemail/agent/PiEventAdapter.test.ts --path server/api/routes/agentRoutes.test.ts`
- `node --import tsx --test --test-force-exit server/wemail/agent/PiAgentRuntime.test.ts`
- `npm run test:renderer -- app/services/api.test.ts app/components/AgentPanel.test.tsx app/components/agent/AgentConversationThread.test.tsx shared/wemail/conversationState.test.ts app/components/editor/useInlineAi.test.tsx`
- `npm run build:desktop`
