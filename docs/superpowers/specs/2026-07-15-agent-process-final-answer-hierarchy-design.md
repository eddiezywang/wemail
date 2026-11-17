# Agent Process and Final Answer Hierarchy Design

## Goal

Make the final answer the dominant and last item within each conversational phase. Treat reasoning and ordinary tool execution as one inspectable analysis process that is visible while work is active and collapses once final text begins. Preserve confirmations and errors at their actual positions in the conversation timeline.

## Current Problem

The renderer maps `message.parts` directly to components in insertion order. Reasoning, text, tools, confirmations, and errors therefore compete at one visual level. Multi-step agent runs can append tool parts after a text part, leaving command cards at the bottom while the apparent final answer sits above them. This is technically faithful to part insertion order but conflicts with user expectations: information gathering should support the answer, not visually supersede it.

## Classification

Each assistant message part is classified for presentation:

- **Process parts:** reasoning and ordinary tool parts.
- **Final-answer parts:** Markdown text and its citations.
- **Timeline anchors:** confirmation cards and errors.

Confirmations are operational business events, not analysis. They remain fixed where they occurred. Resolving a confirmation updates that same card. Later execution activity and later answers render below it.

## Phase Segmentation

The renderer derives presentation blocks without mutating persisted `message.parts` or reducer state.

Timeline anchors split an assistant message into phases. For each phase between anchors:

1. collect all process parts in their original relative order;
2. collect all final-answer parts in their original relative order;
3. render one process disclosure first;
4. render final-answer content after it;
5. render the next timeline anchor at its original boundary.

This guarantees that a phase's final answer is visually last even if raw tool events were inserted after text. A confirmation creates a new phase, so post-confirmation execution and its eventual result naturally appear below the confirmation card.

## Process Disclosure Behavior

Reasoning and tools share one disclosure container.

- While the phase is active and no final text has started, the disclosure is open and streams reasoning/tool updates.
- As soon as the phase has non-empty final text, the disclosure automatically collapses to one row labeled `已完成分析`.
- The collapsed row remains clickable so users can inspect reasoning and tool details.
- When a run fails before producing final text, the disclosure remains open and the error anchor follows it.
- Completed historical messages use the same derived blocks and default to collapsed when they contain final text.
- Tool cards keep their specialized renderers and progressive states inside the disclosure; only their placement and default visibility change.

## Final Answer

Final-answer blocks use the existing safe Markdown renderer and citation chips. They are visually outside the process disclosure and remain directly readable. Multiple text parts in one phase retain their relative order and are rendered together as the phase result.

## Data and Protocol Boundaries

No Agent protocol, reducer, persistence, sequence, or legacy-adapter changes are required. Raw event order remains available for replay and diagnostics. The presentation transformation is a pure function from one `ConversationMessageState` plus its referenced run/tool/confirmation state to ordered view blocks.

This keeps the UI compatible with the current legacy adapter and with the planned Pi 0.80.6 runtime upgrade.

## Components

- Add a pure phase-segmentation helper with focused unit tests.
- Replace per-part rendering in `AssistantMessage` with ordered presentation blocks.
- Extend `ReasoningDisclosure` into a process disclosure that can render both reasoning and tool cards.
- Keep confirmation and error renderers as independent timeline anchors.
- Keep citation navigation and tool renderer registry behavior unchanged.

## Tests

Cover at least:

1. reasoning + tool + text renders as collapsed process followed by final answer;
2. text inserted before a later tool still displays after the process disclosure;
3. active run without final text keeps the process disclosure open;
4. failure without final text keeps process visible and places the error below it;
5. confirmation remains between pre-confirmation and post-confirmation phases;
6. confirmation resolution updates in place while later process/results stay below;
7. persisted history and live streaming derive the same layout;
8. Playwright acceptance verifies the final Markdown answer is the bottom-most content of a completed phase and tool details are hidden until the disclosure is opened.

## Non-goals

- Changing tool execution policy or confirmation requirements.
- Removing process details from history.
- Changing reducer event ordering or persisted schemas.
- Treating confirmations as reasoning/tool content.
- Implementing the future Pi protocol cutover in this change.
