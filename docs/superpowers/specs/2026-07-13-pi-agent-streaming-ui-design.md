# Pi Agent Structured Streaming UI Design

## Goal

Make WeMail's desktop agent feel like a modern mail copilot: show reasoning and
tool activity only while work is in progress, collapse that activity when the
run finishes, and preserve the final answer as clean, selectable Markdown.

## Considered approaches

1. Keep the current flattened `thinking` / `assistant_text` stream and repair
   Markdown with whitespace heuristics. This is low effort but cannot reliably
   recover token boundaries or distinguish reasoning from final output.
2. Forward Pi's native event lifecycle directly into the UI. This is accurate,
   but exposing Pi package types through the public API would tightly couple the
   renderer and persistence schema to one runtime version.
3. Add a thin WeMail adapter over Pi's native events and render the resulting
   structured parts in the existing chat surface. This preserves Pi semantics,
   keeps the public contract stable, and allows the UI to evolve independently.

We will use approach 3. The existing panel already provides conversation,
scrolling, pending-action, and mail-context behavior, so replacing the entire
chat shell would add risk without improving this specific interaction. The
adapter follows the same structured-part model used by assistant-ui runtimes;
Streamdown remains the Markdown renderer.

## Event contract

The public `AgentEvent` contract gains lifecycle-aware events:

- `reasoning_start`, `reasoning_delta`, `reasoning_end`
- `text_start`, `text_delta`, `text_end`
- existing `tool_call` and `tool_result`, correlated by `toolCallId`
- existing terminal `done`, `error`, and `terminate`

Every content event carries Pi's `contentIndex`. Delta text is transported
byte-for-byte and is never trimmed. End events carry the complete block text so
the client and persistence layer can replace any imperfect partial accumulation
with Pi's authoritative snapshot.

Legacy `thinking` and `assistant_text` events remain readable for stored history
and the planner fallback, but the Pi runtime emits the new structured events.

## Persistence

The server accumulates events with a shared reducer and persists a `parts`
array containing reasoning, text, and tool activity. Final `body.text` is derived
only from completed text parts and is retained for conversation context and
backward compatibility. It is not assembled with inserted newlines.

Existing conversations continue to load from their event list or `body.text`.

## UI behavior

- Before the first event, show the compact animated waiting indicator.
- During a run, show one activity disclosure containing reasoning and tool
  status. It opens automatically and updates in place.
- When the final answer starts, activity remains available but visually yields
  to the answer.
- On `done`, activity collapses automatically to a single "已完成" row and can
  be reopened by the user.
- Completed tool-only messages remain hidden, matching current behavior.
- The assistant's final response is a borderless document surface rather than a
  sequence of chat bubbles. User messages remain coral bubbles.
- Streamdown renders headings, lists, tables, links, code, and incomplete
  streaming Markdown. External links retain the desktop-safe open behavior.

## Error handling

Errors finish active reasoning/tool states and render as a concise assistant
message. Aborted runs stop streaming without discarding already received text.
Malformed legacy records fall back to their persisted plain text.

## Verification

- Unit tests cover Pi reasoning/text lifecycle mapping and exact whitespace.
- Route tests cover SSE preservation and structured persistence.
- Renderer tests cover streaming expansion, completion collapse, multi-block
  accumulation, legacy history, and Markdown semantics.
- Run server and renderer tests, TypeScript checks, and the production desktop
  build.
- Launch through `scripts/start-wemail-desktop.ps1 -Rebuild` and require HTTP
  200 plus `loadURL-done` and `ready` in the desktop startup log.
