## Why

The built-in Agent currently applies one six-iteration limit to model turns, tool calls, and accumulated tool results. Legitimate multi-mail analysis and artifact-generation requests can therefore be stopped while every step is still making progress, often immediately before the final answer.

## What Changes

- Replace the fixed low iteration cutoff with progress-aware termination that distinguishes productive work from repeated or stalled work.
- Keep bounded protection through exact-repeat detection, consecutive no-progress detection, an emergency tool-call ceiling, and run/tool deadlines.
- Define progress for mail discovery, pagination, distinct message reads, analysis state, pipeline phases, pending operations, and artifact versions.
- Add a bounded batch mail-source read tool so the Agent can inspect several selected messages without spending one model/tool round trip per message.
- Bound batch inputs and outputs by message count, per-message characters, total characters, account ownership, and privacy-safe observations.
- Improve failure outcomes so users can distinguish a loop/stall, an emergency resource ceiling, and a deadline expiry.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pi-agent-runtime`: Replace the shared fixed iteration requirement with progress-aware execution guards and add bounded multi-message source reading for legitimate mail-analysis workflows.

## Impact

- Runtime: `server/wemail/agent/PiAgentRuntime.ts`, runtime configuration, progress classification, timeout handling, and termination conclusions.
- Mail tools: `server/wemail/agent/MailAgentTools.ts` and its tests.
- Composition and configuration: Agent construction defaults and any evaluation/runtime fixtures that set `maxIterations`.
- Tests: PI native mode, planner-stream mode, legacy planner mode, repeated calls, productive long runs, multi-mail source batches, limits, privacy, cancellation, and deadlines.
- Protocol/UI: no breaking protocol change is required; existing conclusion and tool events remain usable, with clearer reasons and next actions.
